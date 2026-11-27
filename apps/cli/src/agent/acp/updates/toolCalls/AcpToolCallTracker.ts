import { mergeToolCallSnapshot } from './mergeToolCallSnapshot';
import { deepEqual } from '@/utils/deterministicJson';
import {
  isGenericToolCallIdentity,
  resolveBestToolCallIdentity,
} from './resolveToolCallIdentity';
import { isAcpToolCallTerminalStatus } from './types';
import type {
  AcpToolCallCloseReason,
  AcpToolCallEnrichment,
  AcpToolCallEnrichmentDisposition,
  AcpToolCallPublication,
  AcpToolCallSnapshot,
  AcpToolResultPublication,
} from './types';

type ToolCallRecord<TimerHandle> = {
  snapshot: AcpToolCallSnapshot;
  toolName: string;
  revision: number;
  startedAt: number;
  updatedAt: number;
  timer: TimerHandle | null;
  permissionPending: boolean;
};

export type AcpToolCallTracker<TimerHandle = ReturnType<typeof setTimeout>> = Readonly<{
  observe(
    patch: AcpToolCallSnapshot,
    options?: Readonly<{ terminalResult?: Readonly<{ value: unknown; isError?: boolean }> }>,
  ): boolean;
  enrich(callId: string, enrichment: AcpToolCallEnrichment): AcpToolCallEnrichmentDisposition;
  markWaitingForPermission(callId: string): boolean;
  markRunning(callId: string): boolean;
  cancel(callId: string): boolean;
  cancelAll(): string[];
  detachFromTurn(callId: string): void;
  abandonTurn(): string[];
  reset(): void;
  get(callId: string): AcpToolCallPublication | null;
  activeCallIds(): string[];
  isFinalized(callId: string): boolean;
  dispose(): void;
  readonly activeSize: number;
  readonly finalizedSize: number;
  readonly pendingEnrichmentSize: number;
}>;

