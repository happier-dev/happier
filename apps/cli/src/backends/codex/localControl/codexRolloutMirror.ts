import type { ApiSessionClient } from '@/api/session/sessionClient';
import { createJsonlFollowController, type JsonlFollowController } from '@/agent/localControl/jsonlFollowController';
import type { JsonlLineSource } from '@/agent/localControl/jsonlLineFollower';
import { DEFAULT_JSONL_FOLLOW_POLICY, normalizeJsonlFollowPolicy, type JsonlFollowPolicyInput, type JsonlFollowPolicyV1 } from '@/agent/localControl/jsonlFollowPolicy';
import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import { collectCodexSessionRolloutFiles } from '../directSessions/collectCodexSessionRolloutFiles';
import { createCodexSyntheticSubagentTracker } from '../collaboration/createCodexSyntheticSubagentTracker';
import { mapCodexRolloutEventToActions, type CodexRolloutAction } from './rolloutMapper';
import { projectCodexRolloutActions } from '../rollout/projectCodexRolloutActions';
import { createCodexRolloutSemanticTracker } from '../rollout/createCodexRolloutSemanticTracker';
import {
    createCodexRolloutEffectLocalId,
    createCodexRolloutFileIdentity,
} from '../rollout/codexRolloutFileIdentity';
import type { LocalTurnLifecycleEvent } from '@/agent/localControl/turnLifecycle';

type MirrorContext = Readonly<{
    sidechainId: string | null;
    streamScopeId: string;
}>;

type RolloutActionSource = JsonlLineSource & Readonly<{
    actionIndex: number;
}>;

function createRolloutActionLocalId(source: RolloutActionSource, fileIdentity: string): string {
    return createCodexRolloutEffectLocalId({
        fileIdentity,
        lineStartOffsetBytes: source.lineStartOffsetBytes,
        effectIndex: source.actionIndex,
    });
}

type SubagentMirrorState = {
    threadId: string;
    prompt: string | null;
    nickname: string | null;
    role: string | null;
    controller: JsonlFollowController | null;
    discoveryTimer: NodeJS.Timeout | null;
    initialization: Promise<void> | null;
    createdAtMs: number;
    lastTouchedAtMs: number;
};

function resolveCodexHomeFromRolloutFilePath(filePath: string): string | null {
    const normalized = filePath.replace(/\\/g, '/');
    const markers = ['/sessions/', '/archived_sessions/'];
    for (const marker of markers) {
        const idx = normalized.indexOf(marker);
        if (idx > 0) {
            return normalized.slice(0, idx);
        }
    }
    return null;
}

export class CodexRolloutMirror {
    private controller: JsonlFollowController | null = null;
    private readonly itemTranscriptBridge;
    private readonly syntheticSubagentTracker;
    private readonly rolloutSemanticTracker = createCodexRolloutSemanticTracker();
    private readonly subagentMirrorByThreadId = new Map<string, SubagentMirrorState>();
    private readonly closedSubagentThreadIds = new Map<string, number>();
    private readonly followPolicy: JsonlFollowPolicyV1;
    private stopped = false;

    constructor(
        private readonly opts: {
            filePath: string;
            codexHome?: string | null;
            session: ApiSessionClient;
            debug: boolean;
            onCodexSessionId: (id: string) => void | Promise<void>;
            onTurnLifecycleEvent?: (event: LocalTurnLifecycleEvent) => void | Promise<void>;
            followPolicy?: JsonlFollowPolicyInput;
        },
    ) {
        this.followPolicy = normalizeJsonlFollowPolicy(opts.followPolicy, DEFAULT_JSONL_FOLLOW_POLICY.activeBurstPollIntervalMs);
        this.itemTranscriptBridge = createKeyedStreamedTranscriptBridge<{
            streamKey: string;
            sidechainId: string | null;
        }>({
            provider: 'codex',
            createSessionForStream: () => this.opts.session,
            checkpointIntervalMs: 0,
            checkpointMinChars: 1,
        });
        this.syntheticSubagentTracker = createCodexSyntheticSubagentTracker({
            session: this.opts.session,
        });
    }

