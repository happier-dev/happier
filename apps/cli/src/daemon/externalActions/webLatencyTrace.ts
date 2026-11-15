import { AsyncLocalStorage } from 'node:async_hooks';
import { logger } from '@/ui/logger';
import { resolveFileLogLevel } from '@/ui/logFileLevel';
import { DAEMON_EVENT_LOOP_STALL_WARNING_THRESHOLD_MS } from '@/daemon/diagnostics/daemonEventLoopStallMonitor';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';

type TraceContext = Readonly<{
  requestId?: string;
  sessionId?: string;
  sequence: { next: number };
  spanId?: number;
  parentSpanId?: number;
  storageRead?: Readonly<{ debug: boolean }>;
  approval?: { actionId: string; artifactId: string | null };
}>;
const context = new AsyncLocalStorage<TraceContext>();

export type WebLatencyTracePoint = Readonly<{ requestId: string; spanId?: number }>;

export function isWebLatencyTraceEnabled(): boolean {
  return sessionProcessEnvironment().HAPPIER_WEB_LATENCY_TRACE === '1';
}

/** Owner-supplied code/identity facts only; never approval operands or errors. */
export type WebLatencyApprovalFacts = Readonly<{
  artifactId?: string;
  executionRequestId?: string;
  operationId?: string;
  liveWaiterCount?: number;
  detachedWaiterCount?: number;
  signalMatchesHostLifetime?: boolean;
  signalAborted?: boolean;
  resolved?: boolean;
  inputIdentityEqual?: boolean;
}>;

/** Diagnostic provenance for an already-shared promise, never an authority witness. */
export function readWebLatencyTracePoint(): WebLatencyTracePoint | undefined {
  const current = context.getStore();
  return isWebLatencyTraceEnabled() && current?.requestId
    ? { requestId: current.requestId, ...(current.spanId === undefined ? {} : { spanId: current.spanId }) } : undefined;
}

export function withWebLatencyTrace<T>(requestId: unknown, operation: () => T, sessionId?: string): T {
  const parent = context.getStore();
  if (parent?.requestId === requestId) return operation();
  // MCP child spawns hash the parent/creation-key tuple to retain one root
  // across retries; ordinary Actions and new-Session attempts use UUIDs.
  return isWebLatencyTraceEnabled()
    && typeof requestId === 'string' && /^(?:(?:new-session-attempt-)?[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{64})$/iu.test(requestId)
    ? context.run({ ...(parent?.approval ? parent : {}), requestId, ...(sessionId ? { sessionId } : {}),
      sequence: parent?.approval ? parent.sequence : { next: 0 } }, operation) : operation();
}

/** Invocation-local diagnostic identity, never an authorization or retained cache. */
export function withApprovalActionTrace<T>(actionId: string, operation: () => T, artifactId?: string, requestId?: unknown): T {
  if (actionId !== 'approval.request.decide') return operation();
  const parent = context.getStore();
  const candidate = typeof requestId === 'string' ? requestId.replace(/^rpc_/u, '') : undefined;
  const root = candidate && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(candidate) ? candidate : undefined;
  if (parent?.approval) {
    if (artifactId !== undefined) parent.approval.artifactId = artifactId;
    return operation();
  }
  return context.run({ ...parent, ...(root ? { requestId: root } : {}), sequence: parent?.sequence ?? { next: 0 },
    approval: { actionId, artifactId: artifactId ?? null } }, operation);
}

/** Called only by the canonical typed Artifact reader after Action input admission. */
export function setApprovalTraceArtifactId(artifactId: string): void {
  const approval = context.getStore()?.approval;
  if (approval) approval.artifactId = artifactId;
}

function writeApprovalPhase(span: TraceContext | undefined, phase: string,
  status: 'started' | 'completed' | 'failed', durationMs: number): void {
  if (!span?.approval) return;
  try { logger.debug('[ActionApproval] origin phase', { phase, status, durationMs,
    actionId: span.approval.actionId, artifactId: span.approval.artifactId,
    // Authored free-form identities never enter ordinary daemon debug records.
    ...(span.requestId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(span.requestId) ? { requestId: span.requestId } : {}),
    spanId: span.spanId, ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }) }); } catch { /* Diagnostic only. */ }
}

/** New approval-only phases leave other Actions' existing tracing untouched. */
export async function timeApprovalPhase<T>(phase: string, operation: () => T | Promise<T>): Promise<T> {
  return context.getStore()?.approval ? await timeWebLatencyPhase(phase, operation) : await operation();
}

