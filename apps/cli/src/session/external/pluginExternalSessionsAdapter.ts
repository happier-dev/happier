import { PluginError, type JsonValue, type PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import { type PluginOperationAvailability } from '@happier-dev/plugin-sdk/runtime';
import {
  ExternalSessionsAgentIdSchema,
  MAX_PLUGIN_TRANSCRIPT_SOURCES_PER_CONTRIBUTION,
  type ExternalSessionsAgentId,
  type ExternalSessionsSource,
  type ExternalSessionTranscriptRawMessageV1,
  type PluginContributionIdentityV1,
} from '@happier-dev/protocol';
import { AgentRuntimeJsonValueV1Schema } from '@happier-dev/protocol/runtime';
import { randomUUID } from 'node:crypto';

import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from './agentExternalSessionsInvocation';
import type {
  HostExternalSessionCandidate,
  HostExternalSessionFollowTargetResolution,
  HostExternalSessionRef,
  HostExternalSessionsService,
  HostExternalTranscriptFollowResult,
  HostExternalTranscriptItem,
} from './privateContract';
import type { ExternalSessionProviderOps } from './providerOps';
import {
  ExternalSessionProviderFailureError,
  toLegacyTranscriptSourceReadAfter,
} from './providerOps';

type SourceEntry = Readonly<{
  agentId: ExternalSessionsAgentId;
  agentIdentity?: PluginContributionIdentityV1;
  sourceId: string;
  source: ExternalSessionsSource;
  supportsFollow?: boolean;
}>;
export type PluginExternalSessionSourceEntry = SourceEntry;
export type PluginExternalSessionsProviderOps = Pick<
  ExternalSessionProviderOps,
  'validateSource' | 'listCandidates' | 'pageTranscript'
> & Partial<Pick<
  ExternalSessionProviderOps,
  'readAfterTranscript' | 'resolveLinkIdentity'
>>;
type ListSourceSnapshot = {
  entry: SourceEntry;
  providerCursor?: string;
  items: readonly HostExternalSessionCandidate[];
  offset: number;
  exhausted: boolean;
  pagesRead: number;
  consecutiveEmptyPages: number;
  diagnosticCode?: string;
  seenCursors: Set<string>;
};
type ListSnapshot = { queryKey: string; sources: readonly ListSourceSnapshot[]; refillStartIndex: number };
const CURSOR_PREFIX = 'plugin_external_sessions_v1_';
const MAX_CURSOR_SNAPSHOTS = 128;
const MAX_PROVIDER_PAGES_PER_SOURCE = 100;
const MAX_EMPTY_PROVIDER_PAGES_PER_SOURCE = 8;
const MAX_SNAPSHOT_ITEMS = 10_000;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const DEFAULT_LIST_MAX_BYTES = 512 * 1024;
const MAX_REMOTE_SESSION_ID_CODE_UNITS = 2_000;

function compareCandidates(
  left: HostExternalSessionCandidate,
  right: HostExternalSessionCandidate,
): number {
  return (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0)
    || left.ref.agentId.localeCompare(right.ref.agentId)
    || left.ref.sourceId.localeCompare(right.ref.sourceId)
    || left.ref.remoteSessionId.localeCompare(right.ref.remoteSessionId);
}

function unavailable(code: string): PluginOperationAvailability {
  return Object.freeze({ status: 'unavailable' as const, code });
}
function available(): PluginOperationAvailability { return Object.freeze({ status: 'available' as const }); }
function fail(code: string): never { throw new PluginError({ code, message: code }); }
function failure(code: string): PluginError { return new PluginError({ code, message: code }); }
function serviceFailure(error: unknown, fallbackCode: string): PluginError {
  if (error instanceof PluginError) return error;
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
  if (!Number.isFinite(value) || value <= 0) fail(code);
  return Math.min(max, Math.trunc(value));
}
function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) fail('plugin_operation_aborted');
}
function serializedBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) fail('plugin_external_response_invalid');
    return new TextEncoder().encode(serialized).byteLength;
  } catch (error) {
    if (error instanceof PluginError) throw error;
    fail('plugin_external_response_invalid');
  }
}
function assertSerializedBytes(value: unknown, maxBytes: number): void {
  if (serializedBytes(value) > maxBytes) fail('plugin_external_response_capacity_exceeded');
}

