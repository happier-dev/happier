import type { AgentId } from '@/agent/core';
import { DirectSessionsProviderIdSchema } from '@happier-dev/protocol';
import type { DirectSessionsProviderId } from '@happier-dev/protocol';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';
import { getBuiltInCatalogEntries } from '@/extensions/registry/createResolvedContributionRegistry';
import { resolveExecutablePluginRuntimeRegistry } from '@/extensions/runtime/resolveExecutablePluginRuntimeRegistry';
import { loadPluginDaemonModule } from '@/extensions/runtime/loadPluginDaemonModule';
import type { PluginDaemonModuleNamespace, PluginHookHandler } from '@/extensions/runtime/types';
import { DEFAULT_CATALOG_AGENT_ID } from './types';
import type {
  AcpForkContinuationHandler,
  AgentCatalogEntry,
  CatalogAgentId,
  ConnectedServicesSpawnMaterializer,
  DirectSessionProviderOps,
  ProviderAttachOps,
  ProviderNativeForkHandler,
  SessionHandoffProviderOps,
  AnyTerminalRuntimeOps,
  VendorResumeSupportFn,
} from './types';

export type { AgentCatalogEntry, AgentChecklistContributions, CatalogAgentId, CliDetectSpec } from './types';

export const AGENTS: Record<CatalogAgentId, AgentCatalogEntry> = getBuiltInCatalogEntries();

function isCatalogAgentId(value: string): value is CatalogAgentId {
  return Object.prototype.hasOwnProperty.call(AGENTS, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function requireCatalogEntry(agentId: CatalogAgentId): AgentCatalogEntry {
  const entry = AGENTS[agentId];
  if (!entry) throw new Error(`Missing catalog agent entry for ${agentId}`);
  return entry;
}

const cachedVendorResumeSupportPromises = new Map<CatalogAgentId, Promise<VendorResumeSupportFn>>();
const cachedDirectSessionProviderOpsPromises = new Map<DirectSessionsProviderId, Promise<DirectSessionProviderOps>>();
const cachedConnectedServicesSpawnMaterializerPromises = new Map<CatalogAgentId, Promise<ConnectedServicesSpawnMaterializer | null>>();
const cachedProviderAttachOpsPromises = new Map<CatalogAgentId, Promise<ProviderAttachOps | null>>();
const cachedTerminalRuntimeOpsPromises = new Map<CatalogAgentId, Promise<AnyTerminalRuntimeOps | null>>();
const cachedAcpForkContinuationHandlerPromises = new Map<CatalogAgentId, Promise<AcpForkContinuationHandler | null>>();
const cachedProviderNativeForkHandlerPromises = new Map<CatalogAgentId, Promise<ProviderNativeForkHandler | null>>();
const cachedSessionHandoffProviderOpsPromises = new Map<CatalogAgentId, Promise<SessionHandoffProviderOps | null>>();
const cachedBackendExecutionSurfacesPromises = new Map<string, Promise<BackendExecutionSurfaces>>();

export async function getVendorResumeSupport(agentId?: AgentId | null): Promise<VendorResumeSupportFn> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedVendorResumeSupportPromises.get(catalogId);
  if (existing) return await existing;

  const entry = requireCatalogEntry(catalogId);
  const promise = (async () => {
    if (entry.vendorResumeSupport === 'supported') {
      return () => true;
    }
    if (entry.vendorResumeSupport === 'unsupported') {
      return () => false;
    }
    if (entry.getVendorResumeSupport) {
      return await entry.getVendorResumeSupport();
    }
    return () => false;
  })();

  cachedVendorResumeSupportPromises.set(catalogId, promise);
  return await promise;
}

export async function getDirectSessionProviderOps(providerId: DirectSessionsProviderId): Promise<DirectSessionProviderOps> {
  const existing = cachedDirectSessionProviderOpsPromises.get(providerId);
  if (existing) return await existing;

  const entry = AGENTS[providerId];
  if (!entry?.getDirectSessionProviderOps) {
    throw new Error(`Missing direct-session provider ops for ${providerId}`);
  }

  const promise = entry.getDirectSessionProviderOps();
  cachedDirectSessionProviderOpsPromises.set(providerId, promise);
  return await promise;
}

export async function getConnectedServicesSpawnMaterializer(agentId: CatalogAgentId): Promise<ConnectedServicesSpawnMaterializer | null> {
  const existing = cachedConnectedServicesSpawnMaterializerPromises.get(agentId);
  if (existing) return await existing;

  const entry = AGENTS[agentId];
  const promise = entry?.getConnectedServicesSpawnMaterializer
    ? entry.getConnectedServicesSpawnMaterializer()
    : Promise.resolve(null);
  cachedConnectedServicesSpawnMaterializerPromises.set(agentId, promise);
  return await promise;
}

export async function getProviderAttachOps(agentId?: AgentId | null): Promise<ProviderAttachOps | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedProviderAttachOpsPromises.get(catalogId);
  if (existing) return await existing;

  const entry = AGENTS[catalogId];
  const promise = entry?.getProviderAttachOps ? entry.getProviderAttachOps() : Promise.resolve(null);
  cachedProviderAttachOpsPromises.set(catalogId, promise);
  return await promise;
}

