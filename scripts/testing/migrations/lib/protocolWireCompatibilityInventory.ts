import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ProtocolWireCompatibilityInventoryEntry {
  id: string;
  title: string;
  protocolModules: readonly string[];
  boundaryModules: readonly string[];
  proofTests: readonly string[];
}

export type AcceptedCompatClosureClassification =
  | 'PERMANENT_WIRE_EDGE'
  | 'PERMANENT_PERSISTED_EDGE'
  | 'DELETE_PROOF'
  | 'HARD_BREAK_DENY_LIST'
  | 'HANDOFF';

export type AcceptedCompatClosureSourceStatus = 'current' | 'stale' | 'not-path';

export interface AcceptedCompatClosureInventoryEntry {
  id: string;
  title: string;
  classification: AcceptedCompatClosureClassification;
  sourcePath?: string;
  sourceStatus?: AcceptedCompatClosureSourceStatus;
  boundary?: string;
  compatibilityInput?: string;
  canonicalOutput?: string;
  keptBecause?: string;
  proofTests?: readonly string[];
  absenceProofs?: readonly string[];
  handoffOwner?: string;
  denyListReason?: string;
}

export interface ProtocolWireCompatibilityInventoryValidationOptions {
  rootDir?: string;
  inventory?: readonly ProtocolWireCompatibilityInventoryEntry[];
  acceptedCompatClosures?: readonly AcceptedCompatClosureInventoryEntry[];
  pathExists?: (absolutePath: string, relativePath: string) => boolean;
}

export interface ProtocolWireCompatibilityInventoryValidationResult {
  ok: boolean;
  errors: readonly string[];
  inventory: readonly ProtocolWireCompatibilityInventoryEntry[];
}

export interface AcceptedCompatClosureInventoryValidationOptions {
  rootDir?: string;
  inventory?: readonly AcceptedCompatClosureInventoryEntry[];
  pathExists?: (absolutePath: string, relativePath: string) => boolean;
}

export interface AcceptedCompatClosureInventoryValidationResult {
  ok: boolean;
  errors: readonly string[];
  inventory: readonly AcceptedCompatClosureInventoryEntry[];
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
  'apps/cli/src/plugins/',
] as const;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const ACCEPTED_COMPAT_CLOSURE_CLASSIFICATION_SET: ReadonlySet<AcceptedCompatClosureClassification> = new Set([
  'PERMANENT_WIRE_EDGE',
  'PERMANENT_PERSISTED_EDGE',
  'DELETE_PROOF',
  'HARD_BREAK_DENY_LIST',
  'HANDOFF',
]);

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

function hasText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateAcceptedCompatClosurePath(
  entry: AcceptedCompatClosureInventoryEntry,
  rootDir: string,
  pathExists: (absolutePath: string, relativePath: string) => boolean,
): string[] {
  const errors: string[] = [];
  if (entry.sourceStatus === 'not-path') {
    return errors;
  }
  if (!hasText(entry.sourcePath)) {
    errors.push(`Accepted compat closure "${entry.id}" must declare sourcePath unless sourceStatus is not-path.`);
    return errors;
  }

  const sourcePath = entry.sourcePath;
  const exists = pathExists(resolve(rootDir, sourcePath), sourcePath);
  if (entry.sourceStatus === 'stale' && exists) {
    errors.push(`Accepted compat closure "${entry.id}" stale source path must remain absent: ${sourcePath}`);
  }
  if ((entry.sourceStatus ?? 'current') === 'current' && !exists) {
    errors.push(`Accepted compat closure "${entry.id}" references missing current source path: ${sourcePath}`);
  }
  return errors;
}

