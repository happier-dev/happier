import { isPluginError, type Disposable, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { FileSystemService } from '@happier-dev/plugin-sdk/fs';
import type { ManagedServiceNativeLogResultV1, ManagedServiceNativeLogWatchV1 } from '@happier-dev/plugin-sdk/managed-services';
import { journalDenied, observeJournalSource, readJournalContent, type JournalSelection } from './journal.js';

type Observation = Awaited<ReturnType<FileSystemService['observeMachinePath']>>;
type Snapshot = Awaited<ReturnType<Observation['read']>>;

/** The existing filesystem owner supplies push and native identity fences. Each
 * demanded append uses the same finite byte/cursor reader, never another parser,
 * native follow process, polling loop or retained journal-content buffer. */
export async function watchJournal(selected: JournalSelection, request: ManagedServiceNativeLogWatchV1,
    context?: PluginInvocationContext): Promise<Disposable> {
    if (process.platform !== 'linux' || !context || !Number.isSafeInteger(request.maxBytes) || request.maxBytes < 1) {
        request.emit({ kind: 'unavailable', reason: process.platform !== 'linux' ? 'unsupported' : !context ? 'admission_unavailable' : 'unavailable' });
        return { dispose() {} };
    }
    const lifetime = new AbortController();
    const signal = AbortSignal.any([context.signal, lifetime.signal, ...(request.signal ? [request.signal] : [])]);
    signal.throwIfAborted();
    const observations: Observation[] = [];
    let snapshots: Snapshot[] = [];
    let cursor = request.cursor;
    let closed = false;
    let dirty = false;
    let draining = false;
    let pending = Promise.resolve();
    let disposal: Promise<void> | undefined;
    const dispose = () => disposal ??= Promise.resolve().then(async () => {
        closed = true;
        lifetime.abort();
        signal.removeEventListener('abort', onAbort);
        await Promise.all(observations.map(observation => observation.dispose()));
        await pending;
    });
    const onAbort = () => { void dispose().catch(() => {}); };
    const emit = (value: ManagedServiceNativeLogResultV1) => {
        if (closed || signal.aborted) return;
        try { request.emit(value); }
        catch { void dispose().catch(() => {}); return; }
        if (value.kind !== 'page') void dispose().catch(() => {});
    };
    const failed = (error: unknown) => {
        if (signal.aborted || closed) return;
        const code = isPluginError(error) ? error.data.code : '';
        emit(unavailableFor(code));
    };
    const unavailableFor = (code: string): ManagedServiceNativeLogResultV1 => code === 'plugin_fs_permission_denied' ? journalDenied
        : { kind: 'unavailable', reason: code === 'plugin_generation_stale' || code === 'plugin_fs_path_denied' ? 'admission_unavailable' : 'unavailable' };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
        const source = await observeJournalSource(selected, signal, context);
        if (source.kind === 'failure') { emit(source.result); await dispose(); return { dispose }; }
        if (cursor && cursor.sourceRevision !== source.sourceRevision) {
            emit({ kind: 'source-changed', sourceRevision: source.sourceRevision });
            await dispose(); return { dispose };
        }
        let initialized = false;
        const sample = () => Promise.all(observations.map(observation => observation.read()));
        const replaced = (next: readonly Snapshot[]) => next.some((value, index) => value?.identity !== snapshots[index]?.identity
            || value !== null && snapshots[index] !== null && value.size < snapshots[index]!.size);
        const checkSource = async (next: Snapshot[]) => {
            if (!replaced(next)) { snapshots = next; return true; }
            const current = await observeJournalSource(selected, signal, context);
            if (current.kind === 'failure') { emit(current.result); return false; }
            if (current.sourceRevision !== source.sourceRevision) {
                emit({ kind: 'source-changed', sourceRevision: current.sourceRevision }); return false;
            }
            // A same-ID truncated/copy source is not proof that a retained byte
            // position is valid. Do not disclose guessed continuation bytes.
            emit({ kind: 'unavailable', reason: 'unavailable' }); return false;
        };
        const drain = async () => {
            while (dirty && !closed && !signal.aborted) {
                dirty = false;
                if (!await checkSource(await sample())) return;
                // A source change admits one finite page. Historical continuation
                // belongs to the consumer's next cursor read, never a watch drain.
                const result = await readJournalContent(selected, { kind: 'read', maxBytes: request.maxBytes,
                    ...(cursor ? { cursor } : {}), signal }, source.sourceRevision, context);
                if (closed || signal.aborted || !await checkSource(await sample())) return;
                if (result.kind !== 'page') { emit(result); return; }
                cursor = result.page.nextCursor ?? cursor;
                if (result.page.text) emit(result);
            }
        };
        const schedule = () => {
            dirty = true;
            if (initialized && !draining && !closed && !signal.aborted) {
                draining = true;
                pending = drain().catch(failed).finally(() => {
                    draining = false;
                    if (dirty && !closed && !signal.aborted) schedule();
                });
            }
        };
        for (const file of source.files) {
            const observation = await context.services.fs.observeMachinePath({ absolutePath: file.path }, event => {
                if (event.kind === 'changed') schedule();
                else {
                    emit(unavailableFor(event.code));
                }
            }, { signal });
            observations.push(observation);
            snapshots.push(observation.identity === null ? null : { identity: observation.identity, size: observation.size! });
        }
        const attached = await observeJournalSource(selected, signal, context);
        if (attached.kind === 'failure') { emit(attached.result); await dispose(); return { dispose }; }
        if (attached.sourceRevision !== source.sourceRevision) {
            emit({ kind: 'source-changed', sourceRevision: attached.sourceRevision }); await dispose(); return { dispose };
        }
        initialized = true;
        schedule();
        if (signal.aborted) await dispose();
        return { dispose };
    } catch (error) {
        failed(error);
        await dispose();
        if (request.signal?.aborted || context.signal.aborted) throw error;
        return { dispose };
    }
}
