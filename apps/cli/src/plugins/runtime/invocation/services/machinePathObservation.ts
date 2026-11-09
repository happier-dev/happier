import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';
import type { FileSystemService } from '@happier-dev/plugin-sdk/fs';
import { startFileWatcher } from '@/integrations/watcher/startFileWatcher';

type Observation = Awaited<ReturnType<FileSystemService['observeMachinePath']>>;

/** Lifecycle adaptation only: the filesystem owner supplies every guarded read,
 * and the incumbent shared native watcher retains attachment/recovery ownership. */
export async function observeMachinePath(input: Readonly<{
    absolutePath: string;
    signal: AbortSignal;
    read(): ReturnType<Observation['read']>;
    emit: Parameters<FileSystemService['observeMachinePath']>[1];
}>): Promise<Observation> {
    input.signal.throwIfAborted();
    const initial = await input.read();
    let notified = initial;
    let closed = false;
    let disposal: Promise<void> | undefined;
    let attached!: () => void;
    let rejected!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { attached = resolve; rejected = reject; });
    let stop: ReturnType<typeof startFileWatcher> | undefined;
    const dispose = () => {
        closed = true;
        return disposal ??= Promise.resolve().then(async () => {
            input.signal.removeEventListener('abort', aborted);
            rejected(new PluginError({ code: 'plugin_fs_aborted', message: 'Filesystem observation was aborted' }));
            await stop?.dispose();
        });
    };
    const aborted = () => { void dispose().catch(() => {}); };
    const read = async () => {
        if (closed || input.signal.aborted) throw new PluginError({ code: 'plugin_fs_aborted' });
        const next = await input.read();
        if (closed || input.signal.aborted) throw new PluginError({ code: 'plugin_fs_aborted' });
        return next;
    };
    const publish = (next: Awaited<ReturnType<Observation['read']>>) => {
        if (closed || input.signal.aborted || next?.identity === notified?.identity && next?.size === notified?.size) return;
        notified = next;
        try { input.emit({ kind: 'changed', identity: next?.identity ?? null, size: next?.size ?? null }); }
        catch { void dispose().catch(() => {}); }
    };
    const unavailable = (error: unknown) => {
        if (closed || input.signal.aborted) return;
        const code = isPluginError(error) ? error.data.code
            : typeof error === 'object' && error !== null && 'code' in error
                && (error.code === 'EACCES' || error.code === 'EPERM')
                ? 'plugin_fs_permission_denied' : 'plugin_fs_observation_unavailable';
        const retryable = isPluginError(error) ? error.data.retryable === true : code === 'plugin_fs_observation_unavailable';
        rejected(new PluginError({ code, retryable, message: 'Native filesystem observation is unavailable' }));
        try { input.emit({ kind: 'unavailable', code, retryable }); }
        catch { /* Consumer failure cannot retain a native attachment. */ }
        finally { void dispose().catch(() => {}); }
    };
    input.signal.addEventListener('abort', aborted, { once: true });
    try {
        stop = startFileWatcher(input.absolutePath, async () => {
            if (closed || input.signal.aborted) return;
            try {
                publish(await read());
            } catch (error) { unavailable(error); }
        }, { emitInitial: false, onWatcherAttached: async () => {
            // Reconcile within the incumbent watcher's serialized attachment
            // lifecycle, before a native callback can publish a newer sample.
            publish(await read());
            attached();
        }, onWatcherUnavailable: unavailable });
        if (input.signal.aborted) aborted();
        await ready;
        if (closed || input.signal.aborted) throw new PluginError({ code: 'plugin_fs_aborted' });
        const current = notified;
        return { identity: current?.identity ?? null, size: current?.size ?? null, read, dispose };
    } catch (error) { await dispose(); throw error; }
}