function validateAcceptedCompatClosureEntry(
  entry: AcceptedCompatClosureInventoryEntry,
  rootDir: string,
  pathExists: (absolutePath: string, relativePath: string) => boolean,
): string[] {
  const errors: string[] = [];
  errors.push(...validateAcceptedCompatClosurePath(entry, rootDir, pathExists));

  if (!ACCEPTED_COMPAT_CLOSURE_CLASSIFICATION_SET.has(entry.classification)) {
    errors.push(`Accepted compat closure "${entry.id}" has invalid classification: ${entry.classification}`);
  }

  if (entry.classification === 'PERMANENT_WIRE_EDGE' || entry.classification === 'PERMANENT_PERSISTED_EDGE') {
    if (!hasText(entry.boundary)) {
      errors.push(`Accepted compat closure "${entry.id}" permanent edge must declare boundary.`);
    }
    if (!hasText(entry.compatibilityInput)) {
      errors.push(`Accepted compat closure "${entry.id}" permanent edge must declare compatibilityInput.`);
    }
    if (!hasText(entry.canonicalOutput)) {
      errors.push(`Accepted compat closure "${entry.id}" permanent edge must declare canonicalOutput.`);
    }
    if (!hasText(entry.keptBecause)) {
      errors.push(`Accepted compat closure "${entry.id}" permanent edge must declare keptBecause.`);
    }
    if (!entry.proofTests || entry.proofTests.length === 0) {
      errors.push(`Accepted compat closure "${entry.id}" permanent edge must declare at least one proof test.`);
    }
  }

  if (entry.classification === 'DELETE_PROOF' && (!entry.absenceProofs || entry.absenceProofs.length === 0)) {
    errors.push(`Accepted compat closure "${entry.id}" delete proof must declare absenceProofs.`);
  }

  if (entry.classification === 'HANDOFF' && !hasText(entry.handoffOwner)) {
    errors.push(`Accepted compat closure "${entry.id}" handoff must declare handoffOwner.`);
  }

  if (entry.classification === 'HARD_BREAK_DENY_LIST' && !hasText(entry.denyListReason)) {
    errors.push(`Accepted compat closure "${entry.id}" hard-break deny-list entry must declare denyListReason.`);
  }

  for (const proofTest of entry.proofTests ?? []) {
    if (!TEST_FILE_PATTERN.test(proofTest)) {
      errors.push(`Accepted compat closure "${entry.id}" proof test must point to a test/spec file: ${proofTest}`);
      continue;
    }
    if (!pathExists(resolve(rootDir, proofTest), proofTest)) {
      errors.push(`Accepted compat closure "${entry.id}" references missing proof test: ${proofTest}`);
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
      'packages/protocol/src/changes/index.ts',
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
      'packages/protocol/src/rpc/socket.ts',
      'packages/protocol/src/rpc/index.ts',
      'packages/protocol/src/machines/ownership/daemonOwnership.ts',
    ],
    boundaryModules: [
      'apps/server/sources/app/api/socket.ts',
      'apps/server/sources/app/api/socketRooms.ts',
    ],
    proofTests: [
      'packages/protocol/src/rpc/socket.test.ts',
      'packages/protocol/src/rpc/wireCompatibility.test.ts',
      'packages/protocol/src/machines/ownership/daemonOwnership.test.ts',
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
      'packages/protocol/src/system/tasks/spec.ts',
    ],
    boundaryModules: [
      'apps/ui/src-tauri/src/system_tasks/protocol.rs',
    ],
    proofTests: [
      'packages/protocol/src/system/tasks/spec.test.ts',
    ],
  },
  {
    id: 'execution-run-and-replay',
    title: 'Execution run start, daemon execution runs, and replay request envelopes',
    protocolModules: [
      'packages/protocol/src/execution/runs/startRequest.ts',
      'packages/protocol/src/daemon/executionRuns.ts',
      'packages/protocol/src/sessions/continueWithReplay.ts',
    ],
    boundaryModules: [
      'apps/cli/src/api/machine/rpcHandlers.ts',
      'apps/cli/src/api/types.ts',
    ],
    proofTests: [
      'packages/protocol/src/execution/runs/index.test.ts',
      'packages/protocol/src/rpc/executionRuns.test.ts',
      'packages/protocol/src/daemon/executionRuns.test.ts',
      'packages/protocol/src/rpc/daemonExecutionRuns.test.ts',
      'packages/protocol/src/sessions/continueWithReplay.test.ts',
      'apps/cli/src/api/machine/rpcHandlers.test.ts',
      'apps/cli/src/api/machine/rpcHandlers.externalSessions.executionSurfaces.test.ts',
    ],
  },
  {
    id: 'daemon-contribution-registry-projection',
    title: 'Daemon merged contribution registry projection (UI/daemon)',
    protocolModules: [
      'packages/protocol/src/daemon/contributionRegistryProjection.ts',
    ],
    boundaryModules: [
      'apps/cli/src/rpc/handlers/daemonContributionRegistryProjection.ts',
      'apps/ui/sources/sync/api/daemon/daemonContributionRegistryProjectionProtocol.ts',
    ],
    proofTests: [
      'packages/protocol/src/daemon/contributionRegistryProjection.test.ts',
      'apps/cli/src/rpc/handlers/daemonContributionRegistryProjection.test.ts',
      'apps/ui/sources/sync/ops/machineContributionRegistryProjection.test.ts',
    ],
  },
  {
    id: 'runtime-descriptor-and-target-compat',
    title: 'Runtime descriptor and backend-target compatibility readers',
    protocolModules: [
      'packages/protocol/src/backends/targets/backendTargetRefV2.ts',
      'packages/protocol/src/sessions/metadata/runtimeDescriptorV1.ts',
      'packages/protocol/src/sessions/metadata/compat/runtimeDescriptorMetadata.ts',
      'packages/protocol/src/agents/generated/runtime/descriptors/codex.ts',
      'packages/protocol/src/sessions/control/handoff/handoffSchemas.ts',
      'packages/protocol/src/sessions/external/daemonRpcV1.ts',
    ],
    boundaryModules: [
      'apps/cli/src/api/session/external/linking/ensureExternalSessionLink.ts',
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
      'packages/protocol/src/backends/targets/backendTargetRefV2.test.ts',
      'packages/protocol/src/sessions/metadata/runtimeDescriptorV1.test.ts',
      'packages/protocol/src/sessions/metadata/compat/runtimeDescriptorMetadata.test.ts',
      'packages/protocol/src/sessions/control/handoff/handoffSchemas.test.ts',
      'packages/protocol/src/sessions/external/daemonRpcV1.test.ts',
      'apps/cli/src/api/session/external/linking/ensureExternalSessionLink.test.ts',
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
      'packages/protocol/src/capabilities/index.ts',
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
      'packages/protocol/src/plugins/manifest/v2.ts',
      'packages/protocol/src/plugins/sourceSpecV1.ts',
      'packages/protocol/src/plugins/agentDefinitionV1.ts',
      'packages/protocol/src/plugins/backendDefinitionV1.ts',
      'packages/protocol/src/plugins/backendSurfaceDeclarationV1.ts',
      'packages/protocol/src/plugins/hooks/catalog.ts',
      'packages/protocol/src/plugins/hooks/eventEnvelopeV1.ts',
    ],
    boundaryModules: [
      'apps/cli/src/plugins/manifest/read.ts',
      'apps/cli/src/plugins/projection/registry/normalize/package.ts',
      'apps/cli/src/plugins/manifest/daemonEntry.ts',
      'apps/cli/src/plugins/runtime/hooks/execution/dispatchPluginHookEvent.ts',
      'apps/cli/src/plugins/runtime/hooks/execution/dispatchBridgeLifecycleHookEvent.ts',
      'apps/cli/src/daemon/spawn/resolveSpawnChildEnvironment.ts',
      'apps/cli/src/plugins/runtime/resolveExecutablePluginRuntimeRegistry.ts',
    ],
    proofTests: [
      'packages/protocol/src/plugins/sourceSpecV1.test.ts',
      'packages/protocol/src/plugins/hooks/catalog.test.ts',
      'packages/protocol/src/plugins/hooks/compatibilityReaders.test.ts',
      'packages/protocol/src/plugins/manifest/v2.test.ts',
      'packages/protocol/src/hooks/hookExecutionSemantics.test.ts',
      'packages/protocol/src/hooks/bridgeLifecycleHookCatalog.test.ts',
      'packages/protocol/src/hooks/daemonSpawnHookCatalog.test.ts',
      'apps/cli/src/plugins/manifest/read.test.ts',
      'apps/cli/src/plugins/projection/registry/normalize/package.test.ts',
      'apps/cli/src/plugins/manifest/daemonEntry.test.ts',
      'apps/cli/src/plugins/runtime/hooks/execution/dispatchPluginHookEvent.integration.test.ts',
      'apps/cli/src/plugins/runtime/hooks/execution/dispatchBridgeLifecycleHookEvent.test.ts',
      'apps/cli/src/daemon/spawn/resolveSpawnChildEnvironment.pluginHooks.test.ts',
      'apps/cli/src/daemon/spawn/resolveSpawnChildEnvironment.providerOrdering.test.ts',
      'apps/cli/src/agent/runtime/bridges/session/SessionHostBridge.hooks.test.ts',
      'apps/cli/src/agent/runtime/bridges/executionRun/ExecutionRunHostBridge.registry.test.ts',
      'apps/cli/src/plugins/runtime/resolveExecutablePluginRuntimeRegistry.integration.test.ts',
      'packages/tests/suites/core-e2e/bridge.lifecycleHookDispatch.slow.e2e.test.ts',
      'packages/tests/suites/core-e2e/plugins.hookExecution.slow.e2e.test.ts',
    ],
  },
]);

