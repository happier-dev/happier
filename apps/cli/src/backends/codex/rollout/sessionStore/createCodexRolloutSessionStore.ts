import type {
    FileBackedTranscriptSessionStore,
    FileBackedTranscriptSessionStoreLifecycleState,
    FileBackedTranscriptSubscriptionListener,
} from '@/api/session/fileBackedTranscripts/store';
import { DEFAULT_JSONL_FOLLOW_POLICY } from '@/api/session/fileBackedTranscripts/jsonl/followPolicy';
import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { createCodexRolloutSemanticTracker } from '@happier-dev/plugins-codex/agent/rollout/semanticTracker';
import { mapCodexRolloutEventToActions } from '@happier-dev/plugins-codex/agent/rollout/projection/actions';
import { CodexRolloutFollowerRuntime } from '../runtime/CodexRolloutFollowerRuntime';
import { resolveCodexRolloutSessionStoreMaxRetainedItems } from '@happier-dev/plugins-codex/agent/rollout/session/cachePolicy';

import type {
    CodexRolloutSessionStoreOptions,
    CodexRolloutSessionStorePageParams,
    CodexRolloutSessionStorePageResult,
    CodexRolloutSessionStoreReadAfterParams,
    CodexRolloutSessionStoreReadAfterResult,
} from './codexRolloutSessionStoreTypes';
import { encodeCodexExternalForwardCursor } from '@happier-dev/plugins-codex/agent/surfaces/sessions/external/transcript';
import {
    pageCodexRolloutExternalTranscriptHistory,
    readAfterCodexRolloutExternalTranscriptHistory,
    resolveCodexRolloutExternalTranscriptSnapshot,
} from './transcriptHistory';

type CodexRolloutStoreActivity = Readonly<{ lastActivityAtMs: number | null }>;

class CodexRolloutSessionStore implements FileBackedTranscriptSessionStore<ExternalSessionTranscriptRawMessageV1, CodexRolloutStoreActivity, string | null> {
    private lifecycleState: FileBackedTranscriptSessionStoreLifecycleState = 'warm_detached';
    private readonly discoveryRetryIntervalMs = DEFAULT_JSONL_FOLLOW_POLICY.missingFileRetryIntervalMs;
    private readonly subscriptionDrainMaxBytes = 8 * 1024 * 1024;
    private readonly subscriptionDrainMaxItems = 100;
    private tailCursor: string | null = null;
    private readonly subscriptionListeners = new Set<FileBackedTranscriptSubscriptionListener<ExternalSessionTranscriptRawMessageV1>>();
    private subscriptionRuntime: CodexRolloutFollowerRuntime | null = null;
    private subscriptionRuntimeStartupPromise: Promise<void> | null = null;
    private subscriptionRuntimeStartupGeneration = 0;
    private subscriptionDiscoveryTimer: NodeJS.Timeout | null = null;
    private subscriptionSemanticTracker = createCodexRolloutSemanticTracker();
    private subscriptionCursor: string | null = null;
    private replayDiscoveredHistoryOnNextDrain = false;
    private subscriptionDrainPromise: Promise<void> | null = null;
    private subscriptionDrainQueued = false;
    private transcriptSnapshotPromise: Promise<Awaited<ReturnType<typeof resolveCodexRolloutExternalTranscriptSnapshot>>> | null = null;
    private transcriptSnapshot: Awaited<ReturnType<typeof resolveCodexRolloutExternalTranscriptSnapshot>> | null = null;
    private readonly maxRetainedItems: number;

    constructor(private readonly options: CodexRolloutSessionStoreOptions) {
        this.maxRetainedItems = resolveCodexRolloutSessionStoreMaxRetainedItems(options.env);
    }

    async warm(): Promise<void> {}

    async dispose(): Promise<void> {
        this.lifecycleState = 'disposed';
        this.invalidateTranscriptSnapshot();
        await this.stopSubscriptionRuntime();
    }

