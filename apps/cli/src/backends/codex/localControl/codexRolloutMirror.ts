import type { DirectSessionsSource, DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';
import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { FileBackedTranscriptSessionLease, FileBackedTranscriptSessionStore } from '@/api/session/fileBackedTranscripts/store';
import { createKeyedStreamedTranscriptBridge } from '@/api/session/createKeyedStreamedTranscriptBridge';
import { createCodexSyntheticSubagentTracker } from '../collaboration/createCodexSyntheticSubagentTracker';
import { mapCodexRolloutEventToActions, type CodexRolloutAction } from '../rollout/projection/mapCodexRolloutEventToActions';
import { projectCodexRolloutActions } from '../rollout/projectCodexRolloutActions';
import { createCodexRolloutSemanticTracker } from '../rollout/createCodexRolloutSemanticTracker';
import { CodexRolloutFollowerRuntime } from '../rollout/runtime/CodexRolloutFollowerRuntime';
import { acquireCodexRolloutSessionStore } from '../rollout/sessionStore/codexRolloutSessionStoreRegistry';
import { finalizeCodexSyntheticSubagent, startCodexSyntheticSubagent } from '../runtime/emitCodexSyntheticSubagentLifecycle';
import { sendCodexProjectedToolEvent } from '../runtime/sendCodexProjectedToolEvent';

type MirrorContext = Readonly<{
    sidechainId: string | null;
    streamScopeId: string;
}>;

export class CodexRolloutMirror {
    private readonly itemTranscriptBridge;
    private readonly syntheticSubagentTracker;
    private readonly rolloutSemanticTracker = createCodexRolloutSemanticTracker();
    private readonly followerRuntime;
    private readonly processedSharedStoreItemIds = new Set<string>();
    private readonly rolloutSessionStoreBinding;
    private readonly allowLegacyFollowerFallback;
    private rolloutSessionStoreLease: FileBackedTranscriptSessionLease<FileBackedTranscriptSessionStore<DirectTranscriptRawMessageV1>> | null = null;
    private rolloutSessionStoreUnsubscribe: (() => void) | null = null;
    private startedMode: 'follower' | 'shared-store' | null = null;

    constructor(
        private readonly opts: {
            filePath: string;
            codexHome?: string | null;
            session: ApiSessionClient;
            debug: boolean;
            onCodexSessionId: (id: string) => void | Promise<void>;
            allowLegacyFollowerFallback?: boolean;
            rolloutSessionStore?: Readonly<{
                activeServerDir: string;
                source: DirectSessionsSource;
                remoteSessionId: string;
                env?: NodeJS.ProcessEnv;
            }>;
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
        this.rolloutSessionStoreBinding = this.opts.rolloutSessionStore ?? null;
        this.allowLegacyFollowerFallback = this.opts.allowLegacyFollowerFallback === true;
        this.followerRuntime = new CodexRolloutFollowerRuntime({
            filePath: this.opts.filePath,
            codexHome: this.opts.codexHome,
            onMainJson: (value) => this.onJson(value),
            onSubagentJson: (threadId, value) => this.onSubagentJson(threadId, value),
        });
    }

    async start(): Promise<void> {
        if (this.startedMode === 'shared-store' || this.startedMode === 'follower') {
            return;
        }
        if (this.rolloutSessionStoreBinding) {
            await this.startSharedStoreMirror();
            return;
        }
        if (!this.allowLegacyFollowerFallback) {
            throw new Error('Codex local control requires a shared-store binding; enable the legacy follower fallback explicitly for noncanonical fixtures.');
        }
        this.startedMode = 'follower';
        await this.followerRuntime.start();
    }

    async stop(): Promise<void> {
        if (this.startedMode === 'shared-store') {
            const unsubscribe = this.rolloutSessionStoreUnsubscribe;
            this.rolloutSessionStoreUnsubscribe = null;
            unsubscribe?.();

            const lease = this.rolloutSessionStoreLease;
            this.rolloutSessionStoreLease = null;
            await lease?.release();
        } else if (this.startedMode === 'follower') {
            await this.followerRuntime.stop();
        }
        this.startedMode = null;
        this.processedSharedStoreItemIds.clear();
        await this.itemTranscriptBridge.flushAll({ reason: 'turn-end' });
    }

    private async handleAction(action: CodexRolloutAction, context: MirrorContext): Promise<void> {
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
                await sendCodexProjectedToolEvent({
                    session: this.opts.session,
                    event: projected,
                    flushBeforeToolCall: async () => {
                        await this.itemTranscriptBridge.flushAll({ reason: 'tool-call-boundary' });
                    },
                });
                continue;
            }

            if (projected.type === 'tool-result') {
                if (context.sidechainId === null && action.type === 'subagent-complete') {
                    await finalizeCodexSyntheticSubagent({
                        tracker: this.syntheticSubagentTracker,
                        flushBoundary: async () => {
                            await this.itemTranscriptBridge.flushAll({ reason: 'tool-call-boundary' });
                        },
                        threadId: action.threadId,
                        status: action.status,
                    });
                    continue;
                }
                await sendCodexProjectedToolEvent({
                    session: this.opts.session,
                    event: projected,
                    flushBeforeToolResult: async () => {
                        await this.itemTranscriptBridge.flushAll({ reason: 'tool-call-boundary' });
                    },
                });
                continue;
            }

            if (projected.type === 'subagent-spawn') {
                const subagentAction = action as Extract<CodexRolloutAction, { type: 'subagent-spawn' }>;
                await startCodexSyntheticSubagent({
                    tracker: this.syntheticSubagentTracker,
                    flushBoundary: async () => {
                        await this.itemTranscriptBridge.flushAll({ reason: 'tool-call-boundary' });
                    },
                    threadId: subagentAction.threadId,
                    prompt: subagentAction.prompt,
                    nickname: subagentAction.nickname,
                    role: subagentAction.role,
                });
                await this.followerRuntime.ensureSubagentFollower(subagentAction.threadId);
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

    private async startSharedStoreMirror(): Promise<void> {
        const binding = this.rolloutSessionStoreBinding;
        if (!binding) return;

        const lease = await acquireCodexRolloutSessionStore({
            activeServerDir: binding.activeServerDir,
            env: binding.env,
            key: {
                providerId: 'codex',
                source: binding.source,
                remoteSessionId: binding.remoteSessionId,
            },
        }) as FileBackedTranscriptSessionLease<FileBackedTranscriptSessionStore<DirectTranscriptRawMessageV1>>;
        this.rolloutSessionStoreLease = lease;
        this.startedMode = 'shared-store';

        await this.opts.onCodexSessionId(binding.remoteSessionId);
        await this.replaySharedStoreHistory(lease.store);

        const unsubscribe = lease.store.subscribe(async (event) => {
            if (event.items.length === 0) {
                return;
            }
            await this.handleSharedStoreTranscriptItems(event.items);
        });
        this.rolloutSessionStoreUnsubscribe = unsubscribe;

        if (this.rolloutSessionStoreLease !== lease) {
            unsubscribe();
            await lease.release();
        }
    }

    private async replaySharedStoreHistory(store: FileBackedTranscriptSessionStore): Promise<number> {
        const pages: DirectTranscriptRawMessageV1[][] = [];
        let cursor: string | undefined;
        let itemCount = 0;

        while (true) {
            const page = await store.pageOlder(cursor ? { direction: 'older', cursor } : { direction: 'older' });
            const items = Array.from(page.items as readonly DirectTranscriptRawMessageV1[]);
            itemCount += items.length;
            pages.push(items);
            if (!page.hasMore || !page.nextCursor) {
                break;
            }
            cursor = page.nextCursor;
        }

        for (let index = pages.length - 1; index >= 0; index -= 1) {
            await this.handleSharedStoreTranscriptItems(pages[index] ?? []);
        }
        return itemCount;
    }

    private async handleSharedStoreTranscriptItems(items: readonly DirectTranscriptRawMessageV1[]): Promise<void> {
        for (const item of items) {
            await this.handleSharedStoreTranscriptItem(item);
        }
    }

    private async handleSharedStoreTranscriptItem(item: DirectTranscriptRawMessageV1): Promise<void> {
        const stableItemId = typeof item.id === 'string' && item.id.trim().length > 0 ? item.id : null;
        if (stableItemId) {
            if (this.processedSharedStoreItemIds.has(stableItemId)) {
                return;
            }
            this.processedSharedStoreItemIds.add(stableItemId);
        }

        const raw = item.raw as Record<string, unknown> | null | undefined;
        if (!raw || typeof raw !== 'object') return;

        const role = raw.role;
        if (role === 'user') {
            const content = raw.content as Record<string, unknown> | null | undefined;
            const text = content?.type === 'text' && typeof content.text === 'string' ? content.text : null;
            if (!text) return;

            await this.itemTranscriptBridge.flushAll({ reason: 'tool-call-boundary' });
            this.opts.session.sendUserTextMessage(text);
            return;
        }

        if (role !== 'agent') return;

        const content = raw.content as Record<string, unknown> | null | undefined;
        if (!content || content.type !== 'codex') return;

        const data = content.data as Record<string, unknown> | null | undefined;
        if (!data || typeof data !== 'object') return;

        const sidechainId = typeof data.sidechainId === 'string' && data.sidechainId.trim().length > 0
            ? data.sidechainId
            : null;

        if (data.type === 'message' && typeof data.message === 'string') {
            this.itemTranscriptBridge.appendAssistantDelta({
                deltaText: data.message,
                streamKey: `${sidechainId ?? 'main'}:assistant`,
                sidechainId,
            });
            return;
        }

        if (data.type === 'tool-call') {
            const callId = typeof data.callId === 'string' ? data.callId : null;
            const name = typeof data.name === 'string' ? data.name : null;
            if (!callId || !name) return;

            if (!sidechainId && name === 'SubAgent') {
                const input = data.input as Record<string, unknown> | null | undefined;
                await startCodexSyntheticSubagent({
                    tracker: this.syntheticSubagentTracker,
                    flushBoundary: async () => {
                        await this.itemTranscriptBridge.flushAll({ reason: 'tool-call-boundary' });
                    },
                    threadId: callId,
                    prompt: typeof input?.prompt === 'string' ? input.prompt : null,
                    nickname: typeof input?.nickname === 'string' ? input.nickname : null,
                    role: typeof input?.role === 'string' ? input.role : null,
                });
                return;
            }

            await this.itemTranscriptBridge.flushAll({ reason: 'tool-call-boundary' });
            await sendCodexProjectedToolEvent({
                session: this.opts.session,
                event: {
                    type: 'tool-call',
                    callId,
                    name,
                    input: data.input,
                    sidechainId,
                },
            });
            return;
        }

        if (data.type === 'tool-call-result') {
            const callId = typeof data.callId === 'string' ? data.callId : null;
            if (!callId) return;

            if (!sidechainId && await this.tryFinalizeSyntheticSubagent(callId, data.output)) {
                return;
            }

            await this.itemTranscriptBridge.flushAll({ reason: 'tool-call-boundary' });
            await sendCodexProjectedToolEvent({
                session: this.opts.session,
                event: {
                    type: 'tool-result',
                    callId,
                    output: data.output,
                    sidechainId,
                    ...(data.isError === true ? { isError: true } : {}),
                },
            });
        }
    }

    private async tryFinalizeSyntheticSubagent(callId: string, output: unknown): Promise<boolean> {
        if (!output || typeof output !== 'object' || Array.isArray(output)) {
            return false;
        }
        const status = typeof (output as { status?: unknown }).status === 'string'
            ? (output as { status: string }).status
            : null;
        if (status !== 'completed' && status !== 'interrupted') {
            return false;
        }
        await finalizeCodexSyntheticSubagent({
            tracker: this.syntheticSubagentTracker,
            flushBoundary: async () => {
                await this.itemTranscriptBridge.flushAll({ reason: 'tool-call-boundary' });
            },
            threadId: callId,
            status,
        });
        return true;
    }
}