export async function getTerminalRuntimeOps(agentId?: AgentId | null): Promise<AnyTerminalRuntimeOps | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedTerminalRuntimeOpsPromises.get(catalogId);
  if (existing) return await existing;

  const entry = AGENTS[catalogId];
  const promise = entry?.getTerminalRuntimeOps ? entry.getTerminalRuntimeOps() : Promise.resolve(null);
  cachedTerminalRuntimeOpsPromises.set(catalogId, promise);
  return await promise;
}

export async function getAcpForkContinuationHandler(agentId: CatalogAgentId): Promise<AcpForkContinuationHandler | null> {
  const existing = cachedAcpForkContinuationHandlerPromises.get(agentId);
  if (existing) return await existing;

  const entry = AGENTS[agentId];
  const promise = entry?.getAcpForkContinuationHandler ? entry.getAcpForkContinuationHandler() : Promise.resolve(null);
  cachedAcpForkContinuationHandlerPromises.set(agentId, promise);
  return await promise;
}

export async function getProviderNativeForkHandler(agentId: CatalogAgentId): Promise<ProviderNativeForkHandler | null> {
  const existing = cachedProviderNativeForkHandlerPromises.get(agentId);
  if (existing) return await existing;

  const entry = AGENTS[agentId];
  const promise = entry?.getProviderNativeForkHandler ? entry.getProviderNativeForkHandler() : Promise.resolve(null);
  cachedProviderNativeForkHandlerPromises.set(agentId, promise);
  return await promise;
}

export async function getSessionHandoffProviderOps(agentId?: AgentId | null): Promise<SessionHandoffProviderOps | null> {
  const catalogId = resolveCatalogAgentId(agentId);
  const existing = cachedSessionHandoffProviderOpsPromises.get(catalogId);
  if (existing) return await existing;

  const entry = AGENTS[catalogId];
  const promise = entry?.getSessionHandoffProviderOps
    ? entry.getSessionHandoffProviderOps()
    : Promise.resolve(null);
  cachedSessionHandoffProviderOpsPromises.set(catalogId, promise);
  return await promise;
}

export type BackendExecutionSurfaces = Readonly<{
  terminalRuntime: AnyTerminalRuntimeOps | null;
  directSessions: DirectSessionProviderOps | null;
  attach: ProviderAttachOps | null;
  sessionHandoff: SessionHandoffProviderOps | null;
}>;

function createEmptyBackendExecutionSurfaces(): BackendExecutionSurfaces {
  return {
    terminalRuntime: null,
    directSessions: null,
    attach: null,
    sessionHandoff: null,
  };
}

export async function resolveBackendExecutionSurfaces(
  backendId?: string | null,
  params?: Readonly<{ happyHomeDir?: string }>,
): Promise<BackendExecutionSurfaces> {
  const cacheKey = `${backendId ?? 'default'}::${params?.happyHomeDir ?? ''}`;
  const existing = cachedBackendExecutionSurfacesPromises.get(cacheKey);
  if (existing) return await existing;

  const promise = (async () => {
    if (!backendId) {
      return createEmptyBackendExecutionSurfaces();
    }

    if (isCatalogAgentId(backendId)) {
      const directSessionProvider = DirectSessionsProviderIdSchema.safeParse(backendId).success
        ? (backendId as DirectSessionsProviderId)
        : null;
      return {
        terminalRuntime: await getTerminalRuntimeOps(backendId),
        directSessions: directSessionProvider ? await getDirectSessionProviderOps(directSessionProvider) : null,
        attach: await getProviderAttachOps(backendId),
        sessionHandoff: await getSessionHandoffProviderOps(backendId),
      };
    }

    const runtimeRegistry = await resolveExecutablePluginRuntimeRegistry({
      happyHomeDir: params?.happyHomeDir,
    });
    const backendContribution = runtimeRegistry.contributions.backendDefinitionsById.get(backendId);
    const runtimeAdapters = runtimeRegistry.contributions.runtimeAdaptersByBackendId.get(backendId) ?? [];

    if (!backendContribution?.daemonEntryPath || runtimeAdapters.length === 0) {
      return createEmptyBackendExecutionSurfaces();
    }

    if (runtimeAdapters.some((runtimeAdapter) => runtimeAdapter.definition.handler.target !== 'daemon')) {
      return createEmptyBackendExecutionSurfaces();
    }

    const moduleNamespace = await loadPluginDaemonModule({
      daemonEntryPath: backendContribution.daemonEntryPath,
    });

    const handlerByAdapterId = new Map<string, PluginHookHandler>();
    for (const runtimeAdapter of runtimeAdapters) {
      const resolvedHandler = resolvePluginRuntimeAdapterHandlerExport(
        moduleNamespace,
        runtimeAdapter.definition.handler.exportName,
      );
      if (resolvedHandler) {
        handlerByAdapterId.set(runtimeAdapter.definition.id, resolvedHandler);
      }
    }

    return resolveBackendExecutionSurfacesFromHandlers(handlerByAdapterId);
  })();

  cachedBackendExecutionSurfacesPromises.set(cacheKey, promise);
  return await promise;
}