function unavailableFollowTarget(code: string): HostExternalSessionFollowTargetResolution {
  return Object.freeze({ status: 'unavailable', code });
}

export async function resolvePluginExternalSessionFollowTarget(params: Readonly<{
  agentId: string;
  remoteSessionId: string;
  sources: readonly PluginExternalSessionSourceEntry[];
  resolveProviderOps: (
    agentId: ExternalSessionsAgentId,
  ) => Promise<PluginExternalSessionsProviderOps | null>;
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
  const deadline = new AbortController();
  const timeout = setTimeout(
    () => deadline.abort(),
    EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs,
  );
  const operationSignal = AbortSignal.any([
    deadline.signal,
    ...(params.retirementSignal ? [params.retirementSignal] : []),
    ...(params.signal ? [params.signal] : []),
  ]);
  const checkCurrent = (): void => {
    if (!isCurrent() || params.retirementSignal?.aborted) {
      fail('plugin_generation_retired');
    }
    if (params.signal?.aborted) fail('plugin_operation_aborted');
    if (deadline.signal.aborted) fail('plugin_operation_deadline_exceeded');
  };
  try {
    checkCurrent();
    const parsedAgentId = ExternalSessionsAgentIdSchema.safeParse(params.agentId);
    if (
      !parsedAgentId.success
      || typeof params.remoteSessionId !== 'string'
      || params.remoteSessionId.trim().length === 0
      || params.remoteSessionId !== params.remoteSessionId.trim()
      || params.remoteSessionId.length > MAX_REMOTE_SESSION_ID_CODE_UNITS
    ) {
      return unavailableFollowTarget('plugin_external_follow_identity_unavailable');
    }
    const entries = params.sources.filter(
      (entry) => (
        entry.agentId === parsedAgentId.data
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
        const configured = await ops.validateSource({
          source: entry.source,
          signal: operationSignal,
        });
        checkCurrent();
        if (!configured.ok) {
          return Object.freeze({ kind: 'unavailable' as const });
        }
        const identity = await ops.resolveLinkIdentity({
          source: configured.source,
          remoteSessionId: params.remoteSessionId,
          signal: operationSignal,
        });
        checkCurrent();
        if (
          identity.remoteSessionId !== params.remoteSessionId
          || identity.source.kind !== configured.source.kind
        ) {
          return Object.freeze({ kind: 'unavailable' as const });
        }
        assertSerializedBytes(
          identity.source,
          EXTERNAL_SESSIONS_INVOCATION_POLICY.sourceMaxSerializedBytes,
        );
        const canonical = await ops.validateSource({
          source: identity.source,
          signal: operationSignal,
        });
        checkCurrent();
        if (!canonical.ok || canonical.source.kind !== configured.source.kind) {
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
  } catch (error) {
    const code = error instanceof PluginError
      && (
        error.code === 'plugin_operation_aborted'
        || error.code === 'plugin_operation_deadline_exceeded'
        || error.code === 'plugin_generation_retired'
      )
      ? error.code
      : 'plugin_external_follow_identity_unavailable';
    return unavailableFollowTarget(code);
  } finally {
    clearTimeout(timeout);
  }
}
type PlainJsonSnapshotState = { seen: Set<object>; nodes: number };

function snapshotPlainJson(
  value: unknown,
  state: PlainJsonSnapshotState = { seen: new Set<object>(), nodes: 0 },
  depth = 0,
): JsonValue {
  state.nodes += 1;
  if (state.nodes > 8_192 || depth > 24) fail('plugin_external_transcript_invalid');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('plugin_external_transcript_invalid');
    return value;
  }
  if (typeof value !== 'object') fail('plugin_external_transcript_invalid');
  if (state.seen.has(value)) fail('plugin_external_transcript_invalid');
  state.seen.add(value);
  try {
    if (Object.getOwnPropertySymbols(value).length > 0) fail('plugin_external_transcript_invalid');
    if (Array.isArray(value)) {
      const names = Object.getOwnPropertyNames(value);
      if (names.some((name) => name !== 'length' && !/^(0|[1-9][0-9]*)$/.test(name))) {
        fail('plugin_external_transcript_invalid');
      }
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail('plugin_external_transcript_invalid');
        result.push(snapshotPlainJson(descriptor.value, state, depth + 1));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail('plugin_external_transcript_invalid');
    const result = Object.create(null) as Record<string, JsonValue>;
    for (const name of Object.getOwnPropertyNames(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) fail('plugin_external_transcript_invalid');
      result[name] = snapshotPlainJson(descriptor.value, state, depth + 1);
    }
    return result;
  } finally {
    state.seen.delete(value);
  }
}

export function mapPluginExternalTranscriptItem(
  item: ExternalSessionTranscriptRawMessageV1,
): HostExternalTranscriptItem {
  const snapshot = snapshotPlainJson(item);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    fail('plugin_external_transcript_invalid');
  }
  const record = snapshot as Readonly<Record<string, JsonValue>>;
  if (typeof record.id !== 'string' || record.id.length === 0 || !('raw' in record)) {
    fail('plugin_external_transcript_invalid');
  }
  const parsed = AgentRuntimeJsonValueV1Schema.safeParse(record.raw);
  if (!parsed.success) fail('plugin_external_transcript_invalid');
  const raw = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)
    ? parsed.data as Readonly<Record<string, JsonValue>>
    : null;
  const role = record.messageRole ?? raw?.role;
  const kind = role === 'user' || role === 'agent' || role === 'system' ? role : 'event';
  const timestampMs = typeof record.createdAtMs === 'number' && Number.isFinite(record.createdAtMs)
    ? record.createdAtMs
    : undefined;
  return Object.freeze({ id: record.id, ...(timestampMs !== undefined ? { timestampMs } : {}), kind, data: parsed.data });
}

export function createPluginExternalSessionsAdapter(params: Readonly<{
  isCurrent: () => boolean;
  sources: readonly SourceEntry[];
  resolveProviderOps: (agentId: ExternalSessionsAgentId) => Promise<PluginExternalSessionsProviderOps | null>;
  queryCandidates?: (params: Readonly<{
    entry: SourceEntry;
    ops: PluginExternalSessionsProviderOps;
    source: ExternalSessionsSource;
    cursor?: string;
    limit: number;
    maxBytes: number;
    signal: AbortSignal;
  }>) => Promise<Awaited<ReturnType<PluginExternalSessionsProviderOps['listCandidates']>>>;
  attach?: (ref: HostExternalSessionRef, source: ExternalSessionsSource, options?: { signal?: AbortSignal }) => Promise<{ sessionId: string }>;
  takeover?: (ref: HostExternalSessionRef, source: ExternalSessionsSource, options?: { signal?: AbortSignal }) => Promise<{ sessionId: string; status: 'attached' | 'takenOver' }>;
  followTranscript?: (input: Readonly<{
    ref: HostExternalSessionRef;
    source: ExternalSessionsSource;
    options: Parameters<HostExternalSessionsService['followTranscript']>[1];
    listener: Parameters<HostExternalSessionsService['followTranscript']>[2];
  }>) => Promise<HostExternalTranscriptFollowResult>;
  retirementSignal?: AbortSignal;
}>): HostExternalSessionsService {
  const snapshots = new Map<string, ListSnapshot>();
  const isCurrent = () => { try { return params.isCurrent() === true; } catch { return false; } };
  const runBoundedOperation = async <T>(
    callerSignal: AbortSignal | undefined,
    failureCode: string,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (!isCurrent() || params.retirementSignal?.aborted) fail('plugin_generation_retired');
    assertNotAborted(callerSignal);
    const deadline = new AbortController();
    const timeout = setTimeout(
      () => deadline.abort(),
      EXTERNAL_SESSIONS_INVOCATION_POLICY.deadlineMs,
    );
    const signal = AbortSignal.any([
      deadline.signal,
      ...(params.retirementSignal ? [params.retirementSignal] : []),
      ...(callerSignal ? [callerSignal] : []),
    ]);
    const abortFailure = (): PluginError => {
      if (!isCurrent() || params.retirementSignal?.aborted) return failure('plugin_generation_retired');
      if (callerSignal?.aborted) return failure('plugin_operation_aborted');
      return failure('plugin_operation_deadline_exceeded');
    };
    try {
      try {
        return await new Promise<T>((resolve, reject) => {
          const onAbort = () => reject(abortFailure());
          if (signal.aborted) {
            reject(abortFailure());
            return;
          }
          signal.addEventListener('abort', onAbort, { once: true });
          Promise.resolve().then(() => operation(signal)).then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', onAbort);
          });
        });
      } catch (error) {
        throw serviceFailure(error, failureCode);
      }
    } finally {
      clearTimeout(timeout);
    }
  };
  const sourceFor = (ref: HostExternalSessionRef): SourceEntry => {
    if (!isCurrent()) fail('plugin_generation_retired');
    const entry = params.sources.find((candidate) => candidate.agentId === ref.agentId && candidate.sourceId === ref.sourceId);
    if (!entry) fail('plugin_external_source_unavailable');
    return entry;
  };
  const providerFor = async (
    entry: SourceEntry,
    signal?: AbortSignal,
  ): Promise<Readonly<{ ops: PluginExternalSessionsProviderOps; source: ExternalSessionsSource }>> => {
    assertNotAborted(signal);
    if (!isCurrent()) fail('plugin_generation_retired');
    const ops = await params.resolveProviderOps(entry.agentId);
    assertNotAborted(signal);
    if (!isCurrent()) fail('plugin_generation_retired');
    if (!ops) fail('plugin_external_agent_unavailable');
    const validation = await ops.validateSource({ source: entry.source, ...(signal ? { signal } : {}) });
    assertNotAborted(signal);
    if (!isCurrent()) fail('plugin_generation_retired');
    if (!validation.ok) fail('plugin_external_source_unavailable');
    return Object.freeze({ ops, source: validation.source });
  };
  const caps = () => {
    const current = isCurrent();
    const hasSources = current && params.sources.length > 0;
    return Object.freeze({
      list: hasSources ? available() : unavailable(current ? 'plugin_external_list_unavailable' : 'plugin_generation_retired'),
      attach: hasSources && params.attach ? available() : unavailable(current ? 'plugin_external_attach_unavailable' : 'plugin_generation_retired'),
      takeover: hasSources && params.takeover ? available() : unavailable(current ? 'plugin_external_takeover_unavailable' : 'plugin_generation_retired'),
      transcript: hasSources ? available() : unavailable(current ? 'plugin_external_transcript_unavailable' : 'plugin_generation_retired'),
      follow: hasSources && params.sources.some((source) => source.supportsFollow === true)
        ? available()
        : unavailable(current ? 'plugin_external_follow_unavailable' : 'plugin_generation_retired'),
    });
  };
  const service: HostExternalSessionsService = {
    capabilities: caps,
    async list(query: NonNullable<Parameters<HostExternalSessionsService['list']>[0]> = {}) {
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
          snapshot = snapshots.get(query.cursor) ?? fail('plugin_external_cursor_invalid');
          snapshots.delete(query.cursor);
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
            }))),
            refillStartIndex: 0,
          };
        }

      const diagnosticBySource = new Map<string, PluginDiagnosticData>();
      let candidateIndexPreparing = false;
      const diagnosticKey = (sourceState: ListSourceSnapshot): string => (
        `${sourceState.entry.agentId}\u0000${sourceState.entry.sourceId}`
      );
      const setSourceDiagnostic = (sourceState: ListSourceSnapshot, code: string): void => {
        sourceState.diagnosticCode = code;
        diagnosticBySource.set(diagnosticKey(sourceState), Object.freeze({
          code,
          severity: 'warning',
          details: Object.freeze({
            agentId: sourceState.entry.agentId,
            sourceId: sourceState.entry.sourceId,
          }),
        }));
      };
      const clearSourceDiagnostic = (sourceState: ListSourceSnapshot): void => {
        sourceState.diagnosticCode = undefined;
        diagnosticBySource.delete(diagnosticKey(sourceState));
      };
      for (const sourceState of snapshot.sources) {
        if (sourceState.diagnosticCode) setSourceDiagnostic(sourceState, sourceState.diagnosticCode);
      }

      // Each service page reserves one initial read for every selected source.
      // Further empty-page reads are bounded by both the requested item count
      // and the consecutive-empty ceiling. Provider cursors and unused heads
      // stay in the opaque continuation snapshot; the host never materializes
      // the whole provider inventory merely to return its first page.
      const readNextProviderPage = async (sourceState: ListSourceSnapshot): Promise<void> => {
        if (sourceState.exhausted) return;
        if (sourceState.pagesRead >= MAX_PROVIDER_PAGES_PER_SOURCE) {
          fail('plugin_external_inventory_capacity_exceeded');
        }
        const { ops, source } = await providerFor(sourceState.entry, operationSignal);
        const requestedCursor = sourceState.providerCursor;
        const page = params.queryCandidates
          ? await params.queryCandidates({
            entry: sourceState.entry,
            ops,
            source,
            ...(requestedCursor ? { cursor: requestedCursor } : {}),
            limit,
            maxBytes,
            signal: operationSignal,
          })
          : await ops.listCandidates({
            source,
            ...(requestedCursor ? { cursor: requestedCursor } : {}),
            limit,
            maxBytes,
            signal: operationSignal,
          });
        if (page.preparation && !params.queryCandidates) {
          fail('plugin_external_candidate_index_owner_unavailable');
        }
        candidateIndexPreparing ||= page.preparation !== undefined;
        assertNotAborted(operationSignal);
        if (!isCurrent()) fail('plugin_generation_retired');
        if (page.candidates.length > limit) {
          fail('plugin_external_inventory_capacity_exceeded');
        }
        const nextCursor = page.nextCursor ?? undefined;
        sourceState.pagesRead += 1;
        sourceState.consecutiveEmptyPages = page.candidates.length === 0
          ? sourceState.consecutiveEmptyPages + 1
          : 0;
        const emptyContinuation = page.candidates.length === 0 && nextCursor !== undefined;
        const emptyCapacityExceeded = emptyContinuation
          && sourceState.consecutiveEmptyPages >= MAX_EMPTY_PROVIDER_PAGES_PER_SOURCE;
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
        const mapped = Object.freeze(page.candidates.map((candidate) => Object.freeze({
          ref: Object.freeze({
            agentId: sourceState.entry.agentId,
            remoteSessionId: candidate.remoteSessionId,
            sourceId: sourceState.entry.sourceId,
          }),
          ...(candidate.title ? { title: candidate.title } : {}),
          ...(candidate.updatedAtMs !== undefined ? { updatedAtMs: candidate.updatedAtMs } : {}),
          capabilities: Object.freeze([
            ...(params.attach ? ['attach' as const] : []),
            ...(params.takeover ? ['takeover' as const] : []),
            'transcript' as const,
            ...(sourceState.entry.supportsFollow ? ['follow' as const] : []),
          ]),
        })).sort(compareCandidates));
        assertSerializedBytes(Object.freeze({ items: mapped }), maxBytes);
        sourceState.items = mapped;
        sourceState.offset = 0;
      };

      for (const sourceState of snapshot.sources) {
        if (sourceState.pagesRead === 0) await readNextProviderPage(sourceState);
      }
      if (candidateIndexPreparing) {
        return Object.freeze({ items: Object.freeze([]) });
      }

      let providerRefillsRemaining = limit;
      const fillEmptyHeads = async (): Promise<void> => {
        const sourceCount = snapshot.sources.length;
        let considered = 0;
        let index = snapshot.refillStartIndex;
        while (considered < sourceCount && providerRefillsRemaining > 0) {
          const sourceState = snapshot.sources[index]!;
          index = (index + 1) % sourceCount;
          considered += 1;
          if (sourceState.offset < sourceState.items.length || sourceState.exhausted) continue;
          providerRefillsRemaining -= 1;
          await readNextProviderPage(sourceState);
        }
        snapshot.refillStartIndex = index;
      };

      await fillEmptyHeads();
      if (candidateIndexPreparing) {
        return Object.freeze({ items: Object.freeze([]) });
      }
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
        if (!selected) break;
        items.push(selected.items[selected.offset]!);
        selected.offset += 1;
        if (items.length < limit) {
          await fillEmptyHeads();
          if (candidateIndexPreparing) {
            return Object.freeze({ items: Object.freeze([]) });
          }
        }
      }

      const retainedItems = snapshot.sources.reduce(
        (count, sourceState) => count + Math.max(0, sourceState.items.length - sourceState.offset),
        0,
      );
      if (retainedItems > MAX_SNAPSHOT_ITEMS) fail('plugin_external_inventory_capacity_exceeded');
      const retained = snapshot.sources.flatMap(
        (sourceState) => sourceState.items.slice(sourceState.offset),
      );
      if (serializedBytes(retained) > MAX_SNAPSHOT_BYTES) fail('plugin_external_inventory_capacity_exceeded');
      const hasMore = snapshot.sources.some(
        (sourceState) => sourceState.offset < sourceState.items.length || !sourceState.exhausted,
      );
      let nextCursor: string | undefined;
      if (hasMore) {
        nextCursor = `${CURSOR_PREFIX}${randomUUID()}`;
        while (snapshots.size >= MAX_CURSOR_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
        snapshots.set(nextCursor, snapshot);
      }
      const diagnostics = Object.freeze([...diagnosticBySource.values()]);
      const result = Object.freeze({
        items: Object.freeze(items),
        ...(nextCursor ? { nextCursor } : {}),
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
      });
      try {
        assertSerializedBytes(result, maxBytes);
      } catch (error) {
        if (nextCursor) snapshots.delete(nextCursor);
        throw error;
      }
      return result;
      });
    },
    async attach(ref: HostExternalSessionRef, options?: Parameters<HostExternalSessionsService['attach']>[1]) {
      return await runBoundedOperation(options?.signal, 'plugin_external_attach_failed', async (operationSignal) => {
        assertAvailable(caps().attach);
        const entry = sourceFor(ref);
        const { source } = await providerFor(entry, operationSignal);
        const result = await params.attach!(ref, source, { signal: operationSignal });
        assertNotAborted(operationSignal);
        if (!isCurrent()) fail('plugin_generation_retired');
        return result;
      });
    },
    async takeover(ref: HostExternalSessionRef, options?: Parameters<HostExternalSessionsService['takeover']>[1]) {
      try {
        assertAvailable(caps().takeover);
        assertNotAborted(options?.signal);
        const entry = sourceFor(ref);
        const { source } = await providerFor(entry, options?.signal);
        const result = await params.takeover!(ref, source, options);
        // The qualified host operation owns its pre-commit cancellation/currentness fences.
        // A successful return is a committed takeover and must not be relabeled afterward.
        return result;
      } catch (error) {
        throw serviceFailure(error, 'plugin_external_takeover_failed');
      }
    },
    async resolveFollowTarget(input): Promise<HostExternalSessionFollowTargetResolution> {
      return await resolvePluginExternalSessionFollowTarget({
        agentId: input.agentId,
        remoteSessionId: input.remoteSessionId,
        sources: params.sources,
        resolveProviderOps: params.resolveProviderOps,
        isCurrent,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(params.retirementSignal
          ? { retirementSignal: params.retirementSignal }
          : {}),
      });
    },
    async readTranscript(ref: HostExternalSessionRef, query: NonNullable<Parameters<HostExternalSessionsService['readTranscript']>[1]> = {}) {
      return await runBoundedOperation(query.signal, 'plugin_external_transcript_read_failed', async (operationSignal) => {
        assertAvailable(caps().transcript);
        const entry = sourceFor(ref);
        const { ops, source } = await providerFor(entry, operationSignal);
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
        const page = query.mode === 'readAfter'
          ? await (() => {
              if (typeof query.cursor !== 'string' || query.cursor.length === 0) {
                fail('plugin_external_cursor_invalid');
              }
              if (!ops.readAfterTranscript) fail('plugin_external_read_after_unavailable');
              return ops.readAfterTranscript({
                source,
                remoteSessionId: ref.remoteSessionId,
                cursor: query.cursor,
                maxBytes,
                maxItems,
                signal: operationSignal,
              }).then((result) => toLegacyTranscriptSourceReadAfter(result, query.cursor!));
            })()
          : await ops.pageTranscript({
              source,
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
          items: Object.freeze(page.items.map(mapPluginExternalTranscriptItem)),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        });
        assertSerializedBytes(result, maxBytes);
        return result;
      });
    },
    async followTranscript(
      target: Parameters<HostExternalSessionsService['followTranscript']>[0],
      options: Parameters<HostExternalSessionsService['followTranscript']>[1],
      listener: Parameters<HostExternalSessionsService['followTranscript']>[2],
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
          error instanceof PluginError ? error.code : 'plugin_external_source_unavailable',
        );
      }
      if (!entry.supportsFollow || !params.followTranscript) {
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
            const validation = await ops.validateSource({
              source: target.source,
              signal: operationSignal,
            });
            assertNotAborted(operationSignal);
            if (!isCurrent()) fail('plugin_generation_retired');
            if (!validation.ok || validation.source.kind !== target.source.kind) {
              fail('plugin_external_source_unavailable');
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
                signal: operationSignal,
              }),
              listener,
            });
          },
        );
      } catch (error) {
        const code = error instanceof PluginError
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
  return Object.freeze(service);
}