    async setLifecycleState(state: FileBackedTranscriptSessionStoreLifecycleState): Promise<void> {
        this.lifecycleState = state;
        if (state === 'hot_attached') {
            void this.ensureSubscriptionRuntime().catch(() => undefined);
            return;
        }
        if (this.subscriptionListeners.size === 0) {
            this.invalidateTranscriptSnapshot();
            await this.stopSubscriptionRuntime();
        }
    }

    async pageOlder(params?: unknown): Promise<CodexRolloutSessionStorePageResult> {
        const pageParams = params as CodexRolloutSessionStorePageParams | undefined;
        const result = await pageCodexRolloutExternalTranscriptHistory({
            source: this.options.key.source,
            activeServerDir: this.options.activeServerDir,
            env: this.options.env,
            remoteSessionId: this.options.key.remoteSessionId,
            direction: pageParams?.direction ?? 'older',
            cursor: pageParams?.cursor,
            maxBytes: pageParams?.maxBytes ?? 1024 * 1024,
            maxItems: pageParams?.maxItems ?? 100,
            allowProviderFallback: pageParams?.allowProviderFallback,
        });
        this.tailCursor = result.tailCursor ?? this.tailCursor;
        return result;
    }

    async readAfter(params?: unknown): Promise<CodexRolloutSessionStoreReadAfterResult> {
        const readParams = params as CodexRolloutSessionStoreReadAfterParams | undefined;
        const result = await readAfterCodexRolloutExternalTranscriptHistory({
            source: this.options.key.source,
            activeServerDir: this.options.activeServerDir,
            env: this.options.env,
            remoteSessionId: this.options.key.remoteSessionId,
            cursor: readParams?.cursor ?? 'tail',
            maxBytes: readParams?.maxBytes ?? 1024 * 1024,
            maxItems: readParams?.maxItems ?? 100,
            allowProviderFallback: readParams?.allowProviderFallback,
        });
        this.tailCursor = result.nextCursor ?? this.tailCursor;
        return result;
    }

    getTailCursor(): string | null {
        return this.tailCursor;
    }

    subscribe(listener?: FileBackedTranscriptSubscriptionListener<ExternalSessionTranscriptRawMessageV1>): () => void {
        if (!listener) {
            return () => {};
        }

        this.subscriptionListeners.add(listener);
        void this.ensureSubscriptionRuntime();

        return () => {
            this.subscriptionListeners.delete(listener);
            if (this.subscriptionListeners.size === 0 && this.lifecycleState !== 'hot_attached') {
                void this.stopSubscriptionRuntime();
            }
        };
    }

    async getTitle(): Promise<string | null> {
        return this.withTranscriptSnapshot(
            (snapshot) => snapshot.title,
            { allowRolloutCwdAppServerFallback: false, resolveTitle: true },
        );
    }

    async getWorkingDirectory(): Promise<string | null> {
        return this.withTranscriptSnapshot(
            (snapshot) => snapshot.workingDirectory,
            { resolveTitle: false },
        );
    }

    async getActivity(): Promise<CodexRolloutStoreActivity | null> {
        return this.withTranscriptSnapshot(
            (snapshot) => ({ lastActivityAtMs: snapshot.lastActivityAtMs }),
            { resolveTitle: false },
        );
    }

    async getPreview(): Promise<string | null> {
        return this.getTitle();
    }

    private async withTranscriptSnapshot<TResult>(
        readSnapshot: (
            snapshot: Awaited<ReturnType<typeof resolveCodexRolloutExternalTranscriptSnapshot>>,
        ) => TResult | Promise<TResult>,
        options?: Readonly<{ allowRolloutCwdAppServerFallback?: boolean; resolveTitle?: boolean }>,
    ): Promise<TResult> {
        const snapshot = await this.resolveTranscriptSnapshot(options);
        try {
            return await readSnapshot(snapshot);
        } finally {
            this.maybeInvalidateOversizedSnapshot(snapshot);
        }
    }

    private maybeInvalidateOversizedSnapshot(
        snapshot: Awaited<ReturnType<typeof resolveCodexRolloutExternalTranscriptSnapshot>>,
    ): void {
        if (snapshot.rolloutHome === null) return;
        if (snapshot.mergedRecords.length <= this.maxRetainedItems) return;
        this.invalidateTranscriptSnapshot();
    }

