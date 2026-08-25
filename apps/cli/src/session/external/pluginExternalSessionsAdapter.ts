import { isPluginError, PluginError, type JsonValue, type PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import { type PluginOperationAvailability } from '@happier-dev/plugin-sdk';
import {
  AgentExternalSessionTranscriptRawRecordSchema,
  resolveExternalSessionCandidateIdentityKey,
} from '@happier-dev/plugin-sdk/sessions/external';
import {
  ExternalSessionUserProjectionSchema,
  ExternalSessionAgentIdSchema,
  ExternalSessionRefSchema,
  ExternalSessionTranscriptItemIdV1Schema,
  ExternalSessionTranscriptSourceTimestampV1Schema,
  MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION,
  resolveTranscriptBodySemanticEvent,
  type ExternalSessionAgentId,
  type ExternalSessionSourceId,
  type ExternalSessionsSource,
  type PluginContributionIdentityV1,
} from '@happier-dev/protocol';
import { measureSerializedValidatedStrictPluginJsonUtf8Bytes } from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import { randomUUID } from 'node:crypto';

import { clonePluginPlainData } from '../../plugins/runtime/plainData';
import {
  EXTERNAL_SESSIONS_INVOCATION_POLICY,
  invokeBoundedExternalSessionsOperation,
} from './agentExternalSessionsInvocation';
import type {
  ExternalSessionsCompositionPort,
  HostExternalSessionCandidate,
  HostExternalSessionFollowTargetResolution,
  HostExternalSessionRef,
  HostExternalTranscriptFollowResult,
  HostExternalTranscriptItem,
  PluginExternalSessionsDomainAuthorService,
  PluginExternalSessionsDomainComposition,
} from './privateContract';
import type {
  ExternalSessionCandidatesPage,
  ExternalSessionProviderOps,
} from './providerOps';
import { ExternalSessionProviderFailureError } from './providerOps';
import { resolveExternalSessionLinkIdentityFromSurface } from './resolveExternalSessionLinkIdentity';
import { preservesExternalSessionSourceIdentity } from './sourceIdentity';

type SourceEntry = Readonly<{
  agentId: ExternalSessionAgentId;
  agentIdentity?: PluginContributionIdentityV1;
  sourceId: ExternalSessionSourceId;
  source: ExternalSessionsSource;
  validatedAtAdmission?: true;
  supportsFollow?: boolean;
}>;
export type PluginExternalSessionSourceEntry = SourceEntry;
export type PluginExternalSessionsProviderOps = Pick<
  ExternalSessionProviderOps,
  'validateSource' | 'listCandidates' | 'pageTranscript'
> & Partial<Pick<
  ExternalSessionProviderOps,
  | 'externalLinkedTakeoverWriterSafety'
  | 'readAfterTranscript'
  | 'resolveLinkIdentity'
>>;
type PluginExternalSessionCandidateQuery = (params: Readonly<{
  entry: SourceEntry;
  ops: PluginExternalSessionsProviderOps;
  source: ExternalSessionsSource;
  cursor?: string;
  limit: number;
  maxBytes: number;
  signal: AbortSignal;
}>) => Promise<ExternalSessionCandidatesPage>;
type PluginExternalSessionsDomainListQuery = Parameters<
  PluginExternalSessionsDomainAuthorService['list']
>[0];
type ListCandidate = Readonly<{
  candidate: HostExternalSessionCandidate;
  publicRefKey: string;
  privateCandidateIdentityKey: string;
}>;
type ListSourceSnapshot = {
  entry: SourceEntry;
  providerCursor?: string;
  items: readonly ListCandidate[];
  offset: number;
  exhausted: boolean;
  pagesRead: number;
  consecutiveEmptyPages: number;
  diagnosticCode?: string;
  seenCursors: Set<string>;
  /**
   * Public refs actually emitted in this source's cursor lineage. This remains
   * inside the owned continuation snapshot, whose existing byte estimator is
   * the sole retention ceiling.
   */
  emittedPublicRefKeys: Set<string>;
  publicRefCollision?: true;
};
type ListSnapshot = { queryKey: string; sources: readonly ListSourceSnapshot[]; refillStartIndex: number };
type RetainedListSnapshot = Readonly<{ snapshot: ListSnapshot; retainedBytes: number }>;
const CURSOR_PREFIX = 'plugin_external_sessions_v1_';
const MAX_CURSOR_SNAPSHOTS = 128;
const MAX_PROVIDER_PAGES_PER_SOURCE = 100;
const MAX_EMPTY_PROVIDER_PAGES_PER_SOURCE = 8;
const MAX_CONCURRENT_LIST_HEAD_ACQUISITIONS = 8;
const LIST_HEAD_ACQUISITION_TIMEOUT_MS = 3_000;
const MAX_SNAPSHOT_ITEMS = 10_000;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
// Preserve the existing 128-cursor capacity for ordinary snapshots while limiting
// worst-case retention to the byte budget of four maximum-size candidate snapshots. The
// estimate also counts the state omitted by MAX_SNAPSHOT_BYTES: consumed page
// items, source entries, provider/seen cursors, diagnostics, and the host cursor.
const MAX_CURSOR_SNAPSHOT_TOTAL_BYTES = 4 * MAX_SNAPSHOT_BYTES;
const DEFAULT_LIST_MAX_BYTES = 512 * 1024;
const MAX_LINKED_SESSION_ID_CODE_UNITS = 191;
const MAX_READ_AFTER_DIAGNOSTICS = 32;
const MAX_READ_AFTER_DIAGNOSTIC_CODE_UNITS = 128;
const MAX_READ_AFTER_DIAGNOSTIC_POSITIONS = 200;
const RETAINED_REFERENCE_BYTES = 8;
const RETAINED_CONTAINER_BYTES = 16;
const PUBLIC_REF_COLLISION_DIAGNOSTIC = 'plugin_external_public_ref_collision';

function comparePublicCandidates(
  left: HostExternalSessionCandidate,
  right: HostExternalSessionCandidate,
): number {
  return (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0)
    || compareCodeUnits(left.ref.agentId, right.ref.agentId)
    || compareCodeUnits(left.ref.sourceId, right.ref.sourceId)
    || compareCodeUnits(left.ref.remoteSessionId, right.ref.remoteSessionId);
}

function compareCandidates(left: ListCandidate, right: ListCandidate): number {
  return comparePublicCandidates(left.candidate, right.candidate)
    || compareCodeUnits(
      left.privateCandidateIdentityKey,
      right.privateCandidateIdentityKey,
    );
}

function publicRefKey(ref: HostExternalSessionRef): string {
  return JSON.stringify([ref.agentId, ref.sourceId, ref.remoteSessionId]);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unavailable(code: string): PluginOperationAvailability {
  return Object.freeze({ status: 'unavailable' as const, code });
}
function available(): PluginOperationAvailability { return Object.freeze({ status: 'available' as const }); }
function fail(code: string): never { throw new PluginError({ code, message: code }); }
function failure(code: string): PluginError { return new PluginError({ code, message: code }); }
function serviceFailure(error: unknown, fallbackCode: string): PluginError {
  if (isPluginError(error)) return error;
  return new PluginError(
    { code: fallbackCode, message: fallbackCode },
    error instanceof Error ? { cause: error } : undefined,
  );
}
function assertAvailable(value: PluginOperationAvailability): void {
  if (value.status !== 'available') fail(value.code);
}
function boundedInteger(value: number | undefined, fallback: number, max: number, code: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) fail(code);
  return Math.min(max, value);
}
function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) fail('plugin_operation_aborted');
}
/**
 * Sizes a projected response through the canonical iterative Protocol byte owner.
 * Recursive serialization would reject valid deep values the strict-JSON contract
 * deliberately admits, so the declared byte ceiling stays the only bound.
 */
