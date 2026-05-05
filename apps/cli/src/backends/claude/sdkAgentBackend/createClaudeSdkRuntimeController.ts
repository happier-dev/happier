import type { AgentMessage } from '@/agent/core/AgentBackend';
import { createSubprocessStderrAppender } from '@/agent/runtime/subprocessArtifacts';
import { query } from '@/backends/claude/sdk/query';
import type { SDKMessage, SDKResultMessage } from '@/backends/claude/sdk/types';
import { ensureClaudeJsRuntimeExecutable } from '@/backends/claude/utils/ensureClaudeJsRuntimeExecutable';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';
import { handleClaudeSdkMessage } from './messageHandling';
import { createClaudeSdkCanCallTool } from './permissionPolicy';
import { prepareClaudeSdkPrompt } from './promptPreparation';
import type { ClaudeSdkLifecycleState, ClaudeSdkRuntimeState } from './runtimeState';
import type { ClaudeSdkAgentBackendOptions } from './types';

type ResolvePendingPermissionRequestsParams = Readonly<{
    approved: boolean;
    reason: string;
    emitResponses: boolean;
}>;

type ClaudeSdkRuntimeControllerDeps = Readonly<{
    abortController: AbortController;
    emit: (message: AgentMessage) => void;
    emitTokenCountTelemetry: (result: SDKResultMessage) => void;
    env: NodeJS.ProcessEnv;
    lifecycle: ClaudeSdkLifecycleState;
    noteVendorSessionId: (sessionIdRaw: unknown) => void;
    opts: ClaudeSdkAgentBackendOptions;
    promptStream: PushableAsyncIterable<SDKMessage>;
    resolvePendingPermissionRequests: (params: ResolvePendingPermissionRequestsParams) => void;
    runtime: ClaudeSdkRuntimeState;
}>;

export type ClaudeSdkRuntimeController = Readonly<{
    cancel: () => void;
    dispose: () => Promise<void>;
    sendPrompt: (prompt: string) => Promise<void>;
    sendSteerPrompt: (prompt: string) => Promise<void>;
    startSession: (params: Readonly<{ resume: string | null }>) => Promise<void>;
    waitForResponseComplete: (timeoutMs?: number) => Promise<void>;
}>;

