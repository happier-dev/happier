import * as React from 'react';

import {
    closeRecentCaptures,
    openRecentCaptures,
    refreshRecentCaptures,
    NativeCaptureError,
    chooseRecentCaptureFile,
    pickCaptureLibraryFolder,
    subscribeRecentCaptures,
    type NativeRecentCaptureEntry,
    type NativeRecentCaptureFolder,
    type NativeRecentCaptureChanges,
    type NativeRecentCapturesSnapshot,
} from '@/desktop/capture/nativeCapture';

const applyChanges = (entries: readonly NativeRecentCaptureEntry[], upserted: readonly NativeRecentCaptureEntry[], removed: readonly string[]) => {
    const replaced = new Set([...removed, ...upserted.map(({ path }) => path)]);
    return [...upserted, ...entries.filter(({ path }) => !replaced.has(path))]
        .sort((left, right) => (right.modifiedAt ?? 0) - (left.modifiedAt ?? 0));
};

// IPC snapshots contain fresh objects even when the file metadata did not change.
const reconcileEntries = (previous: readonly NativeRecentCaptureEntry[], next: readonly NativeRecentCaptureEntry[]) => {
    const byPath = new Map(previous.map(entry => [entry.path, entry]));
    const rows = next.map(entry => {
        const old = byPath.get(entry.path);
        return old && old.name === entry.name && old.kind === entry.kind && old.byteSize === entry.byteSize
            && old.modifiedAt === entry.modifiedAt && old.modifiedAtNanos === entry.modifiedAtNanos ? old : entry;
    });
    return rows.length === previous.length && rows.every((entry, index) => entry === previous[index]) ? previous : rows;
};

type RecentState = Readonly<{
    entries: readonly NativeRecentCaptureEntry[];
    folders: readonly NativeRecentCaptureFolder[];
    status: 'loading' | 'ready' | 'error';
    refreshing: boolean;
    error: NativeCaptureError | null;
    choosing: boolean;
}>;

export type RecentCaptureConsumer = (entry: NativeRecentCaptureEntry) => void | Promise<unknown>;

/** The capture folders, kept current by their own pushes only while something shows them. */
export function useRecentCaptures() {
    const [state, setState] = React.useState<RecentState>({ entries: [], folders: [], status: 'loading', refreshing: false, error: null, choosing: false });
    const mounted = React.useRef(false);
    const read = React.useRef<(folder?: string) => Promise<NativeRecentCapturesSnapshot | undefined>>(async () => undefined);
    const refresh = React.useCallback(() => read.current(), []);
    const openFolder = React.useCallback((folder: string) => read.current(folder), []);
    const perform = React.useCallback(async (operation: () => Promise<boolean>) => {
        setState(previous => ({ ...previous, choosing: true }));
        try {
            const succeeded = await operation();
            if (succeeded && mounted.current) setState(previous => ({ ...previous, status: 'ready', error: null }));
            return succeeded;
        }
        catch (error) {
            if (mounted.current) setState(previous => ({ ...previous, status: 'error', error: error instanceof NativeCaptureError ? error : new NativeCaptureError('native_failure') }));
            return false;
        } finally {
            if (mounted.current) setState(previous => ({ ...previous, choosing: false }));
        }
    }, []);
    const choose = React.useCallback((entry: NativeRecentCaptureEntry, consume: RecentCaptureConsumer) => perform(async () => {
        await consume(entry);
        return true;
    }), [perform]);
    const chooseFile = React.useCallback((consume: RecentCaptureConsumer) => perform(async () => {
        const selected = await chooseRecentCaptureFile();
        if (selected === null || !mounted.current) return false;
        const snapshot = await read.current(selected.folder);
        if (!snapshot || !mounted.current) return false;
        const entry = snapshot.entries.find(entry => entry.path === selected.path);
        if (!entry) throw new NativeCaptureError('invalid_media');
        await consume(entry);
        return true;
    }), [perform]);
    const chooseFolder = React.useCallback(() => perform(async () => {
        const folder = await pickCaptureLibraryFolder();
        if (folder === null || !mounted.current) return false;
        return (await read.current(folder)) !== undefined;
    }), [perform]);
    React.useEffect(() => {
        mounted.current = true;
        let active = true;
        let stop: (() => void) | undefined;
        let opened = false;
        let selectedFolder: string | undefined;
        let pending: Promise<NativeRecentCapturesSnapshot> | undefined;
        let queued: NativeRecentCaptureChanges[] = [];
        const apply = (previous: RecentState, changes: NativeRecentCaptureChanges): RecentState => ({
            ...previous,
            entries: reconcileEntries(previous.entries, applyChanges(previous.entries, changes.upserted, changes.removed)),
            folders: changes.folders ?? previous.folders,
        });
        const ensureSubscribed = async () => {
            if (stop) return;
            const dispose = await subscribeRecentCaptures(changes => {
                if (!active) return;
                if (pending) queued.push(changes);
                else setState(previous => apply(previous, changes));
            });
            if (!active) { dispose(); return; }
            stop = dispose;
        };
        read.current = async (folder) => {
            if (!active) return;
            setState(previous => ({ ...previous, refreshing: true, error: null }));
            try {
                await ensureSubscribed();
                if (!active) return;
                if (folder !== undefined) selectedFolder = folder;
                const request = !opened || folder !== undefined ? openRecentCaptures({ folder: selectedFolder }) : refreshRecentCaptures();
                pending = request;
                queued = [];
                const snapshot = await request;
                if (!active || pending !== request) return;
                opened = true;
                pending = undefined;
                const changes = queued;
                queued = [];
                setState(previous => changes.reduce<RecentState>(apply, {
                    ...previous,
                    entries: reconcileEntries(previous.entries, snapshot.entries), folders: snapshot.folders,
                    status: 'ready', refreshing: false,
                }));
                return snapshot;
            } catch (error) {
                if (!active) return;
                pending = undefined;
                const changes = queued;
                queued = [];
                setState(previous => ({ ...changes.reduce(apply, previous), status: 'error', refreshing: false,
                    error: error instanceof NativeCaptureError ? error : new NativeCaptureError('native_failure') }));
            }
        };
        void read.current();
        return () => { active = false; mounted.current = false; stop?.(); void closeRecentCaptures().catch(() => undefined); };
    }, []);
    return { ...state, refresh, openFolder, choose, chooseFile, chooseFolder };
}
