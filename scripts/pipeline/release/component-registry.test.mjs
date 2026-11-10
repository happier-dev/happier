import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyChangedPaths,
  deriveVersionedComponentChanges,
  releaseTargets,
} from './component-registry.mjs';

test('release target registry covers the local release CLI surface exactly', () => {
  assert.deepEqual(releaseTargets, [
    'ui',
    'server',
    'website',
    'docs',
    'cli',
    'stack',
    'server_runner',
    'plugin_sdk',
    'sdk',
  ]);
});

test('plugin SDK pair and public SDK each have a release component, while bundled protocol and agent changes are candidate-affecting', () => {
  const pluginPair = deriveVersionedComponentChanges(classifyChangedPaths([
    'packages/plugin-ui/src/components/Button.tsx',
  ]));
  assert.equal(pluginPair.plugin_sdk, true);
  assert.equal(pluginPair.sdk, false);

  const publicSdk = deriveVersionedComponentChanges(classifyChangedPaths([
    'packages/sdk/src/index.ts',
  ]));
  assert.equal(publicSdk.plugin_sdk, false);
  assert.equal(publicSdk.sdk, true);

  const protocol = deriveVersionedComponentChanges(classifyChangedPaths([
    'packages/protocol/src/actions/registry.ts',
  ]));
  assert.equal(protocol.plugin_sdk, true);
  assert.equal(protocol.sdk, true);

  const agents = deriveVersionedComponentChanges(classifyChangedPaths([
    'packages/agents/src/runtime/agentRuntime.ts',
  ]));
  assert.equal(agents.plugin_sdk, true);
  assert.equal(agents.sdk, true);
});

for (const changedPath of [
  'packages/plugin-sdk/scripts/apiSurfaceCli.mjs',
  'packages/protocol/src/actions/actionSpecs.ts',
  'packages/agents/src/runtime/agentRuntime.ts',
  'scripts/api-governance/declarationDiff.mjs',
  'packages/cli-common/src/firstPartyRuntime/installVersionedPayload.ts',
  'packages/release-runtime/src/releaseRings.ts',
]) {
  test(`plugin SDK declaration source or bundled dependency change triggers a plugin SDK candidate: ${changedPath}`, () => {
    const classified = classifyChangedPaths([changedPath]);
    const versioned = deriveVersionedComponentChanges(classified);

    assert.equal(versioned.plugin_sdk, true, changedPath);
  });
}

test('packages/cli-common changes trigger cli/stack/server versioned component bumps', () => {
  const classified = classifyChangedPaths(['packages/cli-common/src/firstPartyRuntime/installVersionedPayload.ts']);
  assert.equal(classified.cli_stack_shared, true);

  const versioned = deriveVersionedComponentChanges(classified);
  assert.equal(versioned.cli, true);
  assert.equal(versioned.stack, true);
  assert.equal(versioned.server, true);
  assert.equal(versioned.app, true);
  assert.equal(versioned.runner, true);
});

test('Runner candidate change detection follows its real scoped runtime and release inputs', () => {
  for (const changedPath of [
    'apps/cli/src/ephemeralRunner/main.ts',
    'packages/protocol/src/ephemeralRunner/activation.ts',
    'packages/release-runtime/src/releaseManifest.ts',
    'packages/plugin-sdk/src/runtime/host.ts',
  ]) {
    const versioned = deriveVersionedComponentChanges(classifyChangedPaths([changedPath]));
    assert.equal(versioned.runner, true, changedPath);
  }
});

test('every UI workspace dependency family triggers an app release without pretending UI source changed', () => {
  for (const changedPath of [
    'packages/plugin-ui/src/components/Button.tsx',
    'packages/plugin-sdk/src/ui/contributions.ts',
    'packages/plugins/claude/src/ui/descriptor.ts',
    'packages/connection-supervisor/src/index.ts',
  ]) {
    const classified = classifyChangedPaths([changedPath]);
    assert.equal(classified.ui, false, changedPath);
    assert.equal(classified.ui_dependencies, true, changedPath);
    assert.equal(deriveVersionedComponentChanges(classified).app, true, changedPath);
  }
});

test('Iroh transport owners select every shipped consumer through the canonical release registry', () => {
  for (const changedPath of [
    'packages/iroh-native/src/adapter.ts',
    'packages/peer-transport/src/duplexFrames/streamSession.ts',
  ]) {
    const classified = classifyChangedPaths([changedPath]);
    const versioned = deriveVersionedComponentChanges(classified);

    assert.equal(versioned.app, true, changedPath);
    assert.equal(versioned.cli, true, changedPath);
    assert.equal(versioned.server, true, changedPath);
  }
});

test('relay deployment changes produce the exact Iroh relay decision without an ordinary server release', () => {
  // The stock relay deployment is digest-published by the existing Docker
  // publisher. A relay-only edit is exactly an iroh_relay change: it must not
  // imply an ordinary server release or bump any versioned component.
  const classified = classifyChangedPaths(['deploy/iroh-relay/Dockerfile']);
  assert.equal(classified.iroh_relay, true);
  assert.equal(classified.server, false, 'a relay-only edit must not imply an ordinary server release');
  const versioned = deriveVersionedComponentChanges(classified);
  for (const [component, changed] of Object.entries(versioned)) {
    assert.equal(changed, false, `a relay-only edit must not bump versioned component ${component}`);
  }

  // Ordinary server inputs keep their existing classification.
  const serverSource = classifyChangedPaths(['packages/relay-server/bin/happier-server.mjs']);
  assert.equal(serverSource.server, true);
  assert.equal(serverSource.iroh_relay, false);
});

test('SQLite helper changes select only the helper publication without version bumps', () => {
  const classified = classifyChangedPaths(['deploy/sqlite-helper/Dockerfile']);
  assert.equal(classified.sqlite_helper, true);
  for (const [component, changed] of Object.entries(classified)) {
    assert.equal(changed, component === 'sqlite_helper', component);
  }
  for (const [component, changed] of Object.entries(deriveVersionedComponentChanges(classified))) {
    assert.equal(changed, false, component);
  }
  assert.equal(classifyChangedPaths(['deploy/iroh-relay/Dockerfile']).sqlite_helper, false);
});
