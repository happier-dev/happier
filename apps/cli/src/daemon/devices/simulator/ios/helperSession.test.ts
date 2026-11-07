import { Buffer } from 'node:buffer';
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { parseProcessOwnerTag } from '@/processes/ownerTag';

// Genuine OS spawn boundary; helper admission and process adapter stay real.
vi.mock('node:child_process', async (importOriginal) => ({
    ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn(),
}));

/** Flush enough microtask ticks for the lazily-started helper to register a pending command. */
async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

import type {
    IosSimulatorHelperSessionProcess,
    IosSimulatorHelperSessionStarter,
} from './helperSession';

const modulePath = './helperSession';

const SOURCE_ID = 'ios-simulator:A1B2-C3D4:screen';
const STREAM_ID = 'stream-1';

type StdoutListener = (chunk: Buffer) => void;
type CloseListener = (exit: Readonly<{ exitCode: number | null; signal: string | null }>) => void;

function createDeferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
} {
    let resolve: (value: T) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<T>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
    });
    return { promise, resolve, reject };
}

/**
 * In-memory fake of the piped helper child process. Mocks only the genuine process boundary
 * (stdin writes + stdout/close events); the demux, ack correlation, and lifecycle under test are
 * real internal logic.
 */
function createFakeHelperProcess(): IosSimulatorHelperSessionProcess & {
    emitStdout: (value: unknown | string) => void;
    emitClose: (exit: Readonly<{ exitCode: number | null; signal: string | null }>) => void;
    writes: string[];
    stopCalls: number;
} {
    const stdoutListeners: StdoutListener[] = [];
    const closeListeners: CloseListener[] = [];
    const writes: string[] = [];
    let stopCalls = 0;
    return {
        pid: 4242,
        onStdoutLine: (listener) => {
            stdoutListeners.push((chunk) => listener(chunk.toString('utf8')));
        },
        onClose: (listener) => {
            closeListeners.push(listener);
        },
        writeStdin: async (line: string) => {
            writes.push(line);
        },
        stop: async () => {
            stopCalls += 1;
        },
        emitStdout: (value) => {
            const line = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`;
            for (const listener of stdoutListeners) listener(Buffer.from(line, 'utf8'));
        },
        emitClose: (exit) => {
            for (const listener of closeListeners) listener(exit);
        },
        get writes() {
            return writes;
        },
        get stopCalls() {
            return stopCalls;
        },
    };
}

function frameLine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        v: 1,
        kind: 'frame',
        streamId: STREAM_ID,
        sourceId: SOURCE_ID,
        sequence: 1,
        timestampMs: 1_000,
        codecId: 'image.mjpeg',
        payloadKind: 'image_keyframe',
        payloadEncoding: 'binary_base64',
        payloadBase64: Buffer.from([1, 2, 3]).toString('base64'),
        payloadSizeBytes: 3,
        ...overrides,
    };
}

describe('iOS simulator helper session owner', () => {
    it('delivers the final frame and control acknowledgement after root exit before pipe closure', async () => {
        const mod = await import(modulePath);
        const child = Object.assign(new EventEmitter(), {
            pid: 4242, killed: false, stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn(() => true),
        });
        // Genuine OS process boundary; use the default starter and real NDJSON demux.
        vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
        const session = mod.createIosSimulatorHelperSession({ helperPath: '/verified/ios-helper', maxPayloadBytes: 8 });
        const messages: unknown[] = [];
        await session.openStream({
            sourceId: SOURCE_ID, streamId: STREAM_ID, codecId: 'image.mjpeg',
            emitMessage: (message: unknown) => messages.push(message),
        });
        const pending = session.sendCommand({
            v: 1, kind: 'control', commandId: 'final-command',
            target: { sourceId: SOURCE_ID, simulatorId: 'A1B2-C3D4' },
            control: { v: 1, kind: 'keyboard_text', streamId: STREAM_ID, sourceId: SOURCE_ID, eventId: 'final-event', text: 'hello' },
        });
        const settled = vi.fn();
        void pending.then(settled);
        await flushMicrotasks();
        child.emit('exit', 0, null);
        await flushMicrotasks();
        expect(settled).not.toHaveBeenCalled();
        child.stdout.write(`${JSON.stringify(frameLine())}\n`);
        // Match the native helper's newline-delimited wire output.
        child.stdout.write(`${JSON.stringify({ v: 1, kind: 'control_ack', commandId: 'final-command', status: 'accepted' })}\n`);
        child.emit('close', 0, null);
        await expect(pending).resolves.toMatchObject({ ok: true });
        expect(messages).toEqual([expect.objectContaining({ kind: 'frame', sequence: 1 })]);
        await session.stop();
    });

    it('stamps the device helper owner at the actual default OS spawn boundary', async () => {
        const mod = await import(modulePath);
        const child = Object.assign(new EventEmitter(), {
            pid: 4242, killed: false, stdin: new PassThrough(), stdout: new PassThrough(), kill: vi.fn(() => true),
        });
        // Structural fixture at the genuine child-process boundary.
        vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
        const start = mod.createIosSimulatorHelperSessionProcessStarter();
        await start({ helperPath: '/verified/ios-helper', args: ['--daemon-json'] });
        const environment = vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env;
        expect(parseProcessOwnerTag(environment?.HAPPIER_PROCESS_OWNER)?.owner)
            .toEqual({ kind: 'happier', component: 'device_helper' });
    });
    it('bridges helper stdout frame lines to the active openStream consumer', async () => {
        const mod = await import(modulePath);
        const fake = createFakeHelperProcess();
        const startHelper: IosSimulatorHelperSessionStarter = vi.fn(async () => fake);
        const session = mod.createIosSimulatorHelperSession({ startHelper, maxPayloadBytes: 8 });

        const messages: unknown[] = [];
        const stream = await session.openStream({
            sourceId: SOURCE_ID,
            streamId: STREAM_ID,
            codecId: 'image.mjpeg',
            emitMessage: (message: unknown) => messages.push(message),
        });

        fake.emitStdout(frameLine());

        expect(messages).toEqual([expect.objectContaining({ kind: 'frame', sequence: 1 })]);
        await stream.stop();
    });

    it('handles partial/multi-line stdout chunks (NDJSON reframing)', async () => {
        const mod = await import(modulePath);
        const fake = createFakeHelperProcess();
        const session = mod.createIosSimulatorHelperSession({
            startHelper: async () => fake,
            maxPayloadBytes: 8,
        });

        const messages: unknown[] = [];
        await session.openStream({
            sourceId: SOURCE_ID,
            streamId: STREAM_ID,
            codecId: 'image.mjpeg',
            emitMessage: (message: unknown) => messages.push(message),
        });

        const full = `${JSON.stringify(frameLine({ sequence: 1 }))}\n${JSON.stringify(frameLine({ sequence: 2, timestampMs: 2_000 }))}\n`;
        const half = Math.floor(full.length / 2);
        fake.emitStdout(full.slice(0, half));
        fake.emitStdout(full.slice(half));

        expect(messages).toHaveLength(2);
    });

    it('routes a control command to stdin and resolves on the matching ack', async () => {
        const mod = await import(modulePath);
        const fake = createFakeHelperProcess();
        const session = mod.createIosSimulatorHelperSession({
            startHelper: async () => fake,
            maxPayloadBytes: 8,
        });

        const pending = session.sendCommand({
            v: 1,
            kind: 'control',
            commandId: 'cmd-event-1',
            target: { sourceId: SOURCE_ID, simulatorId: 'A1B2-C3D4' },
            control: {
                v: 1,
                kind: 'tap',
                streamId: STREAM_ID,
                sourceId: SOURCE_ID,
                eventId: 'event-1',
                x: 0.4,
                y: 0.6,
            },
        });

        await flushMicrotasks();
        expect(fake.writes).toHaveLength(1);
        expect(JSON.parse(fake.writes[0] ?? '{}')).toMatchObject({ commandId: 'cmd-event-1' });

        fake.emitStdout({ v: 1, kind: 'control_ack', commandId: 'cmd-event-1', status: 'accepted', diagnostics: [] });

        await expect(pending).resolves.toMatchObject({ ok: true });
    });

    it('surfaces a rejected ack as a typed failure', async () => {
        const mod = await import(modulePath);
        const fake = createFakeHelperProcess();
        const session = mod.createIosSimulatorHelperSession({
            startHelper: async () => fake,
            maxPayloadBytes: 8,
        });

        const pending = session.sendCommand({
            v: 1,
            kind: 'control',
            commandId: 'cmd-event-2',
            target: { sourceId: SOURCE_ID, simulatorId: 'A1B2-C3D4' },
            control: {
                v: 1,
                kind: 'keyboard_text',
                streamId: STREAM_ID,
                sourceId: SOURCE_ID,
                eventId: 'event-2',
                text: 'hello',
            },
        });
        await flushMicrotasks();
        fake.emitStdout({
            v: 1,
            kind: 'control_ack',
            commandId: 'cmd-event-2',
            status: 'rejected',
            reasonCode: 'ios_simulator_keyboard_text_rejected',
            diagnostics: [],
        });

        await expect(pending).resolves.toMatchObject({
            ok: false,
            status: 'rejected',
            reasonCode: 'ios_simulator_keyboard_text_rejected',
        });
    });

    it('fails unacknowledged pending commands when the helper output closes', async () => {
        const mod = await import(modulePath);
        const fake = createFakeHelperProcess();
        const session = mod.createIosSimulatorHelperSession({
            startHelper: async () => fake,
            maxPayloadBytes: 8,
        });

        const pending = session.sendCommand({
            v: 1,
            kind: 'control',
            commandId: 'cmd-event-3',
            target: { sourceId: SOURCE_ID, simulatorId: 'A1B2-C3D4' },
            control: {
                v: 1,
                kind: 'tap',
                streamId: STREAM_ID,
                sourceId: SOURCE_ID,
                eventId: 'event-3',
                x: 0.1,
                y: 0.2,
            },
        });
        await flushMicrotasks();
        fake.emitClose({ exitCode: 9, signal: null });

        await expect(pending).resolves.toMatchObject({
            ok: false,
            status: 'unavailable',
            reasonCode: 'ios_helper_session_closed',
        });
    });

    it('lazily starts the helper once and shares it across stream + command consumers', async () => {
        const mod = await import(modulePath);
        const fake = createFakeHelperProcess();
        const startHelper = vi.fn<IosSimulatorHelperSessionStarter>(async () => fake);
        const session = mod.createIosSimulatorHelperSession({ startHelper, maxPayloadBytes: 8 });

        await session.openStream({
            sourceId: SOURCE_ID,
            streamId: STREAM_ID,
            codecId: 'image.mjpeg',
            emitMessage: () => {},
        });
        void session.sendCommand({
            v: 1,
            kind: 'control',
            commandId: 'cmd-event-4',
            target: { sourceId: SOURCE_ID, simulatorId: 'A1B2-C3D4' },
            control: {
                v: 1,
                kind: 'tap',
                streamId: STREAM_ID,
                sourceId: SOURCE_ID,
                eventId: 'event-4',
                x: 0.1,
                y: 0.2,
            },
        });
        await Promise.resolve();

        expect(startHelper).toHaveBeenCalledTimes(1);
        await session.stop();
        expect(fake.stopCalls).toBe(1);
    });

    it('respawns the helper after recoverable process closure (only stop is terminal)', async () => {
        const mod = await import(modulePath);
        const first = createFakeHelperProcess();
        const second = createFakeHelperProcess();
        const fakes = [first, second];
        const startHelper = vi.fn<IosSimulatorHelperSessionStarter>(async () => {
            const next = fakes.shift();
            if (!next) throw new Error('no more fakes');
            return next;
        });
        const session = mod.createIosSimulatorHelperSession({ startHelper, maxPayloadBytes: 8 });

        await session.openStream({
            sourceId: SOURCE_ID,
            streamId: STREAM_ID,
            codecId: 'image.mjpeg',
            emitMessage: () => {},
        });
        expect(startHelper).toHaveBeenCalledTimes(1);
        const departedRoot = session.readProcessRoots()[0];

        // Completed process output after a crash permits the next openStream to relaunch the helper.
        first.emitClose({ exitCode: 9, signal: null });
        await session.openStream({
            sourceId: SOURCE_ID,
            streamId: STREAM_ID,
            codecId: 'image.mjpeg',
            emitMessage: () => {},
        });
        expect(startHelper).toHaveBeenCalledTimes(2);
        // Both boundary children deliberately reuse PID 4242. A stale UI selection
        // cannot borrow that number to stop the new helper generation.
        await expect(departedRoot?.stop?.()).rejects.toMatchObject({ code: 'process_root_changed' });
        expect(second.stopCalls).toBe(0);
        await session.readProcessRoots()[0]?.stop?.();
        expect(second.stopCalls).toBe(1);
    });

    it('restarts after a crash with a clean stream generation', async () => {
        const mod = await import(modulePath);
        const first = createFakeHelperProcess();
        const second = createFakeHelperProcess();
        const fakes = [first, second];
        const startHelper = vi.fn<IosSimulatorHelperSessionStarter>(async () => {
            const next = fakes.shift();
            if (!next) throw new Error('no more fakes');
            return next;
        });
        const session = mod.createIosSimulatorHelperSession({ startHelper, maxPayloadBytes: 8 });

        const staleGenerationMessages: unknown[] = [];
        const nextGenerationMessages: unknown[] = [];
        await session.openStream({
            sourceId: SOURCE_ID,
            streamId: STREAM_ID,
            codecId: 'image.mjpeg',
            emitMessage: (message: unknown) => staleGenerationMessages.push(message),
        });
        first.emitStdout(frameLine({ sequence: 1 }));
        expect(staleGenerationMessages).toHaveLength(1);

        first.emitClose({ exitCode: 9, signal: null });
        await session.openStream({
            sourceId: SOURCE_ID,
            streamId: STREAM_ID,
            codecId: 'image.mjpeg',
            emitMessage: (message: unknown) => nextGenerationMessages.push(message),
        });
        second.emitStdout(frameLine({ sequence: 2 }));

        expect(nextGenerationMessages).toHaveLength(1);
        expect(staleGenerationMessages).toHaveLength(1);
        expect(startHelper).toHaveBeenCalledTimes(2);
    });

    it('refuses to respawn after stop() — openStream/sendCommand honor the terminal flag', async () => {
        const mod = await import(modulePath);
        const fake = createFakeHelperProcess();
        const startHelper = vi.fn<IosSimulatorHelperSessionStarter>(async () => fake);
        const session = mod.createIosSimulatorHelperSession({ startHelper, maxPayloadBytes: 8 });

        await session.openStream({
            sourceId: SOURCE_ID,
            streamId: STREAM_ID,
            codecId: 'image.mjpeg',
            emitMessage: () => {},
        });
        expect(startHelper).toHaveBeenCalledTimes(1);

        await session.stop();

        // openStream must NOT silently respawn a fresh helper once the session is terminally stopped.
        await expect(
            session.openStream({
                sourceId: SOURCE_ID,
                streamId: STREAM_ID,
                codecId: 'image.mjpeg',
                emitMessage: () => {},
            }),
        ).rejects.toMatchObject({ code: 'IOS_HELPER_SESSION_STOPPED' });
        expect(startHelper).toHaveBeenCalledTimes(1);

        // sendCommand resolves the closed failure rather than relaunching.
        await expect(
            session.sendCommand({
                v: 1,
                kind: 'control',
                commandId: 'cmd-after-stop',
                target: { sourceId: SOURCE_ID, simulatorId: 'A1B2-C3D4' },
                control: {
                    v: 1,
                    kind: 'tap',
                    streamId: STREAM_ID,
                    sourceId: SOURCE_ID,
                    eventId: 'event-after-stop',
                    x: 0.1,
                    y: 0.2,
                },
            }),
        ).resolves.toMatchObject({ ok: false, reasonCode: 'ios_helper_session_closed' });
        expect(startHelper).toHaveBeenCalledTimes(1);
    });

    it('serializes stop() with an in-flight openStream start and stops the late child', async () => {
        const mod = await import(modulePath);
        const fake = createFakeHelperProcess();
        const deferredStart = createDeferred<IosSimulatorHelperSessionProcess>();
        const startHelper = vi.fn<IosSimulatorHelperSessionStarter>(() => deferredStart.promise);
        const session = mod.createIosSimulatorHelperSession({ startHelper, maxPayloadBytes: 8 });

        const opening = session.openStream({
            sourceId: SOURCE_ID,
            streamId: STREAM_ID,
            codecId: 'image.mjpeg',
            emitMessage: () => {},
        });
        await flushMicrotasks();
        expect(startHelper).toHaveBeenCalledTimes(1);

        const stopping = session.stop();
        await flushMicrotasks();
        deferredStart.resolve(fake);

        await expect(opening).rejects.toMatchObject({ code: 'IOS_HELPER_SESSION_STOPPED' });
        await stopping;
        expect(fake.stopCalls).toBe(1);
        expect(startHelper).toHaveBeenCalledTimes(1);
        await expect(
            session.openStream({
                sourceId: SOURCE_ID,
                streamId: STREAM_ID,
                codecId: 'image.mjpeg',
                emitMessage: () => {},
            }),
        ).rejects.toMatchObject({ code: 'IOS_HELPER_SESSION_STOPPED' });
        expect(startHelper).toHaveBeenCalledTimes(1);
    });

    it('does not write a command after stop() closes an already-started helper', async () => {
        const mod = await import(modulePath);
        const fake = createFakeHelperProcess();
        const session = mod.createIosSimulatorHelperSession({
            startHelper: async () => fake,
            maxPayloadBytes: 8,
        });

        await session.openStream({
            sourceId: SOURCE_ID,
            streamId: STREAM_ID,
            codecId: 'image.mjpeg',
            emitMessage: () => {},
        });
        const pending = session.sendCommand({
            v: 1,
            kind: 'control',
            commandId: 'cmd-race-after-stop',
            target: { sourceId: SOURCE_ID, simulatorId: 'A1B2-C3D4' },
            control: {
                v: 1,
                kind: 'tap',
                streamId: STREAM_ID,
                sourceId: SOURCE_ID,
                eventId: 'event-race-after-stop',
                x: 0.1,
                y: 0.2,
            },
        });

        await session.stop();
        await flushMicrotasks();

        await expect(pending).resolves.toMatchObject({
            ok: false,
            status: 'unavailable',
            reasonCode: 'ios_helper_session_closed',
        });
        expect(fake.writes).toHaveLength(0);
        expect(fake.stopCalls).toBe(1);
    });

    it('makes double-stop idempotent for the same helper generation', async () => {
        const mod = await import(modulePath);
        const fake = createFakeHelperProcess();
        const session = mod.createIosSimulatorHelperSession({
            startHelper: async () => fake,
            maxPayloadBytes: 8,
        });

        await session.openStream({
            sourceId: SOURCE_ID,
            streamId: STREAM_ID,
            codecId: 'image.mjpeg',
            emitMessage: () => {},
        });

        const root = session.readProcessRoots()[0];
        expect(root).toMatchObject({ owner: { kind: 'happier', component: 'device_helper' }, pid: 4242 });
        await Promise.all([root?.stop?.(), root?.stop?.()]);

        expect(fake.stopCalls).toBe(1);
        expect(session.readProcessRoots()).toEqual([]);
        await expect(session.openStream({ sourceId: SOURCE_ID, streamId: STREAM_ID,
            codecId: 'image.mjpeg', emitMessage: () => {} })).rejects.toMatchObject({ code: 'IOS_HELPER_SESSION_STOPPED' });
    });

    it('discards an unbounded newline-free stdout run instead of accumulating (bounded reframer)', async () => {
        const mod = await import(modulePath);
        const fake = createFakeHelperProcess();
        const oversized: { sample: string; maxLineBytes: number }[] = [];
        const session = mod.createIosSimulatorHelperSession({
            startHelper: async () => fake,
            maxPayloadBytes: 8,
            maxLineBytes: 4096,
            onOversizedLine: (sample: string, maxLineBytes: number) => {
                oversized.push({ sample, maxLineBytes });
            },
        });

        const messages: unknown[] = [];
        await session.openStream({
            sourceId: SOURCE_ID,
            streamId: STREAM_ID,
            codecId: 'image.mjpeg',
            emitMessage: (m: unknown) => messages.push(m),
        });

        // Emit a newline-free run far larger than maxLineBytes: it must be discarded, not buffered.
        for (let i = 0; i < 8; i += 1) {
            fake.emitStdout('x'.repeat(2048));
        }
        expect(oversized.length).toBeGreaterThan(0);
        expect(oversized[0]?.maxLineBytes).toBe(4096);

        // Terminate the discarded oversized line with a newline; nothing parses from the garbage run.
        fake.emitStdout('\n');
        expect(messages).toHaveLength(0);

        // The discarded oversized line does NOT poison the stream: a subsequent valid frame parses.
        fake.emitStdout(frameLine());
        expect(messages).toHaveLength(1);
    });

    it('only delivers frames to the matching active stream consumer', async () => {
        const mod = await import(modulePath);
        const fake = createFakeHelperProcess();
        const session = mod.createIosSimulatorHelperSession({
            startHelper: async () => fake,
            maxPayloadBytes: 8,
        });

        const otherMessages: unknown[] = [];
        const matchingMessages: unknown[] = [];
        await session.openStream({
            sourceId: 'ios-simulator:OTHER:screen',
            streamId: 'other-stream',
            codecId: 'image.mjpeg',
            emitMessage: (m: unknown) => otherMessages.push(m),
        });
        await session.openStream({
            sourceId: SOURCE_ID,
            streamId: STREAM_ID,
            codecId: 'image.mjpeg',
            emitMessage: (m: unknown) => matchingMessages.push(m),
        });

        fake.emitStdout(frameLine());

        expect(matchingMessages).toHaveLength(1);
        expect(otherMessages).toHaveLength(0);
    });
});
