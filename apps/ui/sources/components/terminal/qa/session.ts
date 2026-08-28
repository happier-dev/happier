import type { MutableRefObject } from 'react';

import type {
    EmbeddedTerminalRendererHandle,
    EmbeddedTerminalWriteCompleteEvent,
} from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { createTerminalStreamRuntime } from '@/sync/domains/terminal/stream/runtime';
import type { TerminalStreamBytesFrame } from '@/sync/domains/terminal/stream/model';

import { encodeTerminalQaText, getTerminalQaWorkload, type TerminalQaWorkloadId } from './workloads';

export type TerminalQaEventKind =
    | 'workload-queued'
    | 'write-queued'
    | 'write-acked'
    | 'write-rejected'
    | 'input'
    | 'paste'
    | 'resize'
    | 'ready'
    | 'renderer-replayed'
    | 'link'
    | 'selection'
    | 'copy'
    | 'lifecycle'
    | 'crash-injection';

export type TerminalQaEvent = Readonly<{
    id: number;
    atMs: number;
    kind: TerminalQaEventKind;
    detail: string;
}>;

export type TerminalQaSessionSnapshot = Readonly<{
    terminalId: string;
    runId: string;
    runNonce: string;
    buildEvidenceId: string;
    sourceStateSha256: string;
    dependencyClosureSha256: string;
    runStartedAt: string;
    acceptedByteOffset: number;
    queuedFrames: number;
    inFlight: boolean;
    writeAttempts: number;
    acknowledgedWrites: number;
    rejectedWrites: number;
    rendererReady: boolean;
    cols: number | null;
    rows: number | null;
    lastWorkloadId: TerminalQaWorkloadId | null;
    rejectNextWrite: boolean;
    events: readonly TerminalQaEvent[];
}>;

type PendingFrame = Readonly<{
    frame: TerminalStreamBytesFrame;
    generation: number;
}>;

export type TerminalQaSession = Readonly<{
    getSnapshot: () => TerminalQaSessionSnapshot;
    subscribe: (listener: () => void) => () => void;
    runWorkload: (id: TerminalQaWorkloadId) => void;
    writeInput: (text: string) => void;
    writePaste: (text: string) => void;
    rejectOneWrite: () => void;
    notifyRendererReady: (cols: number, rows: number) => void;
    notifyResize: (cols: number, rows: number) => void;
    notifyLink: (url: string) => void;
    notifySelection: (state: string, byteLength: number) => void;
    notifyCopy: (byteLength: number) => void;
    notifyLifecycle: (state: string) => void;
    notifyCrashInjection: (result: string) => void;
    onWriteComplete: (event: EmbeddedTerminalWriteCompleteEvent) => void;
    clear: () => void;
    retry: () => void;
    dispose: () => void;
}>;

const MAX_EVENTS = 80;
const MAX_REPLAY_BYTES = 1024 * 1024;
const RETRY_DELAY_MS = 80;
type TerminalQaTimer = ReturnType<typeof setTimeout>;

function formatWriteAttemptId(pending: PendingFrame): string {
    return `${pending.frame.terminalId}:${pending.frame.seq}:${pending.generation}`;
}

