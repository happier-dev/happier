import type { AgentBackend, AgentMessageHandler, StartSessionResult } from '@/agent/core/AgentBackend';
import type {
    ExecutionRunHostRuntime,
    ExecutionRunSessionProvisionResult,
} from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';

import { createExecutionRunRuntime } from './runtime/create';

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function createExecutionRunHostRuntimeFromAgentBackend(backend: AgentBackend): ExecutionRunHostRuntime {
    return Object.freeze({
        async readResumeSupport(opts) {
            if (opts?.captureReplay === true) {
                return typeof backend.loadSessionWithReplayCapture === 'function';
            }
            return typeof backend.loadSessionWithReplayCapture === 'function' || typeof backend.loadSession === 'function';
        },
        async provisionSession(opts) {
            const resumeSessionId = normalizeNonEmptyString(opts?.resumeSessionId);
            if (resumeSessionId) {
                if (opts?.captureReplay === true) {
                    if (typeof backend.loadSessionWithReplayCapture !== 'function') {
                        throw new Error('Backend does not support resumable long-lived runs');
                    }
                    const loaded = await backend.loadSessionWithReplayCapture(resumeSessionId);
                    return { sessionId: loaded.sessionId };
                }
                if (typeof backend.loadSessionWithReplayCapture === 'function') {
                    const loaded = await backend.loadSessionWithReplayCapture(resumeSessionId);
                    return { sessionId: loaded.sessionId };
                }
                if (typeof backend.loadSession === 'function') {
                    const loaded = await backend.loadSession(resumeSessionId);
                    return { sessionId: loaded.sessionId };
                }
                throw new Error('Backend does not support resume');
            }

            const started = await backend.startSession(opts?.initialPrompt);
            return { sessionId: started.sessionId };
        },
        async sendPrompt(sessionId, prompt) {
            await backend.sendPrompt(sessionId, prompt);
        },
        ...(typeof backend.sendSteerPrompt === 'function'
            ? {
                async sendSteerPrompt(sessionId: string, prompt: string) {
                    await backend.sendSteerPrompt!(sessionId, prompt);
                },
            }
            : {}),
        async cancel(sessionId) {
            await backend.cancel(sessionId);
        },
        subscribeMessages(handler) {
            const wrapped: AgentMessageHandler = (message) => {
                handler(message);
            };
            backend.onMessage(wrapped);
            return () => {
                backend.offMessage?.(wrapped);
            };
        },
        ...(typeof backend.respondToPermission === 'function'
            ? {
                async respondToPermission(requestId: string, approved: boolean) {
                    await backend.respondToPermission!(requestId, approved);
                },
            }
            : {}),
        ...(typeof backend.waitForResponseComplete === 'function'
            ? {
                async waitForTurnCompletion(timeoutMs?: number | null) {
                    await backend.waitForResponseComplete!(timeoutMs);
                },
            }
            : {}),
        async dispose() {
            await backend.dispose();
        },
    });
}

export function createAgentBackendFromExecutionRunHostRuntime(runtime: ExecutionRunHostRuntime): AgentBackend {
    const unsubscribeByHandler = new Map<AgentMessageHandler, () => void>();

    const wrapSessionResult = (result: ExecutionRunSessionProvisionResult): StartSessionResult => ({
        sessionId: result.sessionId,
    });

    return Object.freeze({
        async readResumeSupport(opts: Readonly<{ captureReplay?: boolean }> | undefined) {
            return await runtime.readResumeSupport(opts);
        },
        async startSession(initialPrompt: string | undefined) {
            return wrapSessionResult(await runtime.provisionSession({ initialPrompt }));
        },
        async loadSession(sessionId: string) {
            return wrapSessionResult(await runtime.provisionSession({ resumeSessionId: sessionId }));
        },
        async sendPrompt(sessionId: string, prompt: string) {
            await runtime.sendPrompt(sessionId, prompt);
        },
        ...(typeof runtime.sendSteerPrompt === 'function'
            ? {
                async sendSteerPrompt(sessionId: string, prompt: string) {
                    await runtime.sendSteerPrompt!(sessionId, prompt);
                },
            }
            : {}),
        async cancel(sessionId: string) {
            await runtime.cancel(sessionId);
        },
        onMessage(handler: AgentMessageHandler) {
            if (unsubscribeByHandler.has(handler)) return;
            const unsubscribe = runtime.subscribeMessages(handler);
            unsubscribeByHandler.set(handler, unsubscribe);
        },
        offMessage(handler: AgentMessageHandler) {
            const unsubscribe = unsubscribeByHandler.get(handler);
            if (!unsubscribe) return;
            unsubscribe();
            unsubscribeByHandler.delete(handler);
        },
        ...(typeof runtime.respondToPermission === 'function'
            ? {
                async respondToPermission(requestId: string, approved: boolean) {
                    await runtime.respondToPermission!(requestId, approved);
                },
            }
            : {}),
        ...(typeof runtime.waitForTurnCompletion === 'function'
            ? {
                async waitForResponseComplete(timeoutMs?: number | null) {
                    await runtime.waitForTurnCompletion!(timeoutMs);
                },
            }
            : {}),
        async dispose() {
            for (const unsubscribe of unsubscribeByHandler.values()) {
                unsubscribe();
            }
            unsubscribeByHandler.clear();
            await runtime.dispose();
        },
    });
}

export function createExecutionRunBackend(opts: Parameters<typeof createExecutionRunRuntime>[0]): AgentBackend {
    return createAgentBackendFromExecutionRunHostRuntime(createExecutionRunRuntime(opts));
}
