import test from 'node:test';
import assert from 'node:assert/strict';

import { renderDownloadsPageMarkdown } from './generateDownloadsPage.mjs';

test('generated downloads page uses stable rolling desktop and Android links', async () => {
  const markdown = await renderDownloadsPageMarkdown();

  assert.match(markdown, /ui-mobile-stable\/happier-android\.apk/);
  assert.doesNotMatch(markdown, /ui-mobile-preview/);
  assert.match(markdown, /ui-desktop-stable\/happier-ui-desktop-darwin-aarch64\.dmg/);
  assert.match(markdown, /ui-desktop-stable\/happier-ui-desktop-windows-x86_64\.exe/);
  assert.doesNotMatch(markdown, /ui-desktop-stable\/[^\s)"']*-v\d/);
  assert.doesNotMatch(markdown, /Current desktop build:/);
});