export function createTerminalQaSession(input: Readonly<{
    terminalId: string;
    evidenceIdentity: Readonly<{
        runId: string;
        runNonce: string;
        buildEvidenceId: string;
        sourceStateSha256: string;
        dependencyClosureSha256: string;
    }>;
    rendererRef: MutableRefObject<EmbeddedTerminalRendererHandle | null>;
    now?: () => number;
    schedule?: (callback: () => void, delayMs: number) => TerminalQaTimer;
    cancel?: (timer: TerminalQaTimer) => void;
}>): TerminalQaSession {
    const now = input.now ?? Date.now;
    const schedule: (callback: () => void, delayMs: number) => TerminalQaTimer = input.schedule
        ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    const cancel: (timer: TerminalQaTimer) => void = input.cancel
        ?? ((timer) => clearTimeout(timer));
    const listeners = new Set<() => void>();
    const queue: PendingFrame[] = [];
    let eventId = 0;
    let seq = 0;
    let generation = 1;
    let retryTimer: TerminalQaTimer | null = null;
    let inFlight: PendingFrame | null = null;
    let replayFrames: TerminalStreamBytesFrame[] = [];
    let replayByteLength = 0;
    let lastReadyRenderer: EmbeddedTerminalRendererHandle | null = null;
    let disposed = false;
    let state: TerminalQaSessionSnapshot = Object.freeze({
        terminalId: input.terminalId,
        ...input.evidenceIdentity,
        runStartedAt: new Date(now()).toISOString(),
        acceptedByteOffset: 0,
        queuedFrames: 0,
        inFlight: false,
        writeAttempts: 0,
        acknowledgedWrites: 0,
        rejectedWrites: 0,
        rendererReady: false,
        cols: null,
        rows: null,
        lastWorkloadId: null,
        rejectNextWrite: false,
        events: Object.freeze([]),
    });

    function publish(patch: Partial<TerminalQaSessionSnapshot>) {
        state = Object.freeze({ ...state, ...patch });
        listeners.forEach((listener) => listener());
    }

    function event(kind: TerminalQaEventKind, detail: string) {
        const next = Object.freeze({ id: ++eventId, atMs: now(), kind, detail });
        publish({ events: Object.freeze([...state.events, next].slice(-MAX_EVENTS)) });
    }

    function scheduleRetry() {
        if (disposed || retryTimer !== null) return;
        retryTimer = schedule(() => {
            retryTimer = null;
            pump();
        }, RETRY_DELAY_MS);
    }

    function advanceGeneration() {
        generation += 1;
        for (let index = 0; index < queue.length; index += 1) {
            queue[index] = { frame: queue[index]!.frame, generation };
        }
    }

    function rememberAcceptedFrame(frame: TerminalStreamBytesFrame) {
        if (frame.byteLength > MAX_REPLAY_BYTES) {
            replayFrames = [];
            replayByteLength = 0;
            return;
        }
        const retainedFrame = Object.freeze({
            ...frame,
            bytes: frame.bytes.slice(),
        });
        replayFrames.push(retainedFrame);
        replayByteLength += retainedFrame.byteLength;
        while (replayByteLength > MAX_REPLAY_BYTES && replayFrames.length > 1) {
            const removed = replayFrames.shift();
            if (removed) replayByteLength -= removed.byteLength;
        }
    }

    function replayAcceptedFramesIfRendererChanged() {
        const renderer = input.rendererRef.current;
        if (!renderer || renderer === lastReadyRenderer) return;
        const replacedRenderer = lastReadyRenderer !== null;
        lastReadyRenderer = renderer;
        if (!replacedRenderer || replayFrames.length === 0) return;

        renderer.clear();
        let replayedFrames = 0;
        let replayedBytes = 0;
        for (const frame of replayFrames) {
            const result = renderer.writeBytes?.({
                terminalId: frame.terminalId,
                seq: frame.seq,
                byteOffset: frame.byteOffset,
                writeGeneration: generation,
                bytes: frame.bytes,
            });
            if (result === false || !renderer.writeBytes) break;
            replayedFrames += 1;
            replayedBytes += frame.byteLength;
        }
        event('renderer-replayed', `frames=${replayedFrames} bytes=${replayedBytes}`);
    }

    function rendererProxy(): EmbeddedTerminalRendererHandle {
        return {
            write: (data) => input.rendererRef.current?.write(data) ?? false,
            writeBytes: (write) => {
                if (state.rejectNextWrite) {
                    publish({ rejectNextWrite: false });
                    return false;
                }
                return input.rendererRef.current?.writeBytes?.(write) ?? false;
            },
            clear: () => input.rendererRef.current?.clear(),
            focus: () => input.rendererRef.current?.focus?.(),
            copySelection: () => input.rendererRef.current?.copySelection?.(),
        };
    }

    function acceptSynchronously(pending: PendingFrame) {
        queue.shift();
        rememberAcceptedFrame(pending.frame);
        publish({
            acceptedByteOffset: pending.frame.byteOffset + pending.frame.byteLength,
            queuedFrames: queue.length,
            writeAttempts: state.writeAttempts + 1,
            acknowledgedWrites: state.acknowledgedWrites + 1,
        });
        event('write-acked', `writeId=${formatWriteAttemptId(pending)} seq=${pending.frame.seq} bytes=${pending.frame.byteLength} mode=sync`);
        pump();
    }

    function rejectBeforeQueue(pending: PendingFrame) {
        advanceGeneration();
        publish({
            writeAttempts: state.writeAttempts + 1,
            rejectedWrites: state.rejectedWrites + 1,
        });
        event('write-rejected', `writeId=${formatWriteAttemptId(pending)} seq=${pending.frame.seq} offset=${pending.frame.byteOffset} mode=immediate`);
        scheduleRetry();
    }

    function pump() {
        if (disposed || inFlight || retryTimer !== null || queue.length === 0) return;
        if (!input.rendererRef.current) {
            scheduleRetry();
            return;
        }

        const pending = queue[0]!;
        const runtime = createTerminalStreamRuntime({
            terminalId: input.terminalId,
            rendererId: 'terminal-qa-pane',
            renderer: rendererProxy(),
            surfaceEpoch: pending.generation,
        });
        const result = runtime.applyFrames([pending.frame]);
        if (result.queuedWrite) {
            inFlight = pending;
            publish({ inFlight: true, writeAttempts: state.writeAttempts + 1 });
            event('write-queued', `writeId=${formatWriteAttemptId(pending)} seq=${pending.frame.seq} bytes=${pending.frame.byteLength}`);
            return;
        }
        if (result.rejectedByteOffset !== null) {
            rejectBeforeQueue(pending);
            return;
        }
        if (result.acceptedByteOffset === pending.frame.byteOffset + pending.frame.byteLength) {
            acceptSynchronously(pending);
            return;
        }
        rejectBeforeQueue(pending);
    }

    function enqueue(bytes: Uint8Array, workloadId: TerminalQaWorkloadId | null, kind: 'workload' | 'input' | 'paste') {
        if (disposed || bytes.byteLength === 0) return;
        const byteOffset = queue.length > 0
            ? queue[queue.length - 1]!.frame.byteOffset + queue[queue.length - 1]!.frame.byteLength
            : state.acceptedByteOffset;
        const frame: TerminalStreamBytesFrame = Object.freeze({
            t: 'bytes',
            terminalId: input.terminalId,
            seq: ++seq,
            byteOffset,
            byteLength: bytes.byteLength,
            bytes,
            source: 'byte-stream',
        });
        queue.push({ frame, generation });
        publish({ queuedFrames: queue.length, lastWorkloadId: workloadId ?? state.lastWorkloadId });
        if (kind === 'workload') event('workload-queued', `id=${workloadId} bytes=${bytes.byteLength}`);
        if (kind === 'input') event('input', `bytes=${bytes.byteLength}`);
        if (kind === 'paste') event('paste', `bytes=${bytes.byteLength} bracketed=true`);
        pump();
    }

    return {
        getSnapshot: () => state,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        runWorkload: (id) => enqueue(getTerminalQaWorkload(id).bytes, id, 'workload'),
        writeInput: (text) => enqueue(encodeTerminalQaText(text), null, 'input'),
        writePaste: (text) => enqueue(encodeTerminalQaText(`\u001b[200~${text}\u001b[201~`), null, 'paste'),
        rejectOneWrite: () => {
            publish({ rejectNextWrite: true });
        },
        notifyRendererReady: (cols, rows) => {
            publish({ rendererReady: true, cols, rows });
            event('ready', `cols=${cols} rows=${rows}`);
            replayAcceptedFramesIfRendererChanged();
            pump();
        },
        notifyResize: (cols, rows) => {
            publish({ cols, rows });
            event('resize', `cols=${cols} rows=${rows}`);
        },
        notifyLink: (url) => {
            const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase() ?? 'invalid';
            event('link', `scheme=${scheme}`);
        },
        notifySelection: (selectionState, byteLength) => (
            event('selection', `state=${selectionState} bytes=${Math.max(0, byteLength)}`)
        ),
        notifyCopy: (byteLength) => event('copy', `bytes=${Math.max(0, byteLength)}`),
        notifyLifecycle: (nextState) => event('lifecycle', nextState),
        notifyCrashInjection: (result) => event('crash-injection', result),
        onWriteComplete: (completion) => {
            if (!inFlight) return;
            const pending = inFlight;
            if (
                completion.terminalId !== input.terminalId
                || completion.seq !== pending.frame.seq
                || completion.writeGeneration !== pending.generation
            ) return;

            inFlight = null;
            publish({ inFlight: false });
            const expectedOffset = pending.frame.byteOffset + pending.frame.byteLength;
            if (completion.ackedByteOffset >= expectedOffset) {
                queue.shift();
                rememberAcceptedFrame(pending.frame);
                publish({
                    acceptedByteOffset: expectedOffset,
                    queuedFrames: queue.length,
                    acknowledgedWrites: state.acknowledgedWrites + 1,
                });
                event('write-acked', `writeId=${formatWriteAttemptId(pending)} seq=${pending.frame.seq} bytes=${pending.frame.byteLength} mode=async`);
                pump();
                return;
            }

            advanceGeneration();
            publish({ rejectedWrites: state.rejectedWrites + 1 });
            event('write-rejected', `writeId=${formatWriteAttemptId(pending)} seq=${pending.frame.seq} offset=${pending.frame.byteOffset} mode=async`);
            scheduleRetry();
        },
        clear: () => {
            replayFrames = [];
            replayByteLength = 0;
            input.rendererRef.current?.clear();
        },
        retry: () => {
            if (retryTimer !== null) {
                cancel(retryTimer);
                retryTimer = null;
            }
            pump();
        },
        dispose: () => {
            disposed = true;
            if (retryTimer !== null) cancel(retryTimer);
            retryTimer = null;
            listeners.clear();
            queue.splice(0);
            replayFrames = [];
            replayByteLength = 0;
            lastReadyRenderer = null;
            inFlight = null;
        },
    };
}
