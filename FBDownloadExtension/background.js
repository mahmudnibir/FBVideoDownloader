// Background service worker: receives download requests and uses chrome.downloads API
// Also captures video URLs from network requests

// Store captured video URLs by tabId
const videoUrlCache = new Map();

// Listen for video file requests (mp4, m3u8, etc.)
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = details.url;
    // Filter for video URLs
    if (/\.(mp4|m3u8|webm|mov)(\?|$)/i.test(url) || url.includes('video')) {
      const tabId = details.tabId;
      if (tabId && tabId > 0) {
        if (!videoUrlCache.has(tabId)) {
          videoUrlCache.set(tabId, []);
        }
        const urls = videoUrlCache.get(tabId);
        // Store only unique URLs, keep last 10
        if (!urls.includes(url)) {
          urls.unshift(url);
          if (urls.length > 10) urls.pop();
        }
        console.log('FBVD Background: Captured video URL for tab', tabId, ':', url);
      }
    }
  },
  { urls: ["*://*.facebook.com/*", "*://*.fbcdn.net/*"] },
  []
);

// Clean up cache when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  videoUrlCache.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle request for cached video URLs
  if (message && message.action === 'getVideoUrls') {
    const tabId = sender.tab && sender.tab.id;
    const urls = tabId ? (videoUrlCache.get(tabId) || []) : [];
    sendResponse({success: true, urls});
    return false;
  }

  // Handle download request
  if (message && message.action === 'downloadUrl' && message.url) {
    const url = message.url;
    const filename = message.filename || undefined;
    try {
      chrome.downloads.download({url: url, filename: filename, conflictAction: 'uniquify'}, (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({success:false, error: chrome.runtime.lastError.message});
        } else {
          sendResponse({success:true, downloadId});
        }
      });
      // Indicate we'll respond asynchronously
      return true;
    } catch (err) {
      sendResponse({success:false, error: err && err.message});
      return false;
    }
  }
});
