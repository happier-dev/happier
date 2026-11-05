import { isRuntimeActive, subscribeToRuntimeActiveChange } from '@/utils/runtime/isRuntimeActive';
import { readHostWindowFocus } from '@/utils/runtime/readHostWindowFocus';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';

export type ScmAutoRefreshDemand = Readonly<{
    sessionId: string;
    serverId?: string | null;
    intervalMs: number;
    stepIntervalMs?: number;
    maxIntervalMs?: number;
}>;

type Target = Readonly<{ key: string; read(): Promise<ScmWorkingSnapshot | null> }>;
type Consumer = { demand: ScmAutoRefreshDemand; poll: Poll };
type Poll = {
    key: string;
    consumers: Set<Consumer>;
    timer: ReturnType<typeof setTimeout> | null;
    running: boolean;
    delayMs: number;
    snapshot: ScmWorkingSnapshot | null;
};

/** One external-editor fallback per repository. Agent and local Git writes use the normal invalidator. */
export class ScmAutoRefresh {
    private polls = new Map<string, Poll>();
    private stopListening: (() => void) | null = null;

    constructor(private resolve: (demand: ScmAutoRefreshDemand) => Target | null) {}

    retain(demand: ScmAutoRefreshDemand): () => void {
        if (!Number.isFinite(demand.intervalMs) || demand.intervalMs < 0) return () => {};
        const target = this.resolve(demand);
        if (!target) return () => {};
        let poll = this.polls.get(target.key);
        if (!poll) {
            poll = { key: target.key, consumers: new Set(), timer: null, running: false,
                delayMs: demand.intervalMs, snapshot: null };
            this.polls.set(target.key, poll);
        }
        const previousInterval = this.policy(poll)?.intervalMs;
        const consumer = { demand, poll };
        poll.consumers.add(consumer);
        if (!this.stopListening) {
            let active = isRuntimeActive() && readHostWindowFocus() !== false;
            this.stopListening = subscribeToRuntimeActiveChange(() => {
                const nextActive = isRuntimeActive() && readHostWindowFocus() !== false;
                if (nextActive === active) return;
                active = nextActive;
                for (const current of this.polls.values()) {
                    this.clearTimer(current);
                    this.schedule(current, 0);
                }
            }, { includeWindowFocus: true });
        }
        if (previousInterval !== undefined && demand.intervalMs > 0 && demand.intervalMs < previousInterval) {
            poll.delayMs = demand.intervalMs;
            this.clearTimer(poll);
            this.schedule(poll, demand.intervalMs);
        } else this.schedule(poll, 0);

        return () => {
            const current = consumer.poll;
            const previous = this.policy(current);
            current.consumers.delete(consumer);
            if (current.consumers.size === 0) this.remove(current);
            else {
                const next = this.policy(current)!;
                if (next.intervalMs === 0) this.clearTimer(current);
                else if (previous && next.intervalMs > previous.intervalMs) {
                    current.delayMs = Math.max(next.intervalMs, current.delayMs);
                    this.clearTimer(current);
                    this.schedule(current, current.delayMs);
                }
            }
            if (this.polls.size === 0) {
                this.stopListening?.();
                this.stopListening = null;
            }
        };
    }

    private policy(poll: Poll): ScmAutoRefreshDemand | undefined {
        let fastest: ScmAutoRefreshDemand | undefined;
        for (const { demand } of poll.consumers) {
            // A surface with polling disabled still acquires its first snapshot; it cannot disable another surface's demand.
            if (fastest && demand.intervalMs === 0) continue;
            if (!fastest || fastest.intervalMs === 0 || demand.intervalMs < fastest.intervalMs
                || demand.intervalMs === fastest.intervalMs && (demand.maxIntervalMs ?? demand.intervalMs) < (fastest.maxIntervalMs ?? fastest.intervalMs)) fastest = demand;
        }
        return fastest;
    }

    private clearTimer(poll: Poll): void {
        if (poll.timer !== null) clearTimeout(poll.timer);
        poll.timer = null;
    }

    private remove(poll: Poll): void {
        this.clearTimer(poll);
        if (this.polls.get(poll.key) === poll) this.polls.delete(poll.key);
    }

    private schedule(poll: Poll, delayMs: number): void {
        if (poll.timer !== null || poll.running || poll.consumers.size === 0
            || this.policy(poll)?.intervalMs === 0 && poll.snapshot !== null
            || !isRuntimeActive() || readHostWindowFocus() === false) return;
        poll.timer = setTimeout(() => { void this.run(poll); }, delayMs);
    }

    /** A first snapshot can discover that two Session directories belong to the same repository. */
    private resolvePoll(poll: Poll): Target | null {
        const consumer = poll.consumers.values().next().value;
        const target = consumer ? this.resolve(consumer.demand) : null;
        if (!target) { this.remove(poll); return null; }
        if (target.key === poll.key) return target;
        this.polls.delete(poll.key);
        const existing = this.polls.get(target.key);
        if (existing) {
            const previous = this.policy(existing);
            for (const retained of poll.consumers) {
                retained.poll = existing;
                existing.consumers.add(retained);
            }
            poll.consumers.clear();
            this.clearTimer(poll);
            const next = this.policy(existing)!;
            if (next.intervalMs > 0 && (!previous || previous.intervalMs === 0 || next.intervalMs < previous.intervalMs)) {
                existing.delayMs = next.intervalMs;
                this.clearTimer(existing);
                this.schedule(existing, existing.delayMs);
            }
            return null;
        }
        poll.key = target.key;
        this.polls.set(target.key, poll);
        return target;
    }

    private async run(poll: Poll): Promise<void> {
        this.clearTimer(poll);
        if (!isRuntimeActive() || readHostWindowFocus() === false) return;
        const target = this.resolvePoll(poll);
        if (!target) return;
        poll.running = true;
        try {
            const snapshot = await target.read();
            const policy = this.policy(poll);
            if (!policy) return;
            const maximum = Math.max(policy.intervalMs, policy.maxIntervalMs ?? policy.intervalMs);
            poll.delayMs = snapshot !== poll.snapshot ? policy.intervalMs
                : Math.min(maximum, Math.max(policy.intervalMs, poll.delayMs + (policy.stepIntervalMs ?? 0)));
            poll.snapshot = snapshot;
        } catch {
            // The status owner presents read failures; a later fallback or pushed change can recover.
        } finally {
            poll.running = false;
            if (poll.consumers.size > 0 && this.resolvePoll(poll) && this.policy(poll)!.intervalMs > 0) this.schedule(poll, poll.delayMs);
        }
    }
}
