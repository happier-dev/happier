import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { basename } from 'node:path';

import { attachJsonlLineReader } from '../../../../agent/runtime/jsonl/attachJsonlLineReader';
import {
    createIosSimulatorHelperMessageParser,
    type IosSimulatorHelperControlAckMessage,
    type IosSimulatorHelperControlCommand,
    type IosSimulatorHelperFrameMessage,
    type IosSimulatorHelperMessage,
} from './helperProtocol';
import type {
    IosSimulatorHelperFrameStream,
    IosSimulatorHelperFrameStreamOpenInput,
    IosSimulatorHelperFrameStreamOpener,
} from './helperFrameProducer';

const DEFAULT_DAEMON_HELPER_ARGS = ['--daemon-json'] as const;
const DEFAULT_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
/**
 * Per-line ceiling for the canonical bounded NDJSON reader. A helper that emits a newline-free run
 * (a stuck or hostile child) must not be allowed to accumulate an unbounded reframe buffer; once a
 * single pending line exceeds this byte budget the reader discards it instead of buffering. Sized to
 * comfortably hold a max-payload frame envelope (base64 payload ~+33%) plus its JSON framing.
 */
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const FORBIDDEN_HELPER_PROCESS_NAMES = new Set(['node', 'npm', 'npx', 'pnpm', 'yarn', 'bunx']);

type MaybePromise<T> = T | Promise<T>;

export type IosSimulatorHelperSessionProcessExit = Readonly<{
    exitCode: number | null;
    signal: string | null;
}>;

/**
 * Piped long-lived helper child boundary. Unlike the probe lifecycle (which spawns with
 * `stdio: 'ignore'`), the streaming/control owner needs full duplex stdio: it reads the
 * NDJSON stdout demux and writes control commands to stdin.
 */
export type IosSimulatorHelperSessionProcess = Readonly<{
    pid?: number;
    onStdoutLine: (listener: (chunk: Buffer | string) => void) => void;
    onExit: (listener: (exit: IosSimulatorHelperSessionProcessExit) => void) => void;
    writeStdin: (line: string) => MaybePromise<void>;
    stop: () => MaybePromise<void>;
}>;

export type IosSimulatorHelperSessionStartInput = Readonly<{
    helperPath: string;
    args: readonly string[];
}>;

export type IosSimulatorHelperSessionStarter = (
    input: IosSimulatorHelperSessionStartInput,
) => MaybePromise<IosSimulatorHelperSessionProcess>;

/**
 * Narrow structural view of the piped helper child the session owner depends on. Spawned with
 * `stdio: ['pipe', 'pipe', 'ignore']`, so stdin (writable) + stdout (readable) are present and
 * stderr is dropped.
 */
export type IosSimulatorHelperSessionChild = Readonly<{
    pid?: number;
    killed: boolean;
    stdin: Readonly<{ write: (chunk: string) => unknown }> | null;
    stdout: Readonly<{ on: (event: 'data', listener: (chunk: Buffer) => void) => unknown }> | null;
    once: (event: 'exit', listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void) => unknown;
    kill: (signal: NodeJS.Signals) => boolean;
}>;

export type IosSimulatorHelperSessionSpawn = (
    command: string,
    args: readonly string[],
) => IosSimulatorHelperSessionChild;

export type IosSimulatorHelperSessionCommandResult = Readonly<
    | { ok: true; diagnostics?: readonly Record<string, unknown>[] }
    | {
        ok: false;
        status: 'rejected' | 'unavailable';
        reasonCode: string;
        diagnostics?: readonly Record<string, unknown>[];
    }
>;

export type IosSimulatorHelperSession = Readonly<{
    openStream: IosSimulatorHelperFrameStreamOpener;
    sendCommand: (
        command: IosSimulatorHelperControlCommand,
    ) => Promise<IosSimulatorHelperSessionCommandResult>;
    stop: () => Promise<void>;
}>;

export type CreateIosSimulatorHelperSessionInput = Readonly<{
    helperPath?: string;
    helperArgs?: readonly string[];
    startHelper?: IosSimulatorHelperSessionStarter;
    spawn?: IosSimulatorHelperSessionSpawn;
    maxPayloadBytes?: number;
    maxLineBytes?: number;
    commandTimeoutMs?: number;
    onOversizedLine?: (sample: string, maxLineBytes: number) => void;
}>;

