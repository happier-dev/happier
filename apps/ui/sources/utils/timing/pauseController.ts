export class PauseController {
    #pausedReasons = new Set<string>();
    #waiters = new Set<() => void>();

    isPaused(): boolean {
        return this.#pausedReasons.size > 0;
    }

    pause(reason: string = 'default'): void {
        const key = String(reason ?? '').trim() || 'default';
        this.#pausedReasons.add(key);
    }

    resume(reason: string = 'default'): void {
        const key = String(reason ?? '').trim() || 'default';
        this.#pausedReasons.delete(key);
        if (this.#pausedReasons.size > 0) return;
        for (const wake of this.#waiters) {
            wake();
        }
    }

    /** Wakes on resume or cancellation. Check the signal before starting work. */
    async waitUntilResumed(signal?: AbortSignal): Promise<void> {
        if (!this.isPaused() || signal?.aborted) return;
        await new Promise<void>((resolve) => {
            const wake = () => {
                this.#waiters.delete(wake);
                signal?.removeEventListener('abort', wake);
                resolve();
            };
            this.#waiters.add(wake);
            signal?.addEventListener('abort', wake, { once: true });
        });
    }
}
