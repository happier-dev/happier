import test from 'node:test';
import assert from 'node:assert/strict';

import { buildStackTauriExportEnv, buildStackWebExportEnv } from './ui_export_env.mjs';

test('buildStackWebExportEnv forces stack server context and leaves server URL empty for runtime origin', () => {
  const env = buildStackWebExportEnv({ baseEnv: { ...process.env } });

  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.EXPO_PUBLIC_DEBUG, '0');
  assert.equal(env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT, 'stack');
  assert.equal(env.EXPO_PUBLIC_HAPPY_SERVER_URL, '');
});

test('buildStackTauriExportEnv forces stack server context and hardcodes API base URL', () => {
  const tauriServerUrl = 'http://127.0.0.1:3013';
  const env = buildStackTauriExportEnv({ baseEnv: { ...process.env }, tauriServerUrl });

  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.EXPO_PUBLIC_DEBUG, '0');
  assert.equal(env.EXPO_PUBLIC_HAPPY_SERVER_CONTEXT, 'stack');
  assert.equal(env.EXPO_PUBLIC_HAPPY_SERVER_URL, tauriServerUrl);
  assert.equal(env.EXPO_PUBLIC_SERVER_URL, tauriServerUrl);
});

