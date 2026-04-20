import type { AgentMessage } from '@/agent/core';
import type { RuntimeTurnMessageHandler, RuntimeTurnOperations, RuntimeTurnSessionIdentity } from '@/agent/runtime/turns/runtimeTurnOperations';

import type { ExecutionRunHostRuntime } from './executionRunHostRuntime';

function requireSessionId(identity: RuntimeTurnSessionIdentity): string {
    const sessionId = typeof identity.sessionId === 'string' && identity.sessionId.trim().length > 0
        ? identity.sessionId.trim()
        : null;
    if (sessionId) return sessionId;
    throw new Error('Execution-run runtime session was not started');
}

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function createExecutionRunHostRuntimeFromRuntimeTurnOperations(
    operations: RuntimeTurnOperations,
): ExecutionRunHostRuntime {
    return Object.freeze({
        async readResumeSupport(opts) {
            return opts?.captureReplay === true ? false : true;
        },
        async provisionSession(opts) {
            const resumeSessionId = typeof opts?.resumeSessionId === 'string' && opts.resumeSessionId.trim().length > 0
                ? opts.resumeSessionId.trim()
                : null;
            if (resumeSessionId && opts?.captureReplay === true) {
                throw new Error('Backend does not support resumable long-lived runs');
            }

            await operations.startOrLoadSession({
                ...(resumeSessionId ? { resumeId: resumeSessionId } : {}),
            });

            const initialPrompt = normalizeNonEmptyString(opts?.initialPrompt);
            if (initialPrompt) {
                operations.beginTurnLifecycle();
                await operations.sendTurnPrompt(initialPrompt);
            }

            return { sessionId: requireSessionId(operations.readSessionIdentity()) };
        },
        async sendPrompt(_sessionId, prompt) {
            operations.beginTurnLifecycle();
            await operations.sendTurnPrompt(prompt);
        },
        async sendSteerPrompt(_sessionId, prompt) {
            await operations.steerInFlightTurn(prompt);
        },
        async cancel() {
            await operations.cancelTurn();
        },
        subscribeMessages(handler) {
            const wrapped: RuntimeTurnMessageHandler = (message) => {
                handler(message as AgentMessage);
            };
            return operations.subscribeRuntimeMessages(wrapped);
        },
        async respondToPermission(requestId, approved) {
            await operations.respondToPermission(requestId, approved);
        },
        async waitForTurnCompletion(timeoutMs) {
            await operations.waitForTurnCompletion({ timeoutMs });
        },
        async dispose() {
            await operations.resetOrDisposeRuntime();
        },
    });
}
