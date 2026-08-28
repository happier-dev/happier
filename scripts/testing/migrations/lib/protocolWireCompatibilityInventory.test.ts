import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCEPTED_COMPAT_CLOSURE_INVENTORY,
  PROTOCOL_WIRE_COMPATIBILITY_INVENTORY,
  validateAcceptedCompatClosureInventory,
  validateProtocolWireCompatibilityInventory,
  type AcceptedCompatClosureInventoryEntry,
  type AcceptedCompatClosureInventoryValidationResult,
} from './protocolWireCompatibilityInventory.ts';

function readAcceptedCompatClosureInventory(): readonly AcceptedCompatClosureInventoryEntry[] {
  return ACCEPTED_COMPAT_CLOSURE_INVENTORY;
}

function validateAcceptedCompatClosureInventoryForTest(params: Readonly<{
  rootDir: string;
  inventory: readonly AcceptedCompatClosureInventoryEntry[];
  pathExists: (absolutePath: string, relativePath: string) => boolean;
}>): AcceptedCompatClosureInventoryValidationResult {
  return validateAcceptedCompatClosureInventory(params);
}

test('validateProtocolWireCompatibilityInventory rejects non-boundary translation modules', () => {
  const result = validateProtocolWireCompatibilityInventory({
    rootDir: '/repo',
    inventory: [
      {
        id: 'socket-rpc',
        title: 'Socket RPC',
        protocolModules: ['packages/protocol/src/rpc/socket.ts'],
        boundaryModules: ['apps/cli/src/agent/runtime/createExecutionRunBackend.ts'],
        proofTests: ['packages/protocol/src/rpc/socket.test.ts'],
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
        protocolModules: ['packages/protocol/src/changes/index.ts'],
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
        protocolModules: ['packages/protocol/src/plugins/manifest/v2.ts'],
        boundaryModules: ['apps/cli/src/plugins/manifest/read.ts'],
        proofTests: ['packages/protocol/src/plugins/manifest/v2.test.ts'],
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
  assert.ok(entry.protocolModules.includes('packages/protocol/src/plugins/sourceSpecV1.ts'));
  assert.ok(entry.protocolModules.includes('packages/protocol/src/plugins/agentDefinitionV1.ts'));
  assert.ok(entry.protocolModules.includes('packages/protocol/src/plugins/backendSurfaceDeclarationV1.ts'));
  assert.ok(entry.protocolModules.includes('packages/protocol/src/plugins/hooks/catalog.ts'));
  assert.ok(entry.protocolModules.includes('packages/protocol/src/plugins/hooks/eventEnvelopeV1.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/plugins/manifest/read.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/plugins/projection/registry/normalize/package.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/plugins/manifest/daemonEntry.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/plugins/runtime/hooks/execution/dispatchPluginHookEvent.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/daemon/spawn/resolveSpawnChildEnvironment.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/plugins/runtime/resolveExecutablePluginRuntimeRegistry.ts'));
  assert.ok(entry.proofTests.includes('packages/protocol/src/plugins/sourceSpecV1.test.ts'));
  assert.ok(entry.proofTests.includes('packages/protocol/src/plugins/hooks/catalog.test.ts'));
  assert.ok(entry.proofTests.includes('packages/protocol/src/plugins/hooks/compatibilityReaders.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/plugins/manifest/read.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/plugins/projection/registry/normalize/package.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/plugins/manifest/daemonEntry.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/plugins/runtime/hooks/execution/dispatchPluginHookEvent.integration.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/plugins/runtime/hooks/execution/dispatchBridgeLifecycleHookEvent.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/daemon/spawn/resolveSpawnChildEnvironment.pluginHooks.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/agent/runtime/bridges/session/SessionHostBridge.hooks.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/agent/runtime/bridges/executionRun/ExecutionRunHostBridge.registry.test.ts'));
  assert.ok(entry.proofTests.includes('packages/tests/suites/core-e2e/bridge.lifecycleHookDispatch.slow.e2e.test.ts'));
  assert.ok(entry.proofTests.includes('packages/tests/suites/core-e2e/plugins.hookExecution.slow.e2e.test.ts'));
});

test('the authoritative protocol wire compatibility inventory pins relocated protocol owners', () => {
  const byId = new Map(PROTOCOL_WIRE_COMPATIBILITY_INVENTORY.map((entry) => [entry.id, entry] as const));

  assert.ok(byId.get('changes-v2')?.protocolModules.includes('packages/protocol/src/changes/index.ts'));

  const socketRpc = byId.get('socket-rpc-transport');
  assert.ok(socketRpc?.protocolModules.includes('packages/protocol/src/rpc/socket.ts'));
  assert.ok(socketRpc?.protocolModules.includes('packages/protocol/src/rpc/index.ts'));
  assert.ok(socketRpc?.protocolModules.includes('packages/protocol/src/machines/ownership/daemonOwnership.ts'));
  assert.ok(socketRpc?.proofTests.includes('packages/protocol/src/rpc/socket.test.ts'));
  assert.ok(socketRpc?.proofTests.includes('packages/protocol/src/rpc/wireCompatibility.test.ts'));
  assert.ok(socketRpc?.proofTests.includes('packages/protocol/src/machines/ownership/daemonOwnership.test.ts'));

  const systemTasks = byId.get('system-tasks');
  assert.ok(systemTasks?.protocolModules.includes('packages/protocol/src/system/tasks/spec.ts'));
  assert.ok(systemTasks?.proofTests.includes('packages/protocol/src/system/tasks/spec.test.ts'));

  const executionRun = byId.get('execution-run-and-replay');
  assert.ok(executionRun?.protocolModules.includes('packages/protocol/src/execution/runs/startRequest.ts'));
  assert.ok(executionRun?.protocolModules.includes('packages/protocol/src/daemon/executionRuns.ts'));
  assert.ok(executionRun?.protocolModules.includes('packages/protocol/src/sessions/continueWithReplay.ts'));
  assert.ok(executionRun?.proofTests.includes('packages/protocol/src/execution/runs/index.test.ts'));
  assert.ok(executionRun?.proofTests.includes('packages/protocol/src/rpc/executionRuns.test.ts'));
  assert.ok(executionRun?.proofTests.includes('packages/protocol/src/daemon/executionRuns.test.ts'));
  assert.ok(executionRun?.proofTests.includes('packages/protocol/src/sessions/continueWithReplay.test.ts'));

  const daemonProjection = byId.get('daemon-contribution-registry-projection');
  assert.ok(daemonProjection?.protocolModules.includes('packages/protocol/src/daemon/contributionRegistryProjection.ts'));
  assert.ok(daemonProjection?.proofTests.includes('packages/protocol/src/daemon/contributionRegistryProjection.test.ts'));

  assert.ok(byId.get('machine-capabilities-protocol')?.protocolModules.includes('packages/protocol/src/capabilities/index.ts'));
});

test('the authoritative protocol wire compatibility inventory pins machine capabilities protocol parsing and callers', () => {
  const entry = PROTOCOL_WIRE_COMPATIBILITY_INVENTORY.find(
    (candidate) => candidate.id === 'machine-capabilities-protocol',
  );

  assert.ok(entry);
  assert.ok(entry.protocolModules.includes('packages/protocol/src/capabilities/index.ts'));
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
  assert.ok(entry.protocolModules.includes('packages/protocol/src/sessions/metadata/runtimeDescriptorV1.ts'));
  assert.ok(entry.protocolModules.includes('packages/protocol/src/sessions/metadata/compat/runtimeDescriptorMetadata.ts'));
  assert.ok(entry.protocolModules.includes('packages/protocol/src/sessions/metadata/metadataOverridesV1.ts'));
  assert.ok(!entry.protocolModules.some((modulePath) => modulePath.includes('/agents/generated/runtime/descriptors/')));
  assert.ok(!entry.protocolModules.includes('packages/protocol/src/agents/codex/runtimeDescriptorCompat.ts'));
  assert.ok(entry.protocolModules.includes('packages/protocol/src/sessions/control/handoff/handoffSchemas.ts'));
  assert.ok(entry.protocolModules.includes('packages/protocol/src/sessions/external/daemonRpcV1.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/rpc/handlers/registerSessionHandlers.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/rpc/handlers/spawnSessionOptionsContract.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/rpc/handlers/spawnRuntimeSelection.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/api/machine/rpcHandlers.sessions.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/api/session/external/linking/ensureExternalSessionLink.ts'));
  assert.ok(entry.boundaryModules.includes('apps/cli/src/daemon/processSupervision/sessionRunnerRespawnDescriptor.ts'));
  assert.ok(entry.boundaryModules.includes('apps/ui/sources/sync/ops/sessionHandoffs.ts'));
  assert.ok(entry.boundaryModules.includes('apps/ui/sources/sync/domains/state/storageTypes.ts'));
  assert.ok(entry.proofTests.includes('packages/protocol/src/sessions/metadata/runtimeDescriptorV1.test.ts'));
  assert.ok(entry.proofTests.includes('packages/protocol/src/sessions/metadata/compat/runtimeDescriptorMetadata.test.ts'));
  assert.ok(entry.proofTests.includes('packages/protocol/src/sessions/control/handoff/handoffSchemas.test.ts'));
  assert.ok(entry.proofTests.includes('packages/protocol/src/sessions/external/daemonRpcV1.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/api/session/external/linking/ensureExternalSessionLink.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/rpc/handlers/spawnRuntimeSelection.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/rpc/handlers/spawnSessionOptionsContract.test.ts'));
  assert.ok(entry.proofTests.includes('apps/cli/src/daemon/processSupervision/sessionRunnerRespawnDescriptor.test.ts'));
  assert.ok(entry.proofTests.includes('apps/ui/sources/sync/ops/sessionHandoffs.test.ts'));
  assert.ok(entry.proofTests.includes('apps/ui/sources/sync/domains/state/storageTypes.terminal.test.ts'));
});

test('the accepted compat closure inventory pins every F4 source-reality row to a terminal state', () => {
  const entries = readAcceptedCompatClosureInventory();
  const byId = new Map(entries.map((entry) => [entry.id, entry] as const));

  assert.deepEqual(
    Array.from(byId.keys()).filter((id) => id.startsWith('F4-SR-')).sort(),
    [
      'F4-SR-01',
      'F4-SR-02',
      'F4-SR-03',
      'F4-SR-04',
      'F4-SR-05',
      'F4-SR-06',
      'F4-SR-07',
      'F4-SR-08',
      'F4-SR-09',
      'F4-SR-10',
      'F4-SR-11',
      'F4-SR-12',
      'F4-SR-13',
      'F4-SR-14',
    ],
  );

  for (const entry of entries.filter((candidate) => candidate.id.startsWith('F4-SR-'))) {
    assert.ok(
      ['PERMANENT_WIRE_EDGE', 'PERMANENT_PERSISTED_EDGE', 'DELETE_PROOF', 'HANDOFF'].includes(entry.classification),
      `${entry.id} has terminal classification ${entry.classification}`,
    );
  }
});

test('the accepted compat closure inventory records kept edge proofs', () => {
  const byId = new Map(readAcceptedCompatClosureInventory().map((entry) => [entry.id, entry] as const));

  const persistedMetadata = byId.get('F4-SR-03');
  assert.equal(persistedMetadata?.classification, 'PERMANENT_PERSISTED_EDGE');
  assert.match(persistedMetadata?.keptBecause ?? '', /legacy persisted/i);
  assert.match(persistedMetadata?.compatibilityInput ?? '', /agentRuntimeDescriptorV1/);
  assert.equal(persistedMetadata?.canonicalOutput, 'runtimeDescriptorV1');
  assert.equal(persistedMetadata?.sourcePath, 'packages/protocol/src/sessions/metadata/compat/runtimeDescriptorMetadata.ts');
  assert.ok(persistedMetadata?.proofTests?.includes('packages/protocol/src/sessions/metadata/compat/runtimeDescriptorMetadata.test.ts'));

  const rpcIngress = byId.get('F4-SR-06');
  assert.equal(rpcIngress?.classification, 'PERMANENT_WIRE_EDGE');
  assert.match(rpcIngress?.boundary ?? '', /RPC ingress/i);
  assert.ok(rpcIngress?.proofTests?.includes('apps/cli/src/rpc/handlers/spawnSessionOptionsContract.test.ts'));

  const connectedServices = byId.get('F4-SR-11');
  assert.equal(connectedServices?.classification, 'HANDOFF');
  assert.match(connectedServices?.handoffOwner ?? '', /SCM-AUTH-1/);
});

test('the accepted compat closure inventory pins broad compat package delete proofs', () => {
  const byId = new Map(readAcceptedCompatClosureInventory().map((entry) => [entry.id, entry] as const));

  for (const [id, sourcePath] of [
    ['F4-DP-01', 'packages/protocol/src/compat'],
    ['F4-DP-02', 'packages/protocol/src/wireCompat'],
  ] as const) {
    const entry = byId.get(id);
    assert.equal(entry?.classification, 'DELETE_PROOF');
    assert.equal(entry?.sourceStatus, 'stale');
    assert.equal(entry?.sourcePath, sourcePath);
    assert.ok(entry?.absenceProofs?.some((proof) => proof.includes(sourcePath)));
  }
});

test('the accepted compat closure inventory pins plugin/auth hard-break deny-list rows', () => {
  const byId = new Map(readAcceptedCompatClosureInventory().map((entry) => [entry.id, entry] as const));

  for (const id of ['F4-HB-01', 'F4-HB-02', 'F4-HB-03', 'F4-HB-04']) {
    const entry = byId.get(id);
    assert.equal(entry?.classification, 'HARD_BREAK_DENY_LIST');
    assert.equal(entry?.sourceStatus, 'not-path');
    assert.ok((entry?.denyListReason ?? '').trim().length > 0);
  }
});

test('validateAcceptedCompatClosureInventory rejects incomplete permanent edges', () => {
  const result = validateAcceptedCompatClosureInventoryForTest({
    rootDir: '/repo',
    inventory: [
      {
        id: 'F4-SR-X',
        classification: 'PERMANENT_WIRE_EDGE',
        sourcePath: 'apps/cli/src/rpc/handlers/spawnSessionOptionsContract.ts',
        sourceStatus: 'current',
        boundary: 'RPC ingress',
        compatibilityInput: 'legacy input',
        canonicalOutput: 'canonical output',
        keptBecause: 'legacy client compatibility',
        proofTests: [],
      },
    ],
    pathExists: () => true,
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /proof test/i);
});

for (const stalePath of ['packages/protocol/src/compat', 'packages/protocol/src/wireCompat']) {
  test(`validateProtocolWireCompatibilityInventory rejects broad compat package reintroduction at ${stalePath}`, () => {
    const result = validateProtocolWireCompatibilityInventory({
      rootDir: '/repo',
      acceptedCompatClosures: readAcceptedCompatClosureInventory(),
      pathExists: (_absolutePath, relativePath) => {
        if (relativePath === stalePath) {
          return true;
        }
        if (relativePath === 'packages/protocol/src/compat' || relativePath === 'packages/protocol/src/wireCompat') {
          return false;
        }
        return true;
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /must remain absent/i);
    assert.match(result.errors.join('\n'), new RegExp(stalePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}