export function normalizeSessionControlPermissionModeForBackendTarget(params: Readonly<{
  backendTarget?: BackendTargetRefV1;
  permissionMode: string;
}>): string {
  const builtInAgentId = params.backendTarget?.kind === 'builtInAgent'
    ? params.backendTarget.agentId
    : null;
  if (!builtInAgentId || !isCatalogAgentId(builtInAgentId)) {
    return params.permissionMode;
  }

  const entry = AGENTS[builtInAgentId];
  if (!entry?.normalizeSessionControlPermissionMode) {
    return params.permissionMode;
  }
  return entry.normalizeSessionControlPermissionMode(params.permissionMode);
}

export function resolveCatalogAgentId(agentId?: AgentId | null): CatalogAgentId {
  const raw = agentId ?? DEFAULT_CATALOG_AGENT_ID;
  const base = raw.split('-')[0];
  if (isCatalogAgentId(base)) {
    return base;
  }
  return DEFAULT_CATALOG_AGENT_ID;
}

export function resolveAgentCliSubcommand(agentId?: AgentId | null): CatalogAgentId {
  const catalogId = resolveCatalogAgentId(agentId);
  return requireCatalogEntry(catalogId).cliSubcommand;
}

export function resolveCatalogAgentIdForCliSubcommand(subcommand: string): CatalogAgentId | null {
  for (const [agentId, entry] of Object.entries(AGENTS) as Array<[CatalogAgentId, AgentCatalogEntry]>) {
    if (entry.cliSubcommand === subcommand) {
      return agentId;
    }
  }
  return null;
}

function resolveBackendExecutionSurfacesFromHandlers(
  handlerByAdapterId: ReadonlyMap<string, PluginHookHandler>,
): BackendExecutionSurfaces {
  const terminalRuntime = resolveTerminalRuntimeOps(handlerByAdapterId);
  const directSessions = resolveDirectSessionProviderOps(handlerByAdapterId);
  const attach = resolveProviderAttachOps(handlerByAdapterId);
  const sessionHandoff = resolveSessionHandoffProviderOps(handlerByAdapterId);

  return {
    terminalRuntime,
    directSessions,
    attach,
    sessionHandoff,
  };
}

function resolvePluginRuntimeAdapterHandlerExport(
  moduleNamespace: PluginDaemonModuleNamespace,
  exportName?: string,
): PluginHookHandler | null {
  if (exportName) {
    const directExport = moduleNamespace[exportName];
    if (typeof directExport === 'function') {
      return directExport as PluginHookHandler;
    }
    if (directExport !== undefined) {
      return null;
    }

    const defaultExport = moduleNamespace.default;
    if (isRecord(defaultExport)) {
      const nestedExport = defaultExport[exportName];
      if (typeof nestedExport === 'function') {
        return nestedExport as PluginHookHandler;
      }
      if (nestedExport !== undefined) {
        return null;
      }
    }

    return null;
  }

  if (typeof moduleNamespace.default === 'function') {
    return moduleNamespace.default as PluginHookHandler;
  }

  return null;
}