export const ACCEPTED_COMPAT_CLOSURE_INVENTORY: readonly AcceptedCompatClosureInventoryEntry[] = Object.freeze([
  {
    id: 'F4-SR-01',
    title: 'Retired execution-run/session compat backend path',
    classification: 'DELETE_PROOF',
    sourcePath: 'apps/cli/src/agent/executionRuns/runtime/createSessionBackedExecutionRunBackend.ts',
    sourceStatus: 'stale',
    absenceProofs: ['test ! -e apps/cli/src/agent/executionRuns/runtime/createSessionBackedExecutionRunBackend.ts'],
  },
  {
    id: 'F4-SR-02',
    title: 'Retired v1 protocol runtime descriptor metadata path',
    classification: 'DELETE_PROOF',
    sourcePath: 'packages/protocol/src/sessionMetadata/compat/runtimeDescriptorMetadata.ts',
    sourceStatus: 'stale',
    absenceProofs: ['test ! -e packages/protocol/src/sessionMetadata/compat/runtimeDescriptorMetadata.ts'],
  },
  {
    id: 'F4-SR-03',
    title: 'Runtime descriptor metadata persisted carrier',
    classification: 'PERMANENT_PERSISTED_EDGE',
    sourcePath: 'packages/protocol/src/sessions/metadata/compat/runtimeDescriptorMetadata.ts',
    sourceStatus: 'current',
    boundary: 'Protocol session metadata persisted reader',
    compatibilityInput: 'legacy persisted agentRuntimeDescriptorV1 session metadata',
    canonicalOutput: 'runtimeDescriptorV1',
    keptBecause: 'Legacy persisted session metadata can be read after the runtime descriptor carrier rename; new writes use runtimeDescriptorV1 by default.',
    proofTests: ['packages/protocol/src/sessions/metadata/compat/runtimeDescriptorMetadata.test.ts'],
  },
  {
    id: 'F4-SR-04',
    title: 'Retired protocol Codex runtime descriptor compat residue',
    classification: 'DELETE_PROOF',
    sourcePath: 'packages/protocol/src/agents/codex/runtimeDescriptorCompat.ts',
    sourceStatus: 'stale',
    absenceProofs: ['test ! -e packages/protocol/src/agents/codex/runtimeDescriptorCompat.ts'],
  },
  {
    id: 'F4-SR-05',
    title: 'Retired agents Codex runtime descriptor compat residue',
    classification: 'DELETE_PROOF',
    sourcePath: 'packages/agents/src/providers/codex/runtimeDescriptorCompat.ts',
    sourceStatus: 'stale',
    absenceProofs: ['test ! -e packages/agents/src/providers/codex/runtimeDescriptorCompat.ts'],
  },
  {
    id: 'F4-SR-06',
    title: 'Spawn-session transport runtime descriptor ingress',
    classification: 'PERMANENT_WIRE_EDGE',
    sourcePath: 'apps/cli/src/rpc/handlers/spawnSessionOptionsContract.ts',
    sourceStatus: 'current',
    boundary: 'RPC ingress request parser',
    compatibilityInput: 'legacy agentRuntimeDescriptorV1, experimentalCodexAcp, and backend target carriers',
    canonicalOutput: 'runtimeDescriptorV1 plus canonical backendTarget/codexBackendMode',
    keptBecause: 'Mixed-version UI/daemon/CLI spawn requests must continue parsing legacy transport carriers at the edge while internal runtime paths consume canonical fields.',
    proofTests: ['apps/cli/src/rpc/handlers/spawnSessionOptionsContract.test.ts'],
  },
  {
    id: 'F4-SR-07',
    title: 'Shared spawn runtime selection ingress canonicalizer',
    classification: 'PERMANENT_WIRE_EDGE',
    sourcePath: 'apps/cli/src/rpc/handlers/spawnRuntimeSelection.ts',
    sourceStatus: 'current',
    boundary: 'RPC runtime-selection ingress canonicalizer',
    compatibilityInput: 'legacy Codex backend mode aliases and agentRuntimeDescriptorV1 carriers',
    canonicalOutput: 'runtimeDescriptorV1 and canonical codexBackendMode',
    keptBecause: 'Spawn ingress callers share this edge canonicalizer so legacy transport fields do not leak into provider/runtime core.',
    proofTests: ['apps/cli/src/rpc/handlers/spawnRuntimeSelection.test.ts'],
  },
  {
    id: 'F4-SR-08',
    title: 'Machine RPC session spawn boundary',
    classification: 'PERMANENT_WIRE_EDGE',
    sourcePath: 'apps/cli/src/api/machine/rpcHandlers.sessions.ts',
    sourceStatus: 'current',
    boundary: 'Machine RPC session handler boundary',
    compatibilityInput: 'raw legacy spawn fields from machine RPC clients',
    canonicalOutput: 'canonical spawn session options',
    keptBecause: 'Machine RPC is a cross-component boundary and may receive older spawn payloads before forwarding canonical runtime selection.',
    proofTests: ['apps/cli/src/api/machine/rpcHandlers.test.ts'],
  },
  {
    id: 'F4-SR-09',
    title: 'Session runner respawn descriptor persisted ingress',
    classification: 'PERMANENT_PERSISTED_EDGE',
    sourcePath: 'apps/cli/src/daemon/processSupervision/sessionRunnerRespawnDescriptor.ts',
    sourceStatus: 'current',
    boundary: 'Persisted daemon respawn descriptor reader',
    compatibilityInput: 'legacy persisted agentRuntimeDescriptorV1 and experimentalCodex* carriers',
    canonicalOutput: 'runtimeDescriptorV1 and canonical codexBackendMode',
    keptBecause: 'Existing persisted respawn descriptors must load after runtime descriptor and Codex backend-mode carrier renames.',
    proofTests: ['apps/cli/src/daemon/processSupervision/sessionRunnerRespawnDescriptor.test.ts'],
  },
  {
    id: 'F4-SR-10',
    title: 'UI local storage runtime descriptor reader',
    classification: 'PERMANENT_PERSISTED_EDGE',
    sourcePath: 'apps/ui/sources/sync/domains/state/storageTypes.ts',
    sourceStatus: 'current',
    boundary: 'UI persisted state/session metadata reader',
    compatibilityInput: 'legacy local-storage agentRuntimeDescriptorV1 session metadata',
    canonicalOutput: 'runtimeDescriptorV1',
    keptBecause: 'UI persisted session state must keep rendering valid cached sessions while canonicalizing older runtime descriptor metadata.',
    proofTests: ['apps/ui/sources/sync/domains/state/storageTypes.terminal.test.ts'],
  },
  {
    id: 'F4-SR-11',
    title: 'Connected-service protocol records',
    classification: 'HANDOFF',
    sourcePath: 'packages/protocol/src/connect/connectedServiceSchemas.ts',
    sourceStatus: 'current',
    handoffOwner: 'SCM-AUTH-1 descriptorization packet',
  },
  {
    id: 'F4-SR-12',
    title: 'UI connected-service registry vocabulary',
    classification: 'HANDOFF',
    sourcePath: 'apps/ui/sources/sync/domains/connectedServices/connectedServiceRegistry.ts',
    sourceStatus: 'current',
    handoffOwner: 'SCM-AUTH-1 descriptorization packet',
  },
  {
    id: 'F4-SR-13',
    title: 'Protocol wire compatibility inventory proof surface',
    classification: 'HANDOFF',
    sourcePath: 'scripts/testing/migrations/lib/protocolWireCompatibilityInventory.ts',
    sourceStatus: 'current',
    handoffOwner: 'F.4 accepted-compat closure inventory in this module',
  },
  {
    id: 'F4-SR-14',
    title: 'Configured ACP customAcp compat residue',
    classification: 'HANDOFF',
    sourcePath: 'apps/cli/src/agent/acp/catalog/compat/customAcp.ts',
    sourceStatus: 'current',
    handoffOwner: 'A.4/A.15.2 ACP runtimeCore cleanup packets',
  },
  {
    id: 'F4-DP-01',
    title: 'Broad protocol compat package absence',
    classification: 'DELETE_PROOF',
    sourcePath: 'packages/protocol/src/compat',
    sourceStatus: 'stale',
    absenceProofs: ['test ! -d packages/protocol/src/compat'],
  },
  {
    id: 'F4-DP-02',
    title: 'Broad protocol wireCompat package absence',
    classification: 'DELETE_PROOF',
    sourcePath: 'packages/protocol/src/wireCompat',
    sourceStatus: 'stale',
    absenceProofs: ['test ! -d packages/protocol/src/wireCompat'],
  },
  {
    id: 'F4-HB-01',
    title: 'Plugin manifest connectedServices hard-break key',
    classification: 'HARD_BREAK_DENY_LIST',
    sourceStatus: 'not-path',
    denyListReason: 'FD-0056 rejects plugin-authoring compatibility windows for unshipped plugin manifest keys; auth/service descriptorization belongs to SCM-AUTH-1.',
  },
  {
    id: 'F4-HB-02',
    title: 'Dotted auth.services manifest alias hard-break key',
    classification: 'HARD_BREAK_DENY_LIST',
    sourceStatus: 'not-path',
    denyListReason: 'L-14/L-22 and FD-0053 require descriptorized auth/services shape without a plugin manifest alias window in F.4.',
  },
  {
    id: 'F4-HB-03',
    title: 'Top-level plugin permissions hard-break key',
    classification: 'HARD_BREAK_DENY_LIST',
    sourceStatus: 'not-path',
    denyListReason: 'FD-0056 moves plugin permissions under manifest capabilities without preserving the unshipped top-level manifest key as compatibility.',
  },
  {
    id: 'F4-HB-04',
    title: 'Legacy plugin store path hard-break key',
    classification: 'HARD_BREAK_DENY_LIST',
    sourceStatus: 'not-path',
    denyListReason: 'FD-0056 says <HAPPIER_HOME>/plugins/plugins has no V1 persistence compatibility window because plugin-platform data has not shipped externally.',
  },
]);

