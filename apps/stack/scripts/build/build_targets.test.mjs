import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBuildSelection, parseRuntimeBuildTarget, resolveRuntimeBuildTargetGroups } from './build_targets.mjs';

test('build target is an explicit canonical runtime target independent of the publishing host', () => {
  assert.deepEqual(parseRuntimeBuildTarget({ argv: ['--target=linux-x64'] }), { platform: 'linux', arch: 'x64' });
  assert.deepEqual(parseRuntimeBuildTarget({ argv: ['--target=windows-arm64'] }), { platform: 'win32', arch: 'arm64' });
  assert.throws(() => parseRuntimeBuildTarget({ argv: ['--target=linux-unknown'] }), /invalid.*target/);
});

test('component build targets follow server placement without retargeting a local daemon', () => {
  const config = { targets: [{ name: 'mac-host' }], runtimePlacement: {
    server: { mode: 'prefer-target', target: 'mac-host' }, daemon: { mode: 'local' },
  } };
  const observedTargets = [{ name: 'mac-host', ok: true, runtimeTarget: { platform: 'darwin', arch: 'arm64' } }];
  const inputs = { argv: ['--target=darwin-arm64'], config, observedTargets,
    hostTarget: { platform: 'linux', arch: 'arm64' } };
  assert.deepEqual(parseRuntimeBuildTarget({ ...inputs, component: 'server' }), { platform: 'darwin', arch: 'arm64' });
  assert.deepEqual(parseRuntimeBuildTarget({ ...inputs, component: 'daemon' }), { platform: 'linux', arch: 'arm64' });
  assert.deepEqual(parseRuntimeBuildTarget({ ...inputs, argv: [], component: 'server' }), { platform: 'darwin', arch: 'arm64' });
});

test('component target resolution fails closed when a placed host cannot be observed', () => {
  assert.throws(() => parseRuntimeBuildTarget({ component: 'server', argv: ['--target=darwin-arm64'],
    config: { targets: [{ name: 'mac-host' }], runtimePlacement: { server: { mode: 'prefer-target', target: 'mac-host' } } },
    observedTargets: [{ name: 'mac-host', ok: false }],
  }), /server.*mac-host.*unavailable/);
});

test('daemon-only target selection retains its local placement when the unselected server is remote', () => {
  const config = { version: 3, commandExecution: { mode: 'local' }, targets: [{ name: 'mac-host' }], runtimePlacement: {
    server: { mode: 'prefer-target', target: 'mac-host' }, daemon: { mode: 'local' },
  } };
  const hostTarget = { platform: 'linux', arch: 'arm64' };
  const input = { config, hostTarget, selection: parseBuildSelection({ argv: ['--daemon'] }) };
  assert.throws(() => resolveRuntimeBuildTargetGroups({ ...input, argv: ['--target=darwin-arm64'] }),
    /does not match.*placement/,
    'an unselected remote service must not make the local daemon accept its foreign target');
  assert.deepEqual(resolveRuntimeBuildTargetGroups({ ...input, argv: [] }).componentTargets.daemon, [hostTarget]);
  assert.deepEqual(resolveRuntimeBuildTargetGroups({ ...input, argv: ['--target=linux-arm64'] }).componentTargets.daemon, [hostTarget]);
  const web = resolveRuntimeBuildTargetGroups({ config, hostTarget, argv: ['--target=darwin-arm64'],
    selection: parseBuildSelection({ argv: ['--web'] }) });
  assert.deepEqual(web.groups[0].target, { platform: 'darwin', arch: 'arm64' }, 'web-only explicit target remains independent of service placement');
});

test('mixed service targets produce independent groups and explicit target constrains matching placements', () => {
  const config = { version: 3, commandExecution: { mode: 'local' }, targets: [{ name: 'mac-host' }], runtimePlacement: {
    server: { mode: 'prefer-target', target: 'mac-host' }, daemon: { mode: 'local' },
  } };
  const input = { config, observedTargets: [{ name: 'mac-host', ok: true, runtimeTarget: { platform: 'darwin', arch: 'arm64' } }],
    hostTarget: { platform: 'linux', arch: 'arm64' }, selection: parseBuildSelection({ argv: ['--server', '--daemon'] }) };
  const result = resolveRuntimeBuildTargetGroups({ ...input, argv: ['--target=darwin-arm64'] });
  assert.deepEqual(result.groups.map(group => [group.target, group.selection.publicationRequiredComponents]), [
    [{ platform: 'darwin', arch: 'arm64' }, ['server']], [{ platform: 'linux', arch: 'arm64' }, ['daemon']],
  ]);
  assert.deepEqual(result.componentTargets.daemon, [{ platform: 'linux', arch: 'arm64' }]);
  assert.throws(() => resolveRuntimeBuildTargetGroups({ ...input, argv: ['--target=windows-x64'] }), /does not match.*placement/);
  assert.throws(() => resolveRuntimeBuildTargetGroups({ ...input, selection: parseBuildSelection({ argv: ['--all', '--activate-runtime'] }) }), /different runtime targets.*subset/);
  const native = resolveRuntimeBuildTargetGroups({ hostTarget: input.hostTarget, selection: input.selection, argv: ['--target=darwin-arm64'] });
  assert.equal(native.groups.length, 1, 'unplaced explicit foreign-target builds retain the established target contract');
  assert.deepEqual(native.groups[0].target, { platform: 'darwin', arch: 'arm64' });
});

test('daemon local-and-targets builds each actual host once and coalesces matching server target', () => {
  const hostTarget = { platform: 'linux', arch: 'arm64' };
  const input = { hostTarget, argv: [], selection: parseBuildSelection({ argv: ['--server', '--daemon'] }),
    config: { version: 3, commandExecution: { mode: 'local' }, targets: [{ name: 'mac' }, { name: 'linux' }], runtimePlacement: {
      server: { mode: 'prefer-target', target: 'mac' }, daemon: { mode: 'local-and-targets', targets: ['mac', 'linux'] },
    } }, observedTargets: [
      { name: 'mac', ok: true, runtimeTarget: { platform: 'darwin', arch: 'arm64' } },
      { name: 'linux', ok: true, runtimeTarget: hostTarget },
    ],
  };
  const result = resolveRuntimeBuildTargetGroups(input);
  assert.equal(result.groups.length, 2);
  assert.deepEqual(result.groups[0].selection.publicationRequiredComponents, ['server', 'daemon']);
  assert.deepEqual(result.groups[1].selection.publicationRequiredComponents, ['daemon']);
  assert.equal(result.componentTargets.daemon.length, 2);
});

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

test('parseBuildSelection keeps explicit --server builds server-only', () => {
  const selection = parseBuildSelection({ argv: ['--server'] });

  assert.deepEqual(selection.components, {
    web: false,
    server: true,
    daemon: false,
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
