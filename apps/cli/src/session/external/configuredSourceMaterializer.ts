import {
  ConnectedServiceProfileIdSchema,
  MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION,
  type AccountProfile,
  type PluginContributionIdentityV1,
} from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk';
import { type PluginOperationAvailability } from '@happier-dev/plugin-sdk/runtime';

import type { ResolvedAgentRichDefinition } from '@/plugins/projection/registry/types';
import { resolveExternalSessionSourceFromAgentProjection } from '@/plugins/projection/registry/externalSessionSources';
import {
  executeExternalSessionCandidateQuery,
  hydrateExternalSessionCandidateThroughAgentSource,
} from '@/session/actions/externalSessions/candidateQuery';

import {
  createPluginExternalSessionsAdapter,
  resolvePluginExternalSessionFollowTarget,
  type PluginExternalSessionsProviderOps,
} from './pluginExternalSessionsAdapter';
import type {
  HostExternalSessionFollowTargetResolution,
  HostExternalSessionsService,
} from './privateContract';
import {
  buildConfiguredExternalSessionSourceSnapshot,
  type ConfiguredExternalSessionSourceCandidate,
  type ConfiguredExternalSessionSourceSnapshotBasis,
} from './configuredSourceRegistry';

export type ConfiguredExternalSessionSourceAgentContribution = Readonly<{
  id: string;
  identity?: PluginContributionIdentityV1;
  richDefinition?: ResolvedAgentRichDefinition;
}>;

export type ConfiguredExternalSessionSourceAccountProjection = Pick<AccountProfile, 'connectedServicesV2'>;

export class ConfiguredExternalSessionSourceMaterializationError extends Error {
  readonly code: 'malformed_profile_id' | 'source_capacity_exceeded';

  constructor(
    message: string,
    code: ConfiguredExternalSessionSourceMaterializationError['code'] = 'malformed_profile_id',
  ) {
    super(message);
    this.name = 'ConfiguredExternalSessionSourceMaterializationError';
    this.code = code;
  }
}

export function materializeConfiguredExternalSessionSourceCandidates(params: Readonly<{
  agents: readonly ConfiguredExternalSessionSourceAgentContribution[];
  account: ConfiguredExternalSessionSourceAccountProjection;
}>): readonly ConfiguredExternalSessionSourceCandidate[] {
  const candidates: ConfiguredExternalSessionSourceCandidate[] = [];
  const appendCandidate = (candidate: ConfiguredExternalSessionSourceCandidate): void => {
    if (candidates.length >= MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION) {
      throw new ConfiguredExternalSessionSourceMaterializationError(
        'External-session source capacity exceeded',
        'source_capacity_exceeded',
      );
    }
    candidates.push(candidate);
  };
  for (const agent of params.agents) {
    const sources = agent.richDefinition?.definition.surfaces?.externalSession.sources ?? [];
    for (const declaration of sources) {
      for (const instance of declaration.instances ?? []) {
        if (instance.kind === 'default') {
          appendCandidate(Object.freeze({
            agentId: agent.id,
            source: Object.freeze({ ...instance.constants, kind: declaration.sourceKind }),
          }));
          continue;
        }
        const service = params.account.connectedServicesV2.find(
          (candidate) => candidate.serviceId === instance.serviceId,
        );
        if (!service) continue;
        for (const profile of service.profiles) {
          const parsedProfileId = ConnectedServiceProfileIdSchema.safeParse(profile.profileId);
          if (!parsedProfileId.success) {
            throw new ConfiguredExternalSessionSourceMaterializationError(
              `Connected service '${instance.serviceId}' has a malformed profile identifier`,
            );
          }
          if (profile.status !== 'connected') continue;
          appendCandidate(Object.freeze({
            agentId: agent.id,
            source: Object.freeze({
              ...instance.constants,
              kind: declaration.sourceKind,
              [instance.fields.serviceId]: instance.serviceId,
              [instance.fields.profileId]: parsedProfileId.data,
            }),
          }));
        }
      }
    }
  }
  return Object.freeze(candidates);
}

export function configuredExternalSessionSourcesUseConnectedProfiles(
  agents: readonly ConfiguredExternalSessionSourceAgentContribution[],
): boolean {
  return agents.some(
    (agent) => agent.richDefinition?.definition.surfaces?.externalSession.sources.some(
      (source) => source.instances?.some(
        (instance) => instance.kind === 'connectedServiceProfiles',
      ) === true,
    ) === true,
  );
}

