import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionListIndexNodeId } from '@/sync/domains/sessionList/sessionListIndexIdentity';
import { normalizeSessionListKeyParts } from './sessionListKeyNormalization';

type SessionItem = Extract<SessionListIndexItem, { type: 'session' }>;
type Group = {
    key: string | undefined;
    headers: SessionListIndexItem[];
    ordinary: SessionListIndexItem[];
    supplemental: SessionItem[];
    ordered: SessionListIndexItem[];
};

function sessionKey(item: SessionItem): string | null {
    return normalizeSessionListKeyParts(item.serverId, item.sessionId, item.keyParts).sessionKey;
}

/** Retain only presentation metadata; the current admitted index supplies every row. */
export function reconcileSupplementalSessionListAttention(params: Readonly<{
    source: readonly SessionListIndexItem[];
    supplementalKeys: ReadonlySet<string>;
    previousPresentedIndex?: readonly SessionListIndexItem[] | null;
    holdMembership: boolean;
}>): SessionListIndexItem[] {
    const groups = new Map<string | undefined, Group>();
    const getGroup = (key: string | undefined) => {
        let group = groups.get(key);
        if (!group) {
            group = { key, headers: [], ordinary: [], supplemental: [], ordered: [] };
            groups.set(key, group);
        }
        return group;
    };
    const currentByKey = new Map<string, SessionItem>();
    const previousByKey = new Map<string, SessionItem>();
    const previousHeaders = new Map<string | undefined, SessionListIndexItem[]>();
    const previousItems = new Map<string | undefined, SessionListIndexItem[]>();
    const previousGroupOrder: (string | undefined)[] = [];
    const previousGroupKeys = new Set<string | undefined>();
    const previousRenderedGroups = new Set<string | undefined>();
    for (const item of params.previousPresentedIndex ?? []) {
        previousRenderedGroups.add(item.groupKey);
        if (item.type === 'header') {
            const headers = previousHeaders.get(item.groupKey) ?? [];
            headers.push(item);
            previousHeaders.set(item.groupKey, headers);
            continue;
        }
        const items = previousItems.get(item.groupKey) ?? [];
        items.push(item);
        previousItems.set(item.groupKey, items);
        if (item.type !== 'session') continue;
        const key = sessionKey(item);
        if (!key || !params.supplementalKeys.has(key)) continue;
        previousByKey.set(key, item);
        if (!previousGroupKeys.has(item.groupKey)) {
            previousGroupKeys.add(item.groupKey);
            previousGroupOrder.push(item.groupKey);
        }
    }
    for (const item of params.source) {
        const group = getGroup(item.groupKey);
        if (item.type === 'header') {
            group.headers.push(item);
        } else if (item.type === 'session') {
            group.ordered.push(item);
            const key = sessionKey(item);
            if (key && params.supplementalKeys.has(key)) currentByKey.set(key, item);
            else group.ordinary.push(item);
        } else {
            group.ordinary.push(item);
            group.ordered.push(item);
        }
    }
    const placed = new Set<string>();
    const append = (key: string, item: SessionItem) => {
        getGroup(item.groupKey).supplemental.push(item);
        placed.add(key);
    };
    for (const [key, previous] of previousByKey) {
        const current = currentByKey.get(key);
        if (!current) continue; // Current authorization always outranks a hold.
        if (params.holdMembership) {
            const group = getGroup(previous.groupKey);
            if (group.headers.length === 0) group.headers = previousHeaders.get(previous.groupKey) ?? [];
            append(key, { ...current, groupKey: previous.groupKey, groupKind: previous.groupKind,
                folderDepth: previous.folderDepth, reportsDepth: previous.reportsDepth });
        } else append(key, current);
    }
    if (!params.holdMembership) {
        for (const [key, item] of currentByKey) if (!placed.has(key)) append(key, item);
    }
    const ownGroups = [...groups.values()].filter(group => group.ordinary.length > 0
        || (group.ordered.length === 0 && group.supplemental.length === 0
            && group.headers.some(item => item.type === 'header' && item.headerKind === 'folder')));
    const ownGroupKeys = new Set(ownGroups.map(group => group.key));
    const pendingGroups = new Map([...groups.values()]
        .filter(group => group.supplemental.length > 0 && !ownGroupKeys.has(group.key))
        .map(group => [group.key, group]));
    const supplementalGroups: Group[] = [];
    for (const key of previousGroupOrder) {
        const group = pendingGroups.get(key);
        if (!group) continue;
        supplementalGroups.push(group);
        pendingGroups.delete(key);
    }
    supplementalGroups.push(...pendingGroups.values());
    let presentedGroups = [...ownGroups, ...supplementalGroups];
    if (params.holdMembership) {
        const pending = new Map(presentedGroups.map(group => [group.key, group]));
        presentedGroups = [];
        for (const key of previousRenderedGroups) {
            const group = pending.get(key);
            if (!group) continue;
            presentedGroups.push(group);
            pending.delete(key);
        }
        presentedGroups.push(...pending.values());
    }
    return presentedGroups.flatMap(group => {
        const byId = new Map([...group.ordinary, ...group.supplemental].map(item => [buildSessionListIndexNodeId(item), item]));
        const items: SessionListIndexItem[] = [];
        const take = (item: SessionListIndexItem) => {
            const id = buildSessionListIndexNodeId(item);
            const current = byId.get(id);
            if (!current) return;
            items.push(current);
            byId.delete(id);
        };
        if (params.holdMembership) {
            for (const item of previousItems.get(group.key) ?? []) take(item);
            for (const item of group.ordered) take(item);
        } else {
            // A visible lead's whole tree is one placement. A supplemental child
            // cannot be appended away from an ordinary lead, nor can a child of
            // a supplemental lead be emitted before that lead.
            const supplementalTrees = new Map<string, SessionListIndexItem[]>();
            let outsideRoot: string | null = null;
            for (const item of group.ordered) {
                if ((item.type === 'header' ? 0 : item.reportsDepth ?? 0) === 0) {
                    const key = item.type === 'session' ? sessionKey(item) : null;
                    outsideRoot = key && params.supplementalKeys.has(key) ? key : null;
                }
                if (outsideRoot) {
                    const tree = supplementalTrees.get(outsideRoot) ?? [];
                    tree.push(item);
                    supplementalTrees.set(outsideRoot, tree);
                } else take(item);
            }
            for (const item of group.supplemental) {
                const tree = supplementalTrees.get(sessionKey(item) ?? '');
                if (tree) for (const member of tree) take(member);
            }
        }
        for (const item of byId.values()) items.push(item);
        return [...group.headers, ...items];
    });
}
