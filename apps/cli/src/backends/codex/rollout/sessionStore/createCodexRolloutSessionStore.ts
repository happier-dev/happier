import type {
    FileBackedTranscriptSessionStore,
    FileBackedTranscriptSessionStoreLifecycleState,
    FileBackedTranscriptSubscriptionListener,
} from '@/api/session/fileBackedTranscripts/store';
import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { findCodexDirectSessionCandidateViaAppServer } from '../../appServer/session/findCodexDirectSessionCandidateViaAppServer';
import { pageCodexTranscript } from '../../directSessions/pageCodexTranscript';
import { readAfterCodexTranscript } from '../../directSessions/readAfterCodexTranscript';
import { readCodexSessionTitleFromRollout } from '../../directSessions/readCodexSessionTitleFromRollout';
import { resolveCodexHomesForDirectSessionsSource } from '../../directSessions/resolveCodexHomesForDirectSessionsSource';
import { createCodexRolloutSemanticTracker } from '../createCodexRolloutSemanticTracker';
import { collectCodexSessionRolloutFiles } from '../discovery/collectCodexSessionRolloutFiles';
import { readCodexSessionMetaFromRollout } from '../discovery/rolloutDiscovery';
import { mapCodexRolloutEventToActions } from '../projection/mapCodexRolloutEventToActions';
import { CodexRolloutFollowerRuntime } from '../runtime/CodexRolloutFollowerRuntime';

import type {
    CodexRolloutSessionStoreOptions,
    CodexRolloutSessionStorePageParams,
    CodexRolloutSessionStorePageResult,
    CodexRolloutSessionStoreReadAfterParams,
    CodexRolloutSessionStoreReadAfterResult,
} from './codexRolloutSessionStoreTypes';

type CodexRolloutStoreActivity = Readonly<{ lastActivityAtMs: number | null }>;

class CodexRolloutSessionStore implements FileBackedTranscriptSessionStore<DirectTranscriptRawMessageV1, CodexRolloutStoreActivity, string | null> {
    private lifecycleState: FileBackedTranscriptSessionStoreLifecycleState = 'warm_detached';
    private readonly discoveryPollIntervalMs = 250;
    private tailCursor: string | null = null;
    private workingDirectoryPromise: Promise<string | null> | null = null;
    private titlePromise: Promise<string | null> | null = null;
    private activityPromise: Promise<CodexRolloutStoreActivity | null> | null = null;
    private readonly subscriptionListeners = new Set<FileBackedTranscriptSubscriptionListener<DirectTranscriptRawMessageV1>>();
    private subscriptionRuntime: CodexRolloutFollowerRuntime | null = null;
    private subscriptionDiscoveryTimer: NodeJS.Timeout | null = null;
    private subscriptionSemanticTracker = createCodexRolloutSemanticTracker();
    private subscriptionCursor: string | null = null;
    private subscriptionDrainPromise: Promise<void> | null = null;
    private subscriptionDrainQueued = false;

    constructor(private readonly options: CodexRolloutSessionStoreOptions) {}

    async warm(): Promise<void> {}

    async dispose(): Promise<void> {
        this.lifecycleState = 'disposed';
        await this.stopSubscriptionRuntime();
    }

    async setLifecycleState(state: FileBackedTranscriptSessionStoreLifecycleState): Promise<void> {
        this.lifecycleState = state;
        if (state === 'hot_attached') {
            await this.ensureSubscriptionRuntime().catch(() => undefined);
            return;
        }
        if (this.subscriptionListeners.size === 0) {
            await this.stopSubscriptionRuntime();
        }
    }

    async pageOlder(params?: unknown): Promise<CodexRolloutSessionStorePageResult> {
        const pageParams = params as CodexRolloutSessionStorePageParams | undefined;
        const result = await pageCodexTranscript({
            source: this.options.key.source,
            activeServerDir: this.options.activeServerDir,
            env: this.options.env,
            remoteSessionId: this.options.key.remoteSessionId,
            direction: pageParams?.direction ?? 'older',
            cursor: pageParams?.cursor,
            maxBytes: pageParams?.maxBytes ?? 1024 * 1024,
            maxItems: pageParams?.maxItems ?? 100,
        });
        this.tailCursor = result.tailCursor ?? this.tailCursor;
        return {
            ...result,
            truncated: result.truncated ?? false,
        };
    }

    async readAfter(params?: unknown): Promise<CodexRolloutSessionStoreReadAfterResult> {
        const readParams = params as CodexRolloutSessionStoreReadAfterParams | undefined;
        const result = await readAfterCodexTranscript({
            source: this.options.key.source,
            activeServerDir: this.options.activeServerDir,
            env: this.options.env,
            remoteSessionId: this.options.key.remoteSessionId,
            cursor: readParams?.cursor ?? 'tail',
            maxBytes: readParams?.maxBytes ?? 1024 * 1024,
            maxItems: readParams?.maxItems ?? 100,
        });
        this.tailCursor = result.nextCursor ?? this.tailCursor;
        return result;
    }