function resolveTerminalRuntimeOps(
  handlerByAdapterId: ReadonlyMap<string, PluginHookHandler>,
): AnyTerminalRuntimeOps | null {
  const launch = handlerByAdapterId.get('backend.terminalRuntime.launch');
  const discoverIdentity = handlerByAdapterId.get('backend.terminalRuntime.discoverIdentity');
  const bindTranscript = handlerByAdapterId.get('backend.terminalRuntime.bindTranscript');

  if (!launch && !discoverIdentity && !bindTranscript) {
    return null;
  }

  return {
    ...(launch
      ? {
          launch: launch as AnyTerminalRuntimeOps['launch'],
        }
      : {}),
    ...(discoverIdentity
      ? {
          discoverIdentity: discoverIdentity as AnyTerminalRuntimeOps['discoverIdentity'],
        }
      : {}),
    ...(bindTranscript
      ? {
          bindTranscript: bindTranscript as AnyTerminalRuntimeOps['bindTranscript'],
        }
      : {}),
  };
}

function resolveDirectSessionProviderOps(
  handlerByAdapterId: ReadonlyMap<string, PluginHookHandler>,
): DirectSessionProviderOps | null {
  const validateSource = handlerByAdapterId.get('backend.directSessions.validateSource');
  const listCandidates = handlerByAdapterId.get('backend.directSessions.listCandidates');
  const getActivity = handlerByAdapterId.get('backend.directSessions.getActivity');
  const pageTranscript = handlerByAdapterId.get('backend.directSessions.pageTranscript');
  const readAfterTranscript = handlerByAdapterId.get('backend.directSessions.readAfterTranscript');
  const resolveTakeoverSpawnOptions = handlerByAdapterId.get('backend.directSessions.resolveTakeoverSpawnOptions');

  if (
    !validateSource ||
    !listCandidates ||
    !getActivity ||
    !pageTranscript ||
    !readAfterTranscript ||
    !resolveTakeoverSpawnOptions
  ) {
    return null;
  }

  const acquireFollowLease = handlerByAdapterId.get('backend.directSessions.acquireFollowLease');
  const canonicalizeLinkedSession = handlerByAdapterId.get('backend.directSessions.canonicalizeLinkedSession');
  const resolveLinkIdentity = handlerByAdapterId.get('backend.directSessions.resolveLinkIdentity');

  return {
    validateSource: validateSource as DirectSessionProviderOps['validateSource'],
    listCandidates: listCandidates as DirectSessionProviderOps['listCandidates'],
    getActivity: getActivity as DirectSessionProviderOps['getActivity'],
    pageTranscript: pageTranscript as DirectSessionProviderOps['pageTranscript'],
    readAfterTranscript: readAfterTranscript as DirectSessionProviderOps['readAfterTranscript'],
    resolveTakeoverSpawnOptions: resolveTakeoverSpawnOptions as DirectSessionProviderOps['resolveTakeoverSpawnOptions'],
    ...(acquireFollowLease
      ? {
          acquireFollowLease: acquireFollowLease as DirectSessionProviderOps['acquireFollowLease'],
        }
      : {}),
    ...(canonicalizeLinkedSession
      ? {
          canonicalizeLinkedSession: canonicalizeLinkedSession as DirectSessionProviderOps['canonicalizeLinkedSession'],
        }
      : {}),
    ...(resolveLinkIdentity
      ? {
          resolveLinkIdentity: resolveLinkIdentity as DirectSessionProviderOps['resolveLinkIdentity'],
        }
      : {}),
  };
}

function resolveProviderAttachOps(
  handlerByAdapterId: ReadonlyMap<string, PluginHookHandler>,
): ProviderAttachOps | null {
  const evaluateEligibility = handlerByAdapterId.get('backend.attach.evaluateEligibility');
  const probeReachability = handlerByAdapterId.get('backend.attach.probeReachability');
  const runAttach = handlerByAdapterId.get('backend.attach.run');

  if (!evaluateEligibility || !runAttach) {
    return null;
  }

  return {
    evaluateEligibility: evaluateEligibility as ProviderAttachOps['evaluateEligibility'],
    ...(probeReachability
      ? {
          probeReachability: probeReachability as ProviderAttachOps['probeReachability'],
        }
      : {}),
    runAttach: runAttach as ProviderAttachOps['runAttach'],
  };
}

function resolveSessionHandoffProviderOps(
  handlerByAdapterId: ReadonlyMap<string, PluginHookHandler>,
): SessionHandoffProviderOps | null {
  const exportBundle = handlerByAdapterId.get('backend.sessionHandoff.exportBundle');
  const importBundle = handlerByAdapterId.get('backend.sessionHandoff.importBundle');

  if (!exportBundle || !importBundle) {
    return null;
  }

  return {
    exportBundle: exportBundle as SessionHandoffProviderOps['exportBundle'],
    importBundle: importBundle as SessionHandoffProviderOps['importBundle'],
  };
}