    async start(): Promise<void> {
        if (this.controller) return;
        this.stopped = false;
        const controller = createJsonlFollowController({
            filePath: this.opts.filePath,
            pollPolicy: this.followPolicy,
            startAtEnd: false,
            onJson: (value, source) => this.onJson(value, source),
        });
        this.controller = controller;
        await controller.start();
        if (this.controller !== controller) {
            await controller.stop();
        }
    }

    async stop(): Promise<void> {
        this.stopped = true;
        const controller = this.controller;
        this.controller = null;
        await controller?.stop();

        const subagentStates = Array.from(this.subagentMirrorByThreadId.values());
        this.subagentMirrorByThreadId.clear();
        this.closedSubagentThreadIds.clear();
        for (const state of subagentStates) {
            if (state.discoveryTimer) {
                clearInterval(state.discoveryTimer);
            }
        }
        await Promise.all(subagentStates.map((state) => state.controller?.stop() ?? Promise.resolve()));
        await this.itemTranscriptBridge.flushAll({ reason: 'turn-end' });
    }

    private resolveCodexHome(): string | null {
        return this.opts.codexHome ?? resolveCodexHomeFromRolloutFilePath(this.opts.filePath);
    }

    private async flushTranscriptBoundary(context: MirrorContext): Promise<void> {
        await this.itemTranscriptBridge.flushStreamsMatching({
            reason: 'tool-call-boundary',
            matches: (stream) => stream.sidechainId === context.sidechainId,
        });
    }

    private async ensureSubagentMirror(
        action: Extract<CodexRolloutAction, { type: 'subagent-spawn' }>,
        localId?: string,
    ): Promise<void> {
        if (this.closedSubagentThreadIds.has(action.threadId)) return;
        const existing = this.subagentMirrorByThreadId.get(action.threadId);
        if (existing) {
            await existing.initialization;
            return;
        }

        const now = Date.now();
        const state: SubagentMirrorState = {
            threadId: action.threadId,
            prompt: action.prompt,
            nickname: action.nickname,
            role: action.role,
            controller: null,
            discoveryTimer: null,
            initialization: null,
            createdAtMs: now,
            lastTouchedAtMs: now,
        };
        const initialization = (async (): Promise<void> => {
            await this.syntheticSubagentTracker.ensureStarted({
                threadId: action.threadId,
                prompt: action.prompt,
                nickname: action.nickname,
                role: action.role,
            }, localId ? { localId } : undefined);

            const codexHome = this.resolveCodexHome();
            if (!codexHome) return;

            const startFollowerIfReady = async (): Promise<void> => {
                if (this.stopped || state.controller) return;
                const files = await collectCodexSessionRolloutFiles({
                    codexHome,
                    remoteSessionId: action.threadId,
                });
                const latestFile = files.at(-1);
                if (!latestFile) return;

                if (state.discoveryTimer) {
                    clearInterval(state.discoveryTimer);
                    state.discoveryTimer = null;
                }

                const childController = createJsonlFollowController({
                    filePath: latestFile.filePath,
                    pollPolicy: this.followPolicy,
                    startAtEnd: false,
                    onClosed: () => this.closeSubagentMirror(action.threadId),
                    onJson: (value, source) => this.onSubagentJson(action.threadId, value, source),
                });
                state.controller = childController;
                await childController.start();
                if (this.stopped || state.controller !== childController) {
                    await childController.stop();
                }
                this.enforceSubagentFollowerCaps();
            };

            await startFollowerIfReady();
            if (!state.controller && !this.stopped) {
                state.discoveryTimer = setInterval(() => {
                    void startFollowerIfReady();
                }, this.followPolicy.missingFileRetryIntervalMs);
                state.discoveryTimer.unref?.();
            }
        })();
        state.initialization = initialization;
        this.subagentMirrorByThreadId.set(action.threadId, state);
        try {
            await initialization;
            state.initialization = null;
        } catch (error) {
            if (state.discoveryTimer) {
                clearInterval(state.discoveryTimer);
                state.discoveryTimer = null;
            }
            const childController = state.controller;
            state.controller = null;
            await childController?.stop().catch(() => undefined);
            if (this.subagentMirrorByThreadId.get(action.threadId) === state) {
                this.subagentMirrorByThreadId.delete(action.threadId);
            }
            throw error;
        }
    }

