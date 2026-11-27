import * as React from 'react';
import { readTranscriptSessionMediaMeta } from '@/components/sessions/transcript/structured/happierMetaEnvelope';
import { workspaceGetDirectoryTree, workspaceListDirectory, type WorkspaceTreeNode } from '@/sync/ops/workspaceFileSystem/directoryBrowsing';
import { workspaceFileSystemTargetFromScope } from '@/sync/ops/workspaceFileSystem/workspaceTarget';
import { readServerAccountScopeOwnerLifetime, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { tryBuildWorkspaceCacheKey, type WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { isSafeWorkspaceRelativePath } from '@/utils/path/isSafeWorkspaceRelativePath';
import { subscribeSessionMessageChanges } from '@/sync/store/sessionMessageChanges';
import { useSessionMessagesById } from '@/sync/store/hooks';
import { classifyGalleryFile, groupGalleryMedia, type GalleryMediaItem } from './galleryModel';

type Store = 'messages' | 'generated' | 'artifacts' | 'captures';
type Failure = Readonly<{ error: string; errorCode?: string }>;
type StoreSnapshot = Readonly<{ items: readonly GalleryMediaItem[]; truncated: boolean }>;
type PendingFolder = Readonly<{ id: string; name: string; path: string; modifiedMs?: number; store: Store }>;
type Recovery = Readonly<{
    pending: readonly PendingFolder[];
    loaded: ReadonlyMap<string, readonly GalleryMediaItem[]>;
    truncated: boolean;
    failure?: Failure;
}>;
type View = Readonly<{
    cache: Map<string, StoreSnapshot>;
    key: string;
    snapshot?: StoreSnapshot;
    failure?: Failure;
    recovery?: Recovery;
    loading: boolean;
}>;
const listingsByAccount = new WeakMap<ServerAccountScopeLifetime, Map<string, StoreSnapshot>>();

function readListingCache(lifetime: ServerAccountScopeLifetime): Map<string, StoreSnapshot> {
    const owner = readServerAccountScopeOwnerLifetime(lifetime);
    let cache = listingsByAccount.get(owner);
    if (!cache) {
        cache = new Map();
        listingsByAccount.set(owner, cache);
    }
    return cache;
}

function isPathSegment(name: string): boolean {
    return !name.includes('/') && isSafeWorkspaceRelativePath(name);
}

function filesInFolder(
    scope: WorkspaceScopeBase,
    store: Store,
    path: string,
    folder: string,
    files: readonly Readonly<{ name: string; type: string; size?: number; modified?: number }>[],
): GalleryMediaItem[] {
    return files.flatMap(file => {
        if (file.type !== 'file' || !isPathSegment(file.name)) return [];
        const item = classifyGalleryFile({ name: file.name, path: `${path}/${folder}/${file.name}`,
            sizeBytes: file.size, modifiedMs: file.modified }, scope, store, store === 'captures' ? undefined : folder);
        return item ? [item] : [];
    });
}

function projectTree(scope: WorkspaceScopeBase, store: Store, path: string, tree: WorkspaceTreeNode, truncated: boolean): StoreSnapshot {
    return {
        items: (tree.children ?? []).flatMap(node => node.type === 'directory' && isPathSegment(node.name)
            ? filesInFolder(scope, store, path, node.name, node.children ?? []) : []),
        truncated,
    };
}

function useStore(
    scope: WorkspaceScopeBase | null,
    store: Store,
    sessionId: string,
    lifetime: ServerAccountScopeLifetime | null,
    enabled: boolean,
    revision: number,
) {
    const cache = lifetime?.isCurrent() && scope && areServerProfileIdentifiersEquivalent(scope.serverId, lifetime.scope.serverId)
        ? readListingCache(lifetime) : null;
    const scopeKey = scope && tryBuildWorkspaceCacheKey(scope);
    // Composer attachments share the workspace's one messages root, one folder per message localId
    // (`resolveAttachmentTransferTarget`); generated and tool media are filed under the Session.
    const path = store === 'messages' ? '.happier/uploads/messages'
        : `.happier/uploads/${store === 'captures' ? 'artifacts' : store}/${sessionId}`;
    const key = scopeKey && sessionId ? JSON.stringify([scopeKey, path, store]) : null;
    const target = React.useMemo(() => scope ? workspaceFileSystemTargetFromScope(scope) : null,
        [scope?.serverId, scope?.machineId, scope?.rootPath, scope?.workspace]);
    const [view, setView] = React.useState<View | null>(null);
    const active = cache && view?.cache === cache && view.key === key ? view : null;
    const snapshot = active?.snapshot ?? (cache && key ? cache.get(key) : undefined);
    const operation = React.useRef<AbortController | null>(null);
    const busyRecovery = React.useRef<AbortSignal | null>(null);
    React.useEffect(() => {
        if (!enabled || !cache || !key || !target || !scope || !lifetime) return;
        const controller = new AbortController();
        operation.current = controller;
        const retirement = lifetime.onRetire(() => controller.abort());
        const last = cache.get(key);
        setView({ cache, key, snapshot: last, loading: true });
        void workspaceGetDirectoryTree(target, path, 2, { signal: controller.signal, accountId: lifetime.scope.accountId }).then(result => {
            if (controller.signal.aborted) return;
            if (result.success || result.errorCode === 'ENOENT') {
                const next = result.success ? projectTree(scope, store, path, result.tree, result.truncated === true)
                    : { items: [], truncated: false };
                cache.set(key, next);
                setView({ cache, key, snapshot: next, loading: false });
            } else {
                setView({ cache, key, snapshot: last, failure: result, loading: false });
            }
        });
        return () => { controller.abort(); retirement.dispose(); };
    }, [enabled, cache, key, target, path, store, revision, lifetime]);

    const recovery = active?.recovery;
    const runRecovery = async (folder?: PendingFolder) => {
        const signal = operation.current?.signal;
        if (!enabled || !active || !snapshot || !signal || signal.aborted || !target || !scope || busyRecovery.current === signal) return;
        busyRecovery.current = signal;
        const base: Recovery = recovery ?? { pending: [], loaded: new Map(), truncated: false };
        const result = await workspaceListDirectory(target, folder ? folder.path : path, { signal, accountId: lifetime?.scope.accountId });
        if (busyRecovery.current === signal) busyRecovery.current = null;
        if (signal.aborted) return;
        const update = (next: Recovery) => setView(current => current === active ? { ...active, recovery: next, failure: undefined } : current);
        if (!result.success && result.errorCode !== 'ENOENT') {
            // Discovery failures leave Load more available. Child failures leave that child pending.
            if (!recovery) setView(current => current === active ? { ...active, failure: result } : current);
            else update({ ...base, failure: result });
            return;
        }
        if (!folder && !result.success) {
            const empty = { items: EMPTY_ITEMS, truncated: false };
            cache?.set(active.key, empty);
            setView(current => current === active ? { ...active, snapshot: empty, failure: undefined } : current);
            return;
        }
        const entries = result.success ? result.entries : [];
        const truncated = result.success && result.truncated === true;
        if (!folder) {
            const pending = entries.filter(entry => entry.type === 'directory' && isPathSegment(entry.name)).map(entry => ({
                id: JSON.stringify([store, path, entry.name]), path: `${path}/${entry.name}`, name: entry.name, modifiedMs: entry.modified, store,
            }));
            update({ ...base, pending, truncated });
            return;
        }
        const loaded = new Map(base.loaded);
        const items = filesInFolder(scope, store, path, folder.name, entries);
        if (truncated) {
            // A one-level result can itself hit its cap. Keep every known file from that folder.
            const known = new Map(snapshot.items.filter(item => item.path.startsWith(`${folder.path}/`)).map(item => [item.id, item]));
            for (const item of items) known.set(item.id, item);
            loaded.set(folder.path, [...known.values()]);
        } else loaded.set(folder.path, items);
        update({ pending: base.pending.filter(candidate => candidate.id !== folder.id), loaded, truncated: base.truncated || truncated });
    };

    const items = React.useMemo(() => {
        if (!snapshot || !recovery?.loaded.size) return snapshot?.items ?? EMPTY_ITEMS;
        const retained = snapshot.items.filter(item => !recovery.loaded.has(item.path.slice(0, item.path.lastIndexOf('/'))));
        return retained.concat(...recovery.loaded.values());
    }, [snapshot, recovery?.loaded]);
    const pending = recovery?.pending ?? EMPTY_FOLDERS;
    return {
        items, pending,
        incomplete: recovery ? recovery.truncated || pending.length > 0 : snapshot?.truncated === true,
        hasSnapshot: snapshot !== undefined,
        loading: Boolean(enabled && cache && key && (!active || active.loading)),
        failure: active?.failure ?? recovery?.failure,
        loadMore: enabled && active && !active.loading && snapshot?.truncated && !recovery ? () => runRecovery() : null,
        loadFolder: (id: string) => {
            const folder = pending.find(candidate => candidate.id === id);
            return folder ? runRecovery(folder) : undefined;
        },
    };
}

const EMPTY_ITEMS: readonly GalleryMediaItem[] = [];
const EMPTY_FOLDERS: readonly PendingFolder[] = [];

export function useSessionMediaModel(input: Readonly<{
    /** Exact session workspace and the optional daemon root from resolveStoredImageReadScope. */
    scope: WorkspaceScopeBase | null;
    captureScope: WorkspaceScopeBase | null;
    sessionId: string;
    enabled: boolean;
    online: boolean;
    lifetime: ServerAccountScopeLifetime | null;
}>) {
    const { scope, captureScope, enabled, online, lifetime } = input;
    const id = input.sessionId.trim();
    const sessionId = isPathSegment(id) ? id : '';
    const active = Boolean(enabled && online && sessionId);
    const owner = lifetime && readServerAccountScopeOwnerLifetime(lifetime);
    const [revision, refresh] = React.useReducer(value => value + 1, 0);
    React.useEffect(() => {
        if (!active || !owner || !scope || !areServerProfileIdentifiersEquivalent(scope.serverId, owner.scope.serverId)) return;
        // The existing transcript publisher supplies a delta. Ordinary text changes require no listing.
        return subscribeSessionMessageChanges(sessionId, event => {
            // Generated media arrive with their message's media meta; a sent message's attachments are filed under its
            // localId, so its first arrival is the moment its folder exists.
            if (event.kind === 'updated' && event.changes.some(({ previous, next }) => (!previous && next.localId)
                || (next.meta !== previous?.meta && readTranscriptSessionMediaMeta(next.meta)?.inlineMedia.length))) refresh();
        });
    }, [active, owner, sessionId, scope?.serverId]);
    const listedMessages = useStore(scope, 'messages', sessionId, lifetime, active, revision);
    // Another Session in the same folder files its attachments beside these: keep the folders named by this
    // Session's own message localIds (the transcript held on this device).
    const messagesById = useSessionMessagesById(sessionId, active, { textUpdates: false });
    const localIds = React.useMemo(() => {
        const ids = new Set<string>();
        for (const message of Object.values(messagesById)) if (message.localId) ids.add(message.localId);
        return ids;
    }, [messagesById]);
    const messageItems = React.useMemo(() => listedMessages.items.filter(item => item.messageLocalId !== undefined
        && localIds.has(item.messageLocalId)), [listedMessages.items, localIds]);
    const messagePending = React.useMemo(() => listedMessages.pending.filter(folder => localIds.has(folder.name)),
        [listedMessages.pending, localIds]);
    const messages = { ...listedMessages, items: messageItems, pending: messagePending };
    const generated = useStore(scope, 'generated', sessionId, lifetime, active, revision);
    const artifacts = useStore(scope, 'artifacts', sessionId, lifetime, active, revision);
    const captures = useStore(captureScope, 'captures', sessionId, lifetime, active, revision);
    const gallery = React.useMemo(() => groupGalleryMedia([...messages.items, ...generated.items, ...artifacts.items, ...captures.items]),
        [messages.items, generated.items, artifacts.items, captures.items]);
    const stores = { messages, generated, artifacts, captures };
    const results = Object.values(stores);
    const pendingFolders = React.useMemo(() => [...messages.pending, ...generated.pending, ...artifacts.pending, ...captures.pending]
        .sort((a, b) => (b.modifiedMs ?? -Infinity) - (a.modifiedMs ?? -Infinity) || a.name.localeCompare(b.name)),
    [messages.pending, generated.pending, artifacts.pending, captures.pending]);
    const expand = results.flatMap(result => result.loadMore ? [result.loadMore] : []);
    return {
        ...gallery, pendingFolders, refresh,
        incomplete: results.some(result => result.incomplete),
        loading: results.some(result => result.loading),
        stale: !online && results.some(result => result.hasSnapshot),
        failures: (Object.keys(stores) as Store[]).flatMap(store => {
            const failure = stores[store].failure;
            return failure ? [{ store, ...failure }] : [];
        }),
        captureScopeAvailable: captureScope !== null,
        loadMore: active && expand.length ? async () => { await Promise.all(expand.map(load => load())); } : null,
        loadFolder: (folderId: string) => {
            const folder = pendingFolders.find(candidate => candidate.id === folderId);
            return folder ? stores[folder.store].loadFolder(folderId) : undefined;
        },
    };
}