    private async resolveTranscriptSnapshot(
        options?: Readonly<{ allowRolloutCwdAppServerFallback?: boolean; resolveTitle?: boolean }>,
    ): Promise<Awaited<ReturnType<typeof resolveCodexRolloutExternalTranscriptSnapshot>>> {
        const allowRolloutCwdAppServerFallback = options?.allowRolloutCwdAppServerFallback !== false;
        const resolveTitle = options?.resolveTitle !== false;
        const existingSnapshotNeedsCwdFallback =
            allowRolloutCwdAppServerFallback
            && this.transcriptSnapshot?.rolloutHome !== null
            && this.transcriptSnapshot?.workingDirectory === null
            && this.transcriptSnapshot?.appServerMetadata === null;
        const existingSnapshotNeedsTitle =
            resolveTitle
            && this.transcriptSnapshot?.rolloutHome !== null
            && this.transcriptSnapshot?.title === null;
        if (this.transcriptSnapshotPromise && !existingSnapshotNeedsCwdFallback && !existingSnapshotNeedsTitle) {
            return this.transcriptSnapshotPromise;
        }
        this.transcriptSnapshotPromise = resolveCodexRolloutExternalTranscriptSnapshot({
            source: this.options.key.source,
            activeServerDir: this.options.activeServerDir,
            env: this.options.env,
            remoteSessionId: this.options.key.remoteSessionId,
            previousSnapshot: this.transcriptSnapshot,
            options: { allowRolloutCwdAppServerFallback, resolveTitle },
        }).then((snapshot) => {
            this.transcriptSnapshot = snapshot;
            return snapshot;
        }).finally(() => {
            this.transcriptSnapshotPromise = null;
        });
        return this.transcriptSnapshotPromise;
    }

    private async ensureSubscriptionRuntime(): Promise<void> {
        if (this.subscriptionRuntime || this.lifecycleState === 'disposed' || !this.shouldKeepSubscriptionRuntime()) return;
        if (this.subscriptionRuntimeStartupPromise) {
            await this.subscriptionRuntimeStartupPromise;
            return;
        }

        const startupGeneration = ++this.subscriptionRuntimeStartupGeneration;
        const startupPromise = (async () => {
            const primaryRolloutFilePath = await this.resolvePrimaryRolloutFilePath();
            if (this.isSubscriptionRuntimeStartupStale(startupGeneration)) {
                return;
            }
            if (!primaryRolloutFilePath) {
                if (this.subscriptionCursor === null) {
                    this.replayDiscoveredHistoryOnNextDrain = true;
                }
                // Avoid pinning an empty snapshot forever while discovery waits for a late rollout file.
                this.invalidateTranscriptSnapshot();
                this.ensureSubscriptionDiscoveryTimer();
                return;
            }

            this.clearSubscriptionDiscoveryTimer();
            const snapshot = await this.resolveTranscriptSnapshot({
                allowRolloutCwdAppServerFallback: false,
                resolveTitle: false,
            });
            const codexHome = snapshot.rolloutHome;
            if (this.isSubscriptionRuntimeStartupStale(startupGeneration)) {
                return;
            }

            const runtime = new CodexRolloutFollowerRuntime({
                filePath: primaryRolloutFilePath,
                codexHome,
                startAtEnd: true,
                onMainJson: async (value) => {
                    await this.handleSubscriptionJson(value, runtime);
                },
                onSubagentJson: async (_threadId, value) => {
                    await this.handleSubscriptionJson(value, runtime);
                },
            });
            this.subscriptionRuntime = runtime;
            this.subscriptionCursor = this.replayDiscoveredHistoryOnNextDrain ? null : (this.tailCursor ?? null);
            await runtime.start();
            if (this.subscriptionRuntime !== runtime || this.isSubscriptionRuntimeStartupStale(startupGeneration)) {
                if (this.subscriptionRuntime === runtime) {
                    this.subscriptionRuntime = null;
                }
                await runtime.stop();
                return;
            }
            const completedThreadIds = new Set(snapshot.streamStates.flatMap((state) => state.completedChildThreadIds));
            const knownSidechainThreadIds = new Set(
                snapshot.streamStates
                    .filter((state) => state.stream.sidechainId !== null)
                    .map((state) => state.stream.threadId),
            );
            for (const threadId of knownSidechainThreadIds) {
                if (completedThreadIds.has(threadId)) continue;
                await runtime.ensureSubagentFollower(threadId);
            }
            await this.queueSubscriptionDrain();
        })().finally(() => {
            if (this.subscriptionRuntimeStartupPromise === startupPromise) {
                this.subscriptionRuntimeStartupPromise = null;
            }
        });
        this.subscriptionRuntimeStartupPromise = startupPromise;
        await startupPromise;
    }

