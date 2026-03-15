import type { NormalizedMessage } from '@/sync/typesRaw';

import { extractWorkspaceMutationsFromNormalizedMessages } from './workspaceMutationDetection/extractWorkspaceMutations';

export type WorkspaceMutationInvalidation = Readonly<{
    sessionId: string;
    changedPaths: readonly string[];
    hasUnknownMutations: boolean;
}>;

export type WorkspaceMutationInvalidatorOptions = Readonly<{
    debounceMs: number;
    minUnknownOnlyIntervalMs: number;
    now: () => number;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (handle: unknown) => void;
    onInvalidate: (event: WorkspaceMutationInvalidation) => void;
}>;

export class WorkspaceMutationInvalidator {
    private readonly pendingBySession = new Map<string, {
        paths: Set<string>;
        hasUnknownMutations: boolean;
        timer: unknown | null;
        lastUnknownOnlyEmitAtMs: number;
    }>();

    constructor(private readonly options: WorkspaceMutationInvalidatorOptions) {}

    ingest(sessionId: string, messages: readonly NormalizedMessage[]): void {
        if (typeof sessionId !== 'string' || sessionId.trim().length === 0) return;
        if (!Array.isArray(messages) || messages.length === 0) return;

        const extracted = extractWorkspaceMutationsFromNormalizedMessages({ messages });
        if (extracted.paths.size === 0 && extracted.hasUnknownMutations !== true) {
            return;
        }

        const existing = this.pendingBySession.get(sessionId) ?? {
            paths: new Set<string>(),
            hasUnknownMutations: false,
            timer: null,
            lastUnknownOnlyEmitAtMs: 0,
        };

        for (const path of extracted.paths) {
            if (typeof path === 'string' && path.trim().length > 0) {
                existing.paths.add(path);
            }
        }
        existing.hasUnknownMutations = existing.hasUnknownMutations || extracted.hasUnknownMutations;

        const hasKnownPaths = existing.paths.size > 0;
        const unknownOnly = !hasKnownPaths && existing.hasUnknownMutations;
        if (unknownOnly) {
            const nowMs = this.options.now();
            if (existing.lastUnknownOnlyEmitAtMs > 0 && nowMs - existing.lastUnknownOnlyEmitAtMs < this.options.minUnknownOnlyIntervalMs) {
                // Too soon to emit another unknown-only invalidation. Keep pending state but don't schedule.
                this.pendingBySession.set(sessionId, existing);
                return;
            }
        }

        if (existing.timer != null) {
            this.options.clearTimer(existing.timer);
            existing.timer = null;
        }

        existing.timer = this.options.setTimer(() => {
            this.flush(sessionId);
        }, this.options.debounceMs);

        this.pendingBySession.set(sessionId, existing);
    }

    private flush(sessionId: string): void {
        const pending = this.pendingBySession.get(sessionId);
        if (!pending) return;

        if (pending.timer != null) {
            this.options.clearTimer(pending.timer);
            pending.timer = null;
        }

        const changedPaths = Array.from(pending.paths);
        const hasUnknownMutations = pending.hasUnknownMutations;
        pending.paths = new Set();
        pending.hasUnknownMutations = false;

        if (changedPaths.length === 0 && hasUnknownMutations) {
            const nowMs = this.options.now();
            if (pending.lastUnknownOnlyEmitAtMs > 0 && nowMs - pending.lastUnknownOnlyEmitAtMs < this.options.minUnknownOnlyIntervalMs) {
                this.pendingBySession.set(sessionId, pending);
                return;
            }
            pending.lastUnknownOnlyEmitAtMs = nowMs;
        }

        this.pendingBySession.set(sessionId, pending);
        this.options.onInvalidate({
            sessionId,
            changedPaths,
            hasUnknownMutations,
        });
    }
}
