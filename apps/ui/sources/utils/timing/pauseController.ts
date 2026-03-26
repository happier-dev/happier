export class PauseController {
    #pausedReasons = new Set<string>();
    #waiters: Array<() => void> = [];

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
        const waiters = this.#waiters;
        this.#waiters = [];
        for (const resolve of waiters) {
            resolve();
        }
    }

    async waitUntilResumed(): Promise<void> {
        if (this.#pausedReasons.size === 0) return;
        await new Promise<void>((resolve) => {
            this.#waiters.push(resolve);
        });
    }
}