/** The same approval spans for synchronous crypto, without introducing an await. */
export function timeApprovalPhaseSync<T>(phase: string, operation: () => T): T {
  const parent = context.getStore();
  if (!parent?.approval) return operation();
  const started = performance.now();
  const span = { ...parent, spanId: ++parent.sequence.next,
    ...(parent.spanId === undefined ? {} : { parentSpanId: parent.spanId }) };
  writeApprovalPhase(span, phase, 'started', 0);
  let status: 'completed' | 'failed' = 'failed';
  try { const result = context.run(span, operation); status = 'completed'; return result; }
  finally { writeApprovalPhase(span, phase, status, Math.max(0, performance.now() - started)); }
}

/** Receives only the dispatcher's already privacy-normalized diagnostic identity. */
export function withStorageReadTrace<T>(requestId: string, operation: () => T): T {
  // Daemon debug retention is implicit; only explicit diagnostic demand enables
  // fast spans. Resolve it once at admission, then retain it through nested phases.
  const debug = process.env.HAPPIER_WEB_LATENCY_TRACE === '1'
    || resolveFileLogLevel({ env: process.env, isDaemonProcess: false }) === 'debug';
  return context.run({ requestId, sequence: { next: 0 }, storageRead: { debug } }, operation);
}

async function timeStorageReadStage<T>(stage: string, operation: () => T | Promise<T>): Promise<T> {
  const parent = context.getStore();
  if (!parent?.storageRead) return await operation();
  const started = performance.now();
  const atMs = Date.now();
  const span = { ...parent, spanId: ++parent.sequence.next,
    ...(parent.spanId === undefined ? {} : { parentSpanId: parent.spanId }) };
  const start = { stage, requestId: span.requestId, spanId: span.spanId,
    ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
    status: 'started' as const, atMs, elapsedMs: 0 };
  const { debug } = parent.storageRead;
  try { if (debug) logger.debug('[storage-read]', start); } catch { /* Diagnostic only. */ }
  let outcome: 'completed' | 'failed' = 'failed';
  try {
    const result = await context.run(span, operation);
    outcome = 'completed';
    return result;
  } finally {
    const elapsedMs = Math.max(0, performance.now() - started);
    const settled = { ...start, status: 'settled' as const, atMs: Date.now(), elapsedMs, outcome };
    try {
      if (elapsedMs >= DAEMON_EVENT_LOOP_STALL_WARNING_THRESHOLD_MS) {
        // Promote the matching start retrospectively, without a timer or fast-read logs.
        logger.infoFile('[storage-read]', start);
        logger.infoFile('[storage-read]', settled);
      } else if (debug) logger.debug('[storage-read]', settled);
    } catch { /* Diagnostic only. */ }
  }
}

export async function timeWebLatencyPhase<T>(phase: string, operation: () => T | Promise<T>, source?: WebLatencyTracePoint,
  approvalFacts?: () => WebLatencyApprovalFacts): Promise<T> {
  if (phase.startsWith('storage.')) return timeStorageReadStage(phase, operation);
  const parent = context.getStore();
  const webTrace = isWebLatencyTraceEnabled();
  if (!webTrace && !parent?.approval) return await operation();
  const started = performance.now();
  const span = parent ? { ...parent, spanId: ++parent.sequence.next,
    ...(parent.spanId === undefined ? {} : { parentSpanId: parent.spanId }) } : undefined;
  const correlation = { ...(source ? { sourceRequestId: source.requestId,
    ...(source.spanId === undefined ? {} : { sourceSpanId: source.spanId }) } : {}),
    ...(span ? { requestId: span.requestId, ...(span.sessionId ? { sessionId: span.sessionId } : {}),
      spanId: span.spanId, ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }) } : {}) };
  writeApprovalPhase(span, phase, 'started', 0);
  try { if (webTrace) logger.debugLocalFile('[web-latency]', { phase, status: 'started', ...correlation, ...approvalFacts?.() }); } catch { /* Diagnostic only. */ }
  let status: 'completed' | 'failed' = 'failed';
  let current: boolean | undefined;
  try {
    const result = await (span ? context.run(span, operation) : operation());
    if (typeof result === 'boolean') current = result;
    status = 'completed';
    return result;
  }
  finally {
    writeApprovalPhase(span, phase, status, Math.max(0, performance.now() - started));
    try { if (webTrace) logger.debugLocalFile('[web-latency]', { phase, elapsedMs: performance.now() - started,
      status, ...(current === undefined ? {} : { current }), ...correlation, ...approvalFacts?.() }); } catch { /* Diagnostic only. */ }
  }
}