export function createAcpToolCallTracker<TimerHandle = ReturnType<typeof setTimeout>>(params: Readonly<{
  now?: () => number;
  determineToolName?: (params: Readonly<{
    callId: string;
    currentName: string;
    snapshot: AcpToolCallSnapshot;
  }>) => string | null | undefined;
  publishCall: (publication: AcpToolCallPublication) => void;
  publishResult: (publication: AcpToolResultPublication) => void;
  resolveTimeoutMs?: (publication: AcpToolCallPublication) => number | null;
  scheduleTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  onCallClosed?: (event: Readonly<{
    callId: string;
    reason: AcpToolCallCloseReason;
    publication: AcpToolCallPublication;
  }>) => void;
  maxFinalizedCalls?: number;
  maxPendingEnrichments?: number;
}>): AcpToolCallTracker<TimerHandle> {
  const now = params.now ?? Date.now;
  const records = new Map<string, ToolCallRecord<TimerHandle>>();
  const detached = new Set<string>();
  const finalized = new Map<string, AcpToolCallPublication>();
  const pendingEnrichments = new Map<string, AcpToolCallEnrichment>();
  const maxFinalizedCalls = Math.max(1, Math.trunc(params.maxFinalizedCalls ?? 1_000));
  const maxPendingEnrichments = Math.max(1, Math.trunc(params.maxPendingEnrichments ?? 1_000));
  let disposed = false;

  const publication = (
    callId: string,
    record: ToolCallRecord<TimerHandle>,
  ): AcpToolCallPublication => ({
    callId,
    toolName: record.toolName,
    snapshot: record.snapshot,
    revision: record.revision,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
  });

  const clearRecordTimer = (record: ToolCallRecord<TimerHandle>): void => {
    if (record.timer === null) return;
    params.clearTimer?.(record.timer);
    record.timer = null;
  };

  const rememberFinalized = (callId: string, value: AcpToolCallPublication): void => {
    finalized.set(callId, value);
    while (finalized.size > maxFinalizedCalls) {
      const oldest = finalized.keys().next().value;
      if (typeof oldest !== 'string') break;
      finalized.delete(oldest);
    }
  };

  const resolveEnrichedToolName = (
    callId: string,
    record: ToolCallRecord<TimerHandle>,
    requestedToolName: string | undefined,
  ): string => {
    const requested = typeof requestedToolName === 'string' ? requestedToolName.trim() : '';
    const requestedIdentity = requested
      ? resolveBestToolCallIdentity({ previous: record.toolName, candidate: requested })
      : record.toolName;
    const determined = params.determineToolName?.({
      callId,
      currentName: requestedIdentity,
      snapshot: record.snapshot,
    });
    const providerIdentity = typeof determined === 'string' ? determined.trim() : '';
    return providerIdentity && !isGenericToolCallIdentity(providerIdentity)
      ? providerIdentity
      : requestedIdentity;
  };

  const applyEnrichment = (
    callId: string,
    record: ToolCallRecord<TimerHandle>,
    enrichment: AcpToolCallEnrichment,
  ): boolean => {
    const metadata = enrichment.metadata === undefined
      ? undefined
      : enrichment.metadata === null
        ? null
        : {
            ...(record.snapshot._meta ?? {}),
            ...enrichment.metadata,
          };
    const patch: AcpToolCallSnapshot = {
      toolCallId: callId,
      ...(enrichment.title !== undefined ? { title: enrichment.title } : {}),
      ...(enrichment.rawInput !== undefined ? { rawInput: enrichment.rawInput } : {}),
      ...(metadata !== undefined ? { _meta: metadata } : {}),
    };
    const nextSnapshot = mergeToolCallSnapshot(record.snapshot, patch);
    const previousSnapshot = record.snapshot;
    const previousToolName = record.toolName;
    record.snapshot = nextSnapshot;
    record.toolName = resolveEnrichedToolName(callId, record, enrichment.toolName);
    if (record.toolName === previousToolName && deepEqual(previousSnapshot, nextSnapshot)) {
      record.snapshot = previousSnapshot;
      return false;
    }
    return true;
  };

  const finish = (
    callId: string,
    record: ToolCallRecord<TimerHandle>,
    reason: AcpToolCallCloseReason,
    terminalResult?: Readonly<{ value: unknown; isError?: boolean }>,
  ): void => {
    clearRecordTimer(record);
    const syntheticStatus = reason === 'terminal'
      ? isAcpToolCallTerminalStatus(record.snapshot.status) ? record.snapshot.status : 'failed'
      : reason;
    const result = terminalResult ?? {
      value: { status: syntheticStatus },
      isError: syntheticStatus !== 'completed',
    };
    params.publishResult({
      callId,
      toolName: record.toolName,
      snapshot: record.snapshot,
      value: result.value,
      ...(result.isError !== undefined ? { isError: result.isError } : {}),
    });
    const finalPublication = publication(callId, record);
    records.delete(callId);
    detached.delete(callId);
    rememberFinalized(callId, finalPublication);
    params.onCallClosed?.({ callId, reason, publication: finalPublication });
  };

  const armTimeout = (callId: string, record: ToolCallRecord<TimerHandle>): void => {
    clearRecordTimer(record);
    if (detached.has(callId) || !params.resolveTimeoutMs || !params.scheduleTimer || !params.clearTimer) return;
    const timeoutMs = params.resolveTimeoutMs(publication(callId, record));
    if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    const timer = params.scheduleTimer(() => {
      const current = records.get(callId);
      if (!current || current.timer !== timer) return;
      current.timer = null;
      current.snapshot = mergeToolCallSnapshot(current.snapshot, {
        toolCallId: callId,
        status: 'failed',
      });
      current.revision += 1;
      current.updatedAt = now();
      publishCurrent(callId, current);
      finish(callId, current, 'timeout', {
        isError: true,
        value: {
          error: `Tool call timed out after ${(timeoutMs / 1_000).toFixed(0)}s`,
          status: 'timeout',
          timeoutMs,
        },
      });
    }, Math.trunc(timeoutMs));
    record.timer = timer;
  };

  const publishCurrent = (
    callId: string,
    record: ToolCallRecord<TimerHandle>,
  ): void => {
    params.publishCall(publication(callId, record));
  };

  const cancelRecord = (callId: string, record: ToolCallRecord<TimerHandle>): void => {
    record.snapshot = mergeToolCallSnapshot(record.snapshot, { toolCallId: callId, status: 'cancelled' });
    record.revision += 1;
    record.updatedAt = now();
    publishCurrent(callId, record);
    finish(callId, record, 'cancelled');
  };

  const abandonRecord = (callId: string, record: ToolCallRecord<TimerHandle>): void => {
    record.revision += 1;
    record.updatedAt = now();
    publishCurrent(callId, record);
    finish(callId, record, 'abandoned');
  };

  return {
    observe(patch, options) {
      if (disposed || finalized.has(patch.toolCallId)) return false;
      const timestamp = now();
      let record = records.get(patch.toolCallId);
      if (!record) {
        const snapshot = mergeToolCallSnapshot(null, patch);
        const seedName = typeof snapshot.kind === 'string' ? snapshot.kind : 'unknown';
        const determined = params.determineToolName?.({
          callId: patch.toolCallId,
          currentName: seedName,
          snapshot,
        });
        record = {
          snapshot,
          toolName: resolveBestToolCallIdentity({ previous: seedName, candidate: determined }),
          revision: 1,
          startedAt: timestamp,
          updatedAt: timestamp,
          timer: null,
          permissionPending: false,
        };
        const pendingEnrichment = pendingEnrichments.get(patch.toolCallId);
        if (pendingEnrichment) {
          pendingEnrichments.delete(patch.toolCallId);
          applyEnrichment(patch.toolCallId, record, pendingEnrichment);
        }
        records.set(patch.toolCallId, record);
      } else {
        const previousSnapshot = record.snapshot;
        const previousToolName = record.toolName;
        const effectivePatch = record.permissionPending && patch.status === 'in_progress'
          ? Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'status')) as AcpToolCallSnapshot
          : patch;
        record.snapshot = mergeToolCallSnapshot(record.snapshot, effectivePatch);
        const kind = typeof record.snapshot.kind === 'string' ? record.snapshot.kind : null;
        const determined = params.determineToolName?.({
          callId: patch.toolCallId,
          currentName: record.toolName,
          snapshot: record.snapshot,
        });
        const standardIdentity = resolveBestToolCallIdentity({ previous: record.toolName, candidate: kind });
        const providerIdentity = typeof determined === 'string' ? determined.trim() : '';
        record.toolName = providerIdentity && !isGenericToolCallIdentity(providerIdentity)
          ? providerIdentity
          : standardIdentity;
        if (record.toolName === previousToolName && deepEqual(previousSnapshot, record.snapshot)) {
          record.snapshot = previousSnapshot;
          if (record.snapshot.status === 'in_progress') armTimeout(patch.toolCallId, record);
          else if (record.snapshot.status === 'pending') clearRecordTimer(record);
          return false;
        }
        record.revision += 1;
        record.updatedAt = timestamp;
      }

      const status = record.snapshot.status;
      const terminalResult = options?.terminalResult;
      publishCurrent(patch.toolCallId, record);
      if (status === 'in_progress') armTimeout(patch.toolCallId, record);
      else if (status === 'pending') clearRecordTimer(record);
      if (isAcpToolCallTerminalStatus(status)) finish(patch.toolCallId, record, 'terminal', terminalResult);
      return true;
    },
    enrich(callId, enrichment) {
      if (disposed) return 'ignored';

      const active = records.get(callId);
      if (active) {
        if (!applyEnrichment(callId, active, enrichment)) return 'duplicate';
        active.revision += 1;
        active.updatedAt = now();
        publishCurrent(callId, active);
        return 'applied';
      }

      const finalPublication = finalized.get(callId);
      if (finalPublication) {
        const finalRecord: ToolCallRecord<TimerHandle> = {
          snapshot: finalPublication.snapshot,
          toolName: finalPublication.toolName,
          revision: finalPublication.revision,
          startedAt: finalPublication.startedAt,
          updatedAt: finalPublication.updatedAt,
          timer: null,
          permissionPending: false,
        };
        if (!applyEnrichment(callId, finalRecord, enrichment)) return 'duplicate';
        finalRecord.revision += 1;
        finalRecord.updatedAt = now();
        const revised = publication(callId, finalRecord);
        // Updating an existing Map value preserves the original tombstone insertion order.
        finalized.set(callId, revised);
        params.publishCall(revised);
        return 'applied';
      }

      const queued = pendingEnrichments.get(callId);
      if (queued && deepEqual(queued, enrichment)) return 'duplicate';
      pendingEnrichments.set(callId, enrichment);
      while (pendingEnrichments.size > maxPendingEnrichments) {
        const oldest = pendingEnrichments.keys().next().value;
        if (typeof oldest !== 'string') break;
        pendingEnrichments.delete(oldest);
      }
      return 'queued';
    },
    markWaitingForPermission(callId) {
      const record = records.get(callId);
      if (!record) return false;
      record.snapshot = mergeToolCallSnapshot(record.snapshot, { toolCallId: callId, status: 'pending' });
      record.revision += 1;
      record.updatedAt = now();
      record.permissionPending = true;
      clearRecordTimer(record);
      publishCurrent(callId, record);
      return true;
    },
    markRunning(callId) {
      const record = records.get(callId);
      if (!record) return false;
      record.snapshot = mergeToolCallSnapshot(record.snapshot, { toolCallId: callId, status: 'in_progress' });
      record.revision += 1;
      record.updatedAt = now();
      record.permissionPending = false;
      publishCurrent(callId, record);
      armTimeout(callId, record);
      return true;
    },
    cancel(callId) {
      const record = records.get(callId);
      if (!record) return false;
      cancelRecord(callId, record);
      return true;
    },
    cancelAll() {
      const callIds = [...records.keys()];
      for (const callId of callIds) {
        const record = records.get(callId);
        if (!record) continue;
        cancelRecord(callId, record);
      }
      return callIds;
    },
    detachFromTurn(callId) {
      const record = records.get(callId);
      if (!record || record.permissionPending) return;
      detached.add(callId);
      clearRecordTimer(record);
    },
    abandonTurn() {
      const callIds = [...records.keys()].filter(id => !detached.has(id));
      for (const callId of callIds) {
        const record = records.get(callId);
        if (record) abandonRecord(callId, record);
      }
      return callIds;
    },
    reset() {
      if (disposed) return;
      for (const record of records.values()) clearRecordTimer(record);
      records.clear();
      detached.clear();
      finalized.clear();
      pendingEnrichments.clear();
    },
    get(callId) {
      const record = records.get(callId);
      return record ? publication(callId, record) : null;
    },
    activeCallIds() {
      return [...records.keys()].filter(id => !detached.has(id));
    },
    isFinalized(callId) {
      return finalized.has(callId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const record of records.values()) clearRecordTimer(record);
      records.clear();
      detached.clear();
      finalized.clear();
      pendingEnrichments.clear();
    },
    get activeSize() {
      return records.size - detached.size;
    },
    get finalizedSize() {
      return finalized.size;
    },
    get pendingEnrichmentSize() {
      return pendingEnrichments.size;
    },
  };
}