function serializedBytes(value: unknown, maxBytes: number): number {
  try {
    return measureSerializedValidatedStrictPluginJsonUtf8Bytes(value, 'External Session response', maxBytes);
  } catch (error) {
    if (isPluginError(error)) throw error;
    fail('plugin_external_response_invalid');
  }
}
function assertSerializedBytes(value: unknown, maxBytes: number): void {
  if (serializedBytes(value, maxBytes) > maxBytes) fail('plugin_external_response_capacity_exceeded');
}

function projectExternalSessionAttachResult(value: unknown): Readonly<{ sessionId: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('plugin_external_attach_failed');
  }
  const sessionId = Reflect.get(value, 'sessionId');
  if (
    typeof sessionId !== 'string'
    || sessionId.length === 0
    || sessionId.length > MAX_LINKED_SESSION_ID_CODE_UNITS
    || sessionId !== sessionId.trim()
  ) {
    fail('plugin_external_attach_failed');
  }
  return Object.freeze({ sessionId });
}

function projectReadAfterDiagnostics(value: unknown): readonly Readonly<{
  code: string;
  count: number;
  positions: readonly number[];
}>[] {
  if (!Array.isArray(value) || value.length > MAX_READ_AFTER_DIAGNOSTICS) {
    fail('plugin_external_transcript_invalid');
  }
  return Object.freeze(value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      fail('plugin_external_transcript_invalid');
    }
    const code = Reflect.get(candidate, 'code');
    const count = Reflect.get(candidate, 'count');
    const positions = Reflect.get(candidate, 'positions');
    if (
      typeof code !== 'string'
      || code.length === 0
      || code.length > MAX_READ_AFTER_DIAGNOSTIC_CODE_UNITS
      || code !== code.trim()
      || !Number.isSafeInteger(count)
      || (count as number) <= 0
      || !Array.isArray(positions)
      || positions.length > MAX_READ_AFTER_DIAGNOSTIC_POSITIONS
      || positions.some((position) => !Number.isSafeInteger(position) || position < 0)
      || (count as number) < positions.length
    ) {
      fail('plugin_external_transcript_invalid');
    }
    return Object.freeze({
      code,
      count: count as number,
      positions: Object.freeze([...(positions as number[])]),
    });
  }));
}

type RetainedByteEstimateState = {
  bytes: number;
  readonly maxBytes: number;
  readonly seen: Set<object>;
};

class MalformedExternalSessionCandidatePageError extends Error {}
class ExternalSessionSourceValidationUnavailableError extends Error {}

function addRetainedBytes(state: RetainedByteEstimateState, bytes: number): boolean {
  state.bytes = Math.min(state.maxBytes + 1, state.bytes + bytes);
  return state.bytes <= state.maxBytes;
}

function addRetainedUtf8Bytes(state: RetainedByteEstimateState, value: string): void {
  for (let index = 0; index < value.length && state.bytes <= state.maxBytes; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) {
      addRetainedBytes(state, 1);
    } else if (codeUnit <= 0x7ff) {
      addRetainedBytes(state, 2);
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        addRetainedBytes(state, 4);
        index += 1;
      } else {
        addRetainedBytes(state, 3);
      }
    } else {
      addRetainedBytes(state, 3);
    }
  }
}

function addRetainedValueBytes(state: RetainedByteEstimateState, value: unknown): void {
  if (!addRetainedBytes(state, RETAINED_REFERENCE_BYTES)) return;
  if (typeof value === 'string') {
    addRetainedUtf8Bytes(state, value);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (state.seen.has(value)) return;
  state.seen.add(value);
  if (!addRetainedBytes(state, RETAINED_CONTAINER_BYTES)) return;
  if (value instanceof Set) {
    for (const item of value) {
      addRetainedValueBytes(state, item);
      if (state.bytes > state.maxBytes) return;
    }
    return;
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'string') addRetainedUtf8Bytes(state, key);
    else addRetainedUtf8Bytes(state, key.description ?? '');
    if (!addRetainedBytes(state, RETAINED_REFERENCE_BYTES)) return;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor) addRetainedValueBytes(state, descriptor.value);
    if (state.bytes > state.maxBytes) return;
  }
}

function estimateRetainedListSnapshotBytes(cursor: string, snapshot: ListSnapshot): number {
  const state: RetainedByteEstimateState = {
    bytes: 0,
    maxBytes: MAX_CURSOR_SNAPSHOT_TOTAL_BYTES,
    seen: new Set<object>(),
  };
  addRetainedValueBytes(state, cursor);
  addRetainedValueBytes(state, snapshot);
  return state.bytes;
}

function unavailableFollowTarget(code: string): HostExternalSessionFollowTargetResolution {
  return Object.freeze({ status: 'unavailable', code });
}

export async function resolvePluginExternalSessionFollowTarget(params: Readonly<{
  agentId: string;
  sourceId?: ExternalSessionSourceId;
  /**
   * Exact source a retained Session is already bound to, as stored by its own
   * link authority. It is the provider-normalized source, which may carry
   * canonical fields the configured instance never declared, so it selects its
   * configured entry by source identity rather than by configured key.
   */
  boundSource?: ExternalSessionsSource;
  remoteSessionId: string;
  admissionDeadlineAtMs?: number;
  sources: readonly PluginExternalSessionSourceEntry[];
  resolveProviderOps: (
    agentId: ExternalSessionAgentId,
  ) => Promise<Pick<
    ExternalSessionProviderOps,
    'validateSource' | 'resolveLinkIdentity'
  > | null>;
  isCurrent: () => boolean;
  signal?: AbortSignal;
  retirementSignal?: AbortSignal;
}>): Promise<HostExternalSessionFollowTargetResolution> {
  const isCurrent = (): boolean => {
    try {
      return params.isCurrent() === true;
    } catch {
      return false;
    }
  };
  const signal = params.signal ?? new AbortController().signal;
  const retirementSignal = params.retirementSignal ?? new AbortController().signal;
  const outcome = await invokeBoundedExternalSessionsOperation({
    signal,
    retirementSignal,
    isCurrent,
    ...(params.admissionDeadlineAtMs === undefined
      ? {}
      : { deadlineAtMs: params.admissionDeadlineAtMs }),
    operation: async (operationSignal) => {
      const checkCurrent = (): void => {
        if (!isCurrent() || retirementSignal.aborted) {
          fail('plugin_generation_retired');
        }
        if (signal.aborted) fail('plugin_operation_aborted');
        if (operationSignal.aborted) {
          fail('plugin_operation_deadline_exceeded');
        }
      };
      checkCurrent();
      const parsedAgentId = ExternalSessionAgentIdSchema.safeParse(params.agentId);
      if (
        !parsedAgentId.success
        || !ExternalSessionRefSchema.shape.remoteSessionId
          .safeParse(params.remoteSessionId).success
      ) {
        return unavailableFollowTarget('plugin_external_follow_identity_unavailable');
      }
      const entries = params.sources.filter(
        (entry) => (
          entry.agentId === parsedAgentId.data
          && (params.sourceId === undefined || entry.sourceId === params.sourceId)
          && (
            params.boundSource === undefined
            || preservesExternalSessionSourceIdentity(
              entry.source,
              params.boundSource,
            )
          )
          && entry.supportsFollow === true
        ),
      );
      if (
        entries.length === 0
        || entries.length > MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION
      ) {
        return unavailableFollowTarget('plugin_external_follow_identity_unavailable');
      }

      const outcomes = await Promise.all(entries.map(async (entry) => {
        try {
          checkCurrent();
          const ops = await params.resolveProviderOps(entry.agentId);
          checkCurrent();
          if (!ops?.resolveLinkIdentity) {
            return Object.freeze({ kind: 'unavailable' as const });
          }
          const configuredSource = entry.validatedAtAdmission
            ? entry.source
            : await (async () => {
                const configured = await ops.validateSource({
                  source: entry.source,
                  signal: operationSignal,
                });
                checkCurrent();
                return configured.ok
                  && preservesExternalSessionSourceIdentity(entry.source, configured.source)
                  ? configured.source
                  : null;
              })();
          if (!configuredSource) {
            return Object.freeze({ kind: 'unavailable' as const });
          }
          const identity = await ops.resolveLinkIdentity({
            source: configuredSource,
            remoteSessionId: params.remoteSessionId,
            signal: operationSignal,
          });
          checkCurrent();
          if (
            identity.remoteSessionId !== params.remoteSessionId
            || !preservesExternalSessionSourceIdentity(
              configuredSource,
              identity.source,
            )
          ) {
            return Object.freeze({ kind: 'unavailable' as const });
          }
          return Object.freeze({
            kind: 'resolved' as const,
            ref: Object.freeze({
              agentId: parsedAgentId.data,
              sourceId: entry.sourceId,
              remoteSessionId: params.remoteSessionId,
            }),
            source: identity.source,
          });
        } catch (error) {
          checkCurrent();
          if (
            error instanceof ExternalSessionProviderFailureError
            && error.code === 'candidate_not_found'
          ) {
            return Object.freeze({ kind: 'not_found' as const });
          }
          return Object.freeze({ kind: 'unavailable' as const });
        }
      }));
      checkCurrent();
      if (outcomes.some((outcome) => outcome.kind === 'unavailable')) {
        return unavailableFollowTarget('plugin_external_follow_identity_unavailable');
      }
      const resolved = outcomes.filter(
        (outcome): outcome is Extract<typeof outcome, { kind: 'resolved' }> => (
          outcome.kind === 'resolved'
        ),
      );
      if (resolved.length !== 1) {
        return unavailableFollowTarget(
          resolved.length > 1
            ? 'plugin_external_follow_identity_ambiguous'
            : 'plugin_external_follow_identity_unavailable',
        );
      }
      return Object.freeze({
        status: 'resolved',
        ref: resolved[0]!.ref,
        source: resolved[0]!.source,
      });
    },
  });
  if (outcome.status === 'fulfilled') return outcome.value;
  if (outcome.status === 'retired') {
    return unavailableFollowTarget('plugin_generation_retired');
  }
  if (outcome.status === 'cancelled') {
    return unavailableFollowTarget('plugin_operation_aborted');
  }
  if (outcome.status === 'timeout') {
    return unavailableFollowTarget('plugin_operation_deadline_exceeded');
  }
  return unavailableFollowTarget('plugin_external_follow_identity_unavailable');
}

