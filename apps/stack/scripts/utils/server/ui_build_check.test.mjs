import test from 'node:test';
import assert from 'node:assert/strict';

import { validateUiServingConfig } from './ui_build_check.mjs';

test('validateUiServingConfig returns disabled/no-warning when UI serving is not requested', () => {
  const res = validateUiServingConfig({
    serverComponentName: 'happier-server',
    serveUiWanted: false,
    uiBuildDir: '',
    uiBuildDirExists: false,
    uiIndexExists: false,
  });
  assert.deepEqual(res, { serveUi: false, warning: null });
});

test('validateUiServingConfig fails closed for server-light when index.html is missing', () => {
  assert.throws(
    () =>
      validateUiServingConfig({
        serverComponentName: 'happier-server-light',
        serveUiWanted: true,
        uiBuildDir: '/tmp/ui',
        uiBuildDirExists: true,
        uiIndexExists: false,
      }),
    /hstack build/i
  );
});

test('validateUiServingConfig warns+disables UI for full server when index.html is missing', () => {
  const res = validateUiServingConfig({
    serverComponentName: 'happier-server',
    serveUiWanted: true,
    uiRequired: false,
    uiBuildDir: '/tmp/ui',
    uiBuildDirExists: true,
    uiIndexExists: false,
  });
  assert.equal(res.serveUi, false);
  assert.match(res.warning ?? '', /index\.html/i);
});

test('validateUiServingConfig warns+disables UI for full server when build dir is missing', () => {
  const res = validateUiServingConfig({
    serverComponentName: 'happier-server',
    serveUiWanted: true,
    uiRequired: false,
    uiBuildDir: '/tmp/missing-ui',
    uiBuildDirExists: false,
    uiIndexExists: false,
  });
  assert.equal(res.serveUi, false);
  assert.match(res.warning ?? '', /build dir/i);
});

test('validateUiServingConfig fails closed when UI is required (even for full server)', () => {
  assert.throws(
    () =>
      validateUiServingConfig({
        serverComponentName: 'happier-server',
        serveUiWanted: true,
        uiRequired: true,
        uiBuildDir: '/tmp/ui',
        uiBuildDirExists: true,
        uiIndexExists: false,
      }),
    /hstack build/i
  );
});
