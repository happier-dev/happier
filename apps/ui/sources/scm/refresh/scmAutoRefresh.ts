import { isRuntimeActive, subscribeToRuntimeActiveChange } from '@/utils/runtime/isRuntimeActive';
import { readHostWindowFocus } from '@/utils/runtime/readHostWindowFocus';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import type { ScmWorkspaceWatchUnavailable } from '@happier-dev/protocol/scm';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

export type ScmAutoRefreshDemand = Readonly<({ sessionId: string; serverId?: string | null } | { scope: WorkspaceScopeBase }) & {
    intervalMs: number;
    stepIntervalMs?: number;
    maxIntervalMs?: number;
    /** Project owns its initial/loading read; it still retains observation and the incumbent fallback. */
    refreshOnRetain?: boolean;
}>;

export type ScmAutoRefreshWatchCallbacks = Readonly<{
    onChange(): void;
    onReady(): void;
    onUnavailable(reason: ScmWorkspaceWatchUnavailable): void;
}>;
type Target = Readonly<{
    key: string;
    read(source?: 'filesystem'): Promise<ScmWorkingSnapshot | null>;
    watch?(callbacks: ScmAutoRefreshWatchCallbacks): () => void;
    onUnavailable?(reason: ScmWorkspaceWatchUnavailable): void;
}>;
type Consumer = { demand: ScmAutoRefreshDemand; poll: Poll };
type WatchState = { status: 'idle' | 'pending' | 'ready' }
    | { status: 'unavailable'; reason: ScmWorkspaceWatchUnavailable };
type Poll = {
    key: string;
    consumers: Set<Consumer>;
    timer: ReturnType<typeof setTimeout> | null;
    running: boolean;
    delayMs: number;
    snapshot: ScmWorkingSnapshot | null;
    watchState: WatchState;
    stopWatch: (() => void) | null;
};

/** One presented observation and external-editor fallback per repository. */
export class ScmAutoRefresh {
    private polls = new Map<string, Poll>();
    private stopListening: (() => void) | null = null;

    constructor(private resolve: (demand: ScmAutoRefreshDemand) => Target | null) {}

    hasDemand(key: string): boolean { return this.polls.has(key); }
    getUnavailable(key: string): ScmWorkspaceWatchUnavailable | null {
        const state = this.polls.get(key)?.watchState;
        return state?.status === 'unavailable' ? state.reason : null;
    }

    /** The status owner has published the first snapshot (and possibly discovered its repository root). */
    reconcile(key: string): void {
        const poll = this.polls.get(key);
        if (!poll) return;
        const target = this.resolvePoll(poll);
        if (target) this.reconcileWatch(poll, target);
    }

    retain(demand: ScmAutoRefreshDemand): () => void {
        if (!Number.isFinite(demand.intervalMs) || demand.intervalMs < 0) return () => {};
        const target = this.resolve(demand);
        if (!target) return () => {};
        let poll = this.polls.get(target.key);
        if (!poll) {
            poll = { key: target.key, consumers: new Set(), timer: null, running: false,
                delayMs: demand.intervalMs, snapshot: null, watchState: { status: 'idle' }, stopWatch: null };
            this.polls.set(target.key, poll);
        }
        const previousInterval = this.policy(poll)?.intervalMs;
        const consumer = { demand, poll };
        poll.consumers.add(consumer);
        if (!this.stopListening) {
            let active = this.isActive();
            this.stopListening = subscribeToRuntimeActiveChange(() => {
                const nextActive = this.isActive();
                if (nextActive === active) return;
                active = nextActive;
                for (const current of this.polls.values()) {
                    this.clearTimer(current);
                    if (!active) this.releaseWatch(current);
                    else {
                        const next = this.resolvePoll(current);
                        if (next) this.reconcileWatch(current, next);
                        this.schedule(current, 0);
                    }
                }
            }, { includeWindowFocus: true });
        }
        this.reconcileWatch(poll, target);
        if (previousInterval !== undefined && demand.intervalMs > 0 && demand.intervalMs < previousInterval) {
            poll.delayMs = demand.intervalMs;
            this.clearTimer(poll);
            this.schedule(poll, demand.intervalMs);
        } else if (demand.refreshOnRetain !== false) this.schedule(poll, 0);
        else if (demand.intervalMs > 0) this.schedule(poll, demand.intervalMs);

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

    private isActive(): boolean { return isRuntimeActive() && readHostWindowFocus() !== false; }

    private reconcileWatch(poll: Poll, target: Target): void {
        if (!this.isActive() || poll.consumers.size === 0 || poll.watchState.status !== 'idle' || !target.watch) return;
        poll.watchState = { status: 'pending' };
        this.clearTimer(poll);
        const revalidate = () => {
            // The shared status queue preserves changes arriving after an in-flight read started.
            void target.read('filesystem').catch(() => {
                // The status owner presents failures; the incumbent fallback remains available.
            });
        };
        poll.stopWatch = target.watch({
            onChange: revalidate,
            // A read after native enrollment closes the initial snapshot-to-attachment window.
            onReady: () => {
                poll.watchState = { status: 'ready' };
                this.clearTimer(poll);
                revalidate();
            },
            onUnavailable: reason => {
                poll.watchState = { status: 'unavailable', reason };
                target.onUnavailable?.(reason);
                // Settles until presentation ends: use the incumbent fallback without a watch retry.
                if (this.policy(poll)?.intervalMs) this.schedule(poll, poll.delayMs);
            },
        });
    }

    private releaseWatch(poll: Poll): void {
        poll.stopWatch?.();
        poll.stopWatch = null;
        poll.watchState = { status: 'idle' };
    }

    private policy(poll: Poll): ScmAutoRefreshDemand | undefined {
        let fastest: ScmAutoRefreshDemand | undefined;
        for (const { demand } of poll.consumers) {
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
        this.releaseWatch(poll);
        if (this.polls.get(poll.key) === poll) this.polls.delete(poll.key);
    }

    private schedule(poll: Poll, delayMs: number): void {
        if (poll.timer !== null || poll.running || poll.consumers.size === 0
            || poll.watchState.status === 'ready'
            || poll.watchState.status === 'pending' && (poll.snapshot !== null || delayMs > 0)
            || this.policy(poll)?.intervalMs === 0 && poll.snapshot !== null || !this.isActive()) return;
        poll.timer = setTimeout(() => { void this.run(poll); }, delayMs);
    }

    private resolvePoll(poll: Poll): Target | null {
        const consumer = poll.consumers.values().next().value;
        const target = consumer ? this.resolve(consumer.demand) : null;
        if (!target) { this.remove(poll); return null; }
        if (target.key === poll.key) return target;
        this.polls.delete(poll.key);
        this.releaseWatch(poll);
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
            this.reconcileWatch(existing, target);
            return null;
        }
        poll.key = target.key;
        this.polls.set(target.key, poll);
        return target;
    }

    private async run(poll: Poll): Promise<void> {
        if (poll.running || poll.consumers.size === 0 || !this.isActive()) return;
        this.clearTimer(poll);
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
            if (poll.consumers.size > 0) {
                const next = this.resolvePoll(poll);
                if (next) {
                    this.reconcileWatch(poll, next);
                    if (this.policy(poll)!.intervalMs > 0) this.schedule(poll, poll.delayMs);
                }
            }
        }
    }
}
