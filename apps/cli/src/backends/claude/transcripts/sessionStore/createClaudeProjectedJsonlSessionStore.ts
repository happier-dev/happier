import { JsonlFollower } from '@/api/session/fileBackedTranscripts/jsonl/followJsonlFile';
import type {
    FileBackedTranscriptPageResult,
    FileBackedTranscriptReadAfterResult,
    FileBackedTranscriptSessionStore,
    FileBackedTranscriptSessionStoreKey,
    FileBackedTranscriptSessionStoreLifecycleState,
    FileBackedTranscriptSubscriptionListener,
} from '@/api/session/fileBackedTranscripts/store';

import { readClaudeJsonlSessionActivity } from './operations/readClaudeJsonlSessionActivity';
import { readClaudeJsonlSessionTitle } from './operations/readClaudeJsonlSessionTitle';
import { readClaudeJsonlSessionWorkingDirectory } from './operations/readClaudeJsonlSessionWorkingDirectory';
import { resolveClaudeJsonlSessionFile } from './operations/resolveClaudeJsonlSessionFile';

type ClaudeProjectedJsonlSessionStoreOperations<TItem, TPageParams, TReadAfterParams> = Readonly<{
    pageOlder: (
        key: FileBackedTranscriptSessionStoreKey,
        params: TPageParams | undefined,
    ) => Promise<FileBackedTranscriptPageResult<TItem>>;
    readAfter: (
        key: FileBackedTranscriptSessionStoreKey,
        params: TReadAfterParams | undefined,
        currentTailCursor: string | null,
    ) => Promise<FileBackedTranscriptReadAfterResult<TItem>>;
}>;