    getTailCursor(): string | null {
        return this.tailCursor;
    }

    subscribe(listener?: FileBackedTranscriptSubscriptionListener<DirectTranscriptRawMessageV1>): () => void {
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
        if (!this.titlePromise) {
            this.titlePromise = this.resolveTitle();
        }
        return this.titlePromise;
    }

    async getWorkingDirectory(): Promise<string | null> {
        if (!this.workingDirectoryPromise) {
            this.workingDirectoryPromise = this.resolveWorkingDirectory();
        }
        return this.workingDirectoryPromise;
    }

    async getActivity(): Promise<CodexRolloutStoreActivity | null> {
        if (!this.activityPromise) {
            this.activityPromise = this.resolveActivity();
        }
        return this.activityPromise;
    }

    async getPreview(): Promise<string | null> {
        return this.getTitle();
    }

    private async resolveTitle(): Promise<string | null> {
        const homes = await this.resolveHomes();
        for (const home of homes) {
            const rollouts = await collectCodexSessionRolloutFiles({
                codexHome: home,
                remoteSessionId: this.options.key.remoteSessionId,
            });
            for (const rollout of rollouts) {
                const title = await readCodexSessionTitleFromRollout(rollout.filePath);
                if (title) return title;
            }
        }
        return null;
    }

    private async resolveWorkingDirectory(): Promise<string | null> {
        const homes = await this.resolveHomes();
        for (const home of homes) {
            const rollouts = await collectCodexSessionRolloutFiles({
                codexHome: home,
                remoteSessionId: this.options.key.remoteSessionId,
            });
            for (const rollout of rollouts) {
                const meta = await readCodexSessionMetaFromRollout(rollout.filePath);
                const cwd = typeof meta?.cwd === 'string' ? meta.cwd.trim() : '';
                if (cwd.length > 0) return cwd;
            }

            try {
                const candidate = await findCodexDirectSessionCandidateViaAppServer({
                    codexHome: home,
                    remoteSessionId: this.options.key.remoteSessionId,
                    env: this.options.env ?? process.env,
                });
                const cwd = typeof candidate?.details?.cwd === 'string' ? candidate.details.cwd.trim() : '';
                if (cwd.length > 0) return cwd;
            } catch {
                // Fall through when app-server metadata is unavailable.
            }
        }
        return null;
    }

    private async resolveActivity(): Promise<CodexRolloutStoreActivity | null> {
        const homes = await this.resolveHomes();

        let maxMtimeMs: number | null = null;
        for (const home of homes) {
            const rollouts = await collectCodexSessionRolloutFiles({
                codexHome: home,
                remoteSessionId: this.options.key.remoteSessionId,
            });
            for (const file of rollouts) {
                const rawMtimeMs = file.mtimeMs;
                const mtimeMs = typeof rawMtimeMs === 'number' && Number.isFinite(rawMtimeMs) ? Math.trunc(rawMtimeMs) : null;
                if (mtimeMs == null || mtimeMs < 0) continue;
                if (maxMtimeMs == null || mtimeMs > maxMtimeMs) {
                    maxMtimeMs = mtimeMs;
                }
            }

            if (maxMtimeMs != null) continue;

            try {
                const candidate = await findCodexDirectSessionCandidateViaAppServer({
                    codexHome: home,
                    remoteSessionId: this.options.key.remoteSessionId,
                    env: this.options.env ?? process.env,
                });
                const rawUpdatedAtMs = candidate?.updatedAtMs;
                const updatedAtMs = typeof rawUpdatedAtMs === 'number' && Number.isFinite(rawUpdatedAtMs)
                    ? Math.trunc(rawUpdatedAtMs)
                    : null;
                if (updatedAtMs != null && updatedAtMs >= 0) {
                    maxMtimeMs = updatedAtMs;
                }
            } catch {
                // Fall through when app-server metadata is unavailable.
            }
        }

        return { lastActivityAtMs: maxMtimeMs };
    }

    private async resolveHomes(): Promise<string[]> {
        return resolveCodexHomesForDirectSessionsSource({
            source: this.options.key.source,
            activeServerDir: this.options.activeServerDir,
            env: this.options.env ?? process.env,
        });
    }