type StreamConsumer = Readonly<{
    sourceId: string;
    streamId: string;
    emitMessage: (message: IosSimulatorHelperFrameMessage) => void;
}>;

type PendingCommand = Readonly<{
    resolve: (result: IosSimulatorHelperSessionCommandResult) => void;
    timer?: ReturnType<typeof setTimeout>;
}>;

function isForbiddenHelperProcessPath(path: string): boolean {
    return FORBIDDEN_HELPER_PROCESS_NAMES.has(basename(path));
}

/**
 * Default piped-stdio process starter over `child_process.spawn`. Refuses Node / package-manager
 * runtimes (binary-safe runtime invariant) so a vendored signed helper is the only thing ever
 * launched here. Demuxes stdout into newline events and exposes a stdin writer + SIGTERM stop.
 */
export function createIosSimulatorHelperSessionProcessStarter(
    input: Readonly<{ spawn?: IosSimulatorHelperSessionSpawn }> = {},
): IosSimulatorHelperSessionStarter {
    const spawn = input.spawn
        ?? ((command, args) => nodeSpawn(command, [...args], {
            stdio: ['pipe', 'pipe', 'ignore'],
            windowsHide: true,
            shell: false,
        }));
    return (startInput) => {
        if (isForbiddenHelperProcessPath(startInput.helperPath)) {
            throw Object.assign(
                new Error('Refusing to start helper through a Node/package-manager runtime'),
                { code: 'FORBIDDEN_HELPER_RUNTIME' },
            );
        }
        const child = spawn(startInput.helperPath, [...startInput.args]);
        return {
            ...(typeof child.pid === 'number' ? { pid: child.pid } : {}),
            onStdoutLine: (listener) => {
                child.stdout?.on('data', (chunk: Buffer) => listener(chunk));
            },
            onExit: (listener) => {
                child.once('exit', (exitCode: number | null, signal: NodeJS.Signals | null) => {
                    listener({ exitCode, signal: signal ?? null });
                });
            },
            writeStdin: (line: string) => {
                child.stdin?.write(line);
            },
            stop: () => {
                if (!child.killed) child.kill('SIGTERM');
            },
        };
    };
}

/**
 * Host-side owner of a single long-lived `--daemon-json` helper process. It is the canonical
 * `openStream` producer (capture) AND the `sendCommand` input sender (control) for the iOS
 * simulator adapter — the iOS analog of the Android scrcpy server handle which serves both the
 * raw video stream and the control socket from one process.
 *
 * Trust/binary-safety is enforced upstream: this owner is only constructed once the vendored
 * helper artifact has passed digest + Developer ID signature + notarization verification, and the
 * process starter refuses Node/package-manager runtimes. The private-framework App Store / TOS
 * posture (out-of-process containment) is documented in docs/ios-simulator-helper.md.
 */
