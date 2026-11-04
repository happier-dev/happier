import type { CollectionGroupRollup } from '@happier-dev/plugin-ui/components';
import { inboxItemViewV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { readWorkStatusPresentationRank } from '@/components/work/status/workStatusRank';
import { isSessionListPrimaryHeaderKind } from '@/components/sessions/shell/sessionListPrimaryHeader';
import { areSessionListGroupRollupsEqual, areSessionListIndexItemsEqual, type SessionListIndexItem } from './sessionListIndex';
import { buildSessionListIndexEntityId, buildSessionListIndexNodeId } from './sessionListIndexIdentity';

export type SessionListGroupSubject = Readonly<{
    status: CollectionGroupRollup['status'];
    coverage: CollectionGroupRollup['coverage'];
}>;

/** Retained by the incumbent visible-membership projection, never a second store or ledger. */
export type SessionListIndexGroupRollupProjection = Readonly<{
    sourceItems: readonly SessionListIndexItem[];
    items: SessionListIndexItem[];
    coverage: CollectionGroupRollup['coverage'];
    memberKeysByHeaderId: ReadonlyMap<string, readonly string[]>;
    headerIndicesById: ReadonlyMap<string, number>;
    headerIdsBySubjectKey: ReadonlyMap<string, ReadonlySet<string>>;
    rollupsByHeaderId: ReadonlyMap<string, CollectionGroupRollup>;
}>;

/** Aggregate admitted entity keys, never visible occurrences or coordinator child subtraction. */
export function projectSessionListIndexGroupRollups(input: Readonly<{
    items: readonly SessionListIndexItem[];
    subjects: ReadonlyMap<string, SessionListGroupSubject>;
    previous?: SessionListIndexGroupRollupProjection;
    changedSubjectKeys?: readonly string[];
    coverage?: CollectionGroupRollup['coverage'];
}>): SessionListIndexGroupRollupProjection {
    const previous = input.previous;
    const coverage = input.coverage ?? 'complete';
    let memberKeysByHeaderId = previous?.memberKeysByHeaderId;
    let headerIdsBySubjectKey = previous?.headerIdsBySubjectKey;
    let headerIndicesById = previous?.headerIndicesById;
    const affectedHeaderIds = new Set<string>();
    // Only the identical immutable arrangement proves the cached header positions
    // and memberships. A new array takes a structural pass, without rereading statuses.
    if (!previous || (input.items !== previous.items && input.items !== previous.sourceItems)) {
        const members = new Map<string, Set<string>>();
        const headersBySubject = new Map<string, Set<string>>();
        let serverHeaderId: string | null = null;
        let primaryHeaderId: string | null = null;
        let primaryBandIsFlat = false;
        let groupHeaderId: string | null = null;
        let currentHeaderIds: readonly string[] = [];
        const folderHeaders: Array<Readonly<{ id: string; depth: number }>> = [];
        const headersByGroupKey = new Map<string, readonly string[]>();
        const headerIndices = new Map<string, number>();
        for (let index = 0; index < input.items.length; index += 1) {
            const item = input.items[index]!;
            if (item.type === 'header') {
                const id = buildSessionListIndexNodeId(item);
                members.set(id, new Set());
                headerIndices.set(id, index);
                // Flat attention/Working/pin bands end at the next group. They
                // are not an ancestor of the Project/date/folder that follows.
                if (primaryBandIsFlat && !isSessionListPrimaryHeaderKind(item.headerKind)) {
                    primaryHeaderId = null;
                    primaryBandIsFlat = false;
                }
                // These are the same primary bands whose disclosure owns following subgroups.
                if (item.headerKind === 'server') {
                    serverHeaderId = id;
                    primaryHeaderId = null;
                    primaryBandIsFlat = false;
                    groupHeaderId = null;
                    folderHeaders.length = 0;
                    currentHeaderIds = [id];
                } else if (isSessionListPrimaryHeaderKind(item.headerKind)) {
                    primaryHeaderId = id;
                    primaryBandIsFlat = item.headerKind === 'attention' || item.headerKind === 'working' || item.headerKind === 'pinned';
                    groupHeaderId = null;
                    folderHeaders.length = 0;
                    currentHeaderIds = [...(serverHeaderId ? [serverHeaderId] : []), id];
                } else if (item.headerKind === 'folder') {
                    const depth = item.folderDepth ?? 0;
                    while (folderHeaders.length && folderHeaders[folderHeaders.length - 1]!.depth >= depth) folderHeaders.pop();
                    currentHeaderIds = [...(serverHeaderId ? [serverHeaderId] : []), ...(primaryHeaderId ? [primaryHeaderId] : []),
                        ...(groupHeaderId ? [groupHeaderId] : []), ...folderHeaders.map(folder => folder.id), id];
                    folderHeaders.push({ id, depth });
                } else {
                    groupHeaderId = id;
                    folderHeaders.length = 0;
                    currentHeaderIds = [...(serverHeaderId ? [serverHeaderId] : []), ...(primaryHeaderId ? [primaryHeaderId] : []), id];
                }
                if (item.groupKey) headersByGroupKey.set(item.groupKey, currentHeaderIds);
                continue;
            }
            const key = buildSessionListIndexEntityId(item);
            const headers = headersBySubject.get(key) ?? new Set<string>();
            // Folder owners emit parent rows after descendant folders. The row's admitted
            // group key, rather than the nearest preceding header, identifies its ancestors.
            const owners = item.groupKey ? headersByGroupKey.get(item.groupKey) : undefined;
            const headerIds = owners ?? (item.groupKind === 'folder' && groupHeaderId
                ? [...(serverHeaderId ? [serverHeaderId] : []), ...(primaryHeaderId ? [primaryHeaderId] : []), groupHeaderId] : currentHeaderIds);
            for (const id of headerIds) {
                members.get(id)?.add(key);
                headers.add(id);
            }
            headersBySubject.set(key, headers);
        }
        const nextMembers = new Map<string, readonly string[]>();
        for (const [id, keys] of members) {
            const oldKeys = previous?.memberKeysByHeaderId.get(id);
            const nextKeys = [...keys];
            const unchanged = oldKeys?.length === nextKeys.length && nextKeys.every((key, index) => key === oldKeys[index]);
            nextMembers.set(id, unchanged ? oldKeys : nextKeys);
            if (!unchanged) affectedHeaderIds.add(id);
        }
        memberKeysByHeaderId = nextMembers;
        headerIdsBySubjectKey = headersBySubject;
        headerIndicesById = headerIndices;
    }
    // A query coverage transition changes every header's claim even without a payload change.
    if (!previous || input.changedSubjectKeys === undefined || previous.coverage !== coverage) {
        for (const id of memberKeysByHeaderId!.keys()) affectedHeaderIds.add(id);
    } else {
        for (const key of input.changedSubjectKeys) {
            for (const id of headerIdsBySubjectKey!.get(key) ?? []) affectedHeaderIds.add(id);
        }
    }
    const rollups = new Map<string, CollectionGroupRollup>();
    for (const [id, keys] of memberKeysByHeaderId!) {
        const previousRollup = previous?.rollupsByHeaderId.get(id);
        if (!affectedHeaderIds.has(id) && previousRollup) { rollups.set(id, previousRollup); continue; }
        let status: CollectionGroupRollup['status'] = null;
        let knownCount = 0;
        let needsYouCount = 0;
        let incomplete = coverage !== 'complete';
        for (const key of keys) {
            const subject = input.subjects.get(key);
            if (subject?.coverage !== 'complete') incomplete = true;
            if (!subject || subject.coverage === 'unavailable') continue;
            knownCount += 1;
            const candidate = subject.status;
            if (candidate && (!status || readWorkStatusPresentationRank(candidate) > readWorkStatusPresentationRank(status))) status = candidate;
            if (candidate?.attentionType && inboxItemViewV1(candidate.attentionType) === 'needs_you') needsYouCount += 1;
        }
        const unavailable = coverage === 'unavailable' || (keys.length > 0 && knownCount === 0);
        const rollup: CollectionGroupRollup = { status, needsYouCount: unavailable ? null : needsYouCount,
            coverage: unavailable ? 'unavailable' : incomplete ? 'partial' : 'complete' };
        rollups.set(id, areSessionListGroupRollupsEqual(previousRollup, rollup) ? previousRollup! : rollup);
    }
    let items = input.items as SessionListIndexItem[];
    for (const [id, index] of headerIndicesById!) {
        const item = input.items[index];
        if (!item || item.type !== 'header') throw new Error('Session group membership no longer matches its header positions');
        const rollup = rollups.get(id)!;
        const candidate = item.rollup === rollup ? item : { ...item, rollup };
        const previousIndex = previous?.headerIndicesById.get(id);
        const oldHeader = previousIndex === undefined ? undefined : previous?.items[previousIndex];
        const next = oldHeader && areSessionListIndexItemsEqual(oldHeader, candidate) ? oldHeader : candidate;
        if (next !== item) {
            if (items === input.items) items = input.items.slice();
            items[index] = next;
        }
    }
    return { sourceItems: input.items, items, coverage,
        memberKeysByHeaderId: memberKeysByHeaderId!, headerIndicesById: headerIndicesById!,
        headerIdsBySubjectKey: headerIdsBySubjectKey!, rollupsByHeaderId: rollups };
}
