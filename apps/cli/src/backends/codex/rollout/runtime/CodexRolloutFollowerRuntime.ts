import { JsonlFollower } from '@/api/session/fileBackedTranscripts/jsonl/followJsonlFile';

import { collectCodexSessionRolloutFiles } from '../discovery/collectCodexSessionRolloutFiles';

type SubagentFollowerState = {
    threadId: string;
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

export class CodexRolloutFollowerRuntime {
    private readonly pollIntervalMs: number;
    private follower: JsonlFollower | null = null;
    private readonly subagentFollowerByThreadId = new Map<string, SubagentFollowerState>();
    private stopped = false;

    constructor(
        private readonly opts: Readonly<{
            filePath: string;
            codexHome?: string | null;
            pollIntervalMs?: number;
            startAtEnd?: boolean;
            onMainJson: (value: unknown) => void | Promise<void>;
            onSubagentJson: (threadId: string, value: unknown) => void | Promise<void>;
        }>,
    ) {
        this.pollIntervalMs =
            typeof opts.pollIntervalMs === 'number' && Number.isFinite(opts.pollIntervalMs) && opts.pollIntervalMs > 0
                ? Math.trunc(opts.pollIntervalMs)
                : 250;
    }

    async start(): Promise<void> {
        if (this.follower) return;
        this.stopped = false;
        const follower = new JsonlFollower({
            filePath: this.opts.filePath,
            pollIntervalMs: this.pollIntervalMs,
            startAtEnd: this.opts.startAtEnd === true,
            onJson: (value) => this.opts.onMainJson(value),
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

        const subagentStates = Array.from(this.subagentFollowerByThreadId.values());
        this.subagentFollowerByThreadId.clear();
        for (const state of subagentStates) {
            if (state.discoveryTimer) {
                clearInterval(state.discoveryTimer);
            }
        }
        await Promise.all(subagentStates.map((state) => state.follower?.stop() ?? Promise.resolve()));
    }

    async ensureSubagentFollower(threadId: string): Promise<void> {
        if (this.subagentFollowerByThreadId.has(threadId)) return;

        const state: SubagentFollowerState = {
            threadId,
            follower: null,
            discoveryTimer: null,
        };
        this.subagentFollowerByThreadId.set(threadId, state);

        const codexHome = this.resolveCodexHome();
        if (!codexHome) return;

        const startFollowerIfReady = async (): Promise<void> => {
            if (this.stopped || state.follower) return;
            const files = await collectCodexSessionRolloutFiles({
                codexHome,
                remoteSessionId: threadId,
            });
            const latestFile = files.at(-1);
            if (!latestFile) return;

            if (state.discoveryTimer) {
                clearInterval(state.discoveryTimer);
                state.discoveryTimer = null;
            }

            const childFollower = new JsonlFollower({
                filePath: latestFile.filePath,
                pollIntervalMs: this.pollIntervalMs,
                startAtEnd: this.opts.startAtEnd === true,
                onJson: (value) => this.opts.onSubagentJson(threadId, value),
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
            }, this.pollIntervalMs);
            state.discoveryTimer.unref?.();
        }
    }

    private resolveCodexHome(): string | null {
        return this.opts.codexHome ?? resolveCodexHomeFromRolloutFilePath(this.opts.filePath);
    }
}
