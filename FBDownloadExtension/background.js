// Background service worker: receives download requests and uses chrome.downloads API
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
