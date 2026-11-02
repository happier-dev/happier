'use strict';

function selectNativeBundleResponse(request) {
  if (!request.url?.split('?')[0].endsWith('.bundle')) return;
  const url = new URL(request.url, 'http://localhost');
  if (url.searchParams.get('platform') !== 'android') return;
  // RN's multipart reader buffers the entire bundle part. Its ordinary response
  // path streams to disk, avoiding a second bundle-sized allocation on Android.
  request.headers.accept = 'application/javascript';
}

module.exports = { selectNativeBundleResponse };
