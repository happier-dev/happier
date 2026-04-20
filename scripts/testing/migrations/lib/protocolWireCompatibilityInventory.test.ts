import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROTOCOL_WIRE_COMPATIBILITY_INVENTORY,
  validateProtocolWireCompatibilityInventory,
} from './protocolWireCompatibilityInventory.ts';

test('validateProtocolWireCompatibilityInventory rejects non-boundary translation modules', () => {
  const result = validateProtocolWireCompatibilityInventory({
    rootDir: '/repo',
    inventory: [
      {
        id: 'socket-rpc',
        title: 'Socket RPC',
        protocolModules: ['packages/protocol/src/socketRpc.ts'],
        boundaryModules: ['apps/cli/src/agent/runtime/createExecutionRunBackend.ts'],
        proofTests: ['packages/protocol/src/socketRpc.test.ts'],
      },
    ],
    pathExists: () => true,
  });

  assert.equal(result.ok, false);
  assert.match(
    result.errors[0] ?? '',
    /must stay in explicit boundary modules/i,
  );
});

test('validateProtocolWireCompatibilityInventory rejects entries without proof tests', () => {
  const result = validateProtocolWireCompatibilityInventory({
    rootDir: '/repo',
    inventory: [
      {
        id: 'changes-v2',
        title: 'Changes V2',
        protocolModules: ['packages/protocol/src/changes.ts'],
        boundaryModules: ['apps/server/sources/app/api/routes/changes/changesRoutes.ts'],
        proofTests: [],
      },
    ],
    pathExists: () => true,
  });

  assert.equal(result.ok, false);
  assert.match(result.errors[0] ?? '', /must declare at least one proof test/i);
});

