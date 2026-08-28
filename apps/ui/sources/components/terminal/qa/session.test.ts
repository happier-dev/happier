import { describe, expect, it, vi } from 'vitest';

import type {
    EmbeddedTerminalRendererHandle,
    EmbeddedTerminalWriteCompleteEvent,
} from '@/components/terminal/embedded/embeddedTerminalRendererHandle';
import { getTerminalQaWorkload } from './workloads';
import { createTerminalQaSession } from './session';

type Timer = ReturnType<typeof setTimeout>;

function makeScheduler() {
    const callbacks: Array<() => void> = [];
    return {
        schedule: (callback: () => void) => {
            callbacks.push(callback);
            return callbacks.length as unknown as Timer;
        },
        cancel: vi.fn(),
        flushOne: () => callbacks.shift()?.(),
        count: () => callbacks.length,
    };
}

function completion(input: Readonly<{
    seq: number;
    byteOffset: number;
    byteLength: number;
    generation: number;
    accepted: boolean;
}>): EmbeddedTerminalWriteCompleteEvent {
    return {
        terminalId: 'terminal-qa:test',
        seq: input.seq,
        byteOffset: input.byteOffset,
        byteLength: input.byteLength,
        ackedByteOffset: input.accepted ? input.byteOffset + input.byteLength : input.byteOffset,
        writeGeneration: input.generation,
    };
}

