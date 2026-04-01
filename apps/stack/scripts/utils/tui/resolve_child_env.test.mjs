import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTuiChildEnv } from './resolve_child_env.mjs';

test('resolveTuiChildEnv falls back to stack env file for missing stack keys', () => {
  const out = resolveTuiChildEnv({
    stackEnvFromFile: { HAPPIER_STACK_STACK: 'file-stack', HAPPIER_STACK_EXPO_DEV_PORT: '19364' },
    processEnv: { PATH: '/bin' },
  });

  assert.equal(out.HAPPIER_STACK_STACK, 'file-stack');
  assert.equal(out.HAPPIER_STACK_EXPO_DEV_PORT, '19364');
  assert.equal(out.HAPPIER_STACK_TUI, '1');
});

test('resolveTuiChildEnv prefers process env when keys overlap', () => {
  const out = resolveTuiChildEnv({
    stackEnvFromFile: { HAPPIER_STACK_STACK: 'file-stack' },
    processEnv: { HAPPIER_STACK_STACK: 'process-stack' },
  });

  assert.equal(out.HAPPIER_STACK_STACK, 'process-stack');
  assert.equal(out.HAPPIER_STACK_TUI, '1');
});

test('resolveTuiChildEnv forces fresh Expo bundles when Tauri mode is enabled', () => {
  const out = resolveTuiChildEnv({
    stackEnvFromFile: { HAPPIER_STACK_STACK: 'file-stack' },
    processEnv: { HAPPIER_STACK_TUI_WITH_TAURI: '1' },
  });

  assert.equal(out.HAPPIER_STACK_TUI_WITH_TAURI, '1');
  assert.equal(out.HAPPIER_STACK_EXPO_CLEAR_CACHE, '1');
});
