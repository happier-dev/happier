import { isDeepStrictEqual } from 'node:util';

import {
  ConnectedServiceIdSchema,
  ExternalSessionAgentIdSchema,
  ExternalSessionRefreshCursorV1Schema,
  ExternalSessionRefSchema,
  ExternalSessionSourceIdSchema,
  ExternalSessionTranscriptFollowCursorV1Schema,
  MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION,
  materializeExternalSessionSourceInstances,
  type AccountProfile,
  type ExternalSessionsSource,
  type PluginContributionIdentityV1,
  validateExternalSessionTranscriptFollowEventV1,
} from '@happier-dev/protocol';
import {
  isPluginError,
  PluginError,
  type Disposable,
  type PluginCancellationOptions,
} from '@happier-dev/plugin-sdk';
import { type PluginOperationAvailability } from '@happier-dev/plugin-sdk';
import type {
  ExternalSessionTranscriptItem,
} from '@happier-dev/plugin-sdk/sessions/external';

import type { ResolvedAgentRichDefinition } from '@/plugins/projection/registry/types';
import { logger } from '@/ui/logger';
import { resolveCatalogAgentId } from '@/agent/catalog/resolution';
import { resolveConnectedServiceMaterializedHomeRoot } from '@/daemon/connectedServices/catalogHooks';
import { canonicalAbsolutePathsEqual } from '@/utils/path/expandHomeDirPath';
import {
  resolveExternalSessionSourceConnectedServiceProfile,
  resolveExternalSessionSourceFromAgentProjection,
  type ResolvedExternalSessionSourceProjection,
} from '@/plugins/projection/registry/externalSessionSources';
import {
  executeExternalSessionCandidateQuery,
  hydrateExternalSessionCandidateThroughAgentSource,
  reconcileExternalSessionCandidateIndexes,
} from '@/session/actions/externalSessions/candidateQuery';

import {
  createPluginExternalSessionsAdapter,
  projectAuthorExternalTranscriptItem,
  resolvePluginExternalSessionFollowTarget,
  type PluginExternalSessionsProviderOps,
} from './pluginExternalSessionsAdapter';
import { invokeBoundedExternalSessionsOperation } from './agentExternalSessionsInvocation';
import type { ExternalSessionFollowProviderOps } from './providerOps';
import { resolveExternalSessionLinkIdentityFromSurface } from './resolveExternalSessionLinkIdentity';
import {
  createExternalSessionsUnavailableCapabilities,
  type ExternalSessionsCompositionPort,
  type HostExternalSessionFollowTargetResolution,
  type HostExternalSessionsAuthorService,
  type HostExternalSessionsAuthorTranscriptFollowEvent,
  type HostExternalTranscriptItem,
  type HostExternalTranscriptReadResult,
} from './privateContract';
import type {
  ContextualExternalSessionTakeoverAdapter,
  ContextualExternalSessionTakeoverResolution,
} from './contextualTakeoverAdmission';
import {
  buildConfiguredExternalSessionSourceSnapshot,
  type ConfiguredExternalSessionSourceRefusal,
  type ConfiguredExternalSessionSourceCandidate,
  type ConfiguredExternalSessionSourceSnapshotBasis,
} from './configuredSourceRegistry';
import {
  createExternalSessionFollowCleanupCustody,
} from './followCleanupSettlement';
import {
  settleFollowListenerBounded,
} from './followListenerSettlement';
import {
  EXTERNAL_SESSION_FOLLOW_CLOSE_TRANSPORT_TIMEOUT_MS,
} from './hostOperationOwner';

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

/**
 * The one reader of the cold `terminalFollow` opt-in. Omission is deliberately
 * unavailable, so every terminal-follow eligibility decision — per-source
 * routing and the Agent-level launch barrier alike — resolves through this leaf
 * rather than re-deriving the declaration shape.
 */
function sourceDeclarationDeclaresExplicitTerminalFollow(
  declaration: Readonly<{
    terminalFollow?: Readonly<{ userRowClassification?: string }>;
  }>,
): boolean {
  return declaration.terminalFollow?.userRowClassification === 'explicitV1';
}

function declaresExplicitTerminalFollow(params: Readonly<{
  agents: readonly ConfiguredExternalSessionSourceAgentContribution[];
  agentId: string;
  source: ExternalSessionsSource;
}>): boolean {
  const definition = params.agents.find((agent) => agent.id === params.agentId)
    ?.richDefinition?.definition;
  return definition?.surfaces?.externalSession?.sources.some(
    (source) => source.sourceKind === params.source.kind
      && sourceDeclarationDeclaresExplicitTerminalFollow(source),
  ) === true;
}

/**
 * Declaration-derived terminal-follow eligibility for a whole Agent
 * contribution, established from the Agent's own `terminalFollow` opt-in and
 * never inferred from host wiring, a failure code, or a resolved source.
 *
 * `ES-PEP-03`/`ES-PEP-05` make follow admission a launch precondition for a
 * declaring Agent, so the terminal barrier needs this fact before any source is
 * resolved. An Agent that does not declare follow is unaffected: it keeps
 * launching normally with truthful unsupported follow capability.
 */
export function agentDeclaresExplicitTerminalFollow(
  agent: ConfiguredExternalSessionSourceAgentContribution | null | undefined,
): boolean {
  return agent?.richDefinition?.definition.surfaces?.externalSession?.sources
    .some(sourceDeclarationDeclaresExplicitTerminalFollow) === true;
}

