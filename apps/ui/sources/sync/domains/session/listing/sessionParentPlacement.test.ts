import { describe, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';
import { buildSessionListRenderableFromSession } from './sessionListRenderable';
import type { SessionListViewItem } from './sessionListViewData';
import {
    applySessionParentPlacementToSessionListViewData,
    buildSessionParentPlacementProjection,
    createCanPlaceSessionUnderParent,
    sessionChildrenCollapseKey,
} from './sessionParentPlacement';
import { mergeSessionAppearanceDisplay } from '../organization/sessionAppearance';
import type {
    SessionOrganizationSessionAppearance,
    SessionOrganizationSessionAppearancePresentation,
} from '@happier-dev/protocol';

function row(id: string, creator?: string, serverId = 'home'): Extract<SessionListViewItem, { type: 'session' }> {
    return { type: 'session', serverId, session: buildSessionListRenderableFromSession(createSessionFixture({ id,
        metadata: { path: `/work/${id}`, host: 'host', ...(creator ? { sessionOriginV1: { v: 1, kind: 'agent', creatorSessionId: creator } } : {}) },
    })) };
}
function appearance(sessionId: string, value: Record<string, unknown>): SessionOrganizationSessionAppearance {
    return { sessionId, display: { t: 'plain', v: value }, updatedAt: 1 };
}
function appearancePresentation(
    sessionId: string,
    value: Record<string, unknown>,
): SessionOrganizationSessionAppearancePresentation {
    return { sessionId, presentation: { t: 'plain', v: value }, updatedAt: 1 };
}
const sessions = (items: readonly SessionListViewItem[]) => items.filter(item => item.type === 'session');

describe('session parent placement', () => {
    it('preserves already empty or collapsed folder headings', () => {
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Collapsed project', headerKind: 'project', groupKey: 'collapsed' },
            { type: 'header', title: 'Empty folder', headerKind: 'folder', folderId: 'empty', groupKey: 'empty' },
            { type: 'header', title: 'Other project', headerKind: 'project', groupKey: 'other' }, row('other'),
        ];
        expect(applySessionParentPlacementToSessionListViewData(source)).toEqual(source);
    });
    it('places coordinator-created siblings across workspace headings without fabricating origin', () => {
        const planner = row('planner');
        const implementer = row('implementer');
        const source: SessionListViewItem[] = [
            { type: 'header', title: 'Implementer worktree', headerKind: 'project', groupKey: 'impl' }, implementer,
            { type: 'header', title: 'Planner worktree', headerKind: 'project', groupKey: 'plan' }, planner,
        ];
        const appearances = { 'home:implementer': appearance('implementer', { placement: { kind: 'session', parentSessionId: 'planner' } }) };
        const result = applySessionParentPlacementToSessionListViewData(source, appearances);
        expect(result.map(item => item.type === 'header' ? item.title : item.session.id)).toEqual(['Planner worktree', 'planner', 'implementer']);
        expect(sessions(result)[1]).toMatchObject({ parentSessionId: 'planner', nestingDepth: 1 });
        expect(implementer.session.metadata?.sessionOriginV1).toBeNull();
        expect(planner.session.metadata?.sessionOriginV1).toBeNull();
        const again = applySessionParentPlacementToSessionListViewData(source, { ...appearances });
        expect(again[1]).toBe(result[1]);
        expect(again[2]).toBe(result[2]);
    });

    it('lets explicit placement win, breaks out, promotes, and restores without changing provenance or color', () => {
        const child = row('implementer', 'planner');
        const source = [child, row('planner'), row('coordinator')];
        let display = appearance('implementer', { color: { kind: 'accent', key: 'green' } }).display;
        const project = () => sessions(applySessionParentPlacementToSessionListViewData(source, {
            'home:implementer': { sessionId: 'implementer', display, updatedAt: 1 },
        })).find(item => item.session.id === 'implementer')!;
        display = mergeSessionAppearanceDisplay(display, { placement: { kind: 'session', parentSessionId: 'coordinator' } })!;
        expect(project().parentSessionId).toBe('coordinator');
        display = mergeSessionAppearanceDisplay(display, { placement: { kind: 'topLevel' } })!;
        expect(project().parentSessionId).toBeUndefined();
        expect(project().identityOverride).toBeUndefined();
        display = mergeSessionAppearanceDisplay(display, { placement: { kind: 'topLevel' }, identity: 'independent' })!;
        expect(project().identityOverride).toBe('independent');
        display = mergeSessionAppearanceDisplay(display, { placement: null, identity: null })!;
        expect(project().parentSessionId).toBe('planner');
        expect(display).toEqual({ t: 'plain', v: { color: { kind: 'accent', key: 'green' } } });
        expect(project().session).toBe(child.session);
    });

    it('keeps missing, archived, cross-server, self-linked and cyclic parents from hiding sessions', () => {
        for (const source of [[row('child', 'missing')], [row('self', 'self')], [row('a', 'b'), row('b', 'a')],
            [row('child', 'parent'), row('parent', undefined, 'other')],
            [row('child', 'parent'), { ...row('parent'), session: { ...row('parent').session, archivedAt: 1 } }]]) {
            const result = sessions(applySessionParentPlacementToSessionListViewData(source));
            expect(result).toHaveLength(source.length);
            expect(result.every(item => !item.parentSessionId)).toBe(true);
        }
    });

    it('honors explicit pins and folders and keeps a search match visible without its parent', () => {
        const parent = row('planner');
        for (const child of [{ ...row('implementer', 'planner'), pinned: true }, { ...row('implementer', 'planner'), folderId: 'chosen-folder' }]) {
            expect(sessions(applySessionParentPlacementToSessionListViewData([child, parent]))[0].parentSessionId).toBeUndefined();
        }
        const child = row('implementer', 'planner');
        const collapsed = { [sessionChildrenCollapseKey('home', 'planner')]: true };
        expect(sessions(applySessionParentPlacementToSessionListViewData([child, parent], {}, {}, { 'home:implementer': 'chosen-folder' }))[0].parentSessionId).toBeUndefined();
        expect(sessions(applySessionParentPlacementToSessionListViewData([child, parent], {}, collapsed)).map(item => item.session.id)).toEqual(['planner']);
        expect(sessions(applySessionParentPlacementToSessionListViewData([child], {}, collapsed)).map(item => item.session.id)).toEqual(['implementer']);
        expect(sessions(applySessionParentPlacementToSessionListViewData([child, parent])).map(item => item.session.id)).toEqual(['planner', 'implementer']);
        expect(createCanPlaceSessionUnderParent({ items: [child, parent], appearances: {}, serverId: 'home', sessionId: 'planner' })('implementer')).toBe(false);
    });

    it('keeps an explicit session placement visible when the child is pinned or folder-assigned', () => {
        const parent = row('planner');
        const presentation = {
            'home:implementer': appearancePresentation('implementer', {
                placement: { kind: 'session', parentSessionId: 'planner' },
            }),
        };
        const cases = [
            { child: { ...row('implementer'), pinned: true }, folderAssignments: {} },
            { child: { ...row('implementer'), folderId: 'chosen-folder' }, folderAssignments: {} },
            { child: row('implementer'), folderAssignments: { 'home:implementer': 'chosen-folder' } },
        ];

        for (const { child, folderAssignments } of cases) {
            const result = sessions(applySessionParentPlacementToSessionListViewData(
                [child, parent],
                {},
                {},
                folderAssignments,
                presentation,
            ));
            expect(result.map(item => item.session.id)).toEqual(['planner', 'implementer']);
            expect(result[1]).toMatchObject({ parentSessionId: 'planner', nestingDepth: 1 });
        }
    });

    it('projects every nested descendant for family actions even when the branch is collapsed', () => {
        const lead = row('lead');
        const reviewer = row('reviewer', 'lead');
        const researcher = row('researcher', 'reviewer');
        const worker = row('worker');
        const source: SessionListViewItem[] = [worker, researcher, lead, reviewer];
        const appearances = {
            'home:worker': appearance('worker', { placement: { kind: 'session', parentSessionId: 'lead' } }),
        };
        const collapsed = { [sessionChildrenCollapseKey('home', 'lead')]: true };

        const projection = buildSessionParentPlacementProjection(source, appearances, collapsed);

        expect(sessions(projection.items).map(item => item.session.id)).toEqual(['lead']);
        expect(projection.descendantsByParentKey.get('home:lead')?.map(item => item.session.id)).toEqual([
            'worker',
            'researcher',
            'reviewer',
        ]);
        expect(projection.descendantsByParentKey.get('home:reviewer')?.map(item => item.session.id)).toEqual([
            'researcher',
        ]);
    });
});
