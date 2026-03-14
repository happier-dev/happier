import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldBuildStackArtifacts } from './build_mode.mjs';

test('shouldBuildStackArtifacts keeps --web on main stack as local UI build', () => {
  const result = shouldBuildStackArtifacts({
    selection: {
      components: { web: true, server: false, daemon: false, tauri: false },
      activateRuntime: false,
      forceRebuild: false,
    },
    argv: ['--web'],
    env: {},
  });

  assert.equal(result, false);
});

test('shouldBuildStackArtifacts routes --web to artifact builds for named stacks', () => {
  const result = shouldBuildStackArtifacts({
    selection: {
      components: { web: true, server: false, daemon: false, tauri: false },
      activateRuntime: false,
      forceRebuild: false,
    },
    argv: ['--web'],
    env: { HAPPIER_STACK_STACK: 'exp1' },
  });

  assert.equal(result, true);
});

test('shouldBuildStackArtifacts still routes server builds to artifacts on main stack', () => {
  const result = shouldBuildStackArtifacts({
    selection: {
      components: { web: false, server: true, daemon: false, tauri: false },
      activateRuntime: false,
      forceRebuild: false,
    },
    argv: ['--server'],
    env: {},
  });

  assert.equal(result, true);
});