export async function resolveConfiguredExternalSessionFollowTarget(params: Readonly<{
  agents: readonly ConfiguredExternalSessionSourceAgentContribution[];
  account: ConfiguredExternalSessionSourceAccountProjection;
  basis: ConfiguredExternalSessionSourceSnapshotBasis;
  readCurrentBasis: () => ConfiguredExternalSessionSourceSnapshotBasis;
  isCurrent: () => boolean;
  agentId: string;
  remoteSessionId: string;
  resolveProviderOps: (
    agentId: string,
  ) => Promise<PluginExternalSessionsProviderOps | null>;
  signal?: AbortSignal;
  retirementSignal?: AbortSignal;
}>): Promise<HostExternalSessionFollowTargetResolution> {
  const providerOpsByAgentId = new Map<
    string,
    PluginExternalSessionsProviderOps
  >();
  const resolveProviderOps = async (
    agentId: string,
  ): Promise<PluginExternalSessionsProviderOps | null> => {
    const cached = providerOpsByAgentId.get(agentId);
    if (cached) return cached;
    const resolved = await params.resolveProviderOps(agentId);
    if (resolved) providerOpsByAgentId.set(agentId, resolved);
    return resolved;
  };
  const snapshot = await buildConfiguredExternalSessionSourceSnapshot({
    basis: params.basis,
    readCurrentBasis: params.readCurrentBasis,
    isCurrent: params.isCurrent,
    candidates: materializeConfiguredExternalSessionSourceCandidates({
      agents: params.agents,
      account: params.account,
    }),
    resolveSource: (agentId, source) => resolveExternalSessionSourceFromAgentProjection(
      { agents: params.agents },
      agentId,
      source,
    ),
    resolveProviderOps,
  });
  const sources = await Promise.all(
    snapshot.list(params.readCurrentBasis()).map(async (entry) => {
      const ops = await resolveProviderOps(entry.agentId);
      return Object.freeze({
        agentId: entry.agentId,
        sourceId: entry.sourceKey,
        source: entry.source,
        supportsFollow:
          typeof ops?.resolveLinkIdentity === 'function'
          && typeof ops.readAfterTranscript === 'function',
      });
    }),
  );
  return await resolvePluginExternalSessionFollowTarget({
    agentId: params.agentId,
    remoteSessionId: params.remoteSessionId,
    sources: Object.freeze(sources),
    resolveProviderOps,
    isCurrent: params.isCurrent,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.retirementSignal
      ? { retirementSignal: params.retirementSignal }
      : {}),
  });
}

export async function createConfiguredPluginExternalSessionsAdapter(params: Readonly<{
  agents: readonly ConfiguredExternalSessionSourceAgentContribution[];
  account: ConfiguredExternalSessionSourceAccountProjection;
  basis: ConfiguredExternalSessionSourceSnapshotBasis;
  readCurrentBasis: () => ConfiguredExternalSessionSourceSnapshotBasis;
  isCurrent: () => boolean;
  activeServerDir?: string;
  resolveProviderOps: (agentId: string) => Promise<PluginExternalSessionsProviderOps | null>;
  attach?: NonNullable<Parameters<typeof createPluginExternalSessionsAdapter>[0]['attach']>;
  takeover?: NonNullable<Parameters<typeof createPluginExternalSessionsAdapter>[0]['takeover']>;
  followTranscript?: NonNullable<
    Parameters<typeof createPluginExternalSessionsAdapter>[0]['followTranscript']
  >;
  retirementSignal?: AbortSignal;
}>): Promise<ReturnType<typeof createPluginExternalSessionsAdapter>> {
  const providerOpsByAgentId = new Map<string, PluginExternalSessionsProviderOps>();
  const resolveProviderOps = async (agentId: string): Promise<PluginExternalSessionsProviderOps | null> => {
    const cached = providerOpsByAgentId.get(agentId);
    if (cached) return cached;
    const resolved = await params.resolveProviderOps(agentId);
    if (resolved) providerOpsByAgentId.set(agentId, resolved);
    return resolved;
  };
  const snapshot = await buildConfiguredExternalSessionSourceSnapshot({
    basis: params.basis,
    readCurrentBasis: params.readCurrentBasis,
    isCurrent: params.isCurrent,
    candidates: materializeConfiguredExternalSessionSourceCandidates({
      agents: params.agents,
      account: params.account,
    }),
    resolveSource: (agentId, source) => resolveExternalSessionSourceFromAgentProjection(
      { agents: params.agents },
      agentId,
      source,
    ),
    resolveProviderOps,
  });
  const sources = await Promise.all(snapshot.list(params.readCurrentBasis()).map(async (entry) => {
    const agentId = entry.agentId;
    const agent = params.agents.find((candidate) => candidate.id === agentId);
    const ops = await resolveProviderOps(agentId);
    return Object.freeze({
      agentId,
      ...(agent?.identity ? { agentIdentity: agent.identity } : {}),
      sourceId: entry.sourceKey,
      source: entry.source,
      supportsFollow: typeof params.followTranscript === 'function'
        && typeof ops?.readAfterTranscript === 'function',
    });
  }));
  const isCurrent = (): boolean => {
    if (params.isCurrent() !== true) return false;
    try {
      snapshot.list(params.readCurrentBasis());
      return true;
    } catch {
      return false;
    }
  };
  return createPluginExternalSessionsAdapter({
    isCurrent,
    sources: Object.freeze(sources),
    resolveProviderOps: async (agentId) => await resolveProviderOps(agentId),
    ...(params.activeServerDir ? {
      queryCandidates: async ({ entry, ops, source, cursor, limit, maxBytes, signal }) => {
        const request = {
          source,
          ...(cursor ? { cursor } : {}),
          limit,
          maxBytes,
          signal,
        };
        if (!entry.agentIdentity) {
          const page = await ops.listCandidates(request);
          if (page.preparation) {
            throw new PluginError({
              code: 'plugin_external_candidate_index_identity_unavailable',
              message: 'plugin_external_candidate_index_identity_unavailable',
            });
          }
          return page;
        }
        return await executeExternalSessionCandidateQuery({
          activeServerDir: params.activeServerDir!,
          agentIdentity: entry.agentIdentity,
          source,
          ...(cursor ? { cursor } : {}),
          limit,
          maxBytes,
          listCandidates: async (request) => await ops.listCandidates({
            source,
            ...request,
            maxBytes,
            signal,
          }),
          hydrateCandidate: async (candidate) => (
            await hydrateExternalSessionCandidateThroughAgentSource({
              source,
              candidate,
              providerOps: ops,
              maxBytes,
              signal,
            })
          ),
        });
      },
    } : {}),
    ...(params.attach ? { attach: params.attach } : {}),
    ...(params.takeover ? { takeover: params.takeover } : {}),
    ...(params.followTranscript ? { followTranscript: params.followTranscript } : {}),
    ...(params.retirementSignal ? { retirementSignal: params.retirementSignal } : {}),
  });
}