    private async handleAction(
        action: CodexRolloutAction,
        context: MirrorContext,
        source?: RolloutActionSource,
    ): Promise<void> {
        const localId = source
            ? createRolloutActionLocalId(source, createCodexRolloutFileIdentity(source.fileIdentity))
            : undefined;

        if (action.type === 'turn-lifecycle') {
            if (context.sidechainId === null) {
                await this.opts.onTurnLifecycleEvent?.(action.event);
            }
            return;
        }

        for (const projected of projectCodexRolloutActions([action], { sidechainId: context.sidechainId })) {
            if (projected.type === 'codex-session-id') {
                await this.opts.onCodexSessionId(projected.id);
                continue;
            }
            if (projected.type === 'user-text') {
                await this.flushTranscriptBoundary(context);
                if (localId) {
                    await this.opts.session.sendUserTextMessageCommitted(projected.text, { localId });
                } else {
                    this.opts.session.sendUserTextMessage(projected.text);
                }
                continue;
            }

            if (projected.type === 'thinking') {
                // Rollout reasoning items are complete snapshots, not deltas of one shared segment.
                await this.flushTranscriptBoundary(context);
                this.itemTranscriptBridge.appendThinkingDelta({
                    deltaText: projected.text,
                    streamKey: `${context.streamScopeId}:assistant`,
                    sidechainId: projected.sidechainId,
                });
                await this.flushTranscriptBoundary(context);
                continue;
            }

            if (projected.type === 'assistant-text') {
                this.itemTranscriptBridge.appendAssistantDelta({
                    deltaText: projected.text,
                    streamKey: `${context.streamScopeId}:assistant`,
                    sidechainId: projected.sidechainId,
                });
                continue;
            }

            if (projected.type === 'context-compaction') {
                if (projected.sidechainId !== null) continue;
                if (!source || !localId) {
                    throw new Error('Root Codex rollout compaction is missing its source position');
                }
                await this.opts.session.sendSessionEventCommitted({
                    type: 'context-compaction',
                    phase: projected.phase,
                    lifecycleId: projected.lifecycleId,
                    provider: 'codex',
                    source: projected.source,
                    ...(projected.providerEventId ? { providerEventId: projected.providerEventId } : {}),
                }, {
                    localId,
                });
                continue;
            }

            if (projected.type === 'tool-call') {
                if (context.sidechainId === null && action.type === 'subagent-spawn') {
                    continue;
                }
                await this.flushTranscriptBoundary(context);
                if (context.sidechainId) {
                    const body = {
                        type: 'tool-call',
                        callId: projected.callId,
                        name: projected.name,
                        input: projected.input,
                        id: localId ?? projected.callId,
                        sidechainId: context.sidechainId,
                    } as const;
                    if (localId) {
                        await this.opts.session.sendAgentMessageCommitted('codex', body, { localId });
                    } else {
                        this.opts.session.sendAgentMessage('codex', body);
                    }
                } else {
                    const body = {
                        type: 'tool-call',
                        callId: projected.callId,
                        name: projected.name,
                        input: projected.input,
                        id: localId ?? projected.callId,
                    };
                    if (localId) {
                        await this.opts.session.sendCodexMessageCommitted(body, { localId });
                    } else {
                        this.opts.session.sendCodexMessage(body);
                    }
                }
                continue;
            }

            if (projected.type === 'tool-result') {
                if (context.sidechainId === null && action.type === 'subagent-complete') {
                    await this.syntheticSubagentTracker.finalize({
                        threadId: action.threadId,
                        status: action.status,
                    }, localId ? { localId } : undefined);
                    this.markSubagentMirrorCompleted(action.threadId);
                    continue;
                }
                await this.flushTranscriptBoundary(context);
                if (context.sidechainId) {
                    const body = {
                        type: 'tool-result',
                        callId: projected.callId,
                        output: projected.output,
                        id: localId ?? projected.callId,
                        sidechainId: context.sidechainId,
                        ...(projected.isError ? { isError: projected.isError } : {}),
                    } as const;
                    if (localId) {
                        await this.opts.session.sendAgentMessageCommitted('codex', body, { localId });
                    } else {
                        this.opts.session.sendAgentMessage('codex', body);
                    }
                } else {
                    const body = {
                        type: 'tool-call-result',
                        callId: projected.callId,
                        output: projected.output,
                        id: localId ?? projected.callId,
                        ...(projected.isError ? { isError: projected.isError } : {}),
                    };
                    if (localId) {
                        await this.opts.session.sendCodexMessageCommitted(body, { localId });
                    } else {
                        this.opts.session.sendCodexMessage(body);
                    }
                }
                continue;
            }

            if (projected.type === 'subagent-spawn') {
                await this.flushTranscriptBoundary(context);
                await this.ensureSubagentMirror(
                    action as Extract<CodexRolloutAction, { type: 'subagent-spawn' }>,
                    localId,
                );
                continue;
            }

            if (projected.type === 'debug') {
                this.opts.session.sendSessionEvent({
                    type: 'message',
                    message: `[codex-local] ${projected.message}`,
                });
            }
        }
    }

