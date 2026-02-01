import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveServerUiEnv } from './ui_env.mjs';

test('resolveServerUiEnv returns empty when UI serving is disabled', () => {
  assert.deepEqual(
    resolveServerUiEnv({
      serveUi: false,
      uiBuildDir: '/tmp/ui',
      uiPrefix: '/',
      uiBuildDirExists: true,
    }),
    {}
  );
});

test('resolveServerUiEnv returns empty when UI build dir is missing', () => {
  assert.deepEqual(
    resolveServerUiEnv({
      serveUi: true,
      uiBuildDir: '/tmp/ui',
      uiPrefix: '/',
      uiBuildDirExists: false,
    }),
    {}
  );
});

test('resolveServerUiEnv sets both canonical and legacy env keys when enabled', () => {
  assert.deepEqual(
    resolveServerUiEnv({
      serveUi: true,
      uiBuildDir: '/tmp/ui',
      uiPrefix: '/ui',
      uiBuildDirExists: true,
    }),
    {
      HAPPY_SERVER_UI_DIR: '/tmp/ui',
      HAPPY_SERVER_UI_PREFIX: '/ui',
      HAPPY_SERVER_LIGHT_UI_DIR: '/tmp/ui',
      HAPPY_SERVER_LIGHT_UI_PREFIX: '/ui',
    }
  );
});

