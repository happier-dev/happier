import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBuildSelection } from './build_targets.mjs';

test('parseBuildSelection defaults to web-only build when no component flags are provided', () => {
  const selection = parseBuildSelection({ argv: [] });

  assert.deepEqual(selection, {
    components: {
      web: true,
      server: false,
      daemon: false,
      tauri: false,
    },
    activateRuntime: false,
    forceRebuild: false,
    explicitComponentSelection: false,
  });
});

test('parseBuildSelection expands --all to web, server, and daemon without tauri', () => {
  const selection = parseBuildSelection({ argv: ['--all'] });

  assert.deepEqual(selection.components, {
    web: true,
    server: true,
    daemon: true,
    tauri: false,
  });
  assert.equal(selection.explicitComponentSelection, true);
});

test('parseBuildSelection treats --activate-runtime with no component flags as a full runtime build', () => {
  const selection = parseBuildSelection({ argv: ['--activate-runtime'] });

  assert.deepEqual(selection.components, {
    web: true,
    server: true,
    daemon: true,
    tauri: false,
  });
  assert.equal(selection.activateRuntime, true);
});

test('parseBuildSelection rejects activating a partial runtime snapshot', () => {
  assert.throws(
    () => parseBuildSelection({ argv: ['--server', '--activate-runtime'] }),
    /requires web, server, and daemon/i,
  );
});

test('parseBuildSelection rejects tauri when combined with stack-local artifact/runtime flags', () => {
  assert.throws(
    () => parseBuildSelection({ argv: ['--web', '--tauri', '--force-rebuild'] }),
    /--tauri cannot be combined/i,
  );
});
