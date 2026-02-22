export type MachineActivityUpdate = { id: string; active: boolean; activeAt: number };

export class MachineActivityAccumulator {
    private pendingUpdates = new Map<string, MachineActivityUpdate>();
    private lastEmittedStates = new Map<string, { active: boolean; activeAt: number }>();
    private timeoutId: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private flushHandler: (updates: Map<string, MachineActivityUpdate>) => void,
        private debounceDelay: number = 300
    ) {}

    addUpdate(update: MachineActivityUpdate): void {
        const lastState = this.lastEmittedStates.get(update.id);
        const isSignificantChange = !lastState || lastState.active !== update.active;
        this.pendingUpdates.set(update.id, update);

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
            const updatesToFlush = new Map(this.pendingUpdates);
            this.flushHandler(updatesToFlush);
            for (const [id, update] of updatesToFlush) {
                this.lastEmittedStates.set(id, { active: update.active, activeAt: update.activeAt });
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