    private async ensureSubscriptionRuntime(): Promise<void> {
        if (this.subscriptionRuntime || this.lifecycleState === 'disposed') return;

        const primaryRolloutFilePath = await this.resolvePrimaryRolloutFilePath();
        if (!primaryRolloutFilePath) {
            this.ensureSubscriptionDiscoveryTimer();
            return;
        }

        this.clearSubscriptionDiscoveryTimer();
        const initialCursor = this.tailCursor;
        const runtime = new CodexRolloutFollowerRuntime({
            filePath: primaryRolloutFilePath,
            codexHome: (await this.resolveHomes())[0] ?? null,
            startAtEnd: true,
            onMainJson: async (value) => {
                await this.handleSubscriptionJson(value, runtime);
            },
            onSubagentJson: async (_threadId, value) => {
                await this.handleSubscriptionJson(value, runtime);
            },
        });
        this.subscriptionRuntime = runtime;
        if (initialCursor) {
            this.subscriptionCursor = initialCursor;
        } else {
            this.subscriptionCursor = null;
        }
        await runtime.start();
        if (this.subscriptionRuntime !== runtime) {
            await runtime.stop();
            return;
        }
        await this.queueSubscriptionDrain();
    }

    private async stopSubscriptionRuntime(): Promise<void> {
        const runtime = this.subscriptionRuntime;
        this.subscriptionRuntime = null;
        this.clearSubscriptionDiscoveryTimer();
        this.subscriptionCursor = null;
        this.subscriptionDrainPromise = null;
        this.subscriptionDrainQueued = false;
        this.subscriptionSemanticTracker = createCodexRolloutSemanticTracker();
        await runtime?.stop();
    }

    private async handleSubscriptionJson(value: unknown, runtime: CodexRolloutFollowerRuntime): Promise<void> {
        const actions = mapCodexRolloutEventToActions(value, { debug: false });
        for (const action of actions) {
            for (const normalizedAction of this.subscriptionSemanticTracker.consume(action)) {
                if (normalizedAction.type === 'subagent-spawn') {
                    await runtime.ensureSubagentFollower(normalizedAction.threadId);
                }
            }
        }
        await this.queueSubscriptionDrain();
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
                              maxBytes: 1024 * 1024,
                              maxItems: 100,
                          });
                this.subscriptionCursor = update.nextCursor ?? this.subscriptionCursor ?? 'tail';
                if (update.items.length > 0 || update.truncated) {
                    await Promise.all(
                        Array.from(this.subscriptionListeners).map(async (listener) => {
                            await listener(update);
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

    private async replaySubscriptionHistory(): Promise<CodexRolloutSessionStoreReadAfterResult> {
        const pages: DirectTranscriptRawMessageV1[][] = [];
        let cursor: string | undefined;
        let tailCursor: string | null = null;

        while (true) {
            const page = await this.pageOlder({ direction: 'older', ...(cursor ? { cursor } : {}), maxBytes: 1024 * 1024, maxItems: 100 });
            pages.push(Array.from(page.items));
            tailCursor = page.tailCursor ?? tailCursor;
            if (!page.hasMore || !page.nextCursor) {
                break;
            }
            cursor = page.nextCursor;
        }

        const items = pages.reverse().flatMap((pageItems) => pageItems);
        if (tailCursor) {
            this.subscriptionCursor = tailCursor;
            return {
                items,
                nextCursor: this.subscriptionCursor,
                truncated: false,
            };
        }

        const tailRead = await this.readAfter({ cursor: 'tail', maxBytes: 1024 * 1024, maxItems: 100 });
        this.subscriptionCursor = tailRead.nextCursor ?? this.subscriptionCursor ?? 'tail';
        return {
            items,
            nextCursor: this.subscriptionCursor,
            truncated: false,
        };
    }

    private ensureSubscriptionDiscoveryTimer(): void {
        if (this.subscriptionDiscoveryTimer || this.lifecycleState !== 'hot_attached') {
            return;
        }
        this.subscriptionDiscoveryTimer = setInterval(() => {
            void this.ensureSubscriptionRuntime().catch(() => undefined);
        }, this.discoveryPollIntervalMs);
        this.subscriptionDiscoveryTimer.unref?.();
    }

    private clearSubscriptionDiscoveryTimer(): void {
        if (this.subscriptionDiscoveryTimer) {
            clearInterval(this.subscriptionDiscoveryTimer);
            this.subscriptionDiscoveryTimer = null;
        }
    }

    private async resolvePrimaryRolloutFilePath(): Promise<string | null> {
        const homes = await this.resolveHomes();
        for (const home of homes) {
            const rollouts = await collectCodexSessionRolloutFiles({
                codexHome: home,
                remoteSessionId: this.options.key.remoteSessionId,
            });
            const latest = rollouts.at(-1);
            if (latest?.filePath) {
                return latest.filePath;
            }
        }
        return null;
    }
}

export function createCodexRolloutSessionStore(
    options: CodexRolloutSessionStoreOptions,
): FileBackedTranscriptSessionStore<DirectTranscriptRawMessageV1, CodexRolloutStoreActivity, string | null> {
    return new CodexRolloutSessionStore(options);
}