/**
 * Immutable strict-JSON copy of a producer-supplied transcript value, taken
 * through the one Protocol JSON owner so this boundary carries no second
 * admission policy. Complete-value bounds stay where they are enforced: the
 * transcript item/byte ceilings this adapter already applies to the response.
 */
function snapshotPlainJson(value: unknown): JsonValue {
  const cloned: unknown = clonePluginPlainData(value, {
    path: 'External Session transcript value',
    invalid: () => failure('plugin_external_transcript_invalid'),
  });
  return cloned as JsonValue;
}

export function mapPluginExternalTranscriptItem(
  item: unknown,
): HostExternalTranscriptItem {
  const snapshot = snapshotPlainJson(item);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    fail('plugin_external_transcript_invalid');
  }
  const record = snapshot as Readonly<Record<string, JsonValue>>;
  const parsedId = ExternalSessionTranscriptItemIdV1Schema.safeParse(record.id);
  if (!parsedId.success || !('raw' in record)) {
    fail('plugin_external_transcript_invalid');
  }
  const itemId = parsedId.data;
  const parsed = AgentExternalSessionTranscriptRawRecordSchema.safeParse(record.raw);
  if (!parsed.success) fail('plugin_external_transcript_invalid');
  const raw = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
    ? parsed.data as Readonly<Record<string, JsonValue>>
    : null;
  const rawRole = raw?.role;
  const content = raw?.content && typeof raw.content === 'object' && !Array.isArray(raw.content)
    ? raw.content as Readonly<Record<string, JsonValue>>
    : null;
  if ((rawRole !== 'user' && rawRole !== 'agent') || !content) {
    fail('plugin_external_transcript_invalid');
  }
  const semanticEvent = rawRole === 'user'
    ? null
    : resolveTranscriptBodySemanticEvent({
        protocol: 'acp',
        body: content,
      });
  const kind = rawRole === 'user'
    ? 'user' as const
    : semanticEvent?.role ?? 'unknown';
  // `messageRole: null` is the retained-carrier spelling of an absent
  // compatibility hint. The strict raw envelope remains the role authority.
  const compatibilityMessageRole = record.messageRole ?? undefined;
  if (
    kind === 'unknown'
    ||
    (rawRole === 'agent' && kind !== 'agent' && kind !== 'event')
    || (
      compatibilityMessageRole !== undefined
      && compatibilityMessageRole !== kind
    )
  ) fail('plugin_external_transcript_invalid');
  const parsedTimestamp = ExternalSessionTranscriptSourceTimestampV1Schema.safeParse(record.createdAtMs);
  const timestampMs = parsedTimestamp.success ? parsedTimestamp.data : undefined;
  // The same bounded identity owner the Agent wrapper applies to `localId`.
  const parsedLocalId = record.localId === undefined || record.localId === null
    ? undefined
    : ExternalSessionTranscriptItemIdV1Schema.safeParse(record.localId);
  const localId = parsedLocalId === undefined
    ? undefined
    : parsedLocalId.success
      ? parsedLocalId.data
      : fail('plugin_external_transcript_invalid');
  const parsedUserProjection = record.userProjection === undefined
    ? undefined
    : ExternalSessionUserProjectionSchema.safeParse(record.userProjection);
  const userProjection = parsedUserProjection === undefined
    ? undefined
    : parsedUserProjection.success
      ? parsedUserProjection.data
      : fail('plugin_external_transcript_invalid');
  if (userProjection !== undefined && kind !== 'user') fail('plugin_external_transcript_invalid');
  return Object.freeze({
    id: itemId,
    ...(localId ? { localId } : {}),
    ...(userProjection ? { userProjection } : {}),
    ...(timestampMs !== undefined ? { timestampMs } : {}),
    kind,
    data: parsed.data,
  });
}

/**
 * Removes producer-only identity/origin carriers and projects the canonical
 * raw envelope into the trusted-author transcript shape. Semantic tool bodies
 * remain intact — including paths, arguments, and results — because this is a
 * declared SDK transcript-read surface, not the narrower outward-share
 * projector. Private terminal follow continues to consume
 * `mapPluginExternalTranscriptItem`.
 */
export function projectAuthorExternalTranscriptItem(
  item: HostExternalTranscriptItem,
): HostExternalTranscriptItem {
  const raw = item.data && typeof item.data === 'object' && !Array.isArray(item.data)
    ? item.data as Readonly<Record<string, JsonValue>>
    : null;
  const content = raw?.content && typeof raw.content === 'object' && !Array.isArray(raw.content)
    ? raw.content as Readonly<Record<string, JsonValue>>
    : null;
  let data: JsonValue = item.data;
  if (raw?.role === 'user' && content?.type === 'text' && typeof content.text === 'string') {
    data = Object.freeze({ role: 'user', text: content.text });
  } else if (raw?.role === 'agent' && content) {
    const semanticEvent = resolveTranscriptBodySemanticEvent({
      protocol: 'acp',
      body: content,
    });
    if (!semanticEvent) fail('plugin_external_transcript_invalid');
    const semanticBody = semanticEvent.body && typeof semanticEvent.body === 'object'
      && !Array.isArray(semanticEvent.body)
      ? semanticEvent.body as Readonly<Record<string, unknown>>
      : null;
    data = semanticBody?.type === 'message' && typeof semanticBody.message === 'string'
      ? Object.freeze({ role: semanticEvent.role, text: semanticBody.message })
      : Object.freeze({
          role: semanticEvent.role,
          content: snapshotPlainJson(semanticEvent.body),
        });
  }
  return Object.freeze({
    id: item.id,
    ...(item.timestampMs === undefined ? {} : { timestampMs: item.timestampMs }),
    kind: item.kind,
    data,
  });
}