    private async stopSubscriptionRuntime(): Promise<void> {
        this.subscriptionRuntimeStartupGeneration += 1;
        this.subscriptionRuntimeStartupPromise = null;
        const runtime = this.subscriptionRuntime;
        this.subscriptionRuntime = null;
        this.clearSubscriptionDiscoveryTimer();
        this.subscriptionCursor = null;
        this.replayDiscoveredHistoryOnNextDrain = false;
        this.subscriptionDrainPromise = null;
        this.subscriptionDrainQueued = false;
        this.subscriptionSemanticTracker = createCodexRolloutSemanticTracker();
        await runtime?.stop();
    }

    private shouldKeepSubscriptionRuntime(): boolean {
        return this.lifecycleState === 'hot_attached' || this.subscriptionListeners.size > 0;
    }

    private isSubscriptionRuntimeStartupStale(startupGeneration: number): boolean {
        return (
            this.lifecycleState === 'disposed'
            || !this.shouldKeepSubscriptionRuntime()
            || this.subscriptionRuntimeStartupGeneration !== startupGeneration
        );
    }

    private async handleSubscriptionJson(value: unknown, runtime: CodexRolloutFollowerRuntime): Promise<void> {
        const actions = mapCodexRolloutEventToActions(value, { debug: false });
        for (const action of actions) {
            for (const normalizedAction of this.subscriptionSemanticTracker.consume(action)) {
                if (normalizedAction.type === 'subagent-spawn') {
                    await runtime.ensureSubagentFollower(normalizedAction.threadId);
                } else if (normalizedAction.type === 'subagent-complete') {
                    await runtime.closeSubagentFollower(normalizedAction.threadId);
                }
            }
        }
        this.invalidateTranscriptSnapshot();
        void this.queueSubscriptionDrain().catch(() => undefined);
    }

    private async queueSubscriptionDrain(): Promise<void> {
        if (this.subscriptionDrainPromise) {
            this.subscriptionDrainQueued = true;
            return;
        }

        const run = async (): Promise<void> => {
            do {
                this.subscriptionDrainQueued = false;
                const update =
                    this.subscriptionCursor === null
                        ? await this.replaySubscriptionHistory()
                        : await this.readAfter({
                              cursor: this.subscriptionCursor,
                              maxBytes: this.subscriptionDrainMaxBytes,
                              maxItems: this.subscriptionDrainMaxItems,
                          });
                this.subscriptionCursor = update.nextCursor ?? this.subscriptionCursor ?? 'tail';
                if (update.items.length > 0 || update.truncated) {
                    await Promise.all(
                        Array.from(this.subscriptionListeners).map(async (listener) => {
                            await listener(update);
                        }),
                    );
                }
                if (update.truncated && this.shouldKeepSubscriptionRuntime()) {
                    this.subscriptionDrainQueued = true;
                }
            } while (this.subscriptionDrainQueued && this.shouldKeepSubscriptionRuntime());
        };

        this.subscriptionDrainPromise = run().finally(() => {
            this.subscriptionDrainPromise = null;
        });
        await this.subscriptionDrainPromise;
    }

