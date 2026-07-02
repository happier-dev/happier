import type { AgentCoreRuntimeControlSurface } from '../../types.js';
import type {
  ProviderAuthAdapter,
  ProviderConnectedServicesAdapter,
  ProviderMessageMetaEnricher,
  RuntimePreferencesAdapter,
} from '../adjunctAdapters/types.js';
import type { RuntimeDiscovery } from '../discovery/runtimeDiscovery.js';
import type {
  TranscriptSourceFollowLease,
  TranscriptSourcePage,
  TranscriptSourceReadAfter,
} from '../facets/transcriptSource.js';
import type { RuntimeOutboundTranscriptDispatchFacetV1 } from '../facets/transcriptDispatch.js';
import type { AgentRuntimeKindOverrides, AnyAgentRuntimeKindsManifest } from '../../runtimeKinds.js';
import type { SessionStateFacet } from '../../session/state/index.js';

export type MaybePromise<T> = T | Promise<T>;

export type RuntimeTranscriptSourceFacet<TItem = unknown> = Readonly<{
  page: (params: Readonly<{
    direction: 'older' | 'newer';
    cursor?: string;
    maxBytes: number;
    maxItems: number;
  }>) => MaybePromise<TranscriptSourcePage<TItem>>;
  readAfter: (params: Readonly<{
    cursor: string;
    maxBytes: number;
    maxItems: number;
  }>) => MaybePromise<TranscriptSourceReadAfter<TItem>>;
  acquireFollowLease?: (params: Readonly<{
    reason: string;
  }>) => MaybePromise<TranscriptSourceFollowLease<TItem> | null>;
}>;

/**
 * The live shared runtime control surface is the normalized session/runtime-kind support surface
 * already materialized in `packages/agents` as `AgentCoreRuntimeControlSurface`.
 *
 * It is the concrete owner behind the April `RuntimeControlSurface` noun today. Richer
 * bridge-owned control groups are not implicitly materialized by this alias; they remain
 * lane-owned until a concrete implementation owner lands.
 */
export type RuntimeControlSurface = AgentCoreRuntimeControlSurface;

export type RuntimeFacets = Readonly<{
  /**
   * Transcript read/follow is the only cross-provider runtime facet domain with a concrete shared
   * contract today. Do not treat control-surface domains or other March-era facet nouns as
   * implemented runtime facets until a real shared owner lands.
   */
  transcriptSource?: RuntimeTranscriptSourceFacet;
  transcriptDispatch?: RuntimeOutboundTranscriptDispatchFacetV1;
  sessionState?: SessionStateFacet;
}>;

export type RuntimeCore<
  TCreateSessionRuntimeParams = unknown,
  TSessionRuntime = unknown,
  TCreateExecutionRunBackendParams = unknown,
  TExecutionRunBackend = unknown,
> = Readonly<{
  createSessionRuntime: (params: TCreateSessionRuntimeParams) => MaybePromise<TSessionRuntime>;
  createExecutionRunBackend: (params: TCreateExecutionRunBackendParams) => TExecutionRunBackend;
}>;

export type EngineAdapter<
  TCreateSessionRuntimeParams = unknown,
  TSessionRuntime = unknown,
  TCreateExecutionRunBackendParams = unknown,
  TExecutionRunBackend = unknown,
> = Readonly<{
  runtimeCore: RuntimeCore<
    TCreateSessionRuntimeParams,
    TSessionRuntime,
    TCreateExecutionRunBackendParams,
    TExecutionRunBackend
  >;
  discovery?: RuntimeDiscovery;
  controlSurface?: RuntimeControlSurface;
  facets?: RuntimeFacets;
  runtimePreferences?: RuntimePreferencesAdapter;
  auth?: ProviderAuthAdapter;
  connectedServices?: ProviderConnectedServicesAdapter;
  messageMeta?: ProviderMessageMetaEnricher;
}>;

export type RuntimeKindSpec = Readonly<{
  kind: string;
  /**
   * Static upper-bound delta derived from the runtime-kind manifest. This is not a live bridge-owned
   * control surface instance.
   */
  declaredControlSurfaceSupport: AgentRuntimeKindOverrides | null;
}>;

export type EngineSpec = Readonly<{
  engineId: string;
  defaultRuntimeKind: string | null;
  runtimeKinds: Readonly<Record<string, RuntimeKindSpec>>;
}>;

export function buildEngineSpecFromRuntimeKindsManifest(params: Readonly<{
  engineId: string;
  runtimeKindsManifest: AnyAgentRuntimeKindsManifest | null;
}>): EngineSpec | null {
  const runtimeKindsManifest = params.runtimeKindsManifest;
  if (!runtimeKindsManifest) return null;

  const runtimeKinds = Object.fromEntries(
    Object.entries(runtimeKindsManifest.byKind).map(([kind, definition]) => [
      kind,
      {
        kind,
        declaredControlSurfaceSupport: definition.overrides ?? null,
      } satisfies RuntimeKindSpec,
    ]),
  ) as Record<string, RuntimeKindSpec>;

  return {
    engineId: params.engineId,
    defaultRuntimeKind: runtimeKindsManifest.defaultKind ?? null,
    runtimeKinds,
  };
}
