import { createJsonlFollowController } from '@/api/session/fileBackedTranscripts/jsonl/createJsonlFollowController';
import type { JsonlFollowController } from '@/api/session/fileBackedTranscripts/jsonl/createJsonlFollowController';
import { normalizeJsonlFollowPolicy } from '@/api/session/fileBackedTranscripts/jsonl/followPolicy';
import type { JsonlFollowPolicyInputV1, JsonlFollowPolicyV1 } from '@/api/session/fileBackedTranscripts/jsonl/followPolicy';

import {
    collectCodexSessionRolloutFiles,
    resolveCodexHomeFromRolloutFilePath,
} from '@happier-dev/plugins-codex/agent/rollout/discovery/sessionsForHome';

type SubagentFollowerState = {
    threadId: string;
    controller: JsonlFollowController | null;
    discoveryTimer: NodeJS.Timeout | null;
    closeTimer: NodeJS.Timeout | null;
    closing: boolean;
};

export class CodexRolloutFollowerRuntime {
    private readonly followPolicy: JsonlFollowPolicyV1;
    private controller: JsonlFollowController | null = null;
    private readonly subagentFollowerByThreadId = new Map<string, SubagentFollowerState>();
    private readonly closedSubagentThreadIds = new Map<string, number>();
    private stopped = false;

    constructor(
        private readonly opts: Readonly<{
            filePath: string;
            codexHome?: string | null;
            pollIntervalMs?: number;
            followPolicy?: JsonlFollowPolicyInputV1;
            startAtEnd?: boolean;
            onMainJson: (value: unknown) => void | Promise<void>;
            onSubagentJson: (threadId: string, value: unknown) => void | Promise<void>;
        }>,
    ) {
        this.followPolicy = normalizeJsonlFollowPolicy({
            ...(typeof opts.pollIntervalMs === 'number' && Number.isFinite(opts.pollIntervalMs) && opts.pollIntervalMs > 0
                ? { activeBurstPollIntervalMs: Math.trunc(opts.pollIntervalMs) }
                : {}),
            ...opts.followPolicy,
        });
    }

    async start(): Promise<void> {
        if (this.controller) return;
        this.stopped = false;
        const controller = createJsonlFollowController({
            filePath: this.opts.filePath,
            policy: this.followPolicy,
            startAtEnd: this.opts.startAtEnd === true,
            onLine: (line) => this.ingestMainLine(line),
        });
        this.controller = controller;
        await controller.attach({ keepAlive: true });
        if (this.controller !== controller) {
            await controller.dispose();
        }
    }

    async stop(): Promise<void> {
        this.stopped = true;
        const controller = this.controller;
        this.controller = null;
        await controller?.dispose();

        const subagentStates = Array.from(this.subagentFollowerByThreadId.values());
        this.subagentFollowerByThreadId.clear();
        this.closedSubagentThreadIds.clear();
        for (const state of subagentStates) {
            if (state.discoveryTimer) {
                clearTimeout(state.discoveryTimer);
            }
            if (state.closeTimer) {
                clearTimeout(state.closeTimer);
            }
        }
        await Promise.all(subagentStates.map((state) => state.controller?.dispose() ?? Promise.resolve()));
    }

