import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ProtocolWireCompatibilityInventoryEntry {
  id: string;
  title: string;
  protocolModules: readonly string[];
  boundaryModules: readonly string[];
  proofTests: readonly string[];
}

export interface ProtocolWireCompatibilityInventoryValidationOptions {
  rootDir?: string;
  inventory?: readonly ProtocolWireCompatibilityInventoryEntry[];
  pathExists?: (absolutePath: string, relativePath: string) => boolean;
}

export interface ProtocolWireCompatibilityInventoryValidationResult {
  ok: boolean;
  errors: readonly string[];
  inventory: readonly ProtocolWireCompatibilityInventoryEntry[];
}

const PROTOCOL_ROOT = 'packages/protocol/src/';
const BOUNDARY_ROOTS = [
  'apps/server/sources/app/api/',
  'apps/ui/sources/sync/api/',
  'apps/ui/sources/sync/domains/state/',
  'apps/ui/sources/sync/ops/',
  'apps/ui/src-tauri/src/system_tasks/',
  'apps/cli/src/api/',
  'apps/cli/src/capabilities/',
  'apps/cli/src/daemon/',
  'apps/cli/src/rpc/',
  // Plugin manifests + hook event envelopes are parsed at this boundary (plugin<->host).
  'apps/cli/src/extensions/',
] as const;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

function isBoundaryModulePath(path: string): boolean {
  return BOUNDARY_ROOTS.some((root) => path.startsWith(root));
}

function defaultPathExists(absolutePath: string): boolean {
  return existsSync(absolutePath);
}

function validateModulePaths(
  entry: ProtocolWireCompatibilityInventoryEntry,
  rootDir: string,
  pathExists: (absolutePath: string, relativePath: string) => boolean,
): string[] {
  const errors: string[] = [];

  if (entry.protocolModules.length === 0) {
    errors.push(`Inventory entry "${entry.id}" must declare at least one protocol module.`);
  }
  if (entry.boundaryModules.length === 0) {
    errors.push(`Inventory entry "${entry.id}" must declare at least one boundary module.`);
  }
  if (entry.proofTests.length === 0) {
    errors.push(`Inventory entry "${entry.id}" must declare at least one proof test.`);
  }

  for (const protocolModule of entry.protocolModules) {
    if (!protocolModule.startsWith(PROTOCOL_ROOT)) {
      errors.push(`Inventory entry "${entry.id}" protocol module must stay under ${PROTOCOL_ROOT}: ${protocolModule}`);
      continue;
    }
    if (!pathExists(resolve(rootDir, protocolModule), protocolModule)) {
      errors.push(`Inventory entry "${entry.id}" references missing protocol module: ${protocolModule}`);
    }
  }

  for (const boundaryModule of entry.boundaryModules) {
    if (!isBoundaryModulePath(boundaryModule)) {
      errors.push(`Inventory entry "${entry.id}" boundary module must stay in explicit boundary modules: ${boundaryModule}`);
      continue;
    }
    if (!pathExists(resolve(rootDir, boundaryModule), boundaryModule)) {
      errors.push(`Inventory entry "${entry.id}" references missing boundary module: ${boundaryModule}`);
    }
  }

  for (const proofTest of entry.proofTests) {
    if (!TEST_FILE_PATTERN.test(proofTest)) {
      errors.push(`Inventory entry "${entry.id}" proof test must point to a test/spec file: ${proofTest}`);
      continue;
    }
    if (!pathExists(resolve(rootDir, proofTest), proofTest)) {
      errors.push(`Inventory entry "${entry.id}" references missing proof test: ${proofTest}`);
    }
  }

  return errors;
}