    private async replaySubscriptionHistory(): Promise<CodexRolloutSessionStoreReadAfterResult> {
        const snapshot = await this.resolveTranscriptSnapshot({
            allowRolloutCwdAppServerFallback: false,
            resolveTitle: false,
        });
        if (this.replayDiscoveredHistoryOnNextDrain) {
            this.replayDiscoveredHistoryOnNextDrain = false;
            const startCursor = buildStartCursorFromSnapshot(snapshot);
            if (startCursor) {
                return this.readAfter({
                    cursor: startCursor,
                    maxBytes: this.subscriptionDrainMaxBytes,
                    maxItems: this.subscriptionDrainMaxItems,
                });
            }
        }
        const tailCursor = buildTailCursorFromSnapshot(snapshot);
        if (tailCursor) {
            this.subscriptionCursor = tailCursor;
            return {
                items: [],
                nextCursor: this.subscriptionCursor,
                truncated: false,
            };
        }

        const tailRead = await this.readAfter({
            cursor: 'tail',
            maxBytes: this.subscriptionDrainMaxBytes,
            maxItems: this.subscriptionDrainMaxItems,
        });
        this.subscriptionCursor = tailRead.nextCursor ?? this.subscriptionCursor ?? 'tail';
        return {
            items: [],
            nextCursor: this.subscriptionCursor,
            truncated: false,
        };
    }

    private ensureSubscriptionDiscoveryTimer(): void {
        if (this.subscriptionDiscoveryTimer || !this.shouldKeepSubscriptionRuntime()) {
            return;
        }
        this.subscriptionDiscoveryTimer = setTimeout(() => {
            this.subscriptionDiscoveryTimer = null;
            void this.ensureSubscriptionRuntime().catch(() => undefined);
        }, this.discoveryRetryIntervalMs);
        this.subscriptionDiscoveryTimer.unref?.();
    }

    private clearSubscriptionDiscoveryTimer(): void {
        if (this.subscriptionDiscoveryTimer) {
            clearTimeout(this.subscriptionDiscoveryTimer);
            this.subscriptionDiscoveryTimer = null;
        }
    }

    private invalidateTranscriptSnapshot(): void {
        this.transcriptSnapshotPromise = null;
        this.transcriptSnapshot = null;
    }

    private async resolvePrimaryRolloutFilePath(): Promise<string | null> {
        return this.withTranscriptSnapshot(
            (snapshot) => snapshot.primaryRolloutFilePath,
            { allowRolloutCwdAppServerFallback: false, resolveTitle: false },
        );
    }
}

function buildTailCursorFromSnapshot(snapshot: Awaited<ReturnType<typeof resolveCodexRolloutExternalTranscriptSnapshot>>): string | null {
    if (snapshot.rolloutHome === null) {
        return snapshot.appServerMetadata
            ? encodeCodexExternalForwardCursor({
                v: 2,
                kind: 'codexForwardAppServer',
                updatedAtMs: snapshot.appServerMetadata.updatedAtMs,
                previewText: snapshot.appServerMetadata.previewText,
            })
            : null;
    }
    return encodeCodexExternalForwardCursor({
        v: 4,
        kind: 'codexForwardStreamVector',
        streams: snapshot.streamStates
            .map((state) => ({
                fileRelPath: state.stream.fileRelPath,
                nextOffsetBytes: state.nextOffsetBytes,
                subIndex: 0,
            }))
            .sort((left, right) => left.fileRelPath.localeCompare(right.fileRelPath)),
    });
}

function buildStartCursorFromSnapshot(snapshot: Awaited<ReturnType<typeof resolveCodexRolloutExternalTranscriptSnapshot>>): string | null {
    if (snapshot.rolloutHome === null) {
        return null;
    }
    return encodeCodexExternalForwardCursor({
        v: 4,
        kind: 'codexForwardStreamVector',
        streams: snapshot.streamStates
            .map((state) => ({
                fileRelPath: state.stream.fileRelPath,
                nextOffsetBytes: 0,
                subIndex: 0,
            }))
            .sort((left, right) => left.fileRelPath.localeCompare(right.fileRelPath)),
    });
}

export function createCodexRolloutSessionStore(
    options: CodexRolloutSessionStoreOptions,
): FileBackedTranscriptSessionStore<ExternalSessionTranscriptRawMessageV1, CodexRolloutStoreActivity, string | null> {
    return new CodexRolloutSessionStore(options);
}
