import { randomUUID } from 'node:crypto';

import type {
    ExecutionRunHostBackendV1,
    ExecutionRunHostMessageV1,
    RuntimeDisposeReasonV1,
} from '../runtime/session.js';

export type SingleShotExecutionRunErrorCodeV1 =
    | 'single_shot_busy'
    | 'single_shot_resume_unsupported'
    | 'single_shot_replay_unsupported';

export type SingleShotExecutionRunErrorV1 = Error & Readonly<{
    executionRunErrorCode: SingleShotExecutionRunErrorCodeV1;
}>;

export type SingleShotExecutionRunStartInputV1 = Readonly<{
    prompt: string;
    sessionId: string;
    signal: AbortSignal;
    emit: (message: ExecutionRunHostMessageV1) => void;
}>;

export type SingleShotExecutionRunResultV1 = Readonly<{
    messages?: readonly ExecutionRunHostMessageV1[];
    exitCode?: number | null;
}>;

export type SingleShotExecutionRunHandlerV1 = (
    input: SingleShotExecutionRunStartInputV1,
) => Promise<SingleShotExecutionRunResultV1> | SingleShotExecutionRunResultV1;

export type SingleShotExecutionRunBackendOptionsV1 = Readonly<{
    backendId: string;
    sessionIdPrefix?: string;
    signal?: AbortSignal;
    busyMessage?: string;
    resumeUnsupportedMessage?: string;
    replayUnsupportedMessage?: string;
    run: SingleShotExecutionRunHandlerV1;
    onDispose?: (reason?: RuntimeDisposeReasonV1) => void | Promise<void>;
}>;

type PendingRun = Readonly<{
    abort: () => void;
    done: Promise<void>;
}>;

function createSingleShotError(
    code: SingleShotExecutionRunErrorCodeV1,
    message: string,
): SingleShotExecutionRunErrorV1 {
    const error = new Error(message) as SingleShotExecutionRunErrorV1;
    Object.assign(error, { executionRunErrorCode: code });
    return error;
}

function normalizeSessionIdPrefix(options: SingleShotExecutionRunBackendOptionsV1): string {
    const explicit = options.sessionIdPrefix?.trim();
    if (explicit) return explicit;
    const normalized = options.backendId.trim().replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return normalized || 'execution_run';
}

function normalizeBackendLabel(options: SingleShotExecutionRunBackendOptionsV1): string {
    return options.sessionIdPrefix?.trim() || options.backendId.trim() || 'Single-shot backend';
}

function createAbortController(parentSignal: AbortSignal | undefined): Readonly<{
    controller: AbortController;
    dispose: () => void;
}> {
    const controller = new AbortController();
    if (!parentSignal) {
        return {
            controller,
            dispose: () => undefined,
        };
    }

    if (parentSignal.aborted) {
        controller.abort();
        return {
            controller,
            dispose: () => undefined,
        };
    }

    const abort = () => {
        controller.abort();
    };
    parentSignal.addEventListener('abort', abort, { once: true });
    return {
        controller,
        dispose: () => {
            parentSignal.removeEventListener('abort', abort);
        },
    };
}

export function createSingleShotExecutionRunHostBackend(
    options: SingleShotExecutionRunBackendOptionsV1,
): ExecutionRunHostBackendV1 {
    const pendingBySessionId = new Map<string, PendingRun>();
    const handlers = new Set<(message: ExecutionRunHostMessageV1) => void>();
    const sessionIdPrefix = normalizeSessionIdPrefix(options);
    const backendLabel = normalizeBackendLabel(options);

    function emit(message: ExecutionRunHostMessageV1): void {
        for (const handler of handlers) {
            try {
                handler(message);
            } catch {
                // Subscriber failures must not poison the backend run or other subscribers.
            }
        }
    }

    async function runForSession(sessionId: string, prompt: string): Promise<void> {
        if (pendingBySessionId.has(sessionId)) {
            throw createSingleShotError(
                'single_shot_busy',
                options.busyMessage ?? `${backendLabel} backend is busy`,
            );
        }

        const abort = createAbortController(options.signal);
        let resolveDone!: () => void;
        let rejectDone!: (error: unknown) => void;
        const done = new Promise<void>((resolve, reject) => {
            resolveDone = resolve;
            rejectDone = reject;
        });
        pendingBySessionId.set(sessionId, {
            abort: () => {
                abort.controller.abort();
            },
            done,
        });

        void (async () => {
            try {
                const emitIfActive = (message: ExecutionRunHostMessageV1): void => {
                    if (!abort.controller.signal.aborted) {
                        emit(message);
                    }
                };
                const result = await options.run({
                    prompt,
                    sessionId,
                    signal: abort.controller.signal,
                    emit: emitIfActive,
                });
                if (!abort.controller.signal.aborted) {
                    for (const message of result.messages ?? []) {
                        emit(message);
                    }
                }
                resolveDone();
            } catch (error) {
                rejectDone(error);
            } finally {
                abort.dispose();
                pendingBySessionId.delete(sessionId);
            }
        })();

        await done;
    }

    return Object.freeze({
        async readResumeSupport(opts) {
            void opts;
            return false;
        },
        async provisionSession(opts = {}) {
            if (opts.captureReplay === true) {
                throw createSingleShotError(
                    'single_shot_replay_unsupported',
                    options.replayUnsupportedMessage
                        ?? `${backendLabel} execution runs do not support replay capture`,
                );
            }
            if (typeof opts.resumeSessionId === 'string' && opts.resumeSessionId.trim()) {
                throw createSingleShotError(
                    'single_shot_resume_unsupported',
                    options.resumeUnsupportedMessage
                        ?? `${backendLabel} execution runs do not support session resume`,
                );
            }
            const sessionId = `${sessionIdPrefix}_${randomUUID()}`;
            if (opts.initialPrompt?.trim()) {
                await runForSession(sessionId, opts.initialPrompt);
            }
            return { sessionId };
        },
        async sendPrompt(sessionId, prompt) {
            await runForSession(sessionId, prompt);
        },
        async cancel(sessionId) {
            const pending = pendingBySessionId.get(sessionId);
            if (!pending) return;
            pending.abort();
            await pending.done.catch(() => undefined);
        },
        subscribeMessages(handler) {
            handlers.add(handler);
            return () => {
                handlers.delete(handler);
            };
        },
        async dispose(reason?: RuntimeDisposeReasonV1) {
            const pending = [...pendingBySessionId.values()];
            for (const entry of pending) entry.abort();
            await Promise.allSettled(pending.map(async (entry) => await entry.done));
            pendingBySessionId.clear();
            handlers.clear();
            await options.onDispose?.(reason);
        },
    });
}