export function validateAcceptedCompatClosureInventory(
  options: AcceptedCompatClosureInventoryValidationOptions = {},
): AcceptedCompatClosureInventoryValidationResult {
  const rootDir = options.rootDir ?? process.cwd();
  const inventory = options.inventory ?? ACCEPTED_COMPAT_CLOSURE_INVENTORY;
  const pathExists = options.pathExists ?? defaultPathExists;
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const entry of inventory) {
    if (!entry.id.trim()) {
      errors.push('Accepted compat closure entries must have a non-empty id.');
      continue;
    }
    if (seenIds.has(entry.id)) {
      errors.push(`Accepted compat closure ids must be unique: ${entry.id}`);
      continue;
    }
    seenIds.add(entry.id);
    errors.push(...validateAcceptedCompatClosureEntry(entry, rootDir, pathExists));
  }

  return {
    ok: errors.length === 0,
    errors,
    inventory,
  };
}

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

  const acceptedCompatClosures = options.acceptedCompatClosures
    ?? (options.inventory === undefined ? ACCEPTED_COMPAT_CLOSURE_INVENTORY : []);
  errors.push(...validateAcceptedCompatClosureInventory({
    rootDir,
    inventory: acceptedCompatClosures,
    pathExists,
  }).errors);

  return {
    ok: errors.length === 0,
    errors,
    inventory,
  };
}