describe('terminal loaded-device QA session', () => {
    const evidenceIdentity = {
        runId: 'term-run-test',
        runNonce: 'n'.repeat(64),
        buildEvidenceId: 'term-build-1234567890abcdef',
        sourceStateSha256: 'a'.repeat(64),
        dependencyClosureSha256: 'b'.repeat(64),
    };
    it('advances its byte cursor only after the real async renderer completion', () => {
        const writes: unknown[] = [];
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: (input) => {
                writes.push(input);
                return { status: 'queued' };
            },
            clear: vi.fn(),
        };
        const session = createTerminalQaSession({
            terminalId: 'terminal-qa:test',
            rendererRef: { current: renderer },
            evidenceIdentity,
        });
        const workload = getTerminalQaWorkload('wide-combining');

        session.runWorkload('wide-combining');

        expect(writes).toHaveLength(1);
        expect(session.getSnapshot()).toMatchObject({
            acceptedByteOffset: 0,
            queuedFrames: 1,
            inFlight: true,
            writeAttempts: 1,
        });

        session.onWriteComplete(completion({
            seq: 1,
            byteOffset: 0,
            byteLength: workload.byteLength,
            generation: 1,
            accepted: true,
        }));

        expect(session.getSnapshot()).toMatchObject({
            acceptedByteOffset: workload.byteLength,
            queuedFrames: 0,
            inFlight: false,
            acknowledgedWrites: 1,
        });
    });

    it('replays accepted bytes when a ready fallback renderer replaces the native handle', () => {
        const nativeWrites: Uint8Array[] = [];
        const fallbackWrites: Uint8Array[] = [];
        const native: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: (input) => {
                nativeWrites.push(input.bytes);
                return { status: 'queued' };
            },
            clear: vi.fn(),
        };
        const fallback: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: (input) => {
                fallbackWrites.push(input.bytes);
                return { status: 'queued' };
            },
            clear: vi.fn(),
        };
        const rendererRef = { current: native as EmbeddedTerminalRendererHandle | null };
        const session = createTerminalQaSession({
            terminalId: 'terminal-qa:test',
            rendererRef,
            evidenceIdentity,
        });
        const workload = getTerminalQaWorkload('wide-combining');

        session.notifyRendererReady(80, 24);
        session.runWorkload('wide-combining');
        session.onWriteComplete(completion({
            seq: 1,
            byteOffset: 0,
            byteLength: workload.byteLength,
            generation: 1,
            accepted: true,
        }));

        rendererRef.current = fallback;
        session.notifyRendererReady(80, 24);

        expect(nativeWrites).toHaveLength(1);
        expect(fallback.clear).toHaveBeenCalledTimes(1);
        expect(fallbackWrites).toHaveLength(1);
        expect(fallbackWrites[0]).toEqual(workload.bytes);
        expect(session.getSnapshot()).toMatchObject({
            terminalId: 'terminal-qa:test',
            acceptedByteOffset: workload.byteLength,
            writeAttempts: 1,
            acknowledgedWrites: 1,
        });
        expect(session.getSnapshot().events).toContainEqual(expect.objectContaining({
            kind: 'renderer-replayed',
            detail: `frames=1 bytes=${workload.byteLength}`,
        }));
    });

    it('does not replay output that was explicitly cleared', () => {
        const native: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(() => true),
            clear: vi.fn(),
        };
        const fallback: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(() => true),
            clear: vi.fn(),
        };
        const rendererRef = { current: native as EmbeddedTerminalRendererHandle | null };
        const session = createTerminalQaSession({
            terminalId: 'terminal-qa:test',
            rendererRef,
            evidenceIdentity,
        });

        session.notifyRendererReady(80, 24);
        session.runWorkload('alternate-screen');
        session.clear();
        rendererRef.current = fallback;
        session.notifyRendererReady(80, 24);

        expect(fallback.clear).not.toHaveBeenCalled();
        expect(fallback.writeBytes).not.toHaveBeenCalled();
    });

    it('retries a one-shot immediate rejection from the original byte offset', () => {
        const scheduler = makeScheduler();
        const writes: Array<{ byteOffset: number; writeGeneration: number }> = [];
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: (input) => {
                writes.push({ byteOffset: input.byteOffset, writeGeneration: input.writeGeneration });
                return { status: 'queued' };
            },
            clear: vi.fn(),
        };
        const session = createTerminalQaSession({
            terminalId: 'terminal-qa:test',
            rendererRef: { current: renderer },
            evidenceIdentity,
            schedule: scheduler.schedule,
            cancel: scheduler.cancel,
        });

        session.rejectOneWrite();
        session.runWorkload('alternate-screen');

        expect(writes).toEqual([]);
        expect(session.getSnapshot()).toMatchObject({
            acceptedByteOffset: 0,
            rejectedWrites: 1,
            rejectNextWrite: false,
        });
        expect(scheduler.count()).toBe(1);

        scheduler.flushOne();
        expect(writes).toEqual([{ byteOffset: 0, writeGeneration: 2 }]);
    });

    it('preserves one logical session across native rejection and xterm fallback', () => {
        const scheduler = makeScheduler();
        const nativeWrites: Array<{ seq: number; byteLength: number; generation: number }> = [];
        const fallbackWrites: Array<{ seq: number; byteLength: number; generation: number }> = [];
        const native: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: (input) => {
                nativeWrites.push({ seq: input.seq, byteLength: input.bytes.byteLength, generation: input.writeGeneration });
                return { status: 'queued' };
            },
            clear: vi.fn(),
        };
        const fallback: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: (input) => {
                fallbackWrites.push({ seq: input.seq, byteLength: input.bytes.byteLength, generation: input.writeGeneration });
                return { status: 'queued' };
            },
            clear: vi.fn(),
        };
        const rendererRef = { current: native as EmbeddedTerminalRendererHandle | null };
        const session = createTerminalQaSession({
            terminalId: 'terminal-qa:test',
            rendererRef,
            evidenceIdentity,
            schedule: scheduler.schedule,
            cancel: scheduler.cancel,
        });
        const workload = getTerminalQaWorkload('ansi-burst');

        session.runWorkload('ansi-burst');
        expect(nativeWrites).toEqual([{ seq: 1, byteLength: workload.byteLength, generation: 1 }]);

        session.onWriteComplete(completion({
            seq: 1,
            byteOffset: 0,
            byteLength: workload.byteLength,
            generation: 1,
            accepted: false,
        }));
        rendererRef.current = fallback;
        scheduler.flushOne();

        expect(fallbackWrites).toEqual([{ seq: 1, byteLength: workload.byteLength, generation: 2 }]);
        expect(session.getSnapshot().terminalId).toBe('terminal-qa:test');
        expect(session.getSnapshot().acceptedByteOffset).toBe(0);

        session.onWriteComplete(completion({
            seq: 1,
            byteOffset: 0,
            byteLength: workload.byteLength,
            generation: 1,
            accepted: true,
        }));
        expect(session.getSnapshot().acceptedByteOffset).toBe(0);

        session.onWriteComplete(completion({
            seq: 1,
            byteOffset: 0,
            byteLength: workload.byteLength,
            generation: 2,
            accepted: true,
        }));
        expect(session.getSnapshot()).toMatchObject({
            terminalId: 'terminal-qa:test',
            acceptedByteOffset: workload.byteLength,
            rejectedWrites: 1,
            acknowledgedWrites: 1,
        });
    });

    it('records metadata without retaining input, paste, copied text, or link contents', () => {
        const renderer: EmbeddedTerminalRendererHandle = {
            write: vi.fn(),
            writeBytes: vi.fn(() => true),
            clear: vi.fn(),
        };
        const session = createTerminalQaSession({
            terminalId: 'terminal-qa:test',
            rendererRef: { current: renderer },
            evidenceIdentity,
        });
        const secret = 'qa-secret-value';

        session.writeInput(secret);
        session.writePaste(secret);
        session.notifyCopy(secret.length);
        session.notifyLink(`https://example.invalid/${secret}`);
        session.notifyLink(secret);

        const serialized = JSON.stringify(session.getSnapshot());
        expect(serialized).not.toContain(secret);
        expect(serialized).toContain('scheme=https');
        expect(serialized).toContain('scheme=invalid');
        expect(serialized).toContain('bracketed=true');
    });
});
