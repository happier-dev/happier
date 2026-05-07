export type MachineActivityUpdate = { id: string; active: boolean; activeAt: number };

type MachineActivityAccumulatorOptions = Readonly<{
    shouldContinue?: () => boolean;
    sourceServerId?: string | null;
}>;

type PendingMachineActivityUpdate = Readonly<{
    update: MachineActivityUpdate;
    shouldContinue: () => boolean;
    sourceServerId: string | null;
}>;

export class MachineActivityAccumulator {
    private pendingUpdates = new Map<string, PendingMachineActivityUpdate>();
    private lastEmittedStates = new Map<string, { active: boolean; activeAt: number }>();
    private timeoutId: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private flushHandler: (updates: Map<string, MachineActivityUpdate>, options?: { sourceServerId?: string | null }) => void,
        private debounceDelay: number = 300
    ) {}

    addUpdate(update: MachineActivityUpdate, options?: MachineActivityAccumulatorOptions): void {
        const lastState = this.lastEmittedStates.get(update.id);
        const isSignificantChange = !lastState || lastState.active !== update.active;
        this.pendingUpdates.set(update.id, {
            update,
            shouldContinue: options?.shouldContinue ?? (() => true),
            sourceServerId: typeof options?.sourceServerId === 'string' && options.sourceServerId.trim()
                ? options.sourceServerId.trim()
                : null,
        });

        if (isSignificantChange) {
            if (this.timeoutId) {
                clearTimeout(this.timeoutId);
                this.timeoutId = null;
            }
            this.flushPendingUpdates();
        } else if (!this.timeoutId) {
            this.timeoutId = setTimeout(() => {
                this.flushPendingUpdates();
                this.timeoutId = null;
            }, this.debounceDelay);
        }
    }

    private flushPendingUpdates(): void {
        if (this.pendingUpdates.size > 0) {
            const updatesToFlushBySourceServerId = new Map<string, Map<string, MachineActivityUpdate>>();
            for (const [id, pending] of this.pendingUpdates) {
                if (pending.shouldContinue()) {
                    const sourceKey = pending.sourceServerId ?? '';
                    const updatesForSource = updatesToFlushBySourceServerId.get(sourceKey) ?? new Map<string, MachineActivityUpdate>();
                    updatesForSource.set(id, pending.update);
                    updatesToFlushBySourceServerId.set(sourceKey, updatesForSource);
                }
            }
            for (const [sourceKey, updatesToFlush] of updatesToFlushBySourceServerId) {
                if (updatesToFlush.size > 0) {
                    this.flushHandler(updatesToFlush, { sourceServerId: sourceKey || null });
                }
                for (const [id, update] of updatesToFlush) {
                    this.lastEmittedStates.set(id, { active: update.active, activeAt: update.activeAt });
                }
            }
            this.pendingUpdates.clear();
        }
    }

    cancel(): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        // Pending updates are intentionally dropped without flushing.
        // Only safe when the corresponding storage state is also being discarded
        // (e.g. via resetServerScopedRuntimeState).
        this.pendingUpdates.clear();
    }

    reset(): void {
        this.cancel();
        this.lastEmittedStates.clear();
    }

    flush(): void {
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        this.flushPendingUpdates();
    }
}
