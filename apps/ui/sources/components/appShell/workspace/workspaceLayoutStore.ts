import { randomUUID } from '@/platform/randomUUID';
import { getPersistenceStorage, subscribePersistenceStorageCleared } from '@/sync/domains/state/persistenceStorage';
import { UiStatePersistenceError } from '@/sync/domains/state/persistentUiState';

/*
 * Device storage for workspace layouts, one layout per scope key, split so a save
 * writes only what changed:
 * - head: focus, each group's active tab, and a revision. Every change rewrites it.
 * - frame: tab key order, group membership, split tree, maximized group, tab pairs.
 *   Only structural changes rewrite it.
 * - one entry per tab: the tab, its fallback title and its MRU recency rank.
 * A tab switch writes the head plus the activated tab's rank; at a thousand tabs the
 * earlier single blob rewrote ~400 KB per switch.
 *
 * The head keeps the earlier single-blob key, so the first save replaces those bytes
 * in place. Those blobs are never-released 0.3 data and read as "no layout".
 */
const HEAD = 'ui-state:workspace-layouts-v1:';
const FRAME = 'ui-state:workspace-layout-frame:';
const TAB = 'ui-state:workspace-layout-tab:';
// Web storage keys cannot contain a backslash; encoded parts are self-delimiting.
const tabPrefix = (scope: string) => `${TAB}${encodeURIComponent(scope)}:`;
const tabKey = (scope: string, tabId: string) => tabPrefix(scope) + encodeURIComponent(tabId);