export const PROTOCOL_WIRE_COMPATIBILITY_INVENTORY: readonly ProtocolWireCompatibilityInventoryEntry[] = Object.freeze([
  {
    id: 'features-capabilities',
    title: 'Feature gates and server capability payload',
    protocolModules: [
      'packages/protocol/src/features/payload/featuresResponseSchema.ts',
      'packages/protocol/src/features/serverEnabledBit.ts',
    ],
    boundaryModules: [
      'apps/server/sources/app/api/routes/features/featuresRoutes.ts',
      'apps/ui/sources/sync/api/capabilities/serverFeaturesClient.ts',
    ],
    proofTests: [
      'packages/protocol/src/features.payload.test.ts',
      'apps/server/sources/app/features/serverFeatureRegistry.test.ts',
      'apps/server/sources/app/api/routes/features/featuresRoutes.integration.spec.ts',
      'apps/ui/sources/sync/api/capabilities/serverFeaturesClient.test.ts',
      'apps/ui/sources/sync/api/capabilities/serverFeaturesClient.guardrail.test.ts',
      'apps/ui/sources/sync/api/capabilities/serverFeaturesParse.spec.ts',
    ],
  },
  {
    id: 'changes-v2',
    title: 'Change-stream v2 wire contract',
    protocolModules: [
      'packages/protocol/src/changes.ts',
    ],
    boundaryModules: [
      'apps/server/sources/app/api/routes/changes/changesRoutes.ts',
      'apps/ui/sources/sync/api/session/apiChanges.ts',
    ],
    proofTests: [
      'apps/server/sources/app/api/routes/changes/changesRoutes.spec.ts',
      'apps/server/sources/app/api/routes/changes/changesRoutes.rateLimit.spec.ts',
      'apps/ui/sources/sync/api/session/apiChanges.spec.ts',
    ],
  },
  {
    id: 'socket-rpc-transport',
    title: 'Socket transport, handshake scoping, and RPC negotiation literals',
    protocolModules: [
      'packages/protocol/src/socketRpc.ts',
      'packages/protocol/src/rpc.ts',
      'packages/protocol/src/machineOwnership/daemonOwnership.ts',
    ],
    boundaryModules: [
      'apps/server/sources/app/api/socket.ts',
      'apps/server/sources/app/api/socketRooms.ts',
    ],
    proofTests: [
      'packages/protocol/src/socketRpc.test.ts',
      'packages/protocol/src/rpc.wireCompatibility.test.ts',
      'packages/protocol/src/machineOwnership/daemonOwnership.test.ts',
      'apps/server/sources/app/api/socket.handshakePolicy.spec.ts',
      'apps/server/sources/app/api/socket.handshakeCompatibility.integration.spec.ts',
      'apps/server/sources/app/api/socket.authPolicy.integration.spec.ts',
      'apps/server/sources/app/api/socketRooms.spec.ts',
    ],
  },
  {
    id: 'system-tasks',
    title: 'System task wire protocol',
    protocolModules: [
      'packages/protocol/src/systemTasks/spec.ts',
    ],
    boundaryModules: [
      'apps/ui/src-tauri/src/system_tasks/protocol.rs',
    ],
    proofTests: [
      'packages/protocol/src/systemTasks/spec.test.ts',
    ],
  },
  {
    id: 'execution-run-and-replay',
    title: 'Execution run start, daemon execution runs, and replay request envelopes',
    protocolModules: [
      'packages/protocol/src/executionRunStartRequest.ts',
      'packages/protocol/src/daemonExecutionRuns.ts',
      'packages/protocol/src/sessionContinueWithReplay.ts',
    ],
    boundaryModules: [
      'apps/cli/src/api/machine/rpcHandlers.ts',
      'apps/cli/src/api/types.ts',
    ],
    proofTests: [
      'packages/protocol/src/executionRuns.test.ts',
      'packages/protocol/src/daemonExecutionRuns.test.ts',
      'packages/protocol/src/sessionContinueWithReplay.test.ts',
      'apps/cli/src/api/machine/rpcHandlers.test.ts',
      'apps/cli/src/api/machine/rpcHandlers.directSessions.executionSurfaces.test.ts',
    ],
  },
  {
    id: 'daemon-contribution-registry-projection',
    title: 'Daemon merged contribution registry projection (UI/daemon)',
    protocolModules: [
      'packages/protocol/src/daemonContributionRegistryProjection.ts',
    ],
    boundaryModules: [
      'apps/cli/src/rpc/handlers/daemonContributionRegistryProjection.ts',
      'apps/ui/sources/sync/api/daemon/daemonContributionRegistryProjectionProtocol.ts',
    ],
    proofTests: [
      'packages/protocol/src/daemonContributionRegistryProjection.test.ts',
      'apps/cli/src/rpc/handlers/daemonContributionRegistryProjection.test.ts',
      'apps/ui/sources/sync/ops/machineContributionRegistryProjection.test.ts',
    ],
  },
  {
    id: 'runtime-descriptor-and-target-compat',
    title: 'Runtime descriptor and backend-target compatibility readers',
    protocolModules: [
      'packages/protocol/src/backendTargets/backendTargetRefV2.ts',
      'packages/protocol/src/sessionMetadata/runtimeDescriptorV1.ts',
      'packages/protocol/src/sessionMetadata/compat/runtimeDescriptorMetadata.ts',
      'packages/protocol/src/providers/codex/runtimeDescriptorCompat.ts',
      'packages/protocol/src/sessionControl/handoff/handoffSchemas.ts',
      'packages/protocol/src/directSessions/daemonRpcV1.ts',
    ],
    boundaryModules: [
      'apps/cli/src/api/directSessions/linking/ensureDirectSessionLink.ts',
      'apps/cli/src/api/machine/rpcHandlers.ts',
      'apps/cli/src/api/machine/rpcHandlers.sessions.ts',
      'apps/cli/src/rpc/handlers/registerSessionHandlers.ts',
      'apps/cli/src/rpc/handlers/spawnSessionOptionsContract.ts',
      'apps/cli/src/rpc/handlers/spawnRuntimeSelection.ts',
      'apps/cli/src/daemon/processSupervision/sessionRunnerRespawnDescriptor.ts',
      'apps/ui/sources/sync/domains/state/storageTypes.ts',
      'apps/ui/sources/sync/ops/sessionHandoffs.ts',
    ],
    proofTests: [
      'packages/protocol/src/backendTargets/backendTargetRefV2.test.ts',
      'packages/protocol/src/sessionMetadata/runtimeDescriptorV1.test.ts',
      'packages/protocol/src/sessionMetadata/compat/runtimeDescriptorMetadata.test.ts',
      'packages/protocol/src/sessionControl/handoff/handoffSchemas.test.ts',
      'packages/protocol/src/directSessions/daemonRpcV1.test.ts',
      'apps/cli/src/api/directSessions/linking/ensureDirectSessionLink.test.ts',
      'apps/cli/src/api/machine/rpcHandlers.test.ts',
      'apps/cli/src/rpc/handlers/spawnRuntimeSelection.test.ts',
      'apps/cli/src/rpc/handlers/spawnSessionOptionsContract.test.ts',
      'apps/cli/src/daemon/processSupervision/sessionRunnerRespawnDescriptor.test.ts',
      'apps/ui/sources/sync/domains/state/storageTypes.terminal.test.ts',
      'apps/ui/sources/sync/ops/sessionHandoffs.test.ts',
    ],
  },
  {
    id: 'machine-capabilities-protocol',
    title: 'Machine capabilities describe/detect/invoke wire protocol',
    protocolModules: [
      'packages/protocol/src/capabilities.ts',
    ],
    boundaryModules: [
      'apps/cli/src/capabilities/types.ts',
      'apps/cli/src/capabilities/service.ts',
      'apps/cli/src/rpc/handlers/capabilities.ts',
      'apps/ui/sources/sync/api/capabilities/capabilitiesProtocol.ts',
    ],
    proofTests: [
      'apps/cli/src/capabilities/service.test.ts',
      'apps/cli/src/rpc/handlers/registerSessionHandlers.capabilities.integration.test.ts',
      'apps/ui/sources/sync/api/capabilities/capabilitiesProtocol.test.ts',
    ],
  },
  {
    id: 'plugin-manifest-and-hook-envelopes-v1',
    title: 'PluginManifest + backend/provider definitions + hook event envelopes (plugin/host ABI)',
    protocolModules: [
      'packages/protocol/src/hooks/hookIds.ts',
      'packages/protocol/src/hooks/hookScopes.ts',
      'packages/protocol/src/hooks/hookCategories.ts',
      'packages/protocol/src/hooks/hookExecutionSemantics.ts',
      'packages/protocol/src/hooks/bridgeLifecycleHookCatalog.ts',
      'packages/protocol/src/hooks/daemonSpawnHookCatalog.ts',
      'packages/protocol/src/extensions/manifest/v2.ts',
      'packages/protocol/src/extensions/extensionSourceSpecV1.ts',
      'packages/protocol/src/extensions/providerDefinitionV1.ts',
      'packages/protocol/src/extensions/providerCliRuntimeV1.ts',
      'packages/protocol/src/extensions/backendDefinitionV1.ts',
      'packages/protocol/src/extensions/backendRuntimeAdapterV1.ts',
      'packages/protocol/src/extensions/hookRegistrationV1.ts',
      'packages/protocol/src/extensions/hookEventEnvelopeV1.ts',
    ],
    boundaryModules: [
      'apps/cli/src/extensions/manifest/read.ts',
      'apps/cli/src/extensions/registry/normalize/package.ts',
      'apps/cli/src/extensions/manifest/daemonEntry.ts',
      'apps/cli/src/extensions/hooks/execution/dispatchPluginHookEvent.ts',
      'apps/cli/src/extensions/hooks/execution/dispatchBridgeLifecycleHookEvent.ts',
      'apps/cli/src/extensions/hooks/execution/bridgeLifecycleHookEmissionInventory.ts',
      'apps/cli/src/extensions/runtime/loadPluginDaemonModule.ts',
      'apps/cli/src/extensions/runtime/resolvePluginHookHandlerRegistry.ts',
      'apps/cli/src/extensions/runtime/resolveExecutablePluginRuntimeRegistry.ts',
    ],
    proofTests: [
      'packages/protocol/src/extensions/contractsV1.test.ts',
      'packages/protocol/src/hooks/hookExecutionSemantics.test.ts',
      'packages/protocol/src/hooks/bridgeLifecycleHookCatalog.test.ts',
      'packages/protocol/src/hooks/daemonSpawnHookCatalog.test.ts',
      'apps/cli/src/extensions/manifest/read.test.ts',
      'apps/cli/src/extensions/registry/normalize/package.test.ts',
      'apps/cli/src/extensions/manifest/daemonEntry.test.ts',
      'apps/cli/src/extensions/hooks/execution/dispatchPluginHookEvent.integration.test.ts',
      'apps/cli/src/extensions/hooks/execution/dispatchBridgeLifecycleHookEvent.test.ts',
      'apps/cli/src/extensions/hooks/execution/bridgeLifecycleHookEmissionInventory.test.ts',
      'apps/cli/src/extensions/runtime/loadPluginDaemonModule.test.ts',
      'apps/cli/src/extensions/runtime/resolvePluginHookHandlerRegistry.test.ts',
      'apps/cli/src/extensions/runtime/resolveExecutablePluginRuntimeRegistry.test.ts',
      'apps/cli/src/extensions/runtime/resolveExecutablePluginRuntimeRegistry.integration.test.ts',
      'packages/tests/suites/core-e2e/bridge.lifecycleHookDispatch.slow.e2e.test.ts',
      'packages/tests/suites/core-e2e/plugins.hookExecution.slow.e2e.test.ts',
    ],
  },
]);

export function validateProtocolWireCompatibilityInventory(
  options: ProtocolWireCompatibilityInventoryValidationOptions = {},
): ProtocolWireCompatibilityInventoryValidationResult {
  const rootDir = options.rootDir ?? process.cwd();
  const inventory = options.inventory ?? PROTOCOL_WIRE_COMPATIBILITY_INVENTORY;
  const pathExists = options.pathExists ?? defaultPathExists;
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const entry of inventory) {
    if (!entry.id.trim()) {
      errors.push('Protocol wire inventory entries must have a non-empty id.');
      continue;
    }
    if (seenIds.has(entry.id)) {
      errors.push(`Protocol wire inventory ids must be unique: ${entry.id}`);
      continue;
    }
    seenIds.add(entry.id);
    errors.push(...validateModulePaths(entry, rootDir, pathExists));
  }

  return {
    ok: errors.length === 0,
    errors,
    inventory,
  };
}
