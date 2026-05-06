import type { PluginDisposable } from '../api/types';

async function disposeOne(disposable: PluginDisposable): Promise<void> {
    if (typeof disposable === 'function') {
        await disposable();
        return;
    }
    await disposable.dispose();
}

export function createPluginDisposableRegistry(): Readonly<{
    add: (disposable: PluginDisposable) => PluginDisposable;
    entries: () => readonly PluginDisposable[];
    dispose: () => Promise<void>;
}> {
    const disposables: PluginDisposable[] = [];
    let disposed = false;

    return {
        add(disposable) {
            if (disposed) {
                void disposeOne(disposable);
                return disposable;
            }
            disposables.push(disposable);
            return disposable;
        },
        entries() {
            return Object.freeze([...disposables]);
        },
        async dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            const pending = [...disposables].reverse();
            disposables.length = 0;
            for (const disposable of pending) {
                await disposeOne(disposable);
            }
        },
    };
}
