import {
  ExternalSessionAgentIdSchema,
  ExternalSessionRefreshCursorV1Schema,
  ExternalSessionRefSchema,
  ExternalSessionSourceIdSchema,
  MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION,
  materializeExternalSessionSourceInstances,
  type AccountProfile,
  type ExternalSessionsSource,
  type PluginContributionIdentityV1,
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
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime';

import type { ResolvedAgentRichDefinition } from '@/plugins/projection/registry/types';
import { logger } from '@/ui/logger';
import { resolveExternalSessionSourceFromAgentProjection } from '@/plugins/projection/registry/externalSessionSources';
import {
  executeExternalSessionCandidateQuery,
  hydrateExternalSessionCandidateThroughAgentSource,
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
import type { ContextualExternalSessionTakeoverAdapter } from './contextualTakeoverAdmission';
import {
  buildConfiguredExternalSessionSourceSnapshot,
  type ConfiguredExternalSessionSourceRefusal,
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

export async function resolveConfiguredExternalSessionFollowTarget(params: Readonly<{
  agents: readonly ConfiguredExternalSessionSourceAgentContribution[];
  account: ConfiguredExternalSessionSourceAccountProjection;
  agentSettings?: unknown;
  activeServerId?: string | null;
  basis: ConfiguredExternalSessionSourceSnapshotBasis;
  readCurrentBasis: () => ConfiguredExternalSessionSourceSnapshotBasis;
  isCurrent: () => boolean;
  agentId: string;
  remoteSessionId: string;
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
        resolveSource: (agentId, source) => resolveExternalSessionSourceFromAgentProjection(
          { agents: params.agents },
          agentId,
          source,
        ),
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

export type ConfiguredPluginExternalSessionsComposition = Readonly<{
  authorService: HostExternalSessionsAuthorService;
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
  ): Promise<Readonly<{ source: ExternalSessionsSource }>>;
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

const AUTHOR_FOLLOW_LISTENER_TIMEOUT_MS = 5_000;
const AUTHOR_FOLLOW_CLEANUP_TIMEOUT_MS = 5_000;
const AUTHOR_FOLLOW_EVENT_MAX_SERIALIZED_BYTES = 1_048_576;
const AUTHOR_HOST_CURSOR_MAX_CODE_UNITS = 4_096;

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

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
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
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return authorInputFailure(code);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) {
    return authorInputFailure(code);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      return authorInputFailure(code);
    }
  }
  return value as Readonly<Record<string, unknown>>;
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
    AUTHOR_HOST_CURSOR_MAX_CODE_UNITS,
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
      ...(value.diagnostics === undefined
        ? {}
        : { diagnostics: Object.freeze(value.diagnostics.map((diagnostic) => Object.freeze({
            code: diagnostic.code,
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginError({
      code: 'plugin_external_follow_event_invalid',
      message: 'plugin_external_follow_event_invalid',
    });
  }
  const event = value as Readonly<Record<string, unknown>>;
  let parsed: HostExternalSessionsAuthorTranscriptFollowEvent | null = null;
  if (
    event.kind === 'data'
    && hasExactKeys(event, ['kind', 'items', 'fromCursor', 'nextCursor'])
    && Array.isArray(event.items)
    && (event.fromCursor === null
      || isCanonicalAuthorBoundedString(event.fromCursor, AUTHOR_HOST_CURSOR_MAX_CODE_UNITS))
    && isCanonicalAuthorBoundedString(event.nextCursor, AUTHOR_HOST_CURSOR_MAX_CODE_UNITS)
  ) {
    const items = event.items.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const item = value as Readonly<Record<string, unknown>>;
      const keys = [
        'id',
        ...(item.timestampMs === undefined ? [] : ['timestampMs']),
        'kind',
        'data',
      ];
      const data = AgentRuntimeJsonValueV1Schema.safeParse(item.data);
      if (
        !hasExactKeys(item, keys)
        || typeof item.id !== 'string'
        || item.id.length === 0
        || item.id.length > 2_000
        || (item.timestampMs !== undefined
          && (typeof item.timestampMs !== 'number' || !Number.isFinite(item.timestampMs)))
        || (item.kind !== 'user' && item.kind !== 'agent' && item.kind !== 'system' && item.kind !== 'event')
        || !data.success
      ) return null;
      return Object.freeze({
        id: item.id,
        ...(item.timestampMs === undefined ? {} : { timestampMs: item.timestampMs }),
        kind: item.kind,
        data: data.data,
      });
    });
    if (!items.includes(null)) {
      parsed = Object.freeze({
        kind: 'data',
        items: Object.freeze(items as NonNullable<(typeof items)[number]>[]),
        fromCursor: event.fromCursor as string | null,
        nextCursor: event.nextCursor,
      });
    }
  } else if (
    event.kind === 'resyncRequired'
    && hasExactKeys(event, ['kind', 'reason', 'cursor'])
    && event.reason === 'cursorDiscontinuity'
    && (event.cursor === null
      || isCanonicalAuthorBoundedString(event.cursor, AUTHOR_HOST_CURSOR_MAX_CODE_UNITS))
  ) {
    parsed = Object.freeze({
      kind: 'resyncRequired',
      reason: 'cursorDiscontinuity',
      cursor: event.cursor as string | null,
    });
  } else if (
    event.kind === 'terminated'
    && hasExactKeys(event, [
      'kind',
      'reason',
      'cursor',
      ...(event.code === undefined ? [] : ['code']),
    ])
    && (
      event.reason === 'disposed'
      || event.reason === 'aborted'
      || event.reason === 'retired'
      || event.reason === 'providerFailure'
      || event.reason === 'resyncRequired'
    )
    && (event.cursor === null
      || isCanonicalAuthorBoundedString(event.cursor, AUTHOR_HOST_CURSOR_MAX_CODE_UNITS))
    && (event.code === undefined
      || (typeof event.code === 'string'
        && event.code.length > 0
        && event.code.length <= 256
        && event.code === event.code.trim()))
  ) {
    parsed = Object.freeze({
      kind: 'terminated',
      reason: event.reason,
      cursor: event.cursor as string | null,
      ...(event.code === undefined ? {} : { code: event.code as string }),
    });
  }
  if (!parsed) {
    throw new PluginError({
      code: 'plugin_external_follow_event_invalid',
      message: 'plugin_external_follow_event_invalid',
    });
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(parsed);
  } catch (error) {
    throw new PluginError({
      code: 'plugin_external_follow_event_invalid',
      message: 'plugin_external_follow_event_invalid',
    }, { cause: error });
  }
  if (Buffer.byteLength(serialized, 'utf8') > AUTHOR_FOLLOW_EVENT_MAX_SERIALIZED_BYTES) {
    throw new PluginError({
      code: 'plugin_external_follow_event_too_large',
      message: 'plugin_external_follow_event_too_large',
    });
  }
  return parsed;
}

async function settleAuthorFollowWork(
  work: Promise<void>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('plugin_external_follow_listener_deadline_exceeded')),
          timeoutMs,
        );
        timer.unref?.();
      }),
      ...(signal
        ? [new Promise<never>((_, reject) => {
            onAbort = () => reject(new Error('plugin_operation_aborted'));
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          })]
        : []),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
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
      validatedAtAdmission: true as const,
      externalLinkedTakeoverWriterSafety: ops?.externalLinkedTakeoverWriterSafety
        ?? 'unsupported',
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

  const takeoverStorageModes = (
    contextualTakeover: ContextualExternalSessionTakeoverAdapter | undefined,
    agentId?: string,
  ): readonly ('external-linked' | 'persisted')[] => {
    if (!contextualTakeover) return Object.freeze([]);
    const supportsExternalLinked = sources.some((source) => (
      (agentId === undefined || source.agentId === agentId)
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
      return Object.freeze({
        ...capabilities,
        attach: capabilities.attach.status === 'unavailable'
          ? capabilities.attach
          : linkAdmissionAvailable
            ? capabilities.attach
            : linkUnavailable,
        takeover: contextualTakeover
          && linkAdmissionAvailable
          && capabilities.list.status === 'available'
          ? Object.freeze({
              status: 'available' as const,
              storageModes: takeoverStorageModes(contextualTakeover),
            })
          : unavailable(
              capabilities.list.status === 'unavailable'
                && capabilities.list.code === 'plugin_generation_retired'
                ? 'plugin_generation_retired'
                : !linkAdmissionAvailable
                  ? 'plugin_external_machine_unavailable'
                  : 'plugin_external_takeover_contextual_admission_unavailable',
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
        items: Object.freeze(page.items.map((candidate) => Object.freeze({
          ...candidate,
          capabilities: linkAdmissionAvailable
            ? candidate.capabilities
            : Object.freeze(candidate.capabilities.filter(
                (capability) => capability !== 'attach' && capability !== 'follow',
              )),
          takeover: contextualTakeover && linkAdmissionAvailable
            ? Object.freeze({
                status: 'available' as const,
                storageModes: takeoverStorageModes(
                  contextualTakeover,
                  candidate.ref.agentId,
                ),
              })
            : unavailable(
                linkAdmissionAvailable
                  ? 'plugin_external_takeover_contextual_admission_unavailable'
                  : 'plugin_external_machine_unavailable',
              ),
        }))),
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
      let releasePromise: Promise<void> | null = null;
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
        if (!releasePromise && admitDisposedAcknowledgement) {
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
        if (!releasePromise) {
          const cleanup = Promise.resolve()
            .then(async () => await subscription!.dispose())
            .catch(() => {
              diagnoseFailure();
            });
          releasePromise = settleAuthorFollowWork(
            cleanup,
            AUTHOR_FOLLOW_CLEANUP_TIMEOUT_MS,
          ).catch(() => {
            diagnoseFailure();
          }).finally(() => {
            active = false;
            explicitDisposePending = false;
            listenerAbort.abort();
          });
        }
        await releasePromise;
      };
      onOperationAbort = () => {
        void release();
      };
      operationSignal.addEventListener('abort', onOperationAbort, { once: true });
      if (operationSignal.aborted) onOperationAbort();
      let listenerFailure = false;
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
            if (!releasePromise) await release();
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
            await settleAuthorFollowWork(
              Promise.resolve().then(async () => await listener(publicEvent)),
              AUTHOR_FOLLOW_LISTENER_TIMEOUT_MS,
              operationSignal,
            );
          } catch (error) {
            listenerFailure = true;
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
      const result = await domain.authorService.followTranscript(
        parsedRef,
        Object.freeze({ ...parsedOptions, signal: operationSignal }),
        deliverAuthorFollowEvent,
      );
      if (result.status === 'unavailable') {
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
        && !isCanonicalAuthorBoundedString(
          result.startingCursor,
          AUTHOR_HOST_CURSOR_MAX_CODE_UNITS,
        )
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
  ): Promise<Readonly<{ source: ExternalSessionsSource }>> => {
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
    return Object.freeze({ source: identity.source });
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
    sourceRefusals: snapshot.refusals,
    bindAuthorService,
    resolveAuthorSource,
    compositionPort,
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
  attach?: NonNullable<Parameters<typeof createPluginExternalSessionsAdapter>[0]['attach']>;
  contextualTakeover?: ContextualExternalSessionTakeoverAdapter;
  followTranscript?: NonNullable<
    Parameters<typeof createPluginExternalSessionsAdapter>[0]['followTranscript']
  >;
  canFollowNow?: () => boolean;
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
  };
  const ensureRebuildWorker = (): Promise<void> => {
    if (rebuildWorker) return rebuildWorker;
    rebuildWorker = (async () => {
      while (!disposed && pendingRebuild) {
        const next = pendingRebuild;
        pendingRebuild = null;
        await rebuild(next.accountRevision, next.lifecycleRevision).catch((error: unknown) => {
          lastRebuildFailure = error;
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
    if (accountRevision === observedAccountRevision && (active || pendingRebuild || rebuildWorker)) {
      return rebuildWorker ?? Promise.resolve();
    }
    observedAccountRevision = accountRevision;
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
  ): Promise<Readonly<{ source: ExternalSessionsSource }>> => (
    await current().resolveAuthorSource(ref, options)
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
    get sourceRefusals(): readonly ConfiguredExternalSessionSourceRefusal[] {
      return active?.sourceRefusals ?? EMPTY_SOURCE_REFUSALS;
    },
    bindAuthorService,
    resolveAuthorSource,
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
