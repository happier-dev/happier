import { describe, expect, it } from 'vitest';

import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionListIndexNodeId } from '@/sync/domains/sessionList/sessionListIndex';
import { filterCollapsedSessionListItems } from '@/components/sessions/shell/filterCollapsedSessionListItems';
import { sessionAddressKey } from '../sessionAddress';
import { buildSessionSectionGroupKey, projectSessionSectionListIndex, type SessionSection } from '../organization/sections';
import { computeVisibleSessionListIndex, computeVisibleSessionListProjection, type ComputeVisibleSessionListIndexParams } from './computeVisibleSessionListIndex';

describe('supplied out-of-space attention placement', () => {
    const key = (sessionId: string) => sessionAddressKey({ serverId: 's1', sessionId });
    const sourceFor = (groups: readonly (readonly [string, readonly string[]])[]): SessionListIndexItem[] => groups.flatMap(([groupKey, ids]) => [
        { type: 'header', headerKind: 'project', title: groupKey, groupKey, serverId: 's1' } as const,
        ...ids.map(sessionId => ({ type: 'session', serverId: 's1', sessionId, groupKey, groupKind: 'project' } as const)),
    ]);
    const rows = new Map(['own', 'outside', 'later', 'quiet', 'working'].map(id => [id, createSessionListRenderableSessionFixture({
        id, active: true, activeAt: 1_000_000, projectKey: id === 'own' ? 'own-project' : 'outside-project',
        canApprovePermissions: true, hasPendingPermissionRequests: id !== 'quiet' && id !== 'working',
        hasUnreadMessages: false, thinking: id === 'working',
    })]));
    const base: ComputeVisibleSessionListIndexParams = {
        source: sourceFor([['outside-group', ['outside', 'quiet', 'working']], ['own-group', ['own']]]),
        resolveSessionRow: (_serverId, sessionId) => rows.get(sessionId) ?? null,
        workFilter: normalizeSessionListFilterV1({ homeServerIds: ['s1'], show: 'sessions',
            projects: { include: [{ serverId: 's1', projectKey: 'own-project' }], exclude: [] } }),
        hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
        presentation: { enabled: false, presentation: 'grouped' }, nowMs: 1_000_000,
    };
    const sessions = (items: readonly SessionListIndexItem[] | null) => items?.filter(item => item.type === 'session');
    const ids = (items: readonly SessionListIndexItem[] | null) => sessions(items)?.map(item => item.sessionId);
    const groups = (items: readonly SessionListIndexItem[] | null) => items?.flatMap(item => item.type === 'header' ? [item.groupKey] : []);

    it.each(['both', 'top'] as const)('%s gives a supplemental entity only a Needs-you occurrence', placement => {
        const result = computeVisibleSessionListIndex({ ...base, sessionListAttentionPlacementV1: placement,
            supplementalNeedsYouSessionKeys: new Set([key('outside')]) });
        expect(sessions(result)?.filter(item => item.sessionId === 'outside').map(item => item.occurrenceRole)).toEqual(['needsYou']);
        expect(ids(result)).not.toContain('quiet');
        expect(ids(result)).not.toContain('working');
    });

    it.each(['both', 'top'] as const)('%s says Needs you comes from everywhere only while the space includes it', placement => {
        const attentionHeader = (items: readonly SessionListIndexItem[] | null) =>
            items?.find(item => item.type === 'header' && item.headerKind === 'attention');
        expect(attentionHeader(computeVisibleSessionListIndex({ ...base, sessionListAttentionPlacementV1: placement,
            supplementalNeedsYouSessionKeys: new Set([key('outside')]) }))).toMatchObject({ fromEverywhere: true });
        const own = attentionHeader(computeVisibleSessionListIndex({ ...base, sessionListAttentionPlacementV1: placement }));
        expect(own).toBeDefined();
        expect(own).not.toHaveProperty('fromEverywhere', true);
    });

    it.each(['both', 'top'] as const)('%s holds the first outside arrival without leaking a base occurrence', placement => {
        const rowById = new Map(rows);
        rowById.set('own', { ...rows.get('own')!, hasPendingPermissionRequests: false });
        const options: ComputeVisibleSessionListIndexParams = { ...base,
            resolveSessionRow: (_serverId, sessionId) => rowById.get(sessionId) ?? null,
            sessionListAttentionPlacementV1: placement,
        };
        const first = computeVisibleSessionListIndex({ ...options, supplementalNeedsYouSessionKeys: new Set() })!;
        expect(ids(first)).toEqual(['own']);
        const held = computeVisibleSessionListProjection({ ...options, supplementalNeedsYouSessionKeys: new Set([key('outside')]),
            previousPresentedIndex: first, attentionInteractionHeld: true });
        expect(ids(held.items)).toEqual(['own']);
        expect(held.filterResult).toMatchObject({ matchedCount: 1, attentionSupplementCount: 1 });
        expect(ids(computeVisibleSessionListIndex({ ...options, supplementalNeedsYouSessionKeys: new Set([key('outside')]),
            previousPresentedIndex: held.items, attentionInteractionHeld: false }))).toEqual(['outside', 'own']);
    });

    it('keeps In-place outside rows in their original groups after own groups without quiet neighbors', () => {
        const result = computeVisibleSessionListIndex({ ...base, sessionListAttentionPlacementV1: 'inPlace',
            supplementalNeedsYouSessionKeys: new Set([key('outside')]) });
        expect(ids(result)).toEqual(['own', 'outside']);
        expect(groups(result)).toEqual(['own-group', 'outside-group']);
        expect(sessions(result)?.find(item => item.sessionId === 'outside')).toMatchObject({ groupKey: 'outside-group', groupKind: 'project' });
        expect(result?.some(item => item.type === 'header' && (item.headerKind === 'attention' || item.headerKind === 'working'))).toBe(false);
    });

    it('holds outside membership and placement against latest rows, then removes departures and appends arrivals once', () => {
        const first = computeVisibleSessionListIndex({ ...base, sessionListAttentionPlacementV1: 'inPlace',
            supplementalNeedsYouSessionKeys: new Set([key('outside')]) })!;
        const source = sourceFor([['new-place', ['outside']], ['later-group', ['later']], ['own-group', ['own']]]);
        const settledRows = new Map(rows);
        settledRows.set('outside', { ...rows.get('outside')!, hasPendingPermissionRequests: false });
        const resolveSessionRow: ComputeVisibleSessionListIndexParams['resolveSessionRow'] = (_serverId, sessionId) => settledRows.get(sessionId) ?? null;
        const heldProjection = computeVisibleSessionListProjection({ ...base, source, resolveSessionRow, sessionListAttentionPlacementV1: 'inPlace',
            supplementalNeedsYouSessionKeys: new Set([key('later')]), previousPresentedIndex: first, attentionInteractionHeld: true })!;
        const held = heldProjection.items!;
        expect(ids(held)).toEqual(['own', 'outside']);
        expect(groups(held)).toEqual(['own-group', 'outside-group']);
        expect(heldProjection.filterResult).toMatchObject({ matchedCount: 1, attentionSupplementCount: 1 });
        const released = computeVisibleSessionListIndex({ ...base, source, resolveSessionRow, sessionListAttentionPlacementV1: 'inPlace',
            supplementalNeedsYouSessionKeys: new Set([key('later')]), previousPresentedIndex: held, attentionInteractionHeld: false });
        expect(ids(released)).toEqual(['own', 'later']);
        expect(groups(released)).toEqual(['own-group', 'later-group']);
    });

    it.each(['source', 'row'] as const)('withdraws a %s-revoked outside entity immediately during hold', revoked => {
        const first = computeVisibleSessionListIndex({ ...base, sessionListAttentionPlacementV1: 'inPlace',
            supplementalNeedsYouSessionKeys: new Set([key('outside')]) })!;
        const held = computeVisibleSessionListIndex({ ...base,
            source: revoked === 'source' ? sourceFor([['own-group', ['own']]]) : base.source,
            resolveSessionRow: (_serverId, sessionId) => revoked === 'row' && sessionId === 'outside' ? null : rows.get(sessionId) ?? null,
            sessionListAttentionPlacementV1: 'inPlace', supplementalNeedsYouSessionKeys: new Set([key('outside')]),
            previousPresentedIndex: first, attentionInteractionHeld: true });
        expect(ids(held)).toEqual(['own']);
        expect(groups(held)).toEqual(['own-group']);
    });

    it('does not retain an ordinary row that now misses its dynamic space predicate as an outside shortcut', () => {
        const first = computeVisibleSessionListIndex({ ...base, sessionListAttentionPlacementV1: 'inPlace',
            supplementalNeedsYouSessionKeys: new Set([key('outside')]) })!;
        const rowById = new Map(rows);
        rowById.set('own', { ...rows.get('own')!, projectKey: 'different-project', hasPendingPermissionRequests: false });
        const held = computeVisibleSessionListIndex({ ...base, resolveSessionRow: (_serverId, sessionId) => rowById.get(sessionId) ?? null,
            sessionListAttentionPlacementV1: 'inPlace', supplementalNeedsYouSessionKeys: new Set([key('outside')]),
            previousPresentedIndex: first, attentionInteractionHeld: true });
        expect(ids(held)).toEqual(['outside']);
    });

    it('updates unique shelf eligibility during hold without inserting a new outside occurrence', () => {
        const first = computeVisibleSessionListIndex({ ...base, sessionListAttentionPlacementV1: 'both',
            supplementalNeedsYouSessionKeys: new Set([key('outside')]) })!;
        const held = computeVisibleSessionListIndex({ ...base,
            source: sourceFor([['outside-group', ['outside', 'later']], ['own-group', ['own']]]),
            sessionListAttentionPlacementV1: 'both', supplementalNeedsYouSessionKeys: new Set([key('outside'), key('later')]),
            previousPresentedIndex: first, attentionInteractionHeld: true })!;
        expect(held.find(item => item.type === 'header' && item.headerKind === 'attention')).toMatchObject({ eligibleCount: 3 });
        expect(sessions(held)?.filter(item => item.occurrenceRole === 'needsYou').map(item => item.sessionId)).toEqual(['outside', 'own']);
        expect(ids(held)).not.toContain('later');
    });

    it('retains an outside occurrence becoming an ordinary match until release, then clears its presentation marker', () => {
        const first = computeVisibleSessionListIndex({ ...base, sessionListAttentionPlacementV1: 'inPlace',
            supplementalNeedsYouSessionKeys: new Set([key('outside')]) })!;
        const rowById = new Map(rows);
        rowById.set('outside', { ...rows.get('outside')!, projectKey: 'own-project' });
        const next = { ...base, source: sourceFor([['own-group', ['own', 'outside']]]),
            resolveSessionRow: (_serverId: string | null | undefined, sessionId: string) => rowById.get(sessionId) ?? null,
            sessionListAttentionPlacementV1: 'inPlace' as const, supplementalNeedsYouSessionKeys: new Set<string>() };
        const held = computeVisibleSessionListIndex({ ...next, previousPresentedIndex: first, attentionInteractionHeld: true })!;
        expect(groups(held)).toEqual(['own-group', 'outside-group']);
        const released = computeVisibleSessionListIndex({ ...next, previousPresentedIndex: held, attentionInteractionHeld: false })!;
        expect(groups(released)).toEqual(['own-group']);
        expect(sessions(released)?.every(item => item.supplementalAttention === undefined)).toBe(true);
    });

    it('holds the position of an outside group when a new ordinary group arrives', () => {
        const workFilter = normalizeSessionListFilterV1({ homeServerIds: ['s1'], show: 'sessions', projects: {
            include: [{ serverId: 's1', projectKey: 'own-project' }, { serverId: 's1', projectKey: 'second-own-project' }], exclude: [],
        } });
        const first = computeVisibleSessionListIndex({ ...base, workFilter, sessionListAttentionPlacementV1: 'inPlace',
            supplementalNeedsYouSessionKeys: new Set([key('outside')]) })!;
        const rowById = new Map(rows);
        rowById.set('new-own', { ...rows.get('own')!, id: 'new-own', projectKey: 'second-own-project' });
        const next: ComputeVisibleSessionListIndexParams = { ...base,
            source: sourceFor([['own-group', ['own']], ['new-own-group', ['new-own']], ['outside-group', ['outside']]]),
            resolveSessionRow: (_serverId, sessionId) => rowById.get(sessionId) ?? null,
            workFilter, sessionListAttentionPlacementV1: 'inPlace', supplementalNeedsYouSessionKeys: new Set([key('outside')]),
        };
        const held = computeVisibleSessionListIndex({ ...next, previousPresentedIndex: first, attentionInteractionHeld: true })!;
        expect(groups(held)).toEqual(['own-group', 'outside-group', 'new-own-group']);
        expect(groups(computeVisibleSessionListIndex({ ...next, previousPresentedIndex: held, attentionInteractionHeld: false })))
            .toEqual(['own-group', 'new-own-group', 'outside-group']);
    });

    it('keeps an outside Section placement without presenting its quiet members', () => {
        const sectionSource: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'folder', title: 'Launch', folderId: 'launch', groupKey: 'section', serverId: 's1' },
            { type: 'session', sessionId: 'outside', serverId: 's1', folderId: 'launch', groupKey: 'section', groupKind: 'folder' },
            { type: 'session', sessionId: 'quiet', serverId: 's1', folderId: 'launch', groupKey: 'section', groupKind: 'folder' },
            ...sourceFor([['own-group', ['own']]]),
        ];
        const result = computeVisibleSessionListIndex({ ...base, source: sectionSource,
            sessionListAttentionPlacementV1: 'inPlace', supplementalNeedsYouSessionKeys: new Set([key('outside')]) });
        expect(ids(result)).toEqual(['own', 'outside']);
        expect(groups(result)).toEqual(['own-group', 'section']);
        expect(sessions(result)?.find(item => item.sessionId === 'outside')).toMatchObject({ folderId: 'launch', groupKind: 'folder' });
    });

    it('keeps held geometry while current pin and Section membership facts update', () => {
        const section = (id: string): SessionListIndexItem => ({ type: 'header', headerKind: 'folder', title: id,
            folderId: id, groupKey: `section:${id}`, serverId: 's1' });
        const filed = (id: string): SessionListIndexItem => ({ type: 'session', sessionId: 'outside', serverId: 's1',
            folderId: id, folderDepth: 1, groupKey: `section:${id}`, groupKind: 'folder' });
        const first = computeVisibleSessionListIndex({ ...base,
            source: [section('old'), filed('old'), ...sourceFor([['own-group', ['own']]])],
            sessionListAttentionPlacementV1: 'inPlace', supplementalNeedsYouSessionKeys: new Set([key('outside')]) })!;
        const held = computeVisibleSessionListIndex({ ...base,
            source: [section('new'), filed('new'), ...sourceFor([['own-group', ['own']]])],
            pinnedSessionKeysV1: [key('outside')], sessionListAttentionPlacementV1: 'inPlace',
            supplementalNeedsYouSessionKeys: new Set([key('outside')]), previousPresentedIndex: first, attentionInteractionHeld: true })!;
        expect(sessions(held)?.find(item => item.sessionId === 'outside'))
            .toMatchObject({ groupKey: 'section:old', groupKind: 'folder', folderId: 'new', pinned: true });
    });

    it('keeps a supplemental child beside its ordinary lead before unrelated siblings', () => {
        const rowById = new Map(rows);
        rowById.set('outside', { ...rows.get('outside')!, manager: { sessionId: 'own' } });
        rowById.set('own2', { ...rows.get('own')!, id: 'own2' });
        const result = computeVisibleSessionListIndex({ ...base,
            source: sourceFor([['own-group', ['own', 'own2']], ['outside-group', ['outside']]]),
            resolveSessionRow: (_serverId, sessionId) => rowById.get(sessionId) ?? null,
            sessionListAttentionPlacementV1: 'inPlace', supplementalNeedsYouSessionKeys: new Set([key('outside')]) });
        expect(ids(result)).toEqual(['own', 'outside', 'own2']);
        expect(sessions(result)?.find(item => item.sessionId === 'outside')).toMatchObject({ reportsDepth: 1, groupKey: 'own-group' });
    });

    it('appends new supplemental groups after retained supplemental groups', () => {
        const first = computeVisibleSessionListIndex({ ...base, sessionListAttentionPlacementV1: 'inPlace',
            supplementalNeedsYouSessionKeys: new Set([key('outside')]) })!;
        const result = computeVisibleSessionListIndex({ ...base,
            source: sourceFor([['later-group', ['later']], ['outside-group', ['outside']], ['own-group', ['own']]]),
            sessionListAttentionPlacementV1: 'inPlace', supplementalNeedsYouSessionKeys: new Set([key('outside'), key('later')]),
            previousPresentedIndex: first });
        expect(groups(result)).toEqual(['own-group', 'outside-group', 'later-group']);
    });

    it('keeps own groups before cross-Home supplements with unique Home re-entry headers', () => {
        const foreignOutsideKey = sessionAddressKey({ serverId: 's2', sessionId: 'foreign-outside' });
        const rowById = new Map(rows);
        rowById.set('foreign', { ...rows.get('own')!, id: 'foreign', projectKey: 'foreign-project' });
        rowById.set('foreign-outside', { ...rows.get('outside')!, id: 'foreign-outside' });
        const source = [...sourceFor([['outside-group', ['outside']], ['own-group', ['own']]]),
            ...sourceFor([['foreign-own', ['foreign']], ['foreign-outside-group', ['foreign-outside']]])
                .map(item => ({ ...item, serverId: 's2' }))];
        const params: ComputeVisibleSessionListIndexParams = { ...base, source, sessionListAttentionPlacementV1: 'inPlace',
            resolveSessionRow: (_serverId, sessionId) => rowById.get(sessionId) ?? null,
            workFilter: normalizeSessionListFilterV1({ homeServerIds: ['s1', 's2'], show: 'sessions', projects: {
                include: [{ serverId: 's1', projectKey: 'own-project' }, { serverId: 's2', projectKey: 'foreign-project' }], exclude: [],
            } }), presentation: { enabled: true, presentation: 'grouped', selectedServerIds: ['s1', 's2'] },
            supplementalNeedsYouSessionKeys: new Set([key('outside')]),
        };
        const first = computeVisibleSessionListIndex(params)!;
        expect(ids(first)).toEqual(['own', 'foreign', 'outside']);
        expect(first.filter(item => item.type === 'header' && item.headerKind === 'server').map(item => item.serverId)).toEqual(['s1', 's2', 's1']);
        expect(new Set(first.map(buildSessionListIndexNodeId)).size).toBe(first.length);
        const next = computeVisibleSessionListIndex({ ...params, previousPresentedIndex: first,
            supplementalNeedsYouSessionKeys: new Set([key('outside'), foreignOutsideKey]) })!;
        expect(ids(next)).toEqual(['own', 'foreign', 'outside', 'foreign-outside']);
        expect(new Set(next.map(buildSessionListIndexNodeId)).size).toBe(next.length);
        const removed = computeVisibleSessionListIndex({ ...params, previousPresentedIndex: next,
            supplementalNeedsYouSessionKeys: new Set([foreignOutsideKey]) })!;
        expect(ids(removed)).toEqual(['own', 'foreign', 'foreign-outside']);
        expect(new Set(removed.map(buildSessionListIndexNodeId)).size).toBe(removed.length);
    });

    it('preserves logical Sessions collapse across re-entry without collapsing a foreign Home', () => {
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'sessions', groupKey: 'sessions:s1', serverId: 's1', title: 'Sessions' },
            ...sourceFor([['own-group', ['own']], ['outside-group', ['outside']]]),
            { type: 'header', headerKind: 'sessions', groupKey: 'sessions:s2', serverId: 's2', title: 'Sessions' },
            ...sourceFor([['foreign-own', ['foreign']]]).map(item => ({ ...item, serverId: 's2' })),
        ];
        const foreign = { ...rows.get('own')!, id: 'foreign', projectKey: 'foreign-project' };
        const projected = computeVisibleSessionListIndex({ ...base, source, sessionListAttentionPlacementV1: 'inPlace',
            resolveSessionRow: (_serverId, sessionId) => sessionId === 'foreign' ? foreign : rows.get(sessionId) ?? null,
            workFilter: normalizeSessionListFilterV1({ homeServerIds: ['s1', 's2'], show: 'sessions', projects: {
                include: [{ serverId: 's1', projectKey: 'own-project' }, { serverId: 's2', projectKey: 'foreign-project' }], exclude: [],
            } }), presentation: { enabled: true, presentation: 'grouped', selectedServerIds: ['s1', 's2'] },
            supplementalNeedsYouSessionKeys: new Set([key('outside')]),
        })!;
        expect(projected.filter(item => item.type === 'header' && item.headerKind === 'sessions').map(item => item.groupKey))
            .toEqual(['sessions:s1', 'sessions:s2', 'sessions:s1']);
        expect(projected.filter(item => item.type === 'header' && item.headerKind === 'server').map(item => item.serverId))
            .toEqual(['s1', 's2', 's1']);
        expect(new Set(projected.map(buildSessionListIndexNodeId)).size).toBe(projected.length);
        const collapsedA = filterCollapsedSessionListItems(projected, { 'sessions:s1': true });
        expect(ids(collapsedA)).toEqual(['foreign']);
        expect(collapsedA.some(item => item.type === 'header' && item.headerKind === 'server' && item.serverId === 's2')).toBe(true);
        expect(ids(filterCollapsedSessionListItems(projected, { 'sessions:s2': true }))).toEqual(['own', 'outside']);
    });

    it('keeps flat Account Sections in their own Home context through supplemental append', () => {
        const sections: SessionSection[] = [
            { address: { serverId: 's1', sectionId: 'queue' }, sortKey: 'a0',
                display: { status: 'available', value: { name: 'A queue', icon: null } },
                legacyContext: { workspace: null, ancestors: [{ address: { serverId: 's1', sectionId: 'legacy-parent' },
                    display: { status: 'available', value: { name: 'Legacy parent', icon: null } } }] } },
            { address: { serverId: 's2', sectionId: 'queue' }, sortKey: 'a0',
                display: { status: 'available', value: { name: 'B queue', icon: null } } },
            { address: { serverId: 's2', sectionId: 'empty' }, sortKey: 'a1',
                display: { status: 'available', value: { name: 'B empty', icon: null } } },
        ];
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'sessions', groupKey: 'sessions:s1', serverId: 's1', title: 'Sessions' },
            ...sourceFor([['own-group', ['own']]]),
            { type: 'header', headerKind: 'sessions', groupKey: 'sessions:s2', serverId: 's2', title: 'Sessions' },
            ...sourceFor([['foreign-own', ['foreign']], ['foreign-outside', ['outside', 'quiet']]])
                .map(item => ({ ...item, serverId: 's2' })),
        ];
        const assignmentsBySessionKey = { [key('own')]: 'queue',
            [sessionAddressKey({ serverId: 's2', sessionId: 'outside' })]: 'queue',
            [sessionAddressKey({ serverId: 's2', sessionId: 'quiet' })]: 'queue' };
        const filed = projectSessionSectionListIndex({ source, sections, assignmentsBySessionKey }).items;
        const foreign = { ...rows.get('own')!, id: 'foreign', projectKey: 'foreign-project' };
        const projected = computeVisibleSessionListIndex({ ...base, source: filed,
            resolveSessionRow: (_serverId, sessionId) => sessionId === 'foreign' ? foreign : rows.get(sessionId) ?? null,
            sessionListAttentionPlacementV1: 'inPlace', sessionFolderAssignmentsBySessionKey: assignmentsBySessionKey,
            workFilter: normalizeSessionListFilterV1({ homeServerIds: ['s1', 's2'], show: 'sessions', projects: {
                include: [{ serverId: 's1', projectKey: 'own-project' }, { serverId: 's2', projectKey: 'foreign-project' }], exclude: [],
            } }), presentation: { enabled: true, presentation: 'grouped', selectedServerIds: ['s1', 's2'] },
            supplementalNeedsYouSessionKeys: new Set([sessionAddressKey({ serverId: 's2', sessionId: 'outside' })]),
        })!;
        expect(ids(projected)).toEqual(['own', 'foreign', 'outside']);
        const sectionHeaders = projected.filter(item => item.type === 'header' && item.headerKind === 'folder');
        expect(sectionHeaders.map(item => item.groupKey)).toEqual([
            buildSessionSectionGroupKey(sections[0]!.address), buildSessionSectionGroupKey(sections[2]!.address),
            buildSessionSectionGroupKey(sections[1]!.address),
        ]);
        expect(sectionHeaders.every(item => item.folderDepth === 0)).toBe(true);
        let home: string | undefined;
        for (const item of projected) {
            if (item.type === 'header' && item.headerKind === 'server') home = item.serverId;
            else if (item.serverId) expect(item.serverId).toBe(home);
        }
        expect(new Set(projected.map(buildSessionListIndexNodeId)).size).toBe(projected.length);
    });

    it('preserves admitted Home and Sessions context while hiding inactive cross-Home rows', () => {
        const source: SessionListIndexItem[] = [
            { type: 'header', headerKind: 'server', groupKey: 'server:s1', serverId: 's1', title: 'A' },
            { type: 'header', headerKind: 'sessions', groupKey: 'sessions:s1', serverId: 's1', title: 'Sessions' },
            ...sourceFor([['own-group', ['own', 'inactive']]]),
            { type: 'header', headerKind: 'server', groupKey: 'server:s2', serverId: 's2', title: 'B' },
            { type: 'header', headerKind: 'sessions', groupKey: 'sessions:s2', serverId: 's2', title: 'Sessions' },
            ...sourceFor([['foreign-own', ['foreign']]]).map(item => ({ ...item, serverId: 's2' })),
        ];
        const rowById = new Map(rows);
        rowById.set('foreign', { ...rows.get('own')!, id: 'foreign' });
        rowById.set('inactive', { ...rows.get('own')!, id: 'inactive', active: false, activeAt: 0,
            hasPendingPermissionRequests: false, keepVisibleWhenInactive: false });
        const projected = computeVisibleSessionListIndex({ ...base, source, workFilter: undefined,
            resolveSessionRow: (_serverId, sessionId) => rowById.get(sessionId) ?? null,
            hideInactiveSessions: true, sessionListAttentionPlacementV1: 'inPlace' })!;
        expect(ids(projected)).toEqual(['own', 'foreign']);
        expect(projected.filter(item => item.type === 'header').map(item => item.groupKey))
            .toEqual(['server:s1', 'sessions:s1', 'own-group', 'server:s2', 'sessions:s2', 'foreign-own']);
    });
});
