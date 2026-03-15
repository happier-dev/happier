import type { ScmDiffArea } from '@happier-dev/protocol';

import type { ScmDiffCache } from './scmDiffCache';

export type ScmDiffPrefetchRequest = Readonly<{
    sessionId: string;
    snapshotSignature: string;
    diffArea: ScmDiffArea;
    paths: readonly string[];
}>;

export type ScmDiffPrefetchFetchFn = (input: Readonly<{
    sessionId: string;
    diffArea: ScmDiffArea;
    path: string;
}>) => Promise<Readonly<{ success: true; diff: string }> | Readonly<{ success: false; error: string }>>;

type PrefetchScopeState = {
    readonly scopeKey: string;
    readonly sessionId: string;
    readonly snapshotSignature: string;
    readonly diffArea: ScmDiffArea;
    queue: string[];
    queued: Set<string>;
    inFlight: Set<string>;
    lastAccessAtMs: number;
};

export class ScmDiffPrefetchScheduler {
    private readonly scopes = new Map<string, PrefetchScopeState>();
    private maxConcurrency: number;

    constructor(
        private readonly deps: Readonly<{
            cache: ScmDiffCache;
            fetchDiff: ScmDiffPrefetchFetchFn;
            now: () => number;
            maxScopes?: number;
            maxConcurrency: number;
        }>
    ) {
        this.maxConcurrency = Number.isFinite(deps.maxConcurrency) ? Math.max(1, Math.floor(deps.maxConcurrency)) : 1;
    }

    setMaxConcurrency(value: number): void {
        this.maxConcurrency = Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
    }

    prefetch(input: ScmDiffPrefetchRequest): void {
        if (!input.sessionId || !input.snapshotSignature || !input.diffArea) return;
        if (!Array.isArray(input.paths) || input.paths.length === 0) return;

        const now = this.deps.now();
        const scopeKey = this.toScopeKey(input);
        const scope = this.getOrCreateScope({ ...input, scopeKey, now });
        scope.lastAccessAtMs = now;

        for (const path of input.paths) {
            if (!path || typeof path !== 'string') continue;
            if (scope.queued.has(path) || scope.inFlight.has(path)) continue;
            const cached = this.deps.cache.get({
                sessionId: input.sessionId,
                snapshotSignature: input.snapshotSignature,
                diffArea: input.diffArea,
                path,
            });
            if (cached) continue;
            scope.queue.push(path);
            scope.queued.add(path);
        }

        this.trimScopes();
        this.pump(scope);
    }

    private pump(scope: PrefetchScopeState): void {
        const maxConcurrency = this.maxConcurrency;
        while (scope.inFlight.size < maxConcurrency && scope.queue.length > 0) {
            const path = scope.queue.shift();
            if (!path) continue;
            scope.queued.delete(path);
            scope.inFlight.add(path);
            void this.runOne(scope, path);
        }
    }

    private async runOne(scope: PrefetchScopeState, path: string): Promise<void> {
        try {
            const res = await this.deps.fetchDiff({ sessionId: scope.sessionId, diffArea: scope.diffArea, path });
            if (res && res.success) {
                this.deps.cache.set(
                    {
                        sessionId: scope.sessionId,
                        snapshotSignature: scope.snapshotSignature,
                        diffArea: scope.diffArea,
                        path,
                    },
                    res.diff ?? '',
                );
            }
        } finally {
            scope.inFlight.delete(path);
            this.pump(scope);
        }
    }

    private getOrCreateScope(input: Readonly<{
        scopeKey: string;
        sessionId: string;
        snapshotSignature: string;
        diffArea: ScmDiffArea;
        now: number;
    }>): PrefetchScopeState {
        const existing = this.scopes.get(input.scopeKey);
        if (existing) return existing;
        const next: PrefetchScopeState = {
            scopeKey: input.scopeKey,
            sessionId: input.sessionId,
            snapshotSignature: input.snapshotSignature,
            diffArea: input.diffArea,
            queue: [],
            queued: new Set(),
            inFlight: new Set(),
            lastAccessAtMs: input.now,
        };
        this.scopes.set(input.scopeKey, next);
        return next;
    }

    private trimScopes(): void {
        const maxScopes = Number.isFinite(this.deps.maxScopes) ? Math.max(1, Math.floor(this.deps.maxScopes!)) : 3;
        if (this.scopes.size <= maxScopes) return;

        const sorted = [...this.scopes.values()].sort((a, b) => a.lastAccessAtMs - b.lastAccessAtMs);
        const toDrop = sorted.slice(0, Math.max(0, sorted.length - maxScopes));
        for (const scope of toDrop) {
            this.scopes.delete(scope.scopeKey);
        }
    }

    private toScopeKey(input: Readonly<{ sessionId: string; snapshotSignature: string; diffArea: ScmDiffArea }>): string {
        return `${input.sessionId}\u0000${input.snapshotSignature}\u0000${input.diffArea}`;
    }
}