test('validateProtocolWireCompatibilityInventory treats CLI plugin/extensions parsing as an explicit boundary', () => {
  const result = validateProtocolWireCompatibilityInventory({
    rootDir: '/repo',
    inventory: [
      {
        id: 'extensions-contracts',
        title: 'Plugin manifest and hook envelopes',
        protocolModules: ['packages/protocol/src/extensions/pluginManifestV1.ts'],
        boundaryModules: ['apps/cli/src/extensions/manifest/read.ts'],
        proofTests: ['packages/protocol/src/extensions/contractsV1.test.ts'],
      },
    ],
    pathExists: () => true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

test('the authoritative protocol wire compatibility inventory resolves to real repo files', () => {
  const result = validateProtocolWireCompatibilityInventory({
    rootDir: process.cwd(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.ok(PROTOCOL_WIRE_COMPATIBILITY_INVENTORY.length >= 5);
});

test('the plugin and hook ABI inventory pins hook catalogs and bridge lifecycle proofs', () => {
  const entry = PROTOCOL_WIRE_COMPATIBILITY_INVENTORY.find(
    (candidate) => candidate.id === 'plugin-manifest-and-hook-envelopes-v1',
  );

  assert.ok(entry);
  assert.ok(entry.protocolModules.includes('packages/protocol/src/hooks/hookIds.ts'));
  assert.ok(entry.protocolModules.includes('packages/protocol/src/hooks/hookScopes.ts'));
  assert.ok(entry.protocolModules.includes('packages/protocol/src/hooks/hookCategories.ts'));
  assert.ok(entry.protocolModules.includes('packages/protocol/src/hooks/hookExecutionSemantics.ts'));
  assert.ok(entry.protocolModules.includes('packages/protocol/src/hooks/bridgeLifecycleHookCatalog.ts'));
  assert.ok(entry.protocolModules.includes('packages/protocol/src/hooks/daemonSpawnHookCatalog.ts'));
  assert.ok(entry.protocolModules.includes('packages/protocol/src/extensions/extensionSourceSpecV1.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/extensions/manifest/read.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/extensions/registry/normalize/package.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/extensions/manifest/daemonEntry.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/extensions/hooks/execution/bridgeLifecycleHookEmissionInventory.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/extensions/runtime/loadPluginDaemonModule.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/extensions/runtime/resolvePluginHookHandlerRegistry.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/extensions/runtime/resolveExecutablePluginRuntimeRegistry.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/extensions/manifest/read.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/extensions/registry/normalize/package.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/extensions/manifest/daemonEntry.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/extensions/runtime/loadPluginDaemonModule.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/extensions/runtime/resolvePluginHookHandlerRegistry.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/extensions/runtime/resolveExecutablePluginRuntimeRegistry.test.ts'));
  assert.ok(entry.proofTests.includes('packages/tests/suites/core-e2e/bridge.lifecycleHookDispatch.slow.e2e.test.ts'));
  assert.ok(entry.proofTests.includes('packages/tests/suites/core-e2e/plugins.hookExecution.slow.e2e.test.ts'));
});

test('the authoritative protocol wire compatibility inventory pins machine capabilities protocol parsing and callers', () => {
  const entry = PROTOCOL_WIRE_COMPATIBILITY_INVENTORY.find(
    (candidate) => candidate.id === 'machine-capabilities-protocol',
  );

  assert.ok(entry);
  assert.ok(entry.protocolModules.includes('packages/protocol/src/capabilities.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/capabilities/types.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/rpc/handlers/capabilities.ts'));
  assert.ok(entry.boundaryModules.includes('apps/ui/sources/sync/api/capabilities/capabilitiesProtocol.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/rpc/handlers/registerSessionHandlers.capabilities.integration.test.ts'));
  assert.ok(entry.proofTests.includes('apps/ui/sources/sync/api/capabilities/capabilitiesProtocol.test.ts'));
});

test('the authoritative protocol wire compatibility inventory pins canonical runtime descriptor carriers and compat boundaries', () => {
  const entry = PROTOCOL_WIRE_COMPATIBILITY_INVENTORY.find(
    (candidate) => candidate.id === 'runtime-descriptor-and-target-compat',
  );

  assert.ok(entry);
  assert.ok(!entry.protocolModules.includes('packages/protocol/src/sessionMetadata/agentRuntimeDescriptorV1.ts'));
  assert.ok(entry.protocolModules.includes('packages/protocol/src/sessionMetadata/runtimeDescriptorV1.ts'));
  assert.ok(entry.protocolModules.includes('packages/protocol/src/sessionMetadata/compat/runtimeDescriptorMetadata.ts'));
  assert.ok(entry.protocolModules.includes('packages/protocol/src/providers/codex/runtimeDescriptorCompat.ts'));
  assert.ok(entry.protocolModules.includes('packages/protocol/src/sessionControl/handoff/handoffSchemas.ts'));
  assert.ok(entry.protocolModules.includes('packages/protocol/src/directSessions/daemonRpcV1.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/rpc/handlers/registerSessionHandlers.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/rpc/handlers/spawnSessionOptionsContract.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/rpc/handlers/spawnRuntimeSelection.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/api/machine/rpcHandlers.sessions.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/daemon/processSupervision/sessionRunnerRespawnDescriptor.ts'));
  assert.ok(entry.boundaryModules.includes('apps/ui/sources/sync/ops/sessionHandoffs.ts'));
  assert.ok(entry.boundaryModules.includes('apps/ui/sources/sync/domains/state/storageTypes.ts'));
  assert.ok(entry.proofTests.includes('packages/protocol/src/sessionMetadata/runtimeDescriptorV1.test.ts'));
  assert.ok(entry.proofTests.includes('packages/protocol/src/sessionMetadata/compat/runtimeDescriptorMetadata.test.ts'));
  assert.ok(entry.proofTests.includes('packages/protocol/src/sessionControl/handoff/handoffSchemas.test.ts'));
  assert.ok(entry.proofTests.includes('packages/protocol/src/directSessions/daemonRpcV1.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/rpc/handlers/spawnRuntimeSelection.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/rpc/handlers/spawnSessionOptionsContract.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/daemon/processSupervision/sessionRunnerRespawnDescriptor.test.ts'));
  assert.ok(entry.proofTests.includes('apps/ui/sources/sync/ops/sessionHandoffs.test.ts'));
  assert.ok(entry.proofTests.includes('apps/ui/sources/sync/domains/state/storageTypes.terminal.test.ts'));
});
