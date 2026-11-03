import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveUiWebBuildEnvForChannel } from '../pipeline/release/lib/public-release-rings.mjs';

// Issue #846: the server runtime embeds a web UI built from the channel's ring, not the
// app.config.js development default ("Happier (internal dev)").
test('UI web build env follows the release channel ring', () => {
  assert.deepEqual(resolveUiWebBuildEnvForChannel('stable', {}), { APP_ENV: 'production', EXPO_UPDATES_CHANNEL: 'production' });
  assert.deepEqual(resolveUiWebBuildEnvForChannel('preview', {}), { APP_ENV: 'preview', EXPO_UPDATES_CHANNEL: 'preview' });
  assert.deepEqual(resolveUiWebBuildEnvForChannel('publicdev', {}), { APP_ENV: 'preview', EXPO_UPDATES_CHANNEL: 'dev' });
});

test('an explicitly set UI web build env wins over the channel ring', () => {
  assert.deepEqual(
    resolveUiWebBuildEnvForChannel('stable', { APP_ENV: 'preview', EXPO_UPDATES_CHANNEL: 'preview' }),
    { APP_ENV: 'preview', EXPO_UPDATES_CHANNEL: 'preview' },
  );
});
