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
    let disposalPromise: Promise<void> | null = null;

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
        dispose() {
            if (disposalPromise) return disposalPromise;
            disposed = true;
            const pending = [...disposables].reverse();
            disposables.length = 0;
            disposalPromise = (async () => {
                const errors: unknown[] = [];
                for (const disposable of pending) {
                    try {
                        await disposeOne(disposable);
                    } catch (error) {
                        errors.push(error);
                    }
                }
                if (errors.length === 1) throw errors[0];
                if (errors.length > 1) {
                    throw new AggregateError(errors, 'Plugin generation cleanup failed');
                }
            })();
            return disposalPromise;
        },
    };
}