    private async onSubagentJson(
        threadId: string,
        value: unknown,
        source?: JsonlLineSource,
    ): Promise<void> {
        const state = this.subagentMirrorByThreadId.get(threadId);
        if (state) {
            state.lastTouchedAtMs = Date.now();
        }
        const actions = mapCodexRolloutEventToActions(value, { debug: this.opts.debug });
        await this.rolloutSemanticTracker.consumeAfterAcknowledgement(actions, async (normalizedActions) => {
            let actionIndex = 0;
            for (const normalizedAction of normalizedActions) {
                await this.handleAction(normalizedAction, {
                    sidechainId: threadId,
                    streamScopeId: threadId,
                }, source ? { ...source, actionIndex } : undefined);
                actionIndex += 1;
            }
        });
    }

    private markSubagentMirrorCompleted(threadId: string): void {
        const state = this.subagentMirrorByThreadId.get(threadId);
        if (!state) return;
        if (state.discoveryTimer) {
            clearInterval(state.discoveryTimer);
            state.discoveryTimer = null;
        }
        state.controller?.markCompleted();
    }

    private closeSubagentMirror(threadId: string): void {
        const state = this.subagentMirrorByThreadId.get(threadId);
        if (state?.discoveryTimer) {
            clearInterval(state.discoveryTimer);
            state.discoveryTimer = null;
        }
        this.subagentMirrorByThreadId.delete(threadId);
        this.rememberClosedSubagentThreadId(threadId);
    }

    private rememberClosedSubagentThreadId(threadId: string): void {
        this.closedSubagentThreadIds.delete(threadId);
        this.closedSubagentThreadIds.set(threadId, Date.now());
        while (this.closedSubagentThreadIds.size > this.followPolicy.maxClosedFollowerRecordsPerSession) {
            const oldest = this.closedSubagentThreadIds.keys().next().value;
            if (typeof oldest !== 'string') break;
            this.closedSubagentThreadIds.delete(oldest);
        }
    }

    private enforceSubagentFollowerCaps(): void {
        const activeStates = [...this.subagentMirrorByThreadId.values()]
            .filter((state) => state.controller?.getState() === 'active')
            .sort(compareSubagentStatesForEviction);
        while (activeStates.length > this.followPolicy.maxActiveFollowersPerSession) {
            const state = activeStates.shift();
            state?.controller?.markIdle();
        }

        const idleStates = [...this.subagentMirrorByThreadId.values()]
            .filter((state) => state.controller?.getState() === 'idle')
            .sort(compareSubagentStatesForEviction);
        while (idleStates.length > this.followPolicy.maxIdleFollowersPerSession) {
            const state = idleStates.shift();
            if (!state?.controller) break;
            void state.controller.stop();
        }
    }

    private async onJson(value: unknown, source?: JsonlLineSource): Promise<void> {
        const actions = mapCodexRolloutEventToActions(value, { debug: this.opts.debug });
        await this.rolloutSemanticTracker.consumeAfterAcknowledgement(actions, async (normalizedActions) => {
            let actionIndex = 0;
            for (const normalizedAction of normalizedActions) {
                await this.handleAction(normalizedAction, {
                    sidechainId: null,
                    streamScopeId: 'main',
                }, source ? { ...source, actionIndex } : undefined);
                actionIndex += 1;
            }
        });
    }
}

function compareSubagentStatesForEviction(left: SubagentMirrorState, right: SubagentMirrorState): number {
    return (left.lastTouchedAtMs - right.lastTouchedAtMs) || (left.createdAtMs - right.createdAtMs);
}
