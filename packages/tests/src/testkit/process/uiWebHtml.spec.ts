import { describe, expect, it } from 'vitest';

import { resolveScriptUrlsFromHtml, selectPrimaryAppScriptUrl } from './uiWebHtml';

describe('uiWebHtml', () => {
  it('resolves script src urls against the baseUrl', () => {
    const html = [
      '<!doctype html>',
      '<html>',
      '<head>',
      '<script src="/index.bundle?platform=web&dev=false&minify=true"></script>',
      '<script src="https://cdn.example.com/vendor.js"></script>',
      '</head>',
      '</html>',
    ].join('\n');

    const urls = resolveScriptUrlsFromHtml(html, 'http://localhost:8081/');
    expect(urls).toEqual([
      'http://localhost:8081/index.bundle?platform=web&dev=false&minify=true',
      'https://cdn.example.com/vendor.js',
    ]);
  });

  it('selects the primary bundle-like script url when present', () => {
    const urls = [
      'http://localhost:8081/runtime.js',
      'http://localhost:8081/index.bundle?platform=web&dev=false&minify=true',
      'http://localhost:8081/vendor.js',
    ];
    expect(selectPrimaryAppScriptUrl(urls)).toBe('http://localhost:8081/index.bundle?platform=web&dev=false&minify=true');
  });

  it('falls back to the first script url when no bundle-like url exists', () => {
    const urls = [
      'http://localhost:19006/static/js/runtime.js',
      'http://localhost:19006/static/js/vendor.js',
    ];
    expect(selectPrimaryAppScriptUrl(urls)).toBe('http://localhost:19006/static/js/runtime.js');
  });
});
