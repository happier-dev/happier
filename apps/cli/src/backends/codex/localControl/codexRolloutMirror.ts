import { randomUUID } from 'node:crypto';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import { JsonlFollower } from '@/agent/localControl/jsonlFollower';
import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import { collectCodexSessionRolloutFiles } from '../directSessions/collectCodexSessionRolloutFiles';
import { createCodexSyntheticSubagentTracker } from '../collaboration/createCodexSyntheticSubagentTracker';
import { mapCodexRolloutEventToActions, type CodexRolloutAction } from './rolloutMapper';
import { projectCodexRolloutActions } from '../rollout/projectCodexRolloutActions';
import { createCodexRolloutSemanticTracker } from '../rollout/createCodexRolloutSemanticTracker';
import type { LocalTurnLifecycleEvent } from '@/agent/localControl/turnLifecycle';

type MirrorContext = Readonly<{
    sidechainId: string | null;
    streamScopeId: string;
}>;

type SubagentMirrorState = {
    threadId: string;
    prompt: string | null;
    nickname: string | null;
    role: string | null;
    follower: JsonlFollower | null;
    discoveryTimer: NodeJS.Timeout | null;
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
    private follower: JsonlFollower | null = null;
    private readonly itemTranscriptBridge;
    private readonly syntheticSubagentTracker;
    private readonly rolloutSemanticTracker = createCodexRolloutSemanticTracker();
    private readonly subagentMirrorByThreadId = new Map<string, SubagentMirrorState>();
    private stopped = false;

    constructor(
        private readonly opts: {
            filePath: string;
            codexHome?: string | null;
            session: ApiSessionClient;
            debug: boolean;
            onCodexSessionId: (id: string) => void | Promise<void>;
            onTurnLifecycleEvent?: (event: LocalTurnLifecycleEvent) => void | Promise<void>;
        },
    ) {
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
        if (this.follower) return;
        this.stopped = false;
        const follower = new JsonlFollower({
            filePath: this.opts.filePath,
            pollIntervalMs: 250,
            startAtEnd: false,
            onJson: (value) => this.onJson(value),
        });
        this.follower = follower;
        await follower.start();
        if (this.follower !== follower) {
            await follower.stop();
        }
    }

    async stop(): Promise<void> {
        this.stopped = true;
        const follower = this.follower;
        this.follower = null;
        await follower?.stop();

        const subagentStates = Array.from(this.subagentMirrorByThreadId.values());
        this.subagentMirrorByThreadId.clear();
        for (const state of subagentStates) {
            if (state.discoveryTimer) {
                clearInterval(state.discoveryTimer);
            }
        }
        await Promise.all(subagentStates.map((state) => state.follower?.stop() ?? Promise.resolve()));
        await this.itemTranscriptBridge.flushAll({ reason: 'turn-end' });
    }

    private resolveCodexHome(): string | null {
        return this.opts.codexHome ?? resolveCodexHomeFromRolloutFilePath(this.opts.filePath);
    }

    private async ensureSubagentMirror(action: Extract<CodexRolloutAction, { type: 'subagent-spawn' }>): Promise<void> {
        if (this.subagentMirrorByThreadId.has(action.threadId)) return;

        const state: SubagentMirrorState = {
            threadId: action.threadId,
            prompt: action.prompt,
            nickname: action.nickname,
            role: action.role,
            follower: null,
            discoveryTimer: null,
        };
        this.subagentMirrorByThreadId.set(action.threadId, state);
        this.syntheticSubagentTracker.ensureStarted({
            threadId: action.threadId,
            prompt: action.prompt,
            nickname: action.nickname,
            role: action.role,
        });

        const codexHome = this.resolveCodexHome();
        if (!codexHome) return;

        const startFollowerIfReady = async (): Promise<void> => {
            if (this.stopped || state.follower) return;
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

            const childFollower = new JsonlFollower({
                filePath: latestFile.filePath,
                pollIntervalMs: 250,
                startAtEnd: false,
                onJson: (value) => this.onSubagentJson(action.threadId, value),
            });
            state.follower = childFollower;
            await childFollower.start();
            if (this.stopped || state.follower !== childFollower) {
                await childFollower.stop();
            }
        };

        await startFollowerIfReady();
        if (!state.follower && !this.stopped) {
            state.discoveryTimer = setInterval(() => {
                void startFollowerIfReady();
            }, 250);
            state.discoveryTimer.unref?.();
        }
    }

    private async handleAction(action: CodexRolloutAction, context: MirrorContext): Promise<void> {
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
                await this.itemTranscriptBridge.flushAll({ reason: 'tool-call-boundary' });
                this.opts.session.sendUserTextMessage(projected.text);
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

            if (projected.type === 'tool-call') {
                if (context.sidechainId === null && action.type === 'subagent-spawn') {
                    continue;
                }
                await this.itemTranscriptBridge.flushAll({ reason: 'tool-call-boundary' });
                if (context.sidechainId) {
                    this.opts.session.sendAgentMessage('codex', {
                        type: 'tool-call',
                        callId: projected.callId,
                        name: projected.name,
                        input: projected.input,
                        id: randomUUID(),
                        sidechainId: context.sidechainId,
                    });
                } else {
                    this.opts.session.sendCodexMessage({
                        type: 'tool-call',
                        callId: projected.callId,
                        name: projected.name,
                        input: projected.input,
                        id: randomUUID(),
                    });
                }
                continue;
            }

            if (projected.type === 'tool-result') {
                if (context.sidechainId === null && action.type === 'subagent-complete') {
                    this.syntheticSubagentTracker.finalize({
                        threadId: action.threadId,
                        status: action.status,
                    });
                    continue;
                }
                await this.itemTranscriptBridge.flushAll({ reason: 'tool-call-boundary' });
                if (context.sidechainId) {
                    this.opts.session.sendAgentMessage('codex', {
                        type: 'tool-result',
                        callId: projected.callId,
                        output: projected.output,
                        id: randomUUID(),
                        sidechainId: context.sidechainId,
                        ...(projected.isError ? { isError: projected.isError } : {}),
                    });
                } else {
                    this.opts.session.sendCodexMessage({
                        type: 'tool-call-result',
                        callId: projected.callId,
                        output: projected.output,
                        id: randomUUID(),
                        ...(projected.isError ? { isError: projected.isError } : {}),
                    });
                }
                continue;
            }

            if (projected.type === 'subagent-spawn') {
                await this.itemTranscriptBridge.flushAll({ reason: 'tool-call-boundary' });
                await this.ensureSubagentMirror(action as Extract<CodexRolloutAction, { type: 'subagent-spawn' }>);
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

    private async onSubagentJson(threadId: string, value: unknown): Promise<void> {
        const actions = mapCodexRolloutEventToActions(value, { debug: this.opts.debug });
        for (const action of actions) {
            for (const normalizedAction of this.rolloutSemanticTracker.consume(action)) {
                await this.handleAction(normalizedAction, {
                    sidechainId: threadId,
                    streamScopeId: threadId,
                });
            }
        }
    }

    private async onJson(value: unknown): Promise<void> {
        const actions = mapCodexRolloutEventToActions(value, { debug: this.opts.debug });
        for (const action of actions) {
            for (const normalizedAction of this.rolloutSemanticTracker.consume(action)) {
                await this.handleAction(normalizedAction, {
                    sidechainId: null,
                    streamScopeId: 'main',
                });
            }
        }
    }
}