    async ensureSubagentFollower(threadId: string): Promise<void> {
        if (this.subagentFollowerByThreadId.has(threadId)) return;
        if (this.closedSubagentThreadIds.has(threadId)) return;
        if (!this.canRegisterSubagentFollower()) return;

        const state: SubagentFollowerState = {
            threadId,
            controller: null,
            discoveryTimer: null,
            closeTimer: null,
            closing: false,
        };
        this.subagentFollowerByThreadId.set(threadId, state);

        const codexHome = this.resolveCodexHome();
        if (!codexHome) return;

        const startFollowerIfReady = async (): Promise<void> => {
            if (this.stopped || state.controller) return;
            const files = await collectCodexSessionRolloutFiles({
                codexHome,
                remoteSessionId: threadId,
            });
            const latestFile = files.at(-1);
            if (!latestFile) return;

            if (state.discoveryTimer) {
                clearTimeout(state.discoveryTimer);
                state.discoveryTimer = null;
            }

            const childController = createJsonlFollowController({
                filePath: latestFile.filePath,
                policy: this.followPolicy,
                startAtEnd: this.opts.startAtEnd === true,
                onLine: (line) => this.ingestSubagentLine(threadId, line),
            });
            state.controller = childController;
            await childController.attach({ keepAlive: true });
            if (this.stopped || state.controller !== childController) {
                await childController.dispose();
            }
        };

        const scheduleDiscoveryRetry = (): void => {
            if (state.controller || this.stopped || state.discoveryTimer) return;
            state.discoveryTimer = setTimeout(() => {
                state.discoveryTimer = null;
                void startFollowerIfReady().finally(() => {
                    scheduleDiscoveryRetry();
                });
            }, this.followPolicy.missingFileRetryIntervalMs);
            state.discoveryTimer.unref?.();
        };

        await startFollowerIfReady();
        scheduleDiscoveryRetry();
    }

    async closeSubagentFollower(threadId: string, opts?: Readonly<{ graceMs?: number }>): Promise<void> {
        const state = this.subagentFollowerByThreadId.get(threadId) ?? null;
        if (!state || state.closing) return;

        const graceMs = normalizeGraceMs(opts?.graceMs, this.followPolicy.sidechainCompletionGraceMs);
        if (graceMs > 0) {
            if (state.closeTimer) return;
            state.closeTimer = setTimeout(() => {
                state.closeTimer = null;
                void this.closeSubagentFollower(threadId, { graceMs: 0 });
            }, graceMs);
            state.closeTimer.unref?.();
            return;
        }

        state.closing = true;
        this.subagentFollowerByThreadId.delete(threadId);
        this.rememberClosedSubagentThread(threadId);
        if (state.closeTimer) {
            clearTimeout(state.closeTimer);
            state.closeTimer = null;
        }
        if (state.discoveryTimer) {
            clearTimeout(state.discoveryTimer);
            state.discoveryTimer = null;
        }
        await state.controller?.drainNow();
        await state.controller?.dispose();
        state.controller = null;
    }

    private resolveCodexHome(): string | null {
        return this.opts.codexHome ?? resolveCodexHomeFromRolloutFilePath(this.opts.filePath);
    }

    private async ingestMainLine(line: string): Promise<void> {
        const value = parseJsonLine(line);
        if (value === undefined) return;
        await this.opts.onMainJson(value);
    }

    private async ingestSubagentLine(threadId: string, line: string): Promise<void> {
        const value = parseJsonLine(line);
        if (value === undefined) return;
        await this.opts.onSubagentJson(threadId, value);
    }

    private canRegisterSubagentFollower(): boolean {
        const maxOpenFollowers = Math.min(
            this.followPolicy.maxActiveFollowersPerSession,
            this.followPolicy.maxIdleFollowersPerSession,
        );
        return this.subagentFollowerByThreadId.size < maxOpenFollowers;
    }

    private rememberClosedSubagentThread(threadId: string): void {
        this.closedSubagentThreadIds.set(threadId, Date.now());
        while (this.closedSubagentThreadIds.size > this.followPolicy.maxClosedFollowerRecordsPerSession) {
            const oldest = this.closedSubagentThreadIds.keys().next().value;
            if (typeof oldest !== 'string') break;
            this.closedSubagentThreadIds.delete(oldest);
        }
    }
}

function normalizeGraceMs(value: number | undefined, fallback: number): number {
    const candidate = value ?? fallback;
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) return 0;
    return Math.trunc(candidate);
}

function parseJsonLine(line: string): unknown {
    try {
        return JSON.parse(line) as unknown;
    } catch {
        return undefined;
    }
}