class ClaudeProjectedJsonlSessionStore<TItem, TActivity, TPageParams, TReadAfterParams>
    implements FileBackedTranscriptSessionStore<TItem, TActivity, string | null>
{
    private lifecycleState: FileBackedTranscriptSessionStoreLifecycleState = 'warm_detached';
    private titlePromise: Promise<string | null> | null = null;
    private workingDirectoryPromise: Promise<string | null> | null = null;
    private activityPromise: Promise<TActivity | null> | null = null;
    private tailCursor: string | null = null;
    private readonly subscriptionListeners = new Set<FileBackedTranscriptSubscriptionListener<TItem>>();
    private subscriptionFollower: JsonlFollower | null = null;
    private subscriptionFollowerStartupPromise: Promise<void> | null = null;
    private subscriptionFollowerStartupGeneration = 0;
    private subscriptionCursor: string | null = null;
    private subscriptionDrainPromise: Promise<void> | null = null;
    private subscriptionDrainQueued = false;
    private resolvedFilePromise: Promise<Awaited<ReturnType<typeof resolveClaudeJsonlSessionFile>>> | null = null;

    constructor(
        private readonly key: FileBackedTranscriptSessionStoreKey,
        private readonly operations: ClaudeProjectedJsonlSessionStoreOperations<TItem, TPageParams, TReadAfterParams>,
        private readonly mapActivity: (value: Awaited<ReturnType<typeof readClaudeJsonlSessionActivity>>) => TActivity,
    ) {}

    async warm(): Promise<void> {
        return;
    }

    async dispose(): Promise<void> {
        this.lifecycleState = 'disposed';
        await this.stopSubscriptionFollower();
    }

    async setLifecycleState(state: FileBackedTranscriptSessionStoreLifecycleState): Promise<void> {
        this.lifecycleState = state;
        if (state === 'hot_attached') {
            await this.ensureSubscriptionFollower();
            return;
        }
        if (this.subscriptionListeners.size === 0) {
            await this.stopSubscriptionFollower();
        }
    }

    async pageOlder(params?: TPageParams): Promise<FileBackedTranscriptPageResult<TItem>> {
        const page = await this.operations.pageOlder(this.key, params);
        this.tailCursor = page.tailCursor ?? this.tailCursor;
        return {
            ...page,
            nextCursor: page.nextCursor ?? null,
            tailCursor: page.tailCursor ?? null,
            truncated: page.truncated === true,
        };
    }

    async readAfter(params?: TReadAfterParams): Promise<FileBackedTranscriptReadAfterResult<TItem>> {
        const read = await this.operations.readAfter(this.key, params, this.tailCursor);
        this.tailCursor = read.nextCursor ?? this.tailCursor;
        return {
            ...read,
            nextCursor: read.nextCursor ?? null,
            truncated: read.truncated === true,
        };
    }

    getTailCursor(): string | null {
        return this.tailCursor;
    }

    subscribe(listener?: FileBackedTranscriptSubscriptionListener<TItem>): () => void {
        if (!listener) {
            return () => {};
        }

        this.subscriptionListeners.add(listener);
        void this.ensureSubscriptionFollower();

        return () => {
            this.subscriptionListeners.delete(listener);
            if (this.subscriptionListeners.size === 0 && this.lifecycleState !== 'hot_attached') {
                void this.stopSubscriptionFollower();
            }
        };
    }

    async getTitle(): Promise<string | null> {
        if (this.titlePromise) return this.titlePromise;
        this.titlePromise = (async () => {
            const resolved = await resolveClaudeJsonlSessionFile({
                source: this.key.source,
                remoteSessionId: this.key.remoteSessionId,
            });
            if (!resolved) return null;
            return readClaudeJsonlSessionTitle(resolved.filePath);
        })();
        return this.titlePromise;
    }

    async getWorkingDirectory(): Promise<string | null> {
        if (this.workingDirectoryPromise) return this.workingDirectoryPromise;
        this.workingDirectoryPromise = readClaudeJsonlSessionWorkingDirectory({
            source: this.key.source,
            remoteSessionId: this.key.remoteSessionId,
        });
        return this.workingDirectoryPromise;
    }

    async getActivity(): Promise<TActivity | null> {
        if (this.activityPromise) return this.activityPromise;
        this.activityPromise = (async () => {
            const activity = await readClaudeJsonlSessionActivity({
                source: this.key.source,
                remoteSessionId: this.key.remoteSessionId,
            });
            return this.mapActivity(activity);
        })();
        return this.activityPromise;
    }

    async getPreview(): Promise<string | null> {
        return this.getTitle();
    }

    private async resolveFile() {
        if (!this.resolvedFilePromise) {
            this.resolvedFilePromise = resolveClaudeJsonlSessionFile({
                source: this.key.source,
                remoteSessionId: this.key.remoteSessionId,
            });
        }
        return this.resolvedFilePromise;
    }

    private async ensureSubscriptionFollower(): Promise<void> {
        if (this.subscriptionFollower || this.lifecycleState === 'disposed' || !this.shouldKeepSubscriptionFollower()) return;
        if (this.subscriptionFollowerStartupPromise) {
            await this.subscriptionFollowerStartupPromise;
            return;
        }

        const startupGeneration = ++this.subscriptionFollowerStartupGeneration;
        const startupPromise = (async () => {
            const resolved = await this.resolveFile();
            if (this.isSubscriptionFollowerStartupStale(startupGeneration) || !resolved?.filePath) return;

            const follower = new JsonlFollower({
                filePath: resolved.filePath,
                pollIntervalMs: 250,
                startAtEnd: false,
                onJson: async () => {
                    await this.queueSubscriptionDrain();
                },
            });
            this.subscriptionFollower = follower;
            const currentTailCursor = this.tailCursor;
            if (currentTailCursor) {
                this.subscriptionCursor = currentTailCursor;
            } else {
                const initial = await this.readAfter(undefined);
                if (this.isSubscriptionFollowerStartupStale(startupGeneration)) {
                    this.subscriptionFollower = null;
                    return;
                }
                this.subscriptionCursor = initial.nextCursor ?? 'tail';
            }
            await follower.start();
            if (this.subscriptionFollower !== follower || this.isSubscriptionFollowerStartupStale(startupGeneration)) {
                if (this.subscriptionFollower === follower) {
                    this.subscriptionFollower = null;
                }
                await follower.stop();
            }
        })().finally(() => {
            if (this.subscriptionFollowerStartupPromise === startupPromise) {
                this.subscriptionFollowerStartupPromise = null;
            }
        });
        this.subscriptionFollowerStartupPromise = startupPromise;
        await startupPromise;
    }

    private async stopSubscriptionFollower(): Promise<void> {
        this.subscriptionFollowerStartupGeneration += 1;
        this.subscriptionFollowerStartupPromise = null;
        const follower = this.subscriptionFollower;
        this.subscriptionFollower = null;
        this.subscriptionCursor = null;
        this.subscriptionDrainPromise = null;
        this.subscriptionDrainQueued = false;
        await follower?.stop();
    }

    private shouldKeepSubscriptionFollower(): boolean {
        return this.lifecycleState === 'hot_attached' || this.subscriptionListeners.size > 0;
    }

    private isSubscriptionFollowerStartupStale(startupGeneration: number): boolean {
        return (
            this.lifecycleState === 'disposed'
            || !this.shouldKeepSubscriptionFollower()
            || this.subscriptionFollowerStartupGeneration !== startupGeneration
        );
    }

    private async queueSubscriptionDrain(): Promise<void> {
        if (this.subscriptionDrainPromise) {
            this.subscriptionDrainQueued = true;
            return;
        }

        const run = async (): Promise<void> => {
            do {
                this.subscriptionDrainQueued = false;
                const update = await this.readAfter(({
                    cursor: this.subscriptionCursor ?? 'tail',
                    maxBytes: 1024 * 1024,
                    maxItems: 100,
                } as unknown) as TReadAfterParams);
                this.subscriptionCursor = update.nextCursor ?? this.subscriptionCursor ?? 'tail';
                if (update.items.length > 0 || update.truncated) {
                    await Promise.all(
                        Array.from(this.subscriptionListeners).map(async (subscriptionListener) => {
                            await subscriptionListener(update);
                        }),
                    );
                }
            } while (this.subscriptionDrainQueued && this.subscriptionListeners.size > 0);
        };

        this.subscriptionDrainPromise = run().finally(() => {
            this.subscriptionDrainPromise = null;
        });
        await this.subscriptionDrainPromise;
    }
}

export function createClaudeProjectedJsonlSessionStore<TItem, TActivity, TPageParams, TReadAfterParams>(params: Readonly<{
    key: FileBackedTranscriptSessionStoreKey;
    operations: ClaudeProjectedJsonlSessionStoreOperations<TItem, TPageParams, TReadAfterParams>;
    mapActivity: (value: Awaited<ReturnType<typeof readClaudeJsonlSessionActivity>>) => TActivity;
}>): FileBackedTranscriptSessionStore<TItem, TActivity, string | null> {
    return new ClaudeProjectedJsonlSessionStore(params.key, params.operations, params.mapActivity);
}