export function createIosSimulatorHelperSession(
    input: CreateIosSimulatorHelperSessionInput,
): IosSimulatorHelperSession {
    const helperPath = input.helperPath ?? '';
    const helperArgs = input.helperArgs ?? DEFAULT_DAEMON_HELPER_ARGS;
    const maxPayloadBytes = input.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    const maxLineBytes = input.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    const commandTimeoutMs = input.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const startHelper = input.startHelper
        ?? createIosSimulatorHelperSessionProcessStarter(input.spawn ? { spawn: input.spawn } : {});

    const parser = createIosSimulatorHelperMessageParser({ maxPayloadBytes });
    const streamConsumers = new Set<StreamConsumer>();
    const pendingCommands = new Map<string, PendingCommand>();

    let processHandle: IosSimulatorHelperSessionProcess | null = null;
    let startPromise: Promise<IosSimulatorHelperSessionProcess> | null = null;
    let stopPromise: Promise<void> | null = null;
    // `stopped` is the TERMINAL flag — set only by `stop()`. Once stopped, the owner never respawns a
    // helper: `ensureProcess`/`openStream`/`sendCommand` all refuse. A bare process exit is RECOVERABLE
    // (the next `ensureProcess` may relaunch); only an explicit `stop()` is terminal. Conflating the two
    // (the prior `closed` flag) let a crashed/stopped session silently respawn a fresh helper.
    let stopped = false;

    const createStoppedError = (): Error & { code: 'IOS_HELPER_SESSION_STOPPED' } => Object.assign(
        new Error('iOS simulator helper session is stopped'),
        { code: 'IOS_HELPER_SESSION_STOPPED' as const },
    );

    const isStoppedError = (error: unknown): boolean => Boolean(
        error
        && typeof error === 'object'
        && (error as { code?: unknown }).code === 'IOS_HELPER_SESSION_STOPPED',
    );

    const settlePending = (
        commandId: string,
        result: IosSimulatorHelperSessionCommandResult,
    ): void => {
        const pending = pendingCommands.get(commandId);
        if (!pending) return;
        pendingCommands.delete(commandId);
        if (pending.timer) clearTimeout(pending.timer);
        pending.resolve(result);
    };

    const failAllPending = (result: IosSimulatorHelperSessionCommandResult): void => {
        for (const commandId of [...pendingCommands.keys()]) {
            settlePending(commandId, result);
        }
    };

    const handleAck = (ack: IosSimulatorHelperControlAckMessage): void => {
        if (ack.status === 'accepted') {
            settlePending(ack.commandId, { ok: true, diagnostics: ack.diagnostics });
            return;
        }
        settlePending(ack.commandId, {
            ok: false,
            status: ack.status,
            reasonCode: ack.reasonCode ?? 'ios_simulator_control_failed',
            diagnostics: ack.diagnostics,
        });
    };

    const dispatchMessage = (message: IosSimulatorHelperMessage): void => {
        if (message.kind === 'control_ack') {
            handleAck(message);
            return;
        }
        if (message.kind !== 'frame') return;
        for (const consumer of streamConsumers) {
            if (consumer.sourceId === message.sourceId && consumer.streamId === message.streamId) {
                consumer.emitMessage(message);
            }
        }
    };

    const handleLine = (line: string): void => {
        const trimmed = line.trim();
        if (trimmed.length === 0) return;
        const parsed = parser.parse(trimmed);
        if (parsed.ok) dispatchMessage(parsed.message);
    };

    /**
     * Bridge the process's `onStdoutLine(listener)` callback boundary onto the canonical bounded
     * NDJSON reader. The reader owns reframing + the `maxLineBytes` ceiling so a newline-free run is
     * discarded (`discardingOversizedLine`) instead of accumulating an unbounded local buffer — no
     * hand-rolled cap here (AGENTS.md: reuse the canonical owner). The emitter is the minimal
     * `data`/`end` event surface the reader attaches to; chunks from the process are forwarded as
     * `data` events.
     */
    const attachStdoutReader = (handle: IosSimulatorHelperSessionProcess): void => {
        const stdoutEvents = new EventEmitter();
        attachJsonlLineReader(
            stdoutEvents as unknown as NodeJS.ReadableStream,
            handleLine,
            {
                maxLineBytes,
                ...(input.onOversizedLine ? { onOversizedLine: input.onOversizedLine } : {}),
                onError: () => {
                    // Reader errors are surfaced via the parser/dispatch path already; never let an
                    // unhandled reader error escape into the helper process boundary.
                },
            },
        );
        handle.onStdoutLine((chunk) => {
            stdoutEvents.emit('data', chunk);
        });
        handle.onExit(() => {
            stdoutEvents.emit('end');
        });
    };

    const onExit = (handle: IosSimulatorHelperSessionProcess): void => {
        if (processHandle !== handle) {
            return;
        }
        // RECOVERABLE: the process exited but the session is not terminal. Clear the live handle so the
        // next `ensureProcess` may relaunch; fail any in-flight commands so callers are not left hanging.
        processHandle = null;
        streamConsumers.clear();
        failAllPending({
            ok: false,
            status: 'unavailable',
            reasonCode: 'ios_helper_session_closed',
            diagnostics: [{ code: 'ios_helper_session_closed' }],
        });
    };

    const ensureProcess = async (): Promise<IosSimulatorHelperSessionProcess> => {
        if (stopped) {
            throw createStoppedError();
        }
        if (processHandle) return processHandle;
        if (startPromise) return await startPromise;
        startPromise = (async () => {
            const handle = await startHelper({ helperPath, args: helperArgs });
            if (stopped) {
                await Promise.resolve(handle.stop()).catch(() => undefined);
                throw createStoppedError();
            }
            attachStdoutReader(handle);
            handle.onExit(() => onExit(handle));
            processHandle = handle;
            return handle;
        })().finally(() => {
            startPromise = null;
        });
        return await startPromise;
    };

    const openStream: IosSimulatorHelperFrameStreamOpener = async (
        openInput: IosSimulatorHelperFrameStreamOpenInput,
    ): Promise<IosSimulatorHelperFrameStream> => {
        // Honor the terminal flag: a stopped session must NOT respawn a fresh helper behind the
        // caller's back. Recoverable process exits are handled inside `ensureProcess`.
        if (stopped) {
            throw createStoppedError();
        }
        const consumer: StreamConsumer = {
            sourceId: openInput.sourceId,
            streamId: openInput.streamId,
            emitMessage: openInput.emitMessage,
        };
        streamConsumers.add(consumer);
        try {
            await ensureProcess();
            if (stopped) {
                streamConsumers.delete(consumer);
                throw createStoppedError();
            }
        } catch (error) {
            streamConsumers.delete(consumer);
            throw error;
        }
        return {
            stop: () => {
                streamConsumers.delete(consumer);
            },
        };
    };

    const sendCommand = (
        command: IosSimulatorHelperControlCommand,
    ): Promise<IosSimulatorHelperSessionCommandResult> => {
        if (stopped) {
            return Promise.resolve({
                ok: false,
                status: 'unavailable',
                reasonCode: 'ios_helper_session_closed',
                diagnostics: [{ code: 'ios_helper_session_closed' }],
            });
        }

        // Register the pending command SYNCHRONOUSLY before any await so an ack that arrives on
        // the very next stdout chunk (or a process exit) is still correlated to this waiter and
        // never lost to a registration race.
        return new Promise<IosSimulatorHelperSessionCommandResult>((resolve) => {
            const timer = setTimeout(() => {
                settlePending(command.commandId, {
                    ok: false,
                    status: 'unavailable',
                    reasonCode: 'ios_simulator_control_timeout',
                    diagnostics: [{ code: 'ios_simulator_control_timeout' }],
                });
            }, commandTimeoutMs);
            if (typeof timer === 'object' && 'unref' in timer) timer.unref();
            pendingCommands.set(command.commandId, { resolve, timer });

            void (async () => {
                let handle: IosSimulatorHelperSessionProcess;
                try {
                    handle = await ensureProcess();
                } catch (error) {
                    settlePending(command.commandId, {
                        ok: false,
                        status: 'unavailable',
                        reasonCode: isStoppedError(error)
                            ? 'ios_helper_session_closed'
                            : 'ios_helper_session_start_failed',
                        diagnostics: [{
                            code: isStoppedError(error)
                                ? 'ios_helper_session_closed'
                                : 'ios_helper_session_start_failed',
                            errorName: error instanceof Error ? error.name : 'UnknownError',
                        }],
                    });
                    return;
                }
                if (stopped) {
                    settlePending(command.commandId, {
                        ok: false,
                        status: 'unavailable',
                        reasonCode: 'ios_helper_session_closed',
                        diagnostics: [{ code: 'ios_helper_session_closed' }],
                    });
                    return;
                }
                try {
                    await handle.writeStdin(`${JSON.stringify(command)}\n`);
                } catch (error) {
                    settlePending(command.commandId, {
                        ok: false,
                        status: 'unavailable',
                        reasonCode: 'ios_helper_session_write_failed',
                        diagnostics: [{
                            code: 'ios_helper_session_write_failed',
                            errorName: error instanceof Error ? error.name : 'UnknownError',
                        }],
                    });
                }
            })();
        });
    };

    const stop = async (): Promise<void> => {
        if (stopPromise) return await stopPromise;
        const handle = processHandle;
        const inFlightStart = startPromise;
        stopped = true;
        streamConsumers.clear();
        failAllPending({
            ok: false,
            status: 'unavailable',
            reasonCode: 'ios_helper_session_closed',
            diagnostics: [{ code: 'ios_helper_session_closed' }],
        });
        stopPromise = (async () => {
            if (handle) {
                await Promise.resolve(handle.stop()).catch(() => undefined);
                return;
            }
            if (inFlightStart) {
                await inFlightStart.then(
                    async (startedHandle) => {
                        await Promise.resolve(startedHandle.stop()).catch(() => undefined);
                    },
                    () => undefined,
                );
            }
        })().then(() => {
            processHandle = null;
        });
        return await stopPromise;
    };

    return { openStream, sendCommand, stop };
}