export type LiveConfiguredPluginExternalSessionsAdapter = Readonly<{
  service: HostExternalSessionsService;
  dispose: () => void;
}>;

function unavailable(code: string): PluginOperationAvailability {
  return Object.freeze({ status: 'unavailable', code });
}

export async function createLiveConfiguredPluginExternalSessionsAdapter(params: Readonly<{
  agents: readonly ConfiguredExternalSessionSourceAgentContribution[];
  contributionGenerationId: string;
  readAccount: () => Promise<ConfiguredExternalSessionSourceAccountProjection>;
  readAccountRevision: () => string;
  subscribeAccountRevision: (listener: (revision: string) => void) => () => void;
  isCurrent: () => boolean;
  activeServerDir?: string;
  resolveProviderOps: (agentId: string) => Promise<PluginExternalSessionsProviderOps | null>;
  attach?: NonNullable<Parameters<typeof createPluginExternalSessionsAdapter>[0]['attach']>;
  takeover?: NonNullable<Parameters<typeof createPluginExternalSessionsAdapter>[0]['takeover']>;
  followTranscript?: NonNullable<
    Parameters<typeof createPluginExternalSessionsAdapter>[0]['followTranscript']
  >;
}>): Promise<LiveConfiguredPluginExternalSessionsAdapter> {
  let disposed = false;
  let lifecycleRevision = 0;
  const readAccountRevision = (): string | null => {
    try {
      const revision = params.readAccountRevision().trim();
      return revision || null;
    } catch {
      return null;
    }
  };
  let observedAccountRevision = readAccountRevision();
  let active: HostExternalSessionsService | null = null;
  let activeRetirement: AbortController | null = null;
  let pendingRebuild: Readonly<{ accountRevision: string; lifecycleRevision: number }> | null = null;
  let rebuildWorker: Promise<void> | null = null;

  const lifecycleIsCurrent = (revision: number, accountRevision: string): boolean => (
    !disposed
    && params.isCurrent() === true
    && lifecycleRevision === revision
    && readAccountRevision() === accountRevision
  );
  const rebuild = async (accountRevision: string, revision: number): Promise<void> => {
    const account = await params.readAccount();
    if (!lifecycleIsCurrent(revision, accountRevision)) return;
    const basis = Object.freeze({
      contributionGenerationId: params.contributionGenerationId,
      accountSettingsRevision: accountRevision,
    });
    const retirement = new AbortController();
    const next = await createConfiguredPluginExternalSessionsAdapter({
      agents: params.agents,
      account,
      basis,
      readCurrentBasis: () => basis,
      isCurrent: () => lifecycleIsCurrent(revision, accountRevision),
      ...(params.activeServerDir ? { activeServerDir: params.activeServerDir } : {}),
      resolveProviderOps: params.resolveProviderOps,
      retirementSignal: retirement.signal,
      ...(params.attach ? { attach: params.attach } : {}),
      ...(params.takeover ? { takeover: params.takeover } : {}),
      ...(params.followTranscript ? { followTranscript: params.followTranscript } : {}),
    });
    if (!lifecycleIsCurrent(revision, accountRevision)) {
      retirement.abort();
      return;
    }
    activeRetirement?.abort();
    activeRetirement = retirement;
    active = next;
  };
  const ensureRebuildWorker = (): Promise<void> => {
    if (rebuildWorker) return rebuildWorker;
    rebuildWorker = (async () => {
      while (!disposed && pendingRebuild) {
        const next = pendingRebuild;
        pendingRebuild = null;
        await rebuild(next.accountRevision, next.lifecycleRevision).catch(() => undefined);
      }
    })().finally(() => {
      rebuildWorker = null;
      if (!disposed && pendingRebuild) void ensureRebuildWorker();
    });
    return rebuildWorker;
  };
  const beginRevision = (rawRevision: string): Promise<void> => {
    const accountRevision = rawRevision.trim();
    if (!accountRevision) return Promise.resolve();
    if (accountRevision === observedAccountRevision && (active || pendingRebuild || rebuildWorker)) {
      return rebuildWorker ?? Promise.resolve();
    }
    observedAccountRevision = accountRevision;
    const revision = ++lifecycleRevision;
    activeRetirement?.abort();
    activeRetirement = null;
    active = null;
    pendingRebuild = Object.freeze({ accountRevision, lifecycleRevision: revision });
    return ensureRebuildWorker();
  };
  const synchronizeRevision = (): void => {
    if (disposed) return;
    const currentRevision = readAccountRevision();
    if (!currentRevision) {
      lifecycleRevision += 1;
      observedAccountRevision = null;
      pendingRebuild = null;
      activeRetirement?.abort();
      activeRetirement = null;
      active = null;
      return;
    }
    if (currentRevision !== observedAccountRevision) void beginRevision(currentRevision);
  };
  const unsubscribe = params.subscribeAccountRevision((revision) => {
    void beginRevision(revision);
  });
  let unsubscribed = false;
  const unsubscribeOnce = (): void => {
    if (unsubscribed) return;
    unsubscribed = true;
    try {
      unsubscribe();
    } catch {
      // The account snapshot owner must not make generation cleanup throw.
    }
  };
  await beginRevision(observedAccountRevision ?? '');
  synchronizeRevision();
  if (rebuildWorker) await rebuildWorker;
  if (!active || disposed || params.isCurrent() !== true) {
    unsubscribeOnce();
    throw new PluginError({
      code: 'plugin_external_sources_unavailable',
      message: 'plugin_external_sources_unavailable',
    });
  }

  const current = (): HostExternalSessionsService => {
    synchronizeRevision();
    if (active) return active;
    const code = disposed || params.isCurrent() !== true
      ? 'plugin_generation_retired'
      : 'plugin_external_sources_reconfiguring';
    throw new PluginError({ code, message: code });
  };
  const service: HostExternalSessionsService = Object.freeze({
    capabilities: () => {
      synchronizeRevision();
      if (active) return active.capabilities();
      const code = disposed || params.isCurrent() !== true
        ? 'plugin_generation_retired'
        : 'plugin_external_sources_reconfiguring';
      return Object.freeze({
        list: unavailable(code),
        attach: unavailable(code),
        takeover: unavailable(code),
        transcript: unavailable(code),
        follow: unavailable(code),
      });
    },
    list: async (...args: Parameters<HostExternalSessionsService['list']>) => await current().list(...args),
    attach: async (...args: Parameters<HostExternalSessionsService['attach']>) => await current().attach(...args),
    takeover: async (...args: Parameters<HostExternalSessionsService['takeover']>) => await current().takeover(...args),
    resolveFollowTarget: async (
      ...args: Parameters<HostExternalSessionsService['resolveFollowTarget']>
    ) => await current().resolveFollowTarget(...args),
    readTranscript: async (...args: Parameters<HostExternalSessionsService['readTranscript']>) => await current().readTranscript(...args),
    followTranscript: (...args: Parameters<HostExternalSessionsService['followTranscript']>) => current().followTranscript(...args),
  });
  return Object.freeze({
    service,
    dispose() {
      if (disposed) return;
      disposed = true;
      lifecycleRevision += 1;
      activeRetirement?.abort();
      activeRetirement = null;
      active = null;
      pendingRebuild = null;
      unsubscribeOnce();
    },
  });
}
