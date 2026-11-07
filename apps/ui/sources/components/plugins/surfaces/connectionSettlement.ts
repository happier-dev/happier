/** Push-driven pre-invocation settlement shared by mounted and ordinary host Actions. */
export function createPluginConnectionSettlement() {
    let disposed = false;
    const waiters = new Set<() => void>();
    const notify = () => { for (const resume of [...waiters]) resume(); };
    return {
        wait(input: Readonly<{ isPending(): boolean; isCurrent?(): boolean; signal?: AbortSignal }>): Promise<void> | null {
            if (!input.isPending()) return null;
            if (disposed || input.isCurrent?.() === false || input.signal?.aborted) return Promise.resolve();
            return new Promise<void>(resolve => {
                const finish = () => {
                    waiters.delete(resume);
                    input.signal?.removeEventListener('abort', finish);
                    resolve();
                };
                const resume = () => {
                    if (!disposed && input.isCurrent?.() !== false && input.isPending()) return;
                    finish();
                };
                waiters.add(resume);
                input.signal?.addEventListener('abort', finish, { once: true });
            });
        },
        notify,
        dispose() { disposed = true; notify(); },
    };
}