export function createPluginExternalSessionsAdapter(params: Readonly<{
  isCurrent: () => boolean;
  sources: readonly SourceEntry[];
  resolveProviderOps: (agentId: ExternalSessionAgentId) => Promise<PluginExternalSessionsProviderOps | null>;
  queryCandidates?: PluginExternalSessionCandidateQuery;
  parseAuthorListQuery?: (
    query: unknown,
    unwrapListCursor: (cursor: string) => string | null,
  ) => PluginExternalSessionsDomainListQuery;
  attach?: (ref: HostExternalSessionRef, source: ExternalSessionsSource, options?: { signal?: AbortSignal }) => Promise<{ sessionId: string }>;
  followTranscript?: (input: Readonly<{
    ref: HostExternalSessionRef;
    source: ExternalSessionsSource;
    options: Parameters<ExternalSessionsCompositionPort['followTranscript']>[1];
    listener: Parameters<ExternalSessionsCompositionPort['followTranscript']>[2];
  }>) => Promise<HostExternalTranscriptFollowResult>;
  /**
   * Live check that a follow can actually run, owned by the host-operation owner.
   * When omitted, follow availability falls back to the static source shape — correct
   * for compositions with no host-operation owner at all.
   */
  canFollowNow?: () => boolean;
  retirementSignal?: AbortSignal;
}>): PluginExternalSessionsDomainComposition {
  const snapshots = new Map<string, RetainedListSnapshot>();
  let retainedSnapshotBytes = 0;
  const deleteSnapshot = (cursor: string): boolean => {
    const retained = snapshots.get(cursor);
    if (!retained) return false;
    snapshots.delete(cursor);
    retainedSnapshotBytes = Math.max(0, retainedSnapshotBytes - retained.retainedBytes);
    return true;
  };
  const clearSnapshots = (): void => {
    snapshots.clear();
    retainedSnapshotBytes = 0;
  };
  const isCurrent = () => {
    let current = false;
    try { current = params.isCurrent() === true; } catch { current = false; }
    if (!current) clearSnapshots();
    return current;
  };
  params.retirementSignal?.addEventListener('abort', clearSnapshots, { once: true });
  if (params.retirementSignal?.aborted) clearSnapshots();
  const retainSnapshot = (cursor: string, snapshot: ListSnapshot): void => {
    const retainedBytes = estimateRetainedListSnapshotBytes(cursor, snapshot);
    if (retainedBytes > MAX_CURSOR_SNAPSHOT_TOTAL_BYTES) {
      fail('plugin_external_inventory_capacity_exceeded');
    }
    while (
      snapshots.size >= MAX_CURSOR_SNAPSHOTS
      || retainedSnapshotBytes + retainedBytes > MAX_CURSOR_SNAPSHOT_TOTAL_BYTES
    ) {
      const oldestCursor = snapshots.keys().next().value;
      if (oldestCursor === undefined) fail('plugin_external_inventory_capacity_exceeded');
      deleteSnapshot(oldestCursor);
    }
    snapshots.set(cursor, Object.freeze({ snapshot, retainedBytes }));
    retainedSnapshotBytes += retainedBytes;
  };
  const runBoundedOperation = async <T>(
    callerSignal: AbortSignal | undefined,
    failureCode: string,
    operation: (signal: AbortSignal) => Promise<T>,
    options: Readonly<{
      settleAfterCallerAbort?: boolean;
      deadlineAtMs?: number;
    }> = {},
  ): Promise<T> => {
    if (!isCurrent() || params.retirementSignal?.aborted) fail('plugin_generation_retired');
    assertNotAborted(callerSignal);
    const nowMs = Date.now();
    const deadlineAtMs = Math.min(
      nowMs + EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs,
      options.deadlineAtMs ?? Number.POSITIVE_INFINITY,
    );
    if (deadlineAtMs <= nowMs) {
      throw failure('plugin_operation_deadline_exceeded');
    }
    const deadline = new AbortController();
    const timeout = setTimeout(
      () => deadline.abort(),
      Math.max(0, deadlineAtMs - nowMs),
    );
    const operationSignal = AbortSignal.any([
      deadline.signal,
      ...(params.retirementSignal ? [params.retirementSignal] : []),
      ...(callerSignal ? [callerSignal] : []),
    ]);
    const settlementSignal = options.settleAfterCallerAbort
      ? AbortSignal.any([
          deadline.signal,
          ...(params.retirementSignal ? [params.retirementSignal] : []),
        ])
      : operationSignal;
    const abortFailure = (): PluginError => {
      if (!isCurrent() || params.retirementSignal?.aborted) return failure('plugin_generation_retired');
      if (callerSignal?.aborted) return failure('plugin_operation_aborted');
      return failure('plugin_operation_deadline_exceeded');
    };
    try {
      try {
        return await new Promise<T>((resolve, reject) => {
          const onAbort = () => reject(abortFailure());
          if (settlementSignal.aborted) {
            reject(abortFailure());
            return;
          }
          settlementSignal.addEventListener('abort', onAbort, { once: true });
          Promise.resolve().then(() => operation(operationSignal)).then(resolve, reject).finally(() => {
            settlementSignal.removeEventListener('abort', onAbort);
          });
        });
      } catch (error) {
        if (options.settleAfterCallerAbort) {
          if (!isCurrent() || params.retirementSignal?.aborted) {
            throw failure('plugin_generation_retired');
          }
          if (callerSignal?.aborted) throw failure('plugin_operation_aborted');
          if (deadline.signal.aborted) {
            throw failure('plugin_operation_deadline_exceeded');
          }
        }
        throw serviceFailure(error, failureCode);
      }
    } finally {
      clearTimeout(timeout);
    }
  };
  const sourceFor = (ref: HostExternalSessionRef): SourceEntry => {
    if (!isCurrent()) fail('plugin_generation_retired');
    const parsedRef = ExternalSessionRefSchema.safeParse(ref);
    if (!parsedRef.success) {
      fail('plugin_external_source_unavailable');
    }
    const entry = params.sources.find((candidate) => (
      candidate.agentId === parsedRef.data.agentId
      && candidate.sourceId === parsedRef.data.sourceId
    ));
    if (!entry) fail('plugin_external_source_unavailable');
    return entry;
  };
  const providerFor = async (
    entry: SourceEntry,
    signal?: AbortSignal,
    sourceValidationUnavailableIsLocal = false,
  ): Promise<Readonly<{ ops: PluginExternalSessionsProviderOps; source: ExternalSessionsSource }>> => {
    assertNotAborted(signal);
    if (!isCurrent()) fail('plugin_generation_retired');
    const ops = await params.resolveProviderOps(entry.agentId);
    assertNotAborted(signal);
    if (!isCurrent()) fail('plugin_generation_retired');
    if (!ops) fail('plugin_external_agent_unavailable');
    if (!entry.validatedAtAdmission) {
      const validation = await ops.validateSource({ source: entry.source, ...(signal ? { signal } : {}) });
      assertNotAborted(signal);
      if (!isCurrent()) fail('plugin_generation_retired');
      if (!validation.ok) {
        if (sourceValidationUnavailableIsLocal) {
          throw new ExternalSessionSourceValidationUnavailableError();
        }
        fail('plugin_external_source_unavailable');
      }
      if (!preservesExternalSessionSourceIdentity(entry.source, validation.source)) {
        fail('plugin_external_source_unavailable');
      }
      return Object.freeze({ ops, source: validation.source });
    }
    return Object.freeze({ ops, source: entry.source });
  };
  const publicRefSourceFor = async (paramsForRef: Readonly<{
    entry: SourceEntry;
    ref: HostExternalSessionRef;
    ops: PluginExternalSessionsProviderOps;
    source: ExternalSessionsSource;
    signal: AbortSignal;
  }>): Promise<ExternalSessionsSource> => {
    const identity = await resolveExternalSessionLinkIdentityFromSurface({
      agentId: paramsForRef.entry.agentId,
      remoteSessionId: paramsForRef.ref.remoteSessionId,
      source: paramsForRef.source,
      signal: paramsForRef.signal,
    }, paramsForRef.ops);
    assertNotAborted(paramsForRef.signal);
    if (!isCurrent() || params.retirementSignal?.aborted) {
      fail('plugin_generation_retired');
    }
    return identity.source;
  };
  /**
   * The one live Follow-availability decision, shared by every surface that can
   * advertise or acquire Follow: the global capability, each listed row, and
   * acquisition itself.
   *
   * `supportsFollow` is a static source-shape fact snapshotted at materialization; it
   * cannot observe whether host operations were ever installed. A surface that reads
   * only that snapshot advertises an operation this decision refuses, so all three
   * read it here instead of re-deriving their own answer.
   */
  const hostFollowAvailableNow = (): boolean => (
    params.followTranscript !== undefined
    && (params.canFollowNow === undefined || params.canFollowNow())
  );
  const sourceFollowAvailableNow = (entry: Readonly<{ supportsFollow?: boolean }>): boolean => (
    entry.supportsFollow === true && hostFollowAvailableNow()
  );
  const caps = () => {
    const current = isCurrent();
    const hasSources = current && params.sources.length > 0;
    return Object.freeze({
      list: hasSources ? available() : unavailable(current ? 'plugin_external_list_unavailable' : 'plugin_generation_retired'),
      attach: hasSources && params.attach ? available() : unavailable(current ? 'plugin_external_attach_unavailable' : 'plugin_generation_retired'),
      takeover: unavailable(current ? 'plugin_external_takeover_unavailable' : 'plugin_generation_retired'),
      transcript: hasSources ? available() : unavailable(current ? 'plugin_external_transcript_unavailable' : 'plugin_generation_retired'),
      follow: hasSources && params.sources.some(sourceFollowAvailableNow)
        ? available()
        : unavailable(current ? 'plugin_external_follow_unavailable' : 'plugin_generation_retired'),
    });
  };
  const service: Omit<PluginExternalSessionsDomainAuthorService, 'followTranscript'>
    & ExternalSessionsCompositionPort = {
    capabilities: caps,
    async list(query: NonNullable<Parameters<PluginExternalSessionsDomainAuthorService['list']>[0]> = {}) {
      return await runBoundedOperation(query.signal, 'plugin_external_list_failed', async (operationSignal) => {
        assertAvailable(caps().list);
        const queryKey = JSON.stringify([query.agentId ?? null, query.sourceId ?? null]);
        const listPolicy = EXTERNAL_SESSIONS_INVOCATION_POLICY.listCandidates;
        const limit = boundedInteger(
          query.limit,
          listPolicy.maxItems,
          listPolicy.maxItems,
          'plugin_external_limit_invalid',
        );
        const maxBytes = boundedInteger(
          query.maxBytes,
          DEFAULT_LIST_MAX_BYTES,
          listPolicy.maxSerializedBytes,
          'plugin_external_max_bytes_invalid',
        );
        let snapshot: ListSnapshot;
        if (query.cursor) {
          if (!query.cursor.startsWith(CURSOR_PREFIX)) fail('plugin_external_cursor_invalid');
          snapshot = snapshots.get(query.cursor)?.snapshot ?? fail('plugin_external_cursor_invalid');
          deleteSnapshot(query.cursor);
          if (snapshot.queryKey !== queryKey) fail('plugin_external_cursor_invalid');
        } else {
          const entries = params.sources.filter((entry) => !query.agentId || entry.agentId === query.agentId).filter((entry) => !query.sourceId || entry.sourceId === query.sourceId);
          if (entries.length === 0) fail('plugin_external_source_unavailable');
          if (entries.length > MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION) {
            fail('plugin_external_inventory_capacity_exceeded');
          }
          snapshot = {
            queryKey,
            sources: Object.freeze(entries.map((entry): ListSourceSnapshot => ({
              entry,
              items: Object.freeze([]),
              offset: 0,
              exhausted: false,
              pagesRead: 0,
              consecutiveEmptyPages: 0,
              seenCursors: new Set<string>(),
              emittedPublicRefKeys: new Set<string>(),
            }))),
            refillStartIndex: 0,
          };
        }

      const diagnosticBySource = new Map<string, PluginDiagnosticData>();
      const diagnosticKey = (sourceState: ListSourceSnapshot): string => (
        `${sourceState.entry.agentId}\u0000${sourceState.entry.sourceId}`
      );
      const publishSourceDiagnostic = (sourceState: ListSourceSnapshot, code: string): void => {
        diagnosticBySource.set(diagnosticKey(sourceState), Object.freeze({
          code,
          severity: 'warning',
          details: Object.freeze({
            agentId: sourceState.entry.agentId,
            sourceId: sourceState.entry.sourceId,
          }),
        }));
      };
      const setSourceDiagnostic = (sourceState: ListSourceSnapshot, code: string): void => {
        sourceState.diagnosticCode = code;
        publishSourceDiagnostic(sourceState, code);
      };
      const clearSourceDiagnostic = (sourceState: ListSourceSnapshot): void => {
        sourceState.diagnosticCode = undefined;
        if (sourceState.publicRefCollision) {
          publishSourceDiagnostic(sourceState, PUBLIC_REF_COLLISION_DIAGNOSTIC);
        } else {
          diagnosticBySource.delete(diagnosticKey(sourceState));
        }
      };
      const markPublicRefCollision = (sourceState: ListSourceSnapshot): void => {
        sourceState.publicRefCollision = true;
        if (!sourceState.diagnosticCode) {
          publishSourceDiagnostic(sourceState, PUBLIC_REF_COLLISION_DIAGNOSTIC);
        }
      };
      for (const sourceState of snapshot.sources) {
        if (sourceState.diagnosticCode) {
          setSourceDiagnostic(sourceState, sourceState.diagnosticCode);
        } else if (sourceState.publicRefCollision) {
          publishSourceDiagnostic(sourceState, PUBLIC_REF_COLLISION_DIAGNOSTIC);
        }
      }

      const readNextProviderPage = async (
        sourceState: ListSourceSnapshot,
        sourceSignal: AbortSignal,
      ): Promise<void> => {
        if (sourceState.exhausted) return;
        if (sourceState.pagesRead >= MAX_PROVIDER_PAGES_PER_SOURCE) {
          fail('plugin_external_inventory_capacity_exceeded');
        }
        const { ops, source } = await providerFor(sourceState.entry, sourceSignal, true);
        const requestedCursor = sourceState.providerCursor;
        const page = params.queryCandidates
          ? await params.queryCandidates({
            entry: sourceState.entry,
            ops,
            source,
            ...(requestedCursor ? { cursor: requestedCursor } : {}),
            limit,
            maxBytes,
            signal: sourceSignal,
          })
          : await ops.listCandidates({
            source,
            ...(requestedCursor ? { cursor: requestedCursor } : {}),
            limit,
            maxBytes,
            signal: sourceSignal,
          });
        if (!page || typeof page !== 'object' || !Array.isArray(page.candidates)) {
          throw new MalformedExternalSessionCandidatePageError();
        }
        assertNotAborted(sourceSignal);
        if (!isCurrent()) fail('plugin_generation_retired');
        if (page.preparation && !params.queryCandidates) {
          fail('plugin_external_candidate_index_owner_unavailable');
        }
        /**
         * A preparation response is candidate-index build progress, not a page. It
         * carries no continuation, its rows are a prefix the next build chunk may
         * still reorder, and it proves neither a head nor exhaustion — so it is not
         * a provider page read and must not consume this source's pagination budget.
         * Head acquisition keeps driving the build inside its own source budget until
         * the index answers with a real page; if the build cannot finish inside that
         * budget the source resolves as its own local timeout diagnostic, leaving
         * every ready source publishable.
         */
        if (page.preparation) return;
        if (page.candidates.length > limit) {
          throw new MalformedExternalSessionCandidatePageError();
        }
        if (page.candidates.some(
          (candidate) => !ExternalSessionRefSchema.shape.remoteSessionId
            .safeParse(candidate.remoteSessionId).success,
        )) {
          throw new MalformedExternalSessionCandidatePageError();
        }
        const nextCursor = page.nextCursor ?? undefined;
        sourceState.pagesRead += 1;
        const emptyContinuation = page.candidates.length === 0 && nextCursor !== undefined;
        sourceState.consecutiveEmptyPages = emptyContinuation && requestedCursor !== undefined
          ? sourceState.consecutiveEmptyPages + 1
          : 0;
        const emptyCapacityExceeded = emptyContinuation
          && sourceState.consecutiveEmptyPages > MAX_EMPTY_PROVIDER_PAGES_PER_SOURCE;
        if (emptyCapacityExceeded) {
          sourceState.providerCursor = undefined;
          sourceState.exhausted = true;
          setSourceDiagnostic(sourceState, 'plugin_external_inventory_capacity_exceeded');
        } else if (nextCursor) {
          if (
            nextCursor === requestedCursor
            || sourceState.seenCursors.has(nextCursor)
          ) {
            fail('plugin_external_inventory_capacity_exceeded');
          }
          sourceState.seenCursors.add(nextCursor);
          sourceState.providerCursor = nextCursor;
          if (emptyContinuation) {
            setSourceDiagnostic(sourceState, 'plugin_external_source_page_empty');
          } else {
            clearSourceDiagnostic(sourceState);
          }
        } else {
          sourceState.providerCursor = undefined;
          sourceState.exhausted = true;
          clearSourceDiagnostic(sourceState);
        }
        const mapped = page.candidates.map((providerCandidate): ListCandidate => {
          const ref = Object.freeze({
            agentId: sourceState.entry.agentId,
            remoteSessionId: providerCandidate.remoteSessionId,
            sourceId: sourceState.entry.sourceId,
          });
          return Object.freeze({
            candidate: Object.freeze({
              ref,
              ...(providerCandidate.title ? { title: providerCandidate.title } : {}),
              ...(providerCandidate.updatedAtMs !== undefined ? { updatedAtMs: providerCandidate.updatedAtMs } : {}),
              capabilities: Object.freeze([
                ...(params.attach ? ['attach' as const] : []),
                'transcript' as const,
                ...(sourceFollowAvailableNow(sourceState.entry) ? ['follow' as const] : []),
              ]),
            }),
            publicRefKey: publicRefKey(ref),
            privateCandidateIdentityKey: resolveExternalSessionCandidateIdentityKey(providerCandidate),
          });
        }).sort(compareCandidates);
        const pagePublicRefKeys = new Set<string>();
        const unique = Object.freeze(mapped.filter((candidate) => {
          if (
            sourceState.emittedPublicRefKeys.has(candidate.publicRefKey)
            || pagePublicRefKeys.has(candidate.publicRefKey)
          ) {
            markPublicRefCollision(sourceState);
            return false;
          }
          pagePublicRefKeys.add(candidate.publicRefKey);
          return true;
        }));
        try {
          assertSerializedBytes(Object.freeze({
            items: unique.map((candidate) => candidate.candidate),
          }), maxBytes);
        } catch (error) {
          if (
            isPluginError(error)
            && error.code === 'plugin_external_response_capacity_exceeded'
          ) {
            throw new MalformedExternalSessionCandidatePageError();
          }
          throw error;
        }
        sourceState.items = unique;
        sourceState.offset = 0;
      };

      const throwOperationAbort = (): never => {
        if (!isCurrent() || params.retirementSignal?.aborted) {
          fail('plugin_generation_retired');
        }
        if (query.signal?.aborted) fail('plugin_operation_aborted');
        fail('plugin_operation_deadline_exceeded');
      };
      const isCallFatalListFailure = (error: unknown): boolean => (
        isPluginError(error)
        && (
          error.code === 'plugin_external_inventory_capacity_exceeded'
          || error.code === 'plugin_external_response_capacity_exceeded'
          || error.code === 'plugin_external_candidate_index_owner_unavailable'
          || error.code === 'plugin_external_cursor_invalid'
          || error.code === 'plugin_generation_retired'
          || error.code === 'plugin_operation_aborted'
          || error.code === 'plugin_operation_deadline_exceeded'
        )
      );
      const sourceFailureCode = (error: unknown, timedOut: boolean): string => {
        if (timedOut) return 'plugin_external_source_timeout';
        if (error instanceof ExternalSessionSourceValidationUnavailableError) {
          return 'plugin_external_source_unavailable';
        }
        return 'plugin_external_source_failed';
      };
      const acquireCompleteHead = async (sourceState: ListSourceSnapshot): Promise<void> => {
        if (sourceState.exhausted || sourceState.offset < sourceState.items.length) return;
        const deadline = new AbortController();
        const timeout = setTimeout(
          () => deadline.abort(),
          LIST_HEAD_ACQUISITION_TIMEOUT_MS,
        );
        const sourceSignal = AbortSignal.any([operationSignal, deadline.signal]);
        try {
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => reject(new DOMException('Source acquisition aborted', 'AbortError'));
            if (sourceSignal.aborted) {
              reject(new DOMException('Source acquisition aborted', 'AbortError'));
              return;
            }
            sourceSignal.addEventListener('abort', onAbort, { once: true });
            void (async () => {
              while (
                !sourceState.exhausted
                && sourceState.offset >= sourceState.items.length
              ) {
                await readNextProviderPage(sourceState, sourceSignal);
              }
            })().then(resolve, reject).finally(() => {
              sourceSignal.removeEventListener('abort', onAbort);
            });
          });
        } catch (error) {
          if (operationSignal.aborted) throwOperationAbort();
          if (isCallFatalListFailure(error)) throw error;
          if (
            !deadline.signal.aborted
            && !(error instanceof ExternalSessionProviderFailureError)
            && !(error instanceof MalformedExternalSessionCandidatePageError)
            && !(error instanceof ExternalSessionSourceValidationUnavailableError)
          ) {
            throw error;
          }
          sourceState.items = Object.freeze([]);
          sourceState.offset = 0;
          sourceState.providerCursor = undefined;
          sourceState.exhausted = true;
          setSourceDiagnostic(sourceState, sourceFailureCode(error, deadline.signal.aborted));
        } finally {
          clearTimeout(timeout);
        }
      };
      const fillMissingHeads = async (): Promise<void> => {
        const pending: ListSourceSnapshot[] = [];
        for (let offset = 0; offset < snapshot.sources.length; offset += 1) {
          const index = (snapshot.refillStartIndex + offset) % snapshot.sources.length;
          const sourceState = snapshot.sources[index]!;
          if (
            !sourceState.exhausted
            && sourceState.offset >= sourceState.items.length
          ) {
            pending.push(sourceState);
          }
        }
        if (pending.length > 0) {
          const lastIndex = snapshot.sources.indexOf(pending[pending.length - 1]!);
          snapshot.refillStartIndex = (lastIndex + 1) % snapshot.sources.length;
        }
        let nextIndex = 0;
        const worker = async (): Promise<void> => {
          while (nextIndex < pending.length) {
            const sourceState = pending[nextIndex];
            nextIndex += 1;
            if (sourceState) await acquireCompleteHead(sourceState);
          }
        };
        const outcomes = await Promise.allSettled(
          Array.from(
            { length: Math.min(MAX_CONCURRENT_LIST_HEAD_ACQUISITIONS, pending.length) },
            worker,
          ),
        );
        const failure = outcomes.find(
          (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
        );
        if (failure) throw failure.reason;
      };

      await fillMissingHeads();
      const items: HostExternalSessionCandidate[] = [];
      while (items.length < limit) {
        let selected: ListSourceSnapshot | null = null;
        for (const sourceState of snapshot.sources) {
          const candidate = sourceState.items[sourceState.offset];
          if (!candidate) continue;
          const selectedCandidate = selected?.items[selected.offset];
          if (!selectedCandidate || compareCandidates(candidate, selectedCandidate) < 0) {
            selected = sourceState;
          }
        }
        if (!selected) {
          const hasMissingHead = snapshot.sources.some(
            (sourceState) => !sourceState.exhausted
              && sourceState.offset >= sourceState.items.length,
          );
          if (!hasMissingHead) break;
          await fillMissingHeads();
          continue;
        }
        const selectedCandidate = selected.items[selected.offset]!;
        selected.offset += 1;
        if (selected.emittedPublicRefKeys.has(selectedCandidate.publicRefKey)) {
          markPublicRefCollision(selected);
          continue;
        }
        selected.emittedPublicRefKeys.add(selectedCandidate.publicRefKey);
        items.push(selectedCandidate.candidate);
      }

      const retainedItems = snapshot.sources.reduce(
        (count, sourceState) => count + Math.max(0, sourceState.items.length - sourceState.offset),
        0,
      );
      if (retainedItems > MAX_SNAPSHOT_ITEMS) fail('plugin_external_inventory_capacity_exceeded');
      const retained = snapshot.sources.flatMap((sourceState) => (
        sourceState.items
          .slice(sourceState.offset)
          .map((candidate) => candidate.candidate)
      ));
      if (serializedBytes(retained, MAX_SNAPSHOT_BYTES) > MAX_SNAPSHOT_BYTES) fail('plugin_external_inventory_capacity_exceeded');
      const hasMore = snapshot.sources.some(
        (sourceState) => sourceState.offset < sourceState.items.length || !sourceState.exhausted,
      );
      let nextCursor: string | undefined;
      if (hasMore) {
        nextCursor = `${CURSOR_PREFIX}${randomUUID()}`;
      }
      const diagnostics = Object.freeze(snapshot.sources.flatMap((sourceState) => {
        const diagnostic = diagnosticBySource.get(diagnosticKey(sourceState));
        return diagnostic ? [diagnostic] : [];
      }));
      const result = Object.freeze({
        items: Object.freeze(items),
        ...(nextCursor
          ? { nextCursor }
          : items.length === 0 && diagnostics.length === snapshot.sources.length
            ? { nextCursor: null }
            : {}),
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
      });
      assertSerializedBytes(result, maxBytes);
      assertNotAborted(operationSignal);
      if (!isCurrent()) fail('plugin_generation_retired');
      if (nextCursor) retainSnapshot(nextCursor, snapshot);
      return result;
      });
    },
    async attach(ref: HostExternalSessionRef, options?: Parameters<PluginExternalSessionsDomainAuthorService['attach']>[1]) {
      return await runBoundedOperation(options?.signal, 'plugin_external_attach_failed', async (operationSignal) => {
        assertAvailable(caps().attach);
        const entry = sourceFor(ref);
        const { ops, source } = await providerFor(entry, operationSignal);
        const resolvedSource = await publicRefSourceFor({
          entry,
          ref,
          ops,
          source,
          signal: operationSignal,
        });
        assertNotAborted(operationSignal);
        const result = await params.attach!(ref, resolvedSource, { signal: operationSignal });
        if (!isCurrent()) fail('plugin_generation_retired');
        return projectExternalSessionAttachResult(result);
      }, { settleAfterCallerAbort: true });
    },
    async resolveFollowTarget(input): Promise<HostExternalSessionFollowTargetResolution> {
      return await resolvePluginExternalSessionFollowTarget({
        agentId: input.agentId,
        remoteSessionId: input.remoteSessionId,
        ...(input.boundSource === undefined
          ? {}
          : { boundSource: input.boundSource }),
        ...(input.admissionDeadlineAtMs === undefined
          ? {}
          : { admissionDeadlineAtMs: input.admissionDeadlineAtMs }),
        sources: params.sources,
        resolveProviderOps: params.resolveProviderOps,
        isCurrent,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(params.retirementSignal
          ? { retirementSignal: params.retirementSignal }
          : {}),
      });
    },
    async readTranscript(ref: HostExternalSessionRef, query: NonNullable<Parameters<PluginExternalSessionsDomainAuthorService['readTranscript']>[1]> = {}) {
      return await runBoundedOperation(query.signal, 'plugin_external_transcript_read_failed', async (operationSignal) => {
        assertAvailable(caps().transcript);
        const entry = sourceFor(ref);
        const { ops, source } = await providerFor(entry, operationSignal);
        const resolvedSource = await publicRefSourceFor({
          entry,
          ref,
          ops,
          source,
          signal: operationSignal,
        });
        const transcriptPolicy = query.mode === 'readAfter'
          ? EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript
          : EXTERNAL_SESSIONS_INVOCATION_POLICY.pageTranscript;
        const maxBytes = boundedInteger(
          query.maxBytes,
          transcriptPolicy.maxSerializedBytes,
          transcriptPolicy.maxSerializedBytes,
          'plugin_external_max_bytes_invalid',
        );
        const maxItems = boundedInteger(
          query.limit,
          transcriptPolicy.maxItems,
          transcriptPolicy.maxItems,
          'plugin_external_limit_invalid',
        );
        if (query.mode !== undefined && query.mode !== 'page' && query.mode !== 'readAfter') {
          fail('plugin_external_transcript_read_mode_invalid');
        }
        if (query.mode === 'readAfter') {
          if (typeof query.cursor !== 'string' || query.cursor.length === 0) {
            fail('plugin_external_cursor_invalid');
          }
          if (!ops.readAfterTranscript) fail('plugin_external_read_after_unavailable');
          const readAfter = await ops.readAfterTranscript({
            source: resolvedSource,
            remoteSessionId: ref.remoteSessionId,
            cursor: query.cursor,
            maxBytes,
            maxItems,
            signal: operationSignal,
          });
          assertNotAborted(operationSignal);
          if (!isCurrent()) fail('plugin_generation_retired');
          if (readAfter.outcome !== 'advanced') {
            const result = Object.freeze({
              mode: 'readAfter' as const,
              outcome: readAfter.outcome,
            });
            assertSerializedBytes(result, maxBytes);
            return result;
          }
          if (readAfter.items.length > maxItems) {
            fail('plugin_external_inventory_capacity_exceeded');
          }
          const result = Object.freeze({
            mode: 'readAfter' as const,
            outcome: 'advanced' as const,
            items: Object.freeze(readAfter.items.map((item) =>
              projectAuthorExternalTranscriptItem(mapPluginExternalTranscriptItem(item)))),
            nextCursor: readAfter.nextCursor,
            boundary: readAfter.boundary,
            ...(readAfter.diagnostics
              ? { diagnostics: projectReadAfterDiagnostics(readAfter.diagnostics) }
              : {}),
          });
          assertSerializedBytes(result, maxBytes);
          return result;
        }
        const page = await ops.pageTranscript({
          source: resolvedSource,
          remoteSessionId: ref.remoteSessionId,
          direction: query.direction ?? 'older',
          ...(query.cursor ? { cursor: query.cursor } : {}),
          maxBytes,
          maxItems,
          signal: operationSignal,
        });
        assertNotAborted(operationSignal);
        if (!isCurrent()) fail('plugin_generation_retired');
        if (page.items.length > maxItems) {
          fail('plugin_external_inventory_capacity_exceeded');
        }
        const result = Object.freeze({
          mode: 'page' as const,
          items: Object.freeze(page.items.map((item) =>
            projectAuthorExternalTranscriptItem(mapPluginExternalTranscriptItem(item)))),
          nextCursor: page.nextCursor ?? null,
          ...(page.tailCursor !== undefined ? { tailCursor: page.tailCursor } : {}),
          ...(page.hasMore !== undefined ? { hasMore: page.hasMore } : {}),
          ...(page.truncated !== undefined ? { truncated: page.truncated } : {}),
        });
        assertSerializedBytes(result, maxBytes);
        return result;
      });
    },
    async followTranscript(
      target: Parameters<ExternalSessionsCompositionPort['followTranscript']>[0],
      options: Parameters<ExternalSessionsCompositionPort['followTranscript']>[1],
      listener: Parameters<ExternalSessionsCompositionPort['followTranscript']>[2],
    ): Promise<HostExternalTranscriptFollowResult> {
      const unavailableResult = (code: string): HostExternalTranscriptFollowResult => Object.freeze({
        status: 'unavailable',
        code,
      });
      const rawRequestedCursor: unknown = (options as Readonly<{ cursor?: unknown }>).cursor;
      if (rawRequestedCursor !== undefined
        && (typeof rawRequestedCursor !== 'string' || rawRequestedCursor.length === 0)) {
        return unavailableResult('plugin_external_cursor_invalid');
      }
      let entry: SourceEntry;
      try {
        entry = sourceFor(target.ref);
      } catch (error) {
        return unavailableResult(
          isPluginError(error) ? error.code : 'plugin_external_source_unavailable',
        );
      }
      if (!sourceFollowAvailableNow(entry)) {
        return unavailableResult('plugin_external_follow_unavailable');
      }
      try {
        return await runBoundedOperation(
          options.signal,
          'plugin_external_follow_acquisition_failed',
          async (operationSignal) => {
            if (target.source.kind !== entry.source.kind) {
              fail('plugin_external_follow_identity_mismatch');
            }
            assertSerializedBytes(
              target.source,
              EXTERNAL_SESSIONS_INVOCATION_POLICY.sourceMaxSerializedBytes,
            );
            const ops = await params.resolveProviderOps(entry.agentId);
            assertNotAborted(operationSignal);
            if (!isCurrent()) fail('plugin_generation_retired');
            if (!ops) fail('plugin_external_agent_unavailable');
            const validatedSource = entry.validatedAtAdmission
              ? entry.source
              : await (async () => {
                  const validation = await ops.validateSource({
                    source: target.source,
                    signal: operationSignal,
                  });
                  assertNotAborted(operationSignal);
                  if (!isCurrent()) fail('plugin_generation_retired');
                  return validation.ok ? validation.source : null;
                })();
            if (
              !validatedSource
              || !preservesExternalSessionSourceIdentity(entry.source, validatedSource)
            ) {
              fail('plugin_external_source_unavailable');
            }
            if (!preservesExternalSessionSourceIdentity(target.source, validatedSource)) {
              if (!ops.resolveLinkIdentity) {
                fail('plugin_external_source_unavailable');
              }
              const resolvedIdentity = await ops.resolveLinkIdentity({
                source: validatedSource,
                remoteSessionId: target.ref.remoteSessionId,
                signal: operationSignal,
              });
              assertNotAborted(operationSignal);
              if (
                !isCurrent()
                || resolvedIdentity.remoteSessionId !== target.ref.remoteSessionId
                || !preservesExternalSessionSourceIdentity(
                  target.source,
                  resolvedIdentity.source,
                )
              ) {
                fail('plugin_external_source_unavailable');
              }
            }
            if (!ops.readAfterTranscript) {
              fail('plugin_external_follow_unavailable');
            }
            return await params.followTranscript!({
              ref: target.ref,
              source: target.source,
              options: Object.freeze({
                ...(typeof rawRequestedCursor === 'string'
                  ? { cursor: rawRequestedCursor }
                  : {}),
                ...(options.initialReplay ? { initialReplay: true } : {}),
                ...(options.admissionDeadlineAtMs !== undefined
                  ? { admissionDeadlineAtMs: options.admissionDeadlineAtMs }
                  : {}),
                signal: operationSignal,
              }),
              listener,
            });
          },
          {
            ...(options.admissionDeadlineAtMs === undefined
              ? {}
              : { deadlineAtMs: options.admissionDeadlineAtMs }),
          },
        );
      } catch (error) {
        const code = isPluginError(error)
          ? error.code
          : options.signal?.aborted
            ? 'plugin_operation_aborted'
            : params.retirementSignal?.aborted || !isCurrent()
              ? 'plugin_generation_retired'
              : 'plugin_external_follow_acquisition_failed';
        return unavailableResult(code);
      }
    },
  };
  const followAuthorTranscript: PluginExternalSessionsDomainAuthorService['followTranscript'] = async (
    ref,
    options,
    listener,
  ) => {
    const availability = caps().follow;
    if (availability.status === 'unavailable') {
      return Object.freeze({
        status: 'unavailable' as const,
        code: availability.code,
      });
    }
    const resolvedTarget = await resolvePluginExternalSessionFollowTarget({
      agentId: ref.agentId,
      sourceId: ref.sourceId,
      remoteSessionId: ref.remoteSessionId,
      sources: params.sources,
      resolveProviderOps: params.resolveProviderOps,
      isCurrent,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(params.retirementSignal
        ? { retirementSignal: params.retirementSignal }
        : {}),
    });
    if (resolvedTarget.status === 'unavailable') return resolvedTarget;
    return await service.followTranscript(resolvedTarget, options, listener);
  };
  const unwrapListCursor = (cursor: string): string | null => {
    if (!cursor.startsWith(CURSOR_PREFIX) || !snapshots.has(cursor)) {
      return null;
    }
    if (!isCurrent() || params.retirementSignal?.aborted) {
      fail('plugin_generation_retired');
    }
    return cursor;
  };
  const listAuthor: PluginExternalSessionsDomainAuthorService['list'] = async (
    query,
    options,
  ) => {
    const parsedQuery = params.parseAuthorListQuery
      ? params.parseAuthorListQuery(query, unwrapListCursor)
      : query;
    return await service.list(Object.freeze({
      ...parsedQuery,
      ...(options?.signal ? { signal: options.signal } : {}),
    }));
  };
  return Object.freeze({
    authorService: Object.freeze({
      capabilities: service.capabilities,
      list: listAuthor,
      attach: service.attach,
      readTranscript: service.readTranscript,
      followTranscript: followAuthorTranscript,
    }),
    compositionPort: Object.freeze({
      resolveFollowTarget: service.resolveFollowTarget,
      followTranscript: service.followTranscript,
    }),
  });
}
