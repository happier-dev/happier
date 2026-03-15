export class PauseController {
    #paused = false;
    #waiters: Array<() => void> = [];

    isPaused(): boolean {
        return this.#paused;
    }

    pause(): void {
        this.#paused = true;
    }

    resume(): void {
        if (!this.#paused) return;
        this.#paused = false;
        const waiters = this.#waiters;
        this.#waiters = [];
        for (const resolve of waiters) {
            resolve();
        }
    }

    async waitUntilResumed(): Promise<void> {
        if (!this.#paused) return;
        await new Promise<void>((resolve) => {
            this.#waiters.push(resolve);
        });
    }
}
