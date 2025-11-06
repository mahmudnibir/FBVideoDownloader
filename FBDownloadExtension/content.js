// Content script: injects a download button overlay on Facebook video elements (reels & long videos)
(function () {
  const PROCESSED = Symbol('fb-downloader-processed');

  function createDownloadButton() {
    const btn = document.createElement('button');
    btn.className = 'fbvd-download-btn';
    btn.title = 'Download video';
    btn.style.cssText = `
      display:flex;align-items:center;justify-content:center;
      width:36px;height:36px;border-radius:50%;
      background:rgba(0,0,0,0.6);color:#fff;border:0;cursor:pointer;
      box-shadow:0 2px 6px rgba(0,0,0,0.4);z-index:99999;position:absolute;
      `;
    btn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 3v10" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M8 9l4 4 4-4" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M21 21H3" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
    return btn;
  }

  async function tryDownloadByUrl(url, suggestedFilename) {
    try {
      // Ask background to download using chrome.downloads
      const resp = await chrome.runtime.sendMessage({action: 'downloadUrl', url, filename: suggestedFilename});
      // background will handle errors
      return resp;
    } catch (err) {
      console.warn('FBVD: download via background failed', err);
      return {success:false, error: err && err.message};
    }
  }

  // fallback: fetch blob & trigger anchor download from content-script
  async function fetchAndDownload(url, filename) {
    try {
      const res = await fetch(url, {mode: 'cors'});
      if (!res.ok) throw new Error('Fetch failed: ' + res.status);
      const blob = await res.blob();
      const obj = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = obj;
      a.download = filename || 'facebook_video.mp4';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(obj), 5000);
      return {success:true};
    } catch (err) {
      console.warn('FBVD: fetch/download fallback failed', err);
      return {success:false, error: err && err.message};
    }
  }

  async function handleButtonClick(video) {
    // Try to get the best possible src from the video element
    const suggestedFilename = (document.title || 'facebook_video').replace(/[^a-z0-9._-]/ig, '_') + '.mp4';

    function findDirectFromVideo(v) {
      if (!v) return null;
      if (v.currentSrc && !v.currentSrc.startsWith('blob:')) return v.currentSrc;
      if (v.src && !v.src.startsWith('blob:')) return v.src;
      try {
        const s = v.querySelector && v.querySelector('source');
        if (s && s.src && !s.src.startsWith('blob:')) return s.src;
      } catch (e) {}
      return null;
    }

    // Scan element attributes and ancestors for possible URLs (data-src, data-store, hrefs)
    function scanAncestorsForUrl(node) {
      let cur = node;
      const urlPattern = /https?:\/\/[^\s'"<>]+?(?:\.mp4|\.m3u8)/ig;
      for (let i=0;i<8 && cur;i++) {
        // check attributes
        for (const attr of Array.from(cur.attributes || [])) {
          const val = attr && attr.value;
          if (!val) continue;
          const m = val.match(urlPattern);
          if (m && m.length) return m[0];
        }
        // innerHTML scan - small
        try {
          const inner = cur.innerHTML || '';
          const m2 = inner.match(urlPattern);
          if (m2 && m2.length) return m2[0];
        } catch (e) {}
        cur = cur.parentElement;
      }
      return null;
    }

    // global page scan for common video file patterns (mp4/m3u8)
    function scanDocumentForUrls() {
      const page = document.documentElement && document.documentElement.innerHTML || '';
      // look for https...mp4 or m3u8
      const rx = /https?:\/\/[^\s'"<>]+?(?:\.mp4|\.m3u8)/ig;
      const matches = page.match(rx);
      if (matches && matches.length) return matches[0];
      return null;
    }

    // Start attempts
    let src = findDirectFromVideo(video);

    // If we got a blob or nothing, try scanning sources
    if (!src) {
      // prefer scanning ancestors for data attributes pointing to media
      src = scanAncestorsForUrl(video) || scanDocumentForUrls();
    }

    // If still nothing, ask background for captured URLs from network requests
    if (!src) {
      try {
        const resp = await chrome.runtime.sendMessage({action: 'getVideoUrls'});
        if (resp && resp.success && resp.urls && resp.urls.length) {
          console.log('FBVD: Found cached video URLs from network:', resp.urls);
          // Use the most recent mp4 URL if available, otherwise first URL
          src = resp.urls.find(u => u.includes('.mp4')) || resp.urls[0];
          if (src) console.log('FBVD: Using captured URL:', src);
        }
      } catch (e) {
        console.warn('FBVD: Failed to get cached URLs from background', e);
      }
    }

    if (!src) {
      console.warn('FBVD: no direct URL found for video element. Looked at video.src/currentSrc, <source>, ancestors, page, and network cache.');
      // Show a single informative alert to the user (no duplicates)
      alert('Unable to locate direct video URL. If the video is protected, the extension may not be able to download it. Check the console for details.');
      return;
    }

    // If it's an HLS playlist (m3u8), we can't download directly without extra processing — warn the user
    if (src.includes('.m3u8')) {
      console.warn('FBVD: found HLS playlist (m3u8) — direct download not supported by default:', src);
      alert('Found a streaming playlist (HLS). Direct download is not supported by this extension yet.');
      return;
    }

    // If src is a blob URL, attempt to find a non-blob in ancestors before trying to fetch blob
    if (src.startsWith('blob:')) {
      const anc = scanAncestorsForUrl(video);
      if (anc && !anc.startsWith('blob:')) src = anc;
    }

    // For normal http/https URL, try background download API first
    if (src && /^https?:\/\//i.test(src)) {
      const res = await tryDownloadByUrl(src, suggestedFilename);
      if (!res || !res.success) {
        // fallback to content-fetch
        const r2 = await fetchAndDownload(src, suggestedFilename);
        if (!r2.success) console.warn('FBVD: fallback fetch/download failed', r2 && r2.error);
      }
      return;
    }

    // If we reached here and src is not http(s), try to fetch it directly (may fail due to blob/CORS)
    const r2 = await fetchAndDownload(src, suggestedFilename);
    if (!r2.success) console.warn('FBVD: final fetch/download failed', r2 && r2.error);
  }

  function addButtonToVideo(video) {
    if (!video || video[PROCESSED]) return;
    video[PROCESSED] = true;

    // Find an ancestor suitable as the positioning container. Prefer a parent that fully contains the video.
    let container = video.parentElement;
    if (!container) {
      console.warn('FBVD: video has no parent, skipping', video);
      return;
    }
    
    let tries = 0;
    const vRect = video.getBoundingClientRect();
    // skip videos with zero dimensions (not yet rendered or hidden)
    if (vRect.width === 0 || vRect.height === 0) {
      console.log('FBVD: video not yet visible, will retry on next scan', video);
      delete video[PROCESSED]; // allow retry
      return;
    }
    
    while (container && container !== document.body && tries < 6) {
      const cRect = container.getBoundingClientRect();
      if (cRect.width >= vRect.width - 2 && cRect.height >= vRect.height - 2) break;
      container = container.parentElement;
      tries++;
    }
    if (!container) container = video.parentElement || document.body;

    // Ensure the container can position absolute children
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    const btn = createDownloadButton();

    // Function to compute and apply a good position inside the video area
    function applyPosition() {
      try {
        const parentRect = container.getBoundingClientRect();
        const vidRect = video.getBoundingClientRect();

        // Compute offsets of the video inside the container
        const offsetLeft = Math.max(8, vidRect.left - parentRect.left + 8);
        // place button above the default control/overlay area (approx 56px from bottom of video)
        const offsetTop = Math.max(8, vidRect.top - parentRect.top + vidRect.height - 72);

        btn.style.left = offsetLeft + 'px';
        btn.style.top = offsetTop + 'px';
        btn.style.position = 'absolute';
        btn.style.zIndex = '2147483647';
      } catch (err) {
        // ignore positioning errors
      }
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleButtonClick(video);
    });

    container.appendChild(btn);
    applyPosition();
    
    console.log('FBVD: Download button added to video', video, 'container:', container);

    // keep button positioned if the video element moves/changes size
    const ro = new ResizeObserver(applyPosition);
    try { ro.observe(video); ro.observe(container); } catch (e) {}

    // update on scroll/resize for robust placement
    const onScrollOrResize = throttle(applyPosition, 120);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);

    // clean-up when node is removed
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.removedNodes || []) {
          if (n === container || n.contains && n.contains(video)) {
            try { ro.disconnect(); } catch (e) {}
            try { mo.disconnect(); } catch (e) {}
            try { window.removeEventListener('scroll', onScrollOrResize, true); window.removeEventListener('resize', onScrollOrResize); } catch (e) {}
          }
        }
      }
    });
    mo.observe(container.parentElement || document, {childList:true, subtree:true});
  }

  // simple throttle helper
  function throttle(fn, wait) {
    let last = 0, timeout = null;
    return function () {
      const now = Date.now();
      const args = arguments;
      const ctx = this;
      const remaining = wait - (now - last);
      if (remaining <= 0) {
        if (timeout) { clearTimeout(timeout); timeout = null; }
        last = now;
        fn.apply(ctx, args);
      } else if (!timeout) {
        timeout = setTimeout(() => { last = Date.now(); timeout = null; fn.apply(ctx, args); }, remaining);
      }
    };
  }

  function scanAndAttach() {
    const videos = Array.from(document.querySelectorAll('video'));
    console.log('FBVD: Found', videos.length, 'video elements on page');
    for (const v of videos) addButtonToVideo(v);
  }

  // initial scan
  scanAndAttach();

  // observe DOM changes for dynamically loaded videos (reels infinite scroll etc.)
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.addedNodes && m.addedNodes.length) scanAndAttach();
    }
  });
  observer.observe(document, {childList:true, subtree:true});

  // small CSS appended to page
  const style = document.createElement('style');
  style.textContent = `
  .fbvd-download-btn:hover{transform:scale(1.05)}
  `;
  document.head.appendChild(style);
})();