export function createClaudeSdkRuntimeController(
    deps: ClaudeSdkRuntimeControllerDeps,
): ClaudeSdkRuntimeController {
    const controller: ClaudeSdkRuntimeController = {
        cancel: () => {
            const hadPendingTurn = Boolean(deps.runtime.pendingTurn);
            if (hadPendingTurn) {
                deps.runtime.ignoreNextNonSuccessResult = true;
                const pending = deps.runtime.pendingTurn;
                deps.runtime.pendingTurn = null;
                deps.runtime.pendingTurnCompletion = null;
                deps.runtime.settledTurnOrdinal = deps.runtime.currentTurnOrdinal;
                deps.runtime.turnChangeTracker.resetTurn();
                pending?.reject(new Error('Turn cancelled'));
            }
            deps.resolvePendingPermissionRequests({
                approved: false,
                reason: 'Turn cancelled',
                emitResponses: false,
            });

            try {
                void deps.runtime.query?.interrupt().catch(() => {});
            } catch {
                // Best-effort: interrupt is optional and should not crash cancellation.
            }
        },

        dispose: async () => {
            if (deps.lifecycle.disposed) return;
            deps.lifecycle.disposed = true;
            const pending = deps.runtime.pendingTurn;
            if (pending) {
                deps.runtime.pendingTurn = null;
                deps.runtime.pendingTurnCompletion = null;
                deps.runtime.suppressedExplicitDiffCallIds.clear();
                deps.runtime.settledTurnOrdinal = deps.runtime.currentTurnOrdinal;
                pending.reject(new Error('Agent disposed'));
            }
            deps.resolvePendingPermissionRequests({
                approved: false,
                reason: 'Agent disposed',
                emitResponses: false,
            });
            try {
                deps.promptStream.end();
            } catch {}
            try {
                deps.abortController.abort();
            } catch {}
            try {
                await deps.runtime.loopPromise;
            } catch {}
            try {
                await deps.runtime.stderrAppender?.close();
            } catch {}
            deps.runtime.stderrAppender = null;
            deps.runtime.query = null;
            deps.emit({ type: 'status', status: 'stopped' });
        },

        sendPrompt: async (prompt: string) => {
            let startedResolve!: () => void;
            let startedReject!: (error: Error) => void;
            const startedPromise = new Promise<void>((resolve, reject) => {
                startedResolve = resolve;
                startedReject = reject;
            });

            const run = async () => {
                if (deps.lifecycle.disposed) throw new Error('Backend disposed');
                if (deps.lifecycle.fatalError) throw deps.lifecycle.fatalError;

                try {
                    let completionResolve!: () => void;
                    let completionReject!: (error: Error) => void;
                    const completionPromise = new Promise<void>((resolve, reject) => {
                        completionResolve = resolve;
                        completionReject = reject;
                    });

                    deps.runtime.pendingTurn = {
                        resolve: completionResolve,
                        reject: completionReject,
                        buffer: [],
                    };
                    deps.runtime.pendingTurnCompletion = completionPromise;
                    deps.runtime.currentTurnOrdinal += 1;
                    deps.runtime.turnChangeTracker.beginTurn();

                    deps.promptStream.push({
                        type: 'user',
                        message: { role: 'user', content: prepareClaudeSdkPrompt(prompt) },
                    });
                    startedResolve();

                    await completionPromise.catch(() => {});
                } catch (error: unknown) {
                    const err = error instanceof Error ? error : new Error('Failed to enqueue prompt');
                    startedReject(err);
                    throw err;
                }
            };

            deps.runtime.sendChain = deps.runtime.sendChain.then(run, run);

            try {
                await startedPromise;
            } catch (error: unknown) {
                throw error instanceof Error ? error : new Error('Failed to send prompt');
            }
        },

        sendSteerPrompt: async (prompt: string) => {
            if (!deps.runtime.pendingTurn) {
                await controller.sendPrompt(prompt);
                return;
            }

            deps.promptStream.push({
                type: 'user',
                message: { role: 'user', content: prompt },
            });
        },

        startSession: async ({ resume }) => {
            if (deps.lifecycle.started) return;
            deps.lifecycle.started = true;

            const model = normalizeModelId(deps.opts.modelId);
            const canCallTool = createClaudeSdkCanCallTool({
                emit: deps.emit,
                pendingPermissionRequests: deps.runtime.pendingPermissionRequests,
                permissionPolicy: deps.opts.permissionPolicy,
            });

            deps.emit({ type: 'status', status: 'starting' });
            deps.runtime.stderrAppender = await createSubprocessStderrAppender({
                agentName: 'claude',
                pid: null,
                label: 'claude-sdk',
            });
            const runtimeExecutable = await ensureClaudeJsRuntimeExecutable();
            const q = query({
                prompt: deps.promptStream,
                options: {
                    cwd: deps.opts.cwd,
                    model: model ?? undefined,
                    executable: runtimeExecutable,
                    canCallTool,
                    settingsPath: deps.opts.settingsPath,
                    env: deps.env,
                    ...(resume ? { resume } : {}),
                    abort: deps.abortController.signal,
                    stderr: (data) => {
                        deps.runtime.stderrAppender?.append(data);
                    },
                },
            });

            deps.runtime.query = q;
            deps.runtime.queryIter = q[Symbol.asyncIterator]();
            deps.runtime.loopPromise = runLoop(deps);
        },

        waitForResponseComplete: async (timeoutMs?: number) => {
            if (deps.lifecycle.disposed) throw new Error('Backend disposed');
            const completion = deps.runtime.pendingTurnCompletion;
            if (!completion) {
                if (deps.lifecycle.fatalError) throw deps.lifecycle.fatalError;
                return;
            }

            const ms = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs >= 1 ? Math.floor(timeoutMs) : 120_000;
            await Promise.race([
                completion,
                new Promise<void>((_resolve, reject) => {
                    setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
                }),
            ]);
        },
    };

    return controller;

    async function runLoop(runDeps: ClaudeSdkRuntimeControllerDeps): Promise<void> {
        if (!runDeps.runtime.queryIter) return;
        try {
            for await (const msg of runDeps.runtime.queryIter) {
                if (runDeps.lifecycle.disposed) return;
                handleClaudeSdkMessage({
                    emit: runDeps.emit,
                    emitTokenCountTelemetry: runDeps.emitTokenCountTelemetry,
                    lifecycle: runDeps.lifecycle,
                    noteVendorSessionId: runDeps.noteVendorSessionId,
                    runtime: runDeps.runtime,
                    sdkMessage: msg,
                });
            }
        } catch (error: unknown) {
            const fatal = error instanceof Error ? error : new Error(String(error));
            runDeps.lifecycle.fatalError = fatal;

            const pending = runDeps.runtime.pendingTurn;
            if (pending) {
                runDeps.runtime.pendingTurn = null;
                runDeps.runtime.pendingTurnCompletion = null;
                runDeps.runtime.turnChangeTracker.resetTurn();
                runDeps.runtime.suppressedExplicitDiffCallIds.clear();
                pending.reject(fatal);
            }
            runDeps.resolvePendingPermissionRequests({
                approved: false,
                reason: fatal.message,
                emitResponses: false,
            });

            if (!runDeps.lifecycle.disposed) {
                runDeps.emit({ type: 'status', status: 'error', detail: fatal.message });
            }
        }
    }

    function normalizeModelId(modelIdRaw: string): string | null {
        const trimmed = String(modelIdRaw ?? '').trim();
        return !trimmed || trimmed === 'default' ? null : trimmed;
    }
}