type Group = Readonly<{ tabIds: readonly string[]; activeTabId: unknown; mru: readonly string[] }>;
type LayoutParts = Readonly<{
    tabs: Readonly<Record<string, unknown>>;
    groups: Readonly<Record<string, Group>>;
    titles: Readonly<Record<string, unknown>>;
    root: unknown;
    focusedGroupId: unknown;
    maximizedGroupId: unknown;
    tabPairs: unknown;
}>;
type TabRecord = Readonly<{ tab: unknown; title: string | undefined; rank: number | undefined; json: string }>;
/** What this realm last wrote or read for a scope; the head revision tells whether another realm wrote since. */
type Mirror = {
    head: string | undefined;
    body: string;
    frame: string;
    frameInputs: readonly unknown[] | null;
    tabs: Map<string, TabRecord>;
    mru: Map<string, readonly string[]>;
};

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function strings(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

function layoutParts(value: unknown): LayoutParts {
    const layout = record(value);
    const tabs = record(layout?.tabs);
    const groups = record(layout?.groups);
    const titles = layout?.fallbackTitlesByTabId === undefined ? {} : record(layout.fallbackTitlesByTabId);
    if (!layout || !tabs || !groups || !titles || Object.values(groups).some(group => {
        const candidate = record(group);
        return !candidate || !strings(candidate.tabIds) || !strings(candidate.mru);
    })) throw new TypeError('A workspace layout must have tabs and groups');
    return { tabs, groups: groups as Record<string, Group>, titles, root: layout.root,
        focusedGroupId: layout.focusedGroupId, maximizedGroupId: layout.maximizedGroupId, tabPairs: layout.tabPairs };
}

function parseJson(raw: string | undefined): unknown {
    if (raw === undefined) return undefined;
    try { return JSON.parse(raw); } catch { return null; }
}

function emptyMirror(head: string | undefined): Mirror {
    return { head, body: '', frame: '', frameInputs: null, tabs: new Map(), mru: new Map() };
}

type Storage = ReturnType<typeof getPersistenceStorage>;

/** Reads every part of a scope from storage: the assembled layout (undefined without a split head) and its mirror. */
function load(storage: Storage, scope: string): Readonly<{ value: unknown; mirror: Mirror }> {
    const head = storage.getString(HEAD + scope);
    const parsedHead = record(parseJson(head));
    if (!parsedHead || parsedHead.v !== 2) return { value: undefined, mirror: emptyMirror(head) };
    const prefix = tabPrefix(scope);
    const mirror = emptyMirror(head);
    mirror.body = JSON.stringify({ focusedGroupId: parsedHead.focusedGroupId, active: parsedHead.active });
    for (const key of storage.getAllKeys()) {
        if (!key.startsWith(prefix)) continue;
        const raw = storage.getString(key);
        const entry = record(parseJson(raw));
        if (!entry || raw === undefined) continue;
        mirror.tabs.set(decodeURIComponent(key.slice(prefix.length)), {
            tab: entry.tab, title: typeof entry.title === 'string' ? entry.title : undefined,
            rank: typeof entry.r === 'number' ? entry.r : undefined, json: raw,
        });
    }
    const frameRaw = storage.getString(FRAME + scope);
    const frame = record(parseJson(frameRaw));
    const groups = record(frame?.groups);
    const active = record(parsedHead.active);
    if (!frame || frameRaw === undefined || !groups || !active || !strings(frame.tabs)) return { value: null, mirror };
    mirror.frame = frameRaw;
    const tabs: Record<string, unknown> = {};
    const titles: Record<string, string> = {};
    for (const id of frame.tabs) {
        const entry = mirror.tabs.get(id);
        // A missing entry leaves the membership check to the layout reader, which then rejects it.
        if (!entry) continue;
        tabs[id] = entry.tab;
        if (entry.title !== undefined) titles[id] = entry.title;
    }
    const assembled: Record<string, unknown> = {};
    for (const [id, tabIds] of Object.entries(groups)) {
        if (!strings(tabIds)) return { value: null, mirror };
        const mru = tabIds.flatMap(tabId => {
            const rank = mirror.tabs.get(tabId)?.rank;
            return rank === undefined ? [] : [{ tabId, rank }];
        }).sort((a, b) => b.rank - a.rank).map(entry => entry.tabId);
        assembled[id] = { id, tabIds, activeTabId: active[id], mru };
    }
    return { value: {
        v: 1, tabs, groups: assembled, root: frame.root, focusedGroupId: parsedHead.focusedGroupId,
        maximizedGroupId: frame.maximizedGroupId, fallbackTitlesByTabId: titles, tabPairs: frame.tabPairs,
    }, mirror };
}

/**
 * Recency ranks that keep every stored rank still in order, scanning from the least recent tab.
 * Moving a tab to the front gives it the next rank and leaves the others as they are.
 */
function rankRecency(mru: readonly string[], previous: ReadonlyMap<string, TabRecord>, ranks: Map<string, number>): void {
    let floor = 0;
    for (let index = mru.length - 1; index >= 0; index -= 1) {
        const stored = previous.get(mru[index])?.rank;
        const rank = stored !== undefined && stored > floor ? stored : floor + 1;
        ranks.set(mru[index], rank);
        floor = rank;
    }
}

export function createWorkspaceLayoutStore() {
    const values = new Map<string, unknown>();
    const loaded = new Set<string>();
    const mirrors = new Map<string, Mirror>();
    let snapshot: Readonly<Record<string, unknown>> | undefined;
    let allLoaded = false;
    const listeners = new Set<() => void>();
    const keyedListeners = new Map<string, Set<() => void>>();
    subscribePersistenceStorageCleared(() => {
        const previous = new Set(values.keys());
        values.clear();
        loaded.clear();
        mirrors.clear();
        snapshot = undefined;
        allLoaded = false;
        for (const listener of listeners) listener();
        for (const [key, subscriptions] of keyedListeners) if (previous.has(key)) for (const listener of subscriptions) listener();
    });
    const publish = (key: string) => {
        snapshot = undefined;
        for (const listener of listeners) listener();
        for (const listener of keyedListeners.get(key) ?? []) listener();
    };
    const readStrict = (key: string, admission?: (value: unknown) => unknown): unknown => {
        try {
            // Admission inspects the stored layout itself, never this realm's cached copy.
            if (admission) {
                const { value } = load(getPersistenceStorage(), key);
                return value === undefined ? undefined : admission(value);
            }
            if (!loaded.has(key)) {
                const { value, mirror } = load(getPersistenceStorage(), key);
                if (value !== undefined) {
                    values.set(key, value);
                    snapshot = undefined;
                }
                mirrors.set(key, mirror);
                loaded.add(key);
            }
        } catch (error) {
            throw error instanceof UiStatePersistenceError ? error : new UiStatePersistenceError(error);
        }
        return values.get(key);
    };
    const read = (key: string): unknown => {
        try { return readStrict(key); } catch (error) {
            if (!(error instanceof UiStatePersistenceError)) throw error;
            console.warn('[ui-state] Device state could not be read.');
            return undefined;
        }
    };
    const readAll = (): Readonly<Record<string, unknown>> => {
        if (!allLoaded) {
            let keys: string[];
            try { keys = getPersistenceStorage().getAllKeys(); } catch {
                console.warn('[ui-state] Device state could not be read.');
                return snapshot ??= Object.fromEntries(values);
            }
            for (const key of keys) if (key.startsWith(HEAD)) read(key.slice(HEAD.length));
            allLoaded = true;
        }
        return snapshot ??= Object.fromEntries(values);
    };
    const set = (key: string, value: unknown): void => {
        const parts = layoutParts(value);
        const storage = getPersistenceStorage();
        try {
            let mirror = mirrors.get(key);
            const head = storage.getString(HEAD + key);
            // Another window may have saved this scope; its head revision differs from ours.
            if (!mirror || mirror.head !== head) mirror = load(storage, key).mirror;

            const ranks = new Map<string, number>();
            for (const [groupId, group] of Object.entries(parts.groups)) {
                if (mirror.mru.get(groupId) === group.mru) {
                    for (const id of group.mru) {
                        const rank = mirror.tabs.get(id)?.rank;
                        if (rank !== undefined) ranks.set(id, rank);
                    }
                } else rankRecency(group.mru, mirror.tabs, ranks);
            }
            const writes: [string, string][] = [];
            const tabs = new Map<string, TabRecord>();
            for (const [id, tab] of Object.entries(parts.tabs)) {
                const title = typeof parts.titles[id] === 'string' ? parts.titles[id] as string : undefined;
                const rank = ranks.get(id);
                const previous = mirror.tabs.get(id);
                if (previous && previous.tab === tab && previous.title === title && previous.rank === rank) {
                    tabs.set(id, previous);
                    continue;
                }
                const json = JSON.stringify({ tab, ...(title === undefined ? {} : { title }), ...(rank === undefined ? {} : { r: rank }) });
                tabs.set(id, { tab, title, rank, json });
                if (previous?.json !== json) writes.push([tabKey(key, id), json]);
            }
            const removed = [...mirror.tabs.keys()].filter(id => !tabs.has(id));

            const groupEntries = Object.entries(parts.groups);
            const frameInputs = [parts.tabs, parts.root, parts.maximizedGroupId, parts.tabPairs,
                ...groupEntries.flatMap(([id, group]) => [id, group.tabIds])];
            const sameFrame = mirror.frameInputs !== null && mirror.frameInputs.length === frameInputs.length
                && frameInputs.every((input, index) => Object.is(input, mirror!.frameInputs![index]));
            const frame = sameFrame ? mirror.frame : JSON.stringify({
                tabs: Object.keys(parts.tabs),
                groups: Object.fromEntries(groupEntries.map(([id, group]) => [id, group.tabIds])),
                root: parts.root, maximizedGroupId: parts.maximizedGroupId, tabPairs: parts.tabPairs,
            });
            const active = Object.fromEntries(groupEntries.map(([id, group]) => [id, group.activeTabId]));
            const body = JSON.stringify({ focusedGroupId: parts.focusedGroupId, active });
            if (!writes.length && !removed.length && frame === mirror.frame && body === mirror.body) {
                mirror.frameInputs = frameInputs;
                for (const [groupId, group] of groupEntries) mirror.mru.set(groupId, group.mru);
                mirrors.set(key, mirror);
                return;
            }
            const nextHead = JSON.stringify({ v: 2, rev: randomUUID(), focusedGroupId: parts.focusedGroupId, active });
            // Parts first and the head last, so a reader that sees the new head finds its parts.
            mirrors.delete(key);
            for (const [entryKey, json] of writes) storage.set(entryKey, json);
            if (frame !== mirror.frame) storage.set(FRAME + key, frame);
            storage.set(HEAD + key, nextHead);
            for (const id of removed) storage.delete(tabKey(key, id));
            mirrors.set(key, { head: nextHead, body, frame, frameInputs, tabs,
                mru: new Map(groupEntries.map(([id, group]) => [id, group.mru])) });
        } catch (error) {
            // A refused write may have stored some parts: the next save reloads them before diffing.
            mirrors.delete(key);
            throw new UiStatePersistenceError(error);
        }
        values.set(key, value);
        loaded.add(key);
        publish(key);
    };
    const remove = (key: string): void => {
        read(key);
        const storage = getPersistenceStorage();
        try {
            const prefix = tabPrefix(key);
            const stored = storage.getAllKeys().filter(entry => entry === HEAD + key || entry === FRAME + key || entry.startsWith(prefix));
            if (!stored.length && !values.has(key)) return;
            for (const entry of stored) storage.delete(entry);
        } catch (error) { throw new UiStatePersistenceError(error); }
        mirrors.delete(key);
        values.delete(key);
        publish(key);
    };
    const subscribeKey = (key: string, listener: () => void) => {
        let subscriptions = keyedListeners.get(key);
        if (!subscriptions) keyedListeners.set(key, subscriptions = new Set());
        subscriptions.add(listener);
        return () => {
            subscriptions.delete(listener);
            if (!subscriptions.size) keyedListeners.delete(key);
        };
    };
    return {
        readAll,
        read,
        readStrict,
        set,
        remove,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        subscribeKey,
    };
}