export function materializeConfiguredExternalSessionSourceCandidates(params: Readonly<{
  agents: readonly ConfiguredExternalSessionSourceAgentContribution[];
  account: ConfiguredExternalSessionSourceAccountProjection;
  agentSettings?: unknown;
  activeServerId?: string | null;
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
      const materialized = materializeExternalSessionSourceInstances({
        declaration,
        connectedServices: params.account.connectedServicesV2,
        agentSettings: params.agentSettings,
        activeServerId: params.activeServerId ?? null,
      });
      const malformedProfileIssue = materialized.issues.find(
        (issue) => issue.code === 'malformed_connected_service_profile_id',
      );
      if (malformedProfileIssue) {
        throw new ConfiguredExternalSessionSourceMaterializationError(
          `Connected service '${malformedProfileIssue.serviceId}' has a malformed profile identifier`,
        );
      }
      for (const instance of materialized.instances) {
        appendCandidate(Object.freeze({
          agentId: agent.id,
          source: instance.source,
        }));
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

/**
 * A connected-service source may name an account profile but never gets to
 * derive a daemon storage root from that name.  The host resolves the one
 * materialized home through the catalog hook, then re-admits that stamped
 * source through the declaration before a provider leaf can observe it.
 *
 * `homePath` is declaration-owned rather than Agent-owned: only declarations
 * that explicitly accept that physical-home field participate. Other
 * connected-service source families retain their existing non-filesystem
 * contract.
 *
 * This is also the one materialization every raw machine call goes through:
 * a request that names a `homePath` must name the host-materialized root, and
 * a request that omits it receives the stamped root. Silently rewriting a
 * mismatched caller path would let a request address a directory the account's
 * connected-service namespace never admitted.
 */
export function resolveConfiguredExternalSessionSourceAtAdmission(params: Readonly<{
  agents: readonly ConfiguredExternalSessionSourceAgentContribution[];
  activeServerDir?: string;
  agentId: string;
  source: unknown;
}>): ResolvedExternalSessionSourceProjection {
  const projection = { agents: params.agents };
  const resolved = resolveExternalSessionSourceFromAgentProjection(
    projection,
    params.agentId,
    params.source,
  );
  if (!resolved.ok) return resolved;

  const connectedProfile = resolveExternalSessionSourceConnectedServiceProfile({
    declaration: resolved.declaration,
    source: resolved.source,
  });
  if (connectedProfile.kind === 'not_applicable') return resolved;
  if (connectedProfile.kind === 'invalid') return { ok: false, code: 'source_invalid' };

  const acceptsMaterializedHome = resolved.declaration.schema.fields.some(
    (field) => field.name === 'homePath' && field.kind === 'string',
  );
  if (!acceptsMaterializedHome) return resolved;

  const activeServerDir = params.activeServerDir?.trim();
  const catalogAgentId = resolveCatalogAgentId(params.agentId);
  const serviceId = ConnectedServiceIdSchema.safeParse(connectedProfile.profile.serviceId);
  if (!activeServerDir || !catalogAgentId || !serviceId.success) {
    return { ok: false, code: 'source_invalid' };
  }
  const homePath = resolveConnectedServiceMaterializedHomeRoot(catalogAgentId, {
    activeServerDir,
    serviceId: serviceId.data,
    profileId: connectedProfile.profile.profileId,
  });
  if (!homePath) return { ok: false, code: 'source_invalid' };

  const requestedHomePath = (resolved.source as Record<string, unknown>).homePath;
  if (
    typeof requestedHomePath === 'string'
    && requestedHomePath.trim().length > 0
    && !canonicalAbsolutePathsEqual(requestedHomePath, homePath)
  ) {
    return { ok: false, code: 'source_invalid' };
  }

  const stamped = resolveExternalSessionSourceFromAgentProjection(
    projection,
    params.agentId,
    Object.freeze({ ...resolved.source, homePath }),
  );
  return stamped.ok ? stamped : { ok: false, code: 'source_invalid' };
}

export async function resolveConfiguredExternalSessionFollowTarget(params: Readonly<{
  agents: readonly ConfiguredExternalSessionSourceAgentContribution[];
  account: ConfiguredExternalSessionSourceAccountProjection;
  agentSettings?: unknown;
  activeServerId?: string | null;
  activeServerDir?: string;
  basis: ConfiguredExternalSessionSourceSnapshotBasis;
  readCurrentBasis: () => ConfiguredExternalSessionSourceSnapshotBasis;
  isCurrent: () => boolean;
  agentId: string;
  remoteSessionId: string;
  /** Exact source this Session is already bound to; see `ExternalSessionsCompositionPort`. */
  boundSource?: ExternalSessionsSource;
  admissionDeadlineAtMs?: number;
  resolveProviderOps: (
    agentId: string,
  ) => Promise<ExternalSessionFollowProviderOps | null>;
  signal?: AbortSignal;
  retirementSignal?: AbortSignal;
}>): Promise<HostExternalSessionFollowTargetResolution> {
  const signal = params.signal ?? new AbortController().signal;
  const retirementSignal = params.retirementSignal ?? new AbortController().signal;
  const isCurrent = (): boolean => {
    try {
      return params.isCurrent() === true;
    } catch {
      return false;
    }
  };
  const outcome = await invokeBoundedExternalSessionsOperation({
    signal,
    retirementSignal,
    isCurrent,
    ...(params.admissionDeadlineAtMs === undefined
      ? {}
      : { deadlineAtMs: params.admissionDeadlineAtMs }),
    operation: async (operationSignal, deadlineAtMs) => {
      const checkCurrent = (): void => {
        if (!isCurrent() || retirementSignal.aborted) {
          throw new Error('Configured external-session follow target belongs to a retired generation');
        }
        if (signal.aborted || operationSignal.aborted) {
          throw signal.reason ?? operationSignal.reason ?? new Error(
            'Configured external-session follow target admission was cancelled',
          );
        }
      };
      const providerOpsByAgentId = new Map<
        string,
        ExternalSessionFollowProviderOps
      >();
      const resolveProviderOps = async (
        agentId: string,
      ): Promise<ExternalSessionFollowProviderOps | null> => {
        checkCurrent();
        const cached = providerOpsByAgentId.get(agentId);
        if (cached) return cached;
        const resolved = await params.resolveProviderOps(agentId);
        checkCurrent();
        if (resolved) providerOpsByAgentId.set(agentId, resolved);
        return resolved;
      };
      checkCurrent();
      const snapshot = await buildConfiguredExternalSessionSourceSnapshot({
        basis: params.basis,
        readCurrentBasis: params.readCurrentBasis,
        isCurrent,
        candidates: materializeConfiguredExternalSessionSourceCandidates({
          agents: params.agents,
          account: params.account,
          agentSettings: params.agentSettings,
          activeServerId: params.activeServerId ?? null,
        }),
        resolveSource: (agentId, source) => resolveConfiguredExternalSessionSourceAtAdmission({
          agents: params.agents,
          ...(params.activeServerDir ? { activeServerDir: params.activeServerDir } : {}),
          agentId,
          source,
        }),
        resolveProviderOps,
        signal: operationSignal,
      });
      checkCurrent();
      const sources = await Promise.all(
        snapshot.list(params.readCurrentBasis()).map(async (entry) => {
          checkCurrent();
          const ops = await resolveProviderOps(entry.agentId);
          checkCurrent();
          return Object.freeze({
            agentId: entry.agentId,
            sourceId: entry.sourceKey,
            source: entry.source,
            validatedAtAdmission: true as const,
            supportsFollow:
              declaresExplicitTerminalFollow({
                agents: params.agents,
                agentId: entry.agentId,
                source: entry.source,
              })
              && typeof ops?.resolveLinkIdentity === 'function'
              && typeof ops.pageTranscript === 'function'
              && typeof ops.readAfterTranscript === 'function',
          });
        }),
      );
      checkCurrent();
      return await resolvePluginExternalSessionFollowTarget({
        agentId: params.agentId,
        remoteSessionId: params.remoteSessionId,
        ...(params.boundSource === undefined
          ? {}
          : { boundSource: params.boundSource }),
        admissionDeadlineAtMs: deadlineAtMs,
        sources: Object.freeze(sources),
        resolveProviderOps,
        isCurrent,
        signal: operationSignal,
        retirementSignal,
      });
    },
  });
  if (outcome.status === 'fulfilled') return outcome.value;
  if (outcome.status === 'retired') {
    return Object.freeze({
      status: 'unavailable',
      code: 'plugin_generation_retired',
    });
  }
  if (outcome.status === 'cancelled') {
    return Object.freeze({
      status: 'unavailable',
      code: 'plugin_operation_aborted',
    });
  }
  if (outcome.status === 'timeout') {
    return Object.freeze({
      status: 'unavailable',
      code: 'plugin_operation_deadline_exceeded',
    });
  }
  return Object.freeze({
    status: 'unavailable',
    code: 'plugin_external_follow_identity_unavailable',
  });
}

/**
 * One exact Agent/source identity a composition can own a persisted candidate
 * index for, as the candidate-query owner keys it.
 */
export type ConfiguredExternalSessionCandidateIndexIdentity = Readonly<{
  agentIdentity: PluginContributionIdentityV1;
  source: unknown;
}>;

export type ConfiguredPluginExternalSessionsComposition = Readonly<{
  authorService: HostExternalSessionsAuthorService;
  /**
   * The exact identities this composition can own a persisted candidate index
   * for. Empty when no active-server directory backs the index. The lifecycle
   * owner gives this admitted set to the candidate-index owner, which reconciles
   * the existing private layout across both warm replacements and cold startup.
   */
  candidateIndexIdentities: readonly ConfiguredExternalSessionCandidateIndexIdentity[];
  /**
   * Configured candidates their own Agent's provider leaf refused. Every other
   * Agent still projects; the host names these so an author sees which Agent
   * removed its own sources instead of the drop being silent.
   */
  sourceRefusals: readonly ConfiguredExternalSessionSourceRefusal[];
  bindAuthorService(
    contextualTakeover?: ContextualExternalSessionTakeoverAdapter,
    isPublicLinkAdmissionAvailable?: () => boolean,
  ): HostExternalSessionsAuthorService;
  resolveAuthorSource(
    ref: AuthorTakeoverRef,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ContextualExternalSessionTakeoverResolution>;
  admitPersistedTakeoverSource(input: Readonly<{
    agentId: string;
    sourceId: string;
    source: ExternalSessionsSource;
  }>): ContextualExternalSessionTakeoverResolution | null;
  compositionPort: ExternalSessionsCompositionPort;
  dispose: () => void;
}>;

type AuthorListQuery = Parameters<HostExternalSessionsAuthorService['list']>[0];
type AuthorListOptions = Parameters<HostExternalSessionsAuthorService['list']>[1];
type AuthorAttachRef = Parameters<HostExternalSessionsAuthorService['attach']>[0];
type AuthorAttachOptions = Parameters<HostExternalSessionsAuthorService['attach']>[1];
type AuthorReadRef = Parameters<HostExternalSessionsAuthorService['readTranscript']>[0];
type AuthorReadQuery = Parameters<HostExternalSessionsAuthorService['readTranscript']>[1];
type AuthorReadOptions = Parameters<HostExternalSessionsAuthorService['readTranscript']>[2];
type AuthorFollowRef = Parameters<HostExternalSessionsAuthorService['followTranscript']>[0];
type AuthorFollowOptions = Parameters<HostExternalSessionsAuthorService['followTranscript']>[1];
type AuthorFollowListener = Parameters<HostExternalSessionsAuthorService['followTranscript']>[2];
type AuthorTakeoverRef = Parameters<HostExternalSessionsAuthorService['takeover']>[0];
type AuthorTakeoverRequest = Parameters<HostExternalSessionsAuthorService['takeover']>[1];
type AuthorTakeoverOptions = Parameters<HostExternalSessionsAuthorService['takeover']>[2];
type CompositionResolveInput = Parameters<ExternalSessionsCompositionPort['resolveFollowTarget']>[0];
type CompositionFollowTarget = Parameters<ExternalSessionsCompositionPort['followTranscript']>[0];
type CompositionFollowOptions = Parameters<ExternalSessionsCompositionPort['followTranscript']>[1];
type CompositionFollowListener = Parameters<ExternalSessionsCompositionPort['followTranscript']>[2];
type CompositionFollowResult = Awaited<ReturnType<ExternalSessionsCompositionPort['followTranscript']>>;

const AUTHOR_FOLLOW_CLEANUP_TIMEOUT_MS = 5_000;
const HOST_ADAPTER_CURSOR_MAX_CODE_UNITS = 4_096;

function isCanonicalAuthorBoundedString(
  value: unknown,
  maxCodeUnits: number,
): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxCodeUnits
    && value === value.trim();
}

function isCanonicalAuthorHostQualifiedCursor(value: unknown): value is string {
  return ExternalSessionRefreshCursorV1Schema.safeParse(value).success;
}

function isCanonicalAuthorAgentId(value: unknown): value is string {
  return ExternalSessionAgentIdSchema.safeParse(value).success;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 1;
}

function authorInputFailure(code: string): never {
  throw new PluginError({ code, message: code });
}

function readStrictAuthorRecord(
  value: unknown,
  allowedKeys: readonly string[],
  code: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return authorInputFailure(code);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) {
    return authorInputFailure(code);
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  try {
    for (const key of allowedKeys) {
      const property = Reflect.get(value, key);
      if (property !== undefined) {
        Object.defineProperty(snapshot, key, {
          configurable: false,
          enumerable: true,
          writable: false,
          value: property,
        });
      }
    }
  } catch {
    return authorInputFailure(code);
  }
  return Object.freeze(snapshot);
}

function readAuthorRef(value: unknown): AuthorAttachRef {
  const record = readStrictAuthorRecord(
    value,
    ['agentId', 'sourceId', 'remoteSessionId'],
    'plugin_external_ref_invalid',
  );
  const parsed = ExternalSessionRefSchema.safeParse(record);
  if (!parsed.success) {
    return authorInputFailure('plugin_external_ref_invalid');
  }
  return Object.freeze(parsed.data);
}

function readAuthorListQuery(value: unknown): AuthorListQuery {
  if (value === undefined) return undefined;
  const record = readStrictAuthorRecord(
    value,
    ['agentId', 'sourceId', 'cursor', 'limit', 'maxBytes'],
    'plugin_external_list_query_invalid',
  );
  if (
    (record.agentId !== undefined
      && !isCanonicalAuthorAgentId(record.agentId))
    || (record.sourceId !== undefined
      && !ExternalSessionSourceIdSchema.safeParse(record.sourceId).success)
    || (record.cursor !== undefined
      && !isCanonicalAuthorHostQualifiedCursor(record.cursor))
    || (record.limit !== undefined
      && !isPositiveSafeInteger(record.limit))
    || (record.maxBytes !== undefined
      && !isPositiveSafeInteger(record.maxBytes))
  ) {
    return authorInputFailure('plugin_external_list_query_invalid');
  }
  return Object.freeze({ ...record }) as AuthorListQuery;
}

function readAuthorListQueryWithAdapterContinuation(
  value: unknown,
  unwrapListCursor: (cursor: string) => string | null,
): AuthorListQuery {
  if (value === undefined) return readAuthorListQuery(value);
  const record = readStrictAuthorRecord(
    value,
    ['agentId', 'sourceId', 'cursor', 'limit', 'maxBytes'],
    'plugin_external_list_query_invalid',
  );
  const adapterCursor = isCanonicalAuthorBoundedString(
    record.cursor,
    HOST_ADAPTER_CURSOR_MAX_CODE_UNITS,
  )
    ? unwrapListCursor(record.cursor)
    : null;
  if (!adapterCursor) return readAuthorListQuery(record);
  const { cursor: _cursor, ...strictQuery } = record;
  return Object.freeze({
    ...readAuthorListQuery(Object.freeze(strictQuery)),
    cursor: adapterCursor,
  });
}

function readAuthorTranscriptQuery(value: unknown): AuthorReadQuery {
  const record = readStrictAuthorRecord(
    value,
    ['mode', 'cursor', 'direction', 'limit', 'maxBytes'],
    'plugin_external_transcript_query_invalid',
  );
  if (
    record.mode !== 'page'
    && record.mode !== 'readAfter'
  ) {
    return authorInputFailure('plugin_external_transcript_query_invalid');
  }
  if (
    (record.limit !== undefined
      && !isPositiveSafeInteger(record.limit))
    || (record.maxBytes !== undefined
      && !isPositiveSafeInteger(record.maxBytes))
  ) {
    return authorInputFailure('plugin_external_transcript_query_invalid');
  }
  if (
    record.mode === 'page'
    && (
      (record.direction !== 'older' && record.direction !== 'newer')
      || (record.cursor !== undefined
        && !isCanonicalAuthorHostQualifiedCursor(record.cursor))
    )
  ) {
    return authorInputFailure('plugin_external_transcript_query_invalid');
  }
  if (
    record.mode === 'readAfter'
    && (
      !isCanonicalAuthorHostQualifiedCursor(record.cursor)
      || record.direction !== undefined
    )
  ) {
    return authorInputFailure('plugin_external_transcript_query_invalid');
  }
  return Object.freeze({ ...record }) as AuthorReadQuery;
}

export function readAuthorCancellationOptions(
  value: unknown,
  code = 'plugin_external_options_invalid',
): Readonly<{ signal?: AbortSignal }> | undefined {
  if (value === undefined) return undefined;
  const record = readStrictAuthorRecord(value, ['signal'], code);
  if (record.signal !== undefined && !(record.signal instanceof AbortSignal)) {
    return authorInputFailure(code);
  }
  return Object.freeze(record.signal ? { signal: record.signal } : {});
}

function readAuthorFollowOptions(value: unknown): AuthorFollowOptions {
  const record = readStrictAuthorRecord(
    value,
    ['cursor', 'signal'],
    'plugin_external_follow_options_invalid',
  );
  if (
    record.cursor !== undefined
    && !isCanonicalAuthorHostQualifiedCursor(record.cursor)
  ) {
    return authorInputFailure('plugin_external_cursor_invalid');
  }
  if (record.signal !== undefined && !(record.signal instanceof AbortSignal)) {
    return authorInputFailure('plugin_external_follow_options_invalid');
  }
  return Object.freeze({
    ...(record.cursor === undefined ? {} : { cursor: record.cursor }),
    ...(record.signal === undefined ? {} : { signal: record.signal }),
  }) as AuthorFollowOptions;
}

function readAuthorTakeoverRequest(value: unknown): AuthorTakeoverRequest {
  const record = readStrictAuthorRecord(
    value,
    ['targetStorageMode', 'idempotencyKey'],
    'plugin_external_takeover_request_invalid',
  );
  if (
    (record.targetStorageMode !== 'external-linked'
      && record.targetStorageMode !== 'persisted')
    || typeof record.idempotencyKey !== 'string'
    || record.idempotencyKey.length === 0
    || record.idempotencyKey.length > 256
    || record.idempotencyKey !== record.idempotencyKey.trim()
  ) {
    return authorInputFailure('plugin_external_takeover_request_invalid');
  }
  return Object.freeze({
    targetStorageMode: record.targetStorageMode,
    idempotencyKey: record.idempotencyKey,
  });
}

function projectAuthorTranscriptItem(
  item: HostExternalTranscriptItem,
): ExternalSessionTranscriptItem {
  const projected = projectAuthorExternalTranscriptItem(item);
  return Object.freeze({
    id: projected.id,
    ...(projected.timestampMs === undefined ? {} : { timestampMs: projected.timestampMs }),
    kind: projected.kind,
    data: projected.data,
  });
}

function projectAuthorTranscriptReadResult(
  value: HostExternalTranscriptReadResult,
): Awaited<ReturnType<HostExternalSessionsAuthorService['readTranscript']>> {
  if (value.mode === 'page') {
    return Object.freeze({
      mode: 'page',
      items: Object.freeze(value.items.map(projectAuthorTranscriptItem)),
      nextCursor: value.nextCursor,
      ...(value.tailCursor === undefined ? {} : { tailCursor: value.tailCursor }),
      ...(value.hasMore === undefined ? {} : { hasMore: value.hasMore }),
      ...(value.truncated === undefined ? {} : { truncated: value.truncated }),
    });
  }
  if (value.outcome === 'already_current') {
    return Object.freeze({ mode: 'readAfter', outcome: 'already_current' });
  }
  if (value.outcome === 'advanced') {
    return Object.freeze({
      mode: 'readAfter',
      outcome: 'advanced',
      items: Object.freeze(value.items.map(projectAuthorTranscriptItem)),
      nextCursor: value.nextCursor,
      boundary: value.boundary,
      hasMore: value.hasMore,
      ...(value.diagnostics === undefined
        ? {}
        : { diagnostics: Object.freeze(value.diagnostics.map((diagnostic) => Object.freeze({
            code: diagnostic.code,
            severity: diagnostic.severity,
            count: diagnostic.count,
            positions: Object.freeze([...diagnostic.positions]),
          }))) }),
    });
  }
  return Object.freeze({
    mode: 'readAfter',
    outcome: value.outcome,
  });
}

function readAuthorFollowEvent(
  value: unknown,
): HostExternalSessionsAuthorTranscriptFollowEvent {
  const parsed = validateExternalSessionTranscriptFollowEventV1(value);
  if (parsed.ok) return parsed.event;
  const code = parsed.errorCode === 'serialized_bytes_exceeded'
    ? 'plugin_external_follow_event_too_large'
    : 'plugin_external_follow_event_invalid';
  throw new PluginError({ code, message: code });
}

export async function createConfiguredPluginExternalSessionsAdapter(params: Readonly<{
  agents: readonly ConfiguredExternalSessionSourceAgentContribution[];
  account: ConfiguredExternalSessionSourceAccountProjection;
  agentSettings?: unknown;
  activeServerId?: string | null;
  basis: ConfiguredExternalSessionSourceSnapshotBasis;
  readCurrentBasis: () => ConfiguredExternalSessionSourceSnapshotBasis;
  isCurrent: () => boolean;
  activeServerDir?: string;
  resolveProviderOps: (agentId: string) => Promise<PluginExternalSessionsProviderOps | null>;
  /**
   * Immutable generation of the Agent plugin behind `agentId`. The candidate
   * index this adapter shares with the daemon's own Browse path is qualified by
   * it, so both must read it from the same runtime lease: disagreeing values
   * would make each caller reject and rebuild the other's index forever.
   */
  resolveAgentRuntimeGeneration?: (agentId: string) => string | null;
  attach?: NonNullable<Parameters<typeof createPluginExternalSessionsAdapter>[0]['attach']>;
  contextualTakeover?: ContextualExternalSessionTakeoverAdapter;
  followTranscript?: NonNullable<
    Parameters<typeof createPluginExternalSessionsAdapter>[0]['followTranscript']
  >;
  canFollowNow?: () => boolean;
  retirementSignal?: AbortSignal;
}>): Promise<ConfiguredPluginExternalSessionsComposition> {
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
      agentSettings: params.agentSettings,
      activeServerId: params.activeServerId ?? null,
    }),
    resolveSource: (agentId, source) => resolveConfiguredExternalSessionSourceAtAdmission({
      agents: params.agents,
      ...(params.activeServerDir ? { activeServerDir: params.activeServerDir } : {}),
      agentId,
      source,
    }),
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
      validatedAtAdmission: true as const,
      externalLinkedTakeoverWriterSafety: ops?.externalLinkedTakeoverWriterSafety
        ?? 'unsupported',
      externalSessionTakeoverAdmitted:
        ops?.externalSessionTakeoverAdmitted === true,
      supportsFollow: declaresExplicitTerminalFollow({
        agents: params.agents,
        agentId,
        source: entry.source,
      })
        && typeof params.followTranscript === 'function'
        && typeof ops?.resolveLinkIdentity === 'function'
        && typeof ops?.pageTranscript === 'function'
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
  const localRetirement = new AbortController();
  const retirementSignal = params.retirementSignal
    ? AbortSignal.any([params.retirementSignal, localRetirement.signal])
    : localRetirement.signal;
  type AdapterCandidateQuery = NonNullable<
    Parameters<typeof createPluginExternalSessionsAdapter>[0]['queryCandidates']
  >;
  const candidateIndexServerDir = params.activeServerDir;
  const candidateIndexIdentities: readonly ConfiguredExternalSessionCandidateIndexIdentity[] =
    Object.freeze(candidateIndexServerDir
      ? sources.flatMap((entry) => (entry.agentIdentity
        ? [Object.freeze({ agentIdentity: entry.agentIdentity, source: entry.source })]
        : []))
      : []);
  const queryCandidates: AdapterCandidateQuery | undefined = candidateIndexServerDir
    ? async ({ entry, ops, source, cursor, limit, maxBytes, signal }) => {
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
          activeServerDir: candidateIndexServerDir,
          agentIdentity: entry.agentIdentity,
          agentRuntimeGeneration: params.resolveAgentRuntimeGeneration?.(entry.agentId) ?? null,
          source,
          ...(cursor ? { cursor } : {}),
          limit,
          maxBytes,
          ...(signal ? { signal } : {}),
          listCandidates: async (request) => await ops.listCandidates({
            source,
            ...request,
            searchMode: 'fast',
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
      }
    : undefined;
  const domain = createPluginExternalSessionsAdapter({
    isCurrent,
    sources: Object.freeze(sources),
    resolveProviderOps: async (agentId) => await resolveProviderOps(agentId),
    ...(queryCandidates ? { queryCandidates } : {}),
    parseAuthorListQuery: readAuthorListQueryWithAdapterContinuation,
    ...(params.attach ? { attach: params.attach } : {}),
    ...(params.followTranscript ? { followTranscript: params.followTranscript } : {}),
    ...(params.canFollowNow ? { canFollowNow: params.canFollowNow } : {}),
    retirementSignal,
  });

  /**
   * The one per-candidate takeover capability projection. Every advertised
   * storage mode requires this generation's admitted takeover authority: the
   * Agent's own `externalSessionTakeover` contribution (its launch resolution
   * is what runs after durable admission), plus, for external-linked, the
   * declared native writer-safety contract on top.
   */
  const takeoverStorageModes = (
    contextualTakeover: ContextualExternalSessionTakeoverAdapter | undefined,
    agentId?: string,
  ): readonly ('external-linked' | 'persisted')[] => {
    if (!contextualTakeover) return Object.freeze([]);
    const forAgent = (source: (typeof sources)[number]): boolean => (
      agentId === undefined || source.agentId === agentId
    );
    const takeoverLaunchAdmitted = sources.some((source) => (
      forAgent(source) && source.externalSessionTakeoverAdmitted === true
    ));
    if (!takeoverLaunchAdmitted) return Object.freeze([]);
    const supportsExternalLinked = sources.some((source) => (
      forAgent(source)
      && source.externalLinkedTakeoverWriterSafety === 'native_prevention'
    ));
    return Object.freeze([
      ...(supportsExternalLinked ? ['external-linked' as const] : []),
      'persisted' as const,
    ]);
  };

  const bindAuthorService = (
    contextualTakeover?: ContextualExternalSessionTakeoverAdapter,
    isPublicLinkAdmissionAvailable: () => boolean = () => true,
  ): HostExternalSessionsAuthorService => Object.freeze({
    capabilities: async (options?: PluginCancellationOptions) => {
      if (options?.signal?.aborted) {
        return createExternalSessionsUnavailableCapabilities(
          'plugin_operation_aborted',
        );
      }
      const capabilities = domain.authorService.capabilities();
      const linkAdmissionAvailable = isPublicLinkAdmissionAvailable();
      const linkUnavailable = unavailable('plugin_external_machine_unavailable');
      const advertisedTakeoverStorageModes = contextualTakeover
        && linkAdmissionAvailable
        && capabilities.list.status === 'available'
        ? takeoverStorageModes(contextualTakeover)
        : EMPTY_TAKEOVER_STORAGE_MODES;
      return Object.freeze({
        ...capabilities,
        attach: capabilities.attach.status === 'unavailable'
          ? capabilities.attach
          : linkAdmissionAvailable
            ? capabilities.attach
            : linkUnavailable,
        takeover: advertisedTakeoverStorageModes.length > 0
          ? Object.freeze({
              status: 'available' as const,
              storageModes: advertisedTakeoverStorageModes,
            })
          : unavailable(
              capabilities.list.status === 'unavailable'
                && capabilities.list.code === 'plugin_generation_retired'
                ? 'plugin_generation_retired'
                : !linkAdmissionAvailable
                  ? 'plugin_external_machine_unavailable'
                  : !contextualTakeover
                    ? 'plugin_external_takeover_contextual_admission_unavailable'
                    // The contextual admission owner exists, but this
                    // generation admitted no Agent takeover contribution to
                    // serve either storage mode.
                    : 'plugin_external_agent_unavailable',
            ),
        follow: capabilities.follow.status === 'unavailable'
          ? capabilities.follow
          : linkAdmissionAvailable
            ? capabilities.follow
            : linkUnavailable,
      });
    },
    list: async (query: AuthorListQuery, options: AuthorListOptions) => {
      const parsedOptions = readAuthorCancellationOptions(options);
      const page = await domain.authorService.list(query, parsedOptions);
      const linkAdmissionAvailable = isPublicLinkAdmissionAvailable();
      return Object.freeze({
        ...page,
        nextCursor: page.nextCursor ?? null,
        items: Object.freeze(page.items.map((candidate) => {
          const advertisedTakeoverStorageModes = contextualTakeover
            && linkAdmissionAvailable
            ? takeoverStorageModes(contextualTakeover, candidate.ref.agentId)
            : EMPTY_TAKEOVER_STORAGE_MODES;
          return Object.freeze({
            ...candidate,
            capabilities: linkAdmissionAvailable
              ? candidate.capabilities
              : Object.freeze(candidate.capabilities.filter(
                  (capability) => capability !== 'attach' && capability !== 'follow',
                )),
            takeover: advertisedTakeoverStorageModes.length > 0
              ? Object.freeze({
                  status: 'available' as const,
                  storageModes: advertisedTakeoverStorageModes,
                })
              : unavailable(
                  linkAdmissionAvailable
                    ? contextualTakeover
                      ? 'plugin_external_agent_unavailable'
                      : 'plugin_external_takeover_contextual_admission_unavailable'
                    : 'plugin_external_machine_unavailable',
                ),
          });
        })),
      });
    },
    attach: async (ref: AuthorAttachRef, options: AuthorAttachOptions) => (
      await domain.authorService.attach(
        readAuthorRef(ref),
        readAuthorCancellationOptions(options),
      )
    ),
    readTranscript: async (
      ref: AuthorReadRef,
      query: AuthorReadQuery,
      options: AuthorReadOptions,
    ) => {
      const parsedOptions = readAuthorCancellationOptions(options);
      return projectAuthorTranscriptReadResult(await domain.authorService.readTranscript(
        readAuthorRef(ref),
        Object.freeze({
          ...readAuthorTranscriptQuery(query),
          ...(parsedOptions?.signal
            ? { signal: parsedOptions.signal }
            : {}),
        }),
      ));
    },
    followTranscript: async (
      ref: AuthorFollowRef,
      options: AuthorFollowOptions,
      listener: AuthorFollowListener,
    ) => {
      let parsedRef: AuthorFollowRef;
      try {
        parsedRef = readAuthorRef(ref);
      } catch (error) {
        return Object.freeze({
          status: 'unavailable' as const,
          code: isPluginError(error)
            ? error.code
            : 'plugin_external_ref_invalid',
        });
      }
      let parsedOptions: AuthorFollowOptions;
      try {
        parsedOptions = readAuthorFollowOptions(options);
      } catch (error) {
        return Object.freeze({
          status: 'unavailable' as const,
          code: isPluginError(error)
            ? error.code
            : 'plugin_external_follow_options_invalid',
        });
      }
      const entry = sources.find((source) => (
        source.agentId === parsedRef.agentId && source.sourceId === parsedRef.sourceId
      ));
      if (!entry) {
        return Object.freeze({
          status: 'unavailable' as const,
          code: 'plugin_external_source_unavailable',
        });
      }
      const listenerAbort = new AbortController();
      const operationSignal = parsedOptions.signal
        ? AbortSignal.any([retirementSignal, parsedOptions.signal, listenerAbort.signal])
        : AbortSignal.any([retirementSignal, listenerAbort.signal]);
      let active = true;
      let releaseRequested = false;
      let subscription: Disposable | null = null;
      let releaseStarted = false;
      const cleanupCustody = createExternalSessionFollowCleanupCustody(
        AUTHOR_FOLLOW_CLEANUP_TIMEOUT_MS,
      );
      let diagnosedFailure = false;
      let onOperationAbort: (() => void) | null = null;
      let explicitDisposePending = false;
      let disposedAcknowledgementSeen = false;
      const diagnoseFailure = (): void => {
        if (diagnosedFailure) return;
        diagnosedFailure = true;
        logger.debug('[ExternalSessions] author follow listener or cleanup failed');
      };
      const release = async (
        admitDisposedAcknowledgement = false,
      ): Promise<void> => {
        releaseRequested = true;
        if (!releaseStarted && admitDisposedAcknowledgement) {
          explicitDisposePending = true;
        } else if (!admitDisposedAcknowledgement) {
          active = false;
          explicitDisposePending = false;
          listenerAbort.abort();
        }
        if (onOperationAbort) {
          operationSignal.removeEventListener('abort', onOperationAbort);
          onOperationAbort = null;
        }
        if (!subscription) {
          active = false;
          explicitDisposePending = false;
          listenerAbort.abort();
          return;
        }
        releaseStarted = true;
        const currentSubscription = subscription;
        try {
          await cleanupCustody.settle(
            async () => await currentSubscription.dispose(),
          );
        } catch (error) {
          diagnoseFailure();
          // Custody of the failed or unsettled cleanup stays with the shared
          // owner above. Neither outcome is reported as disposal here: the
          // explicit disposer owns it, while owner-driven releases (abort,
          // listener failure, unavailable acquisition) are already reporting a
          // failure of their own and discard it.
          if (admitDisposedAcknowledgement) throw error;
        } finally {
          // Terminal fencing runs whatever cleanup did, so a hung provider
          // disposer still ends the follow.
          active = false;
          explicitDisposePending = false;
          listenerAbort.abort();
        }
      };
      onOperationAbort = () => {
        void release();
      };
      operationSignal.addEventListener('abort', onOperationAbort, { once: true });
      if (operationSignal.aborted) onOperationAbort();
      let listenerFailure = false;
      let followEventValidationError: PluginError | null = null;
      let listenerDelivery: Promise<void> | null = null;
      const deliverAuthorFollowEvent = (
        event: Parameters<CompositionFollowListener>[0],
      ): Promise<void> => {
        const deliver = async (): Promise<void> => {
          const isDisposedAcknowledgement = explicitDisposePending
            && !disposedAcknowledgementSeen
            && event.kind === 'terminated'
            && event.reason === 'disposed';
          if (explicitDisposePending && !isDisposedAcknowledgement) {
            throw new Error('plugin_external_follow_listener_failed');
          }
          if (!active || operationSignal.aborted || !isCurrent()) {
            if (!releaseStarted) await release();
            throw new Error('plugin_external_follow_listener_failed');
          }
          if (isDisposedAcknowledgement) {
            disposedAcknowledgementSeen = true;
          }
          let projected: unknown;
          if (event.kind === 'data') {
            projected = Object.freeze({
              kind: 'data',
              items: Object.freeze(event.items.map(projectAuthorTranscriptItem)),
              fromCursor: event.fromCursor,
              nextCursor: event.nextCursor,
            });
          } else if (event.kind === 'resyncRequired') {
            if (event.reason === 'cursorDiscontinuity') {
              projected = Object.freeze({
                kind: 'resyncRequired',
                reason: 'cursorDiscontinuity',
                cursor: event.cursor,
              });
            } else {
              projected = Object.freeze({
                kind: 'terminated',
                reason: 'resyncRequired',
                cursor: event.cursor,
              });
            }
          } else {
            projected = Object.freeze({
              kind: 'terminated',
              reason: event.reason,
              cursor: event.cursor,
              ...(event.code ? { code: event.code } : {}),
            });
          }
          try {
            const publicEvent = readAuthorFollowEvent(projected);
            // This callback is the daemon's publisher into the author process,
            // not the author callback itself. The runner owns the five-second
            // author ceiling; this outer acknowledgement needs its one
            // transport-round-trip margin or a listener settling at the
            // ceiling can still lose its cursor acknowledgement in transit.
            await settleFollowListenerBounded(
              Promise.resolve().then(async () => await listener(publicEvent)),
              EXTERNAL_SESSION_FOLLOW_CLOSE_TRANSPORT_TIMEOUT_MS,
              operationSignal,
            );
          } catch (error) {
            listenerFailure = true;
            if (
              followEventValidationError === null
              && isPluginError(error)
              && (
                error.code === 'plugin_external_follow_event_invalid'
                || error.code === 'plugin_external_follow_event_too_large'
              )
            ) {
              followEventValidationError = error;
            }
            diagnoseFailure();
            if (!explicitDisposePending) await release();
            throw error;
          }
        };
        const delivery = listenerDelivery
          ? listenerDelivery.then(deliver)
          : deliver();
        listenerDelivery = delivery.catch(() => undefined);
        return delivery;
      };
      let result: CompositionFollowResult;
      try {
        result = await domain.authorService.followTranscript(
          parsedRef,
          Object.freeze({ ...parsedOptions, signal: operationSignal }),
          deliverAuthorFollowEvent,
        );
      } catch (error) {
        if (followEventValidationError) throw followEventValidationError;
        throw error;
      }
      if (result.status === 'unavailable') {
        if (followEventValidationError) throw followEventValidationError;
        const code = result.code;
        await release();
        return Object.freeze({
          status: 'unavailable' as const,
          code: typeof code === 'string'
            && code.length > 0
            && code.length <= 256
            && code === code.trim()
            ? code
            : 'plugin_external_follow_result_invalid',
        });
      }
      subscription = result.subscription;
      if (followEventValidationError) {
        await release();
        throw followEventValidationError;
      }
      if (result.failure) {
        void result.failure.then(
          () => {
            diagnoseFailure();
            void release();
          },
          () => {
            diagnoseFailure();
            void release();
          },
        );
      }
      if (
        result.startingCursor !== null
        && !ExternalSessionTranscriptFollowCursorV1Schema.safeParse(result.startingCursor).success
      ) {
        await release();
        return Object.freeze({
          status: 'unavailable' as const,
          code: 'plugin_external_follow_result_invalid',
        });
      }
      if (releaseRequested || listenerFailure || operationSignal.aborted) {
        await release();
        return Object.freeze({
          status: 'unavailable' as const,
          code: listenerFailure
            ? 'plugin_external_follow_listener_failed'
            : parsedOptions.signal?.aborted
              ? 'plugin_operation_aborted'
              : 'plugin_generation_retired',
        });
      }
      return Object.freeze({
        status: 'following',
        startingCursor: result.startingCursor,
        subscription: Object.freeze({
          dispose: async () => await release(true),
        }),
      });
    },
    takeover: async (
      ref: AuthorTakeoverRef,
      request: AuthorTakeoverRequest,
      options: AuthorTakeoverOptions,
    ) => {
      const parsedRef = readAuthorRef(ref);
      if (!contextualTakeover) {
        throw new PluginError({
          code: 'plugin_external_takeover_contextual_admission_unavailable',
          message: 'plugin_external_takeover_contextual_admission_unavailable',
        });
      }
      const parsedOptions = readAuthorCancellationOptions(options);
      return await contextualTakeover.takeover(
        parsedRef,
        readAuthorTakeoverRequest(request),
        Object.freeze({
          ...(parsedOptions?.signal ? { signal: parsedOptions.signal } : {}),
          retirementSignal,
          isCurrent,
        }),
      );
    },
  });
  const authorService = bindAuthorService(params.contextualTakeover);
  const resolveAuthorSource = async (
    rawRef: AuthorTakeoverRef,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ContextualExternalSessionTakeoverResolution> => {
    const ref = readAuthorRef(rawRef);
    const assertAuthorSourceCurrent = (): void => {
      if (options?.signal?.aborted) {
        throw new PluginError({
          code: 'plugin_operation_aborted',
          message: 'plugin_operation_aborted',
        });
      }
      if (!isCurrent() || retirementSignal.aborted) {
        throw new PluginError({
          code: 'plugin_generation_retired',
          message: 'plugin_generation_retired',
        });
      }
    };
    assertAuthorSourceCurrent();
    const entry = snapshot.resolve(
      ref.agentId,
      ref.sourceId,
      params.readCurrentBasis(),
    );
    if (!entry || entry.agentId !== ref.agentId) {
      throw new PluginError({
        code: 'plugin_external_source_unavailable',
        message: 'plugin_external_source_unavailable',
      });
    }
    const ops = await resolveProviderOps(entry.agentId);
    assertAuthorSourceCurrent();
    if (!ops) {
      throw new PluginError({
        code: 'plugin_external_agent_unavailable',
        message: 'plugin_external_agent_unavailable',
      });
    }
    const identity = await resolveExternalSessionLinkIdentityFromSurface({
      agentId: entry.agentId,
      remoteSessionId: ref.remoteSessionId,
      source: entry.source,
      ...(options?.signal ? { signal: options.signal } : {}),
    }, ops);
    assertAuthorSourceCurrent();
    return Object.freeze({
      source: identity.source,
      externalLinkedTakeoverWriterSafety:
        ops.externalLinkedTakeoverWriterSafety ?? 'unsupported',
    });
  };
  const admitPersistedTakeoverSource = (input: Readonly<{
    agentId: string;
    sourceId: string;
    source: ExternalSessionsSource;
  }>): ContextualExternalSessionTakeoverResolution | null => {
    if (!isCurrent() || retirementSignal.aborted) return null;
    const agentId = ExternalSessionAgentIdSchema.safeParse(input.agentId);
    const sourceId = ExternalSessionSourceIdSchema.safeParse(input.sourceId);
    if (!agentId.success || !sourceId.success) return null;
    const entry = snapshot.resolve(
      agentId.data,
      sourceId.data,
      params.readCurrentBasis(),
    );
    if (!entry || !isDeepStrictEqual(entry.source, input.source)) return null;
    const declaration = params.agents.find((agent) => agent.id === agentId.data)
      ?.richDefinition?.definition.surfaces?.externalSession;
    return Object.freeze({
      source: entry.source,
      externalLinkedTakeoverWriterSafety:
        declaration?.externalLinkedTakeover?.writerSafety ?? 'unsupported',
    });
  };
  const compositionPort: ExternalSessionsCompositionPort = Object.freeze({
    resolveFollowTarget: async (input: CompositionResolveInput) => await domain.compositionPort.resolveFollowTarget(input),
    followTranscript: async (
      target: CompositionFollowTarget,
      options: CompositionFollowOptions,
      listener: CompositionFollowListener,
    ) => (
      await domain.compositionPort.followTranscript(target, options, listener)
    ),
  });
  let disposed = false;
  return Object.freeze({
    authorService,
    candidateIndexIdentities,
    sourceRefusals: snapshot.refusals,
    bindAuthorService,
    resolveAuthorSource,
    admitPersistedTakeoverSource,
    compositionPort,
    /**
     * Releases this composition only. The persisted candidate index is keyed by
     * Agent/source identity, not by composition generation, and dispose fires on
     * ordinary replacement — a plugin reload or any Account-settings revision —
     * so deleting it here would discard a still-current index and force a full
     * corpus re-crawl. An index a genuinely removed source left behind is retired
     * by the live lifecycle owner below, which is the only place that can see one
     * admitted source set replace another.
     */
    dispose() {
      if (disposed) return;
      disposed = true;
      localRetirement.abort();
    },
  });
}

export type LiveConfiguredPluginExternalSessionsAdapter =
  ConfiguredPluginExternalSessionsComposition;

function unavailable(
  code: string,
): Extract<PluginOperationAvailability, { status: 'unavailable' }> {
  return Object.freeze({ status: 'unavailable', code });
}

const EMPTY_SOURCE_REFUSALS: readonly ConfiguredExternalSessionSourceRefusal[] = Object.freeze([]);
const EMPTY_TAKEOVER_STORAGE_MODES: readonly ('external-linked' | 'persisted')[] = Object.freeze([]);
const EMPTY_CANDIDATE_INDEX_IDENTITIES: readonly ConfiguredExternalSessionCandidateIndexIdentity[] = Object.freeze([]);

export async function createLiveConfiguredPluginExternalSessionsAdapter(params: Readonly<{
  agents: readonly ConfiguredExternalSessionSourceAgentContribution[];
  contributionGenerationId: string;
  readAccount: () => Promise<ConfiguredExternalSessionSourceAccountProjection>;
  readAgentSettings?: () => unknown;
  activeServerId?: string | null;
  readAccountRevision: () => string;
  subscribeAccountRevision: (listener: (revision: string) => void) => () => void;
  isCurrent: () => boolean;
  activeServerDir?: string;
  resolveProviderOps: (agentId: string) => Promise<PluginExternalSessionsProviderOps | null>;
  resolveAgentRuntimeGeneration?: (agentId: string) => string | null;
  attach?: NonNullable<Parameters<typeof createPluginExternalSessionsAdapter>[0]['attach']>;
  contextualTakeover?: ContextualExternalSessionTakeoverAdapter;
  followTranscript?: NonNullable<
    Parameters<typeof createPluginExternalSessionsAdapter>[0]['followTranscript']
  >;
  canFollowNow?: () => boolean;
  /**
   * The caller's existing diagnostics projection observes only admitted
   * rebuilds. Source refusal facts remain owned by this lifecycle and never
   * become a second Account-revision subscription.
   */
  onSourceRefusalsChanged?(
    refusals: readonly ConfiguredExternalSessionSourceRefusal[],
  ): void;
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
  let active: ConfiguredPluginExternalSessionsComposition | null = null;
  /**
   * Why the newest rebuild produced no composition. The rebuild worker must keep
   * running so a later Account revision can still recover, but the failure is the
   * only explanation a caller of the typed unavailable/reconfiguring result will
   * ever get, so it is carried as that error's `cause` rather than discarded.
   */
  let lastRebuildFailure: unknown = null;
  let sameRevisionRetryAccountRevision: string | null = null;
  let sameRevisionRetryRequestedAccountRevision: string | null = null;
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
      agentSettings: params.readAgentSettings?.(),
      activeServerId: params.activeServerId ?? null,
      basis,
      readCurrentBasis: () => basis,
      isCurrent: () => lifecycleIsCurrent(revision, accountRevision),
      ...(params.activeServerDir ? { activeServerDir: params.activeServerDir } : {}),
      resolveProviderOps: params.resolveProviderOps,
      ...(params.resolveAgentRuntimeGeneration
        ? { resolveAgentRuntimeGeneration: params.resolveAgentRuntimeGeneration }
        : {}),
      retirementSignal: retirement.signal,
      ...(params.attach ? { attach: params.attach } : {}),
      ...(params.contextualTakeover ? { contextualTakeover: params.contextualTakeover } : {}),
      ...(params.followTranscript ? { followTranscript: params.followTranscript } : {}),
      ...(params.canFollowNow ? { canFollowNow: params.canFollowNow } : {}),
    });
    if (!lifecycleIsCurrent(revision, accountRevision)) {
      retirement.abort();
      next.dispose();
      return;
    }
    activeRetirement?.abort();
    active?.dispose();
    activeRetirement = retirement;
    active = next;
    lastRebuildFailure = null;
    sameRevisionRetryRequestedAccountRevision = null;
    try {
      params.onSourceRefusalsChanged?.(next.sourceRefusals);
    } catch {
      // Diagnostics are a projection of the admitted source facts. A consumer
      // failure must not revoke a successfully rebuilt source owner.
      logger.debug('[ExternalSessions] source-refusal diagnostics refresh failed');
    }
    if (params.activeServerDir) {
      try {
        await reconcileExternalSessionCandidateIndexes({
          activeServerDir: params.activeServerDir,
          admitted: next.candidateIndexIdentities,
          signal: retirement.signal,
        });
      } catch {
        // Candidate-index retirement is best-effort local cleanup. A successful
        // source admission stays available if its stale private index cannot be
        // removed during this rebuild.
        logger.debug('[ExternalSessions] candidate index reconciliation failed');
      }
    }
  };
  const ensureRebuildWorker = (): Promise<void> => {
    if (rebuildWorker) return rebuildWorker;
    rebuildWorker = (async () => {
      while (!disposed && pendingRebuild) {
        const next = pendingRebuild;
        pendingRebuild = null;
        await rebuild(next.accountRevision, next.lifecycleRevision).catch((error: unknown) => {
          if (
            observedAccountRevision === next.accountRevision
            && lifecycleRevision === next.lifecycleRevision
          ) {
            lastRebuildFailure = error;
            if (
              sameRevisionRetryRequestedAccountRevision === next.accountRevision
              && sameRevisionRetryAccountRevision !== next.accountRevision
            ) {
              sameRevisionRetryAccountRevision = next.accountRevision;
              sameRevisionRetryRequestedAccountRevision = null;
              lastRebuildFailure = null;
              const retryRevision = ++lifecycleRevision;
              pendingRebuild = Object.freeze({
                accountRevision: next.accountRevision,
                lifecycleRevision: retryRevision,
              });
            }
          }
        });
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
    if (accountRevision === observedAccountRevision && lifecycleRevision > 0) {
      if (active) {
        return rebuildWorker ?? Promise.resolve();
      }
      if (pendingRebuild || (rebuildWorker && lastRebuildFailure === null)) {
        sameRevisionRetryRequestedAccountRevision = accountRevision;
        return rebuildWorker ?? Promise.resolve();
      }
      if (
        lastRebuildFailure === null
        || sameRevisionRetryAccountRevision === accountRevision
      ) {
        return Promise.resolve();
      }
      sameRevisionRetryAccountRevision = accountRevision;
    } else if (accountRevision !== observedAccountRevision) {
      observedAccountRevision = accountRevision;
      sameRevisionRetryAccountRevision = null;
      sameRevisionRetryRequestedAccountRevision = null;
    }
    lastRebuildFailure = null;
    const revision = ++lifecycleRevision;
    activeRetirement?.abort();
    active?.dispose();
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
      active?.dispose();
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
  const rebuildFailureCause = (): Readonly<{ cause: unknown }> | undefined => (
    lastRebuildFailure === null ? undefined : { cause: lastRebuildFailure }
  );
  if (!active || disposed || params.isCurrent() !== true) {
    unsubscribeOnce();
    throw new PluginError({
      code: 'plugin_external_sources_unavailable',
      message: 'plugin_external_sources_unavailable',
    }, rebuildFailureCause());
  }

  const current = (): ConfiguredPluginExternalSessionsComposition => {
    synchronizeRevision();
    if (active) return active;
    const code = disposed || params.isCurrent() !== true
      ? 'plugin_generation_retired'
      : 'plugin_external_sources_reconfiguring';
    throw new PluginError({ code, message: code }, rebuildFailureCause());
  };
  const bindAuthorService = (
    contextualTakeover?: ContextualExternalSessionTakeoverAdapter,
    isPublicLinkAdmissionAvailable?: () => boolean,
  ): HostExternalSessionsAuthorService => {
    let boundOwner: ConfiguredPluginExternalSessionsComposition | null = null;
    let boundService: HostExternalSessionsAuthorService | null = null;
    const currentBound = (): HostExternalSessionsAuthorService => {
      const owner = current();
      if (owner !== boundOwner || !boundService) {
        boundOwner = owner;
        boundService = owner.bindAuthorService(
          contextualTakeover,
          isPublicLinkAdmissionAvailable,
        );
      }
      return boundService;
    };
    return Object.freeze({
    capabilities: async (options?: PluginCancellationOptions) => {
      synchronizeRevision();
      if (active) return await currentBound().capabilities(options);
      if (options?.signal?.aborted) {
        return createExternalSessionsUnavailableCapabilities(
          'plugin_operation_aborted',
        );
      }
      const code = disposed || params.isCurrent() !== true
        ? 'plugin_generation_retired'
        : 'plugin_external_sources_reconfiguring';
      return createExternalSessionsUnavailableCapabilities(code);
    },
    list: async (query: AuthorListQuery, options: AuthorListOptions) => (
      await currentBound().list(query, options)
    ),
    attach: async (ref: AuthorAttachRef, options: AuthorAttachOptions) => await currentBound().attach(ref, options),
    readTranscript: async (ref: AuthorReadRef, query: AuthorReadQuery, options: AuthorReadOptions) => (
      await currentBound().readTranscript(ref, query, options)
    ),
    followTranscript: async (
      ref: AuthorFollowRef,
      options: AuthorFollowOptions,
      listener: AuthorFollowListener,
    ) => (
      await currentBound().followTranscript(ref, options, listener)
    ),
    takeover: async (
      ref: AuthorTakeoverRef,
      request: AuthorTakeoverRequest,
      options: AuthorTakeoverOptions,
    ) => (
      await currentBound().takeover(ref, request, options)
    ),
  });
  };
  const authorService = bindAuthorService(params.contextualTakeover);
  const resolveAuthorSource = async (
    ref: AuthorTakeoverRef,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ContextualExternalSessionTakeoverResolution> => (
    await current().resolveAuthorSource(ref, options)
  );
  const admitPersistedTakeoverSource = (
    input: Parameters<ConfiguredPluginExternalSessionsComposition['admitPersistedTakeoverSource']>[0],
  ): ContextualExternalSessionTakeoverResolution | null => (
    current().admitPersistedTakeoverSource(input)
  );
  const compositionPort: ExternalSessionsCompositionPort = Object.freeze({
    resolveFollowTarget: async (input: CompositionResolveInput) => await current().compositionPort.resolveFollowTarget(input),
    followTranscript: async (
      target: CompositionFollowTarget,
      options: CompositionFollowOptions,
      listener: CompositionFollowListener,
    ) => (
      await current().compositionPort.followTranscript(target, options, listener)
    ),
  });
  return Object.freeze({
    authorService,
    get candidateIndexIdentities(): readonly ConfiguredExternalSessionCandidateIndexIdentity[] {
      return active?.candidateIndexIdentities ?? EMPTY_CANDIDATE_INDEX_IDENTITIES;
    },
    get sourceRefusals(): readonly ConfiguredExternalSessionSourceRefusal[] {
      return active?.sourceRefusals ?? EMPTY_SOURCE_REFUSALS;
    },
    bindAuthorService,
    resolveAuthorSource,
    admitPersistedTakeoverSource,
    compositionPort,
    dispose() {
      if (disposed) return;
      disposed = true;
      lifecycleRevision += 1;
      activeRetirement?.abort();
      active?.dispose();
      activeRetirement = null;
      active = null;
      pendingRebuild = null;
      unsubscribeOnce();
    },
  });
}
