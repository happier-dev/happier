/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionListQuerySourceHarness, waitForSessionListQueryState, type SessionListQuerySourceHarness } from '@/dev/testkit/harness/sessionListQuerySourceHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { applyProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { storage } from '@/sync/domains/state/storageStore';
import { useProjectSessions, type ProjectSessionsState } from './useProjectSessions';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

let boundary: SessionListQuerySourceHarness;
beforeEach(async () => { boundary = await createSessionListQuerySourceHarness(); });
afterEach(async () => { await boundary.dispose(); });

type Read = Readonly<{ path: string; cursor: string | null; projectKeys: unknown }>;

/** The Home's Account corpus is six pages of Sessions, none of them in the Project. */
function answerUnrelatedCorpus(serverId: string): Read[] {
    const reads: Read[] = [];
    const corpusPage = (cursor: string | null) => {
        const index = cursor ? Number(cursor.split(':')[1]) : 0;
        const ids = Array.from({ length: 50 }, (_, offset) => `other-${index}-${offset}`);
        return { sessionIds: ids, nextCursor: index < 5 ? `cursor_v2_page:${index + 1}` : null };
    };
    for (const path of ['/v2/sessions', '/v2/sessions/query']) {
        boundary.http.answer(serverId, path, { select(input, request) {
            const query = (input ?? {}) as Readonly<Record<string, unknown>>;
            const url = request.url ? new URL(request.url, 'https://home.test') : null;
            const cursor = (typeof query.cursor === 'string' ? query.cursor : url?.searchParams.get('cursor')) ?? null;
            const projectKeys = query.projectKeys ?? null;
            reads.push({ path, cursor, projectKeys });
            // The Home answers a Project selector from its own published Project identity: nothing matches.
            const { sessionIds, nextCursor } = projectKeys ? { sessionIds: [], nextCursor: null } : corpusPage(cursor);
            return { body: { sessions: sessionIds.map(id => {
                const session = createSessionFixture({ id, projectKey: 'other', active: true, activeAt: Date.now() });
                return { ...createPlainSessionCurrentProjectionRecordFixture({ id, projectKey: session.projectKey,
                    active: session.active, activeAt: session.activeAt }),
                    viewer: createSessionOwnerViewerFixture(session) };
            }),
            nextCursor, hasNext: nextCursor !== null, attentionNextCursor: null, attentionHasNext: false } };
        } });
    }
    return reads;
}

async function advertiseProjectSelector(serverId: string, projectSelectorVersion: 1 | null = 1, filteredListingEnabled = true) {
    const features = createRootLayoutFeaturesResponse({ features: {
        sessions: { enabled: true, filteredListing: { enabled: filteredListingEnabled,
            ...(projectSelectorVersion === null ? {} : { projectSelectorVersion: 1 }) }, following: { enabled: true } },
        workflows: { enabled: false }, automations: { enabled: false },
        social: { friends: { enabled: false } }, encryption: { plaintextStorage: { enabled: true } },
    } });
    boundary.http.answer(serverId, '/v1/features', { body: features });
    boundary.http.answer(serverId, '/v1/features/authenticated', { body: features });
    await getServerFeaturesSnapshot({ serverId, force: true });
}

async function mountRoster(serverId: string) {
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const state: { current: ProjectSessionsState | null } = { current: null };
    const project = { serverId, projectKey: 'project-without-sessions' };
    function Roster() {
        state.current = useProjectSessions(project);
        return null;
    }
    await act(async () => root.render(<Roster />));
    return { state, async unmount() { await act(async () => root.unmount()); container.remove(); } };
}

describe('Project Session roster paging', () => {
    it.each([300, 3000])('reads only the 53 Project members across pages in a %i Session Account with published identities', async (inventorySize) => {
        const home = boundary.serverIds[0]!;
        await advertiseProjectSelector(home);
        const members = Array.from({ length: 53 }, (_, index) => `member-${index}`);
        const unrelated = Array.from({ length: inventorySize - members.length }, (_, index) => `other-${index}`);
        let reads = 0;
        boundary.http.answer(home, '/v2/sessions/query', { select(input) {
            const query = input as Readonly<{ projectKeys?: { include: readonly string[] }; cursor?: string }>;
            reads += 1;
            const selected = query.projectKeys?.include.includes('project-without-sessions') ? members : [...unrelated, ...members];
            const offset = query.cursor ? Number(query.cursor.split(':')[1]) : 0;
            const nextOffset = offset + 50;
            const nextCursor = nextOffset < selected.length ? `cursor_v2_page:${nextOffset}` : null;
            return { body: { sessions: selected.slice(offset, nextOffset).map(id => {
                const session = createSessionFixture({ id, projectKey: id.startsWith('member-') ? 'project-without-sessions' : 'other' });
                return { ...createPlainSessionCurrentProjectionRecordFixture({ id, projectKey: session.projectKey }),
                    viewer: createSessionOwnerViewerFixture(session) };
            }), nextCursor, hasNext: nextCursor !== null, attentionNextCursor: null, attentionHasNext: false } };
        } });
        const roster = await mountRoster(home);
        try {
            await waitForSessionListQueryState(() => expect(roster.state.current?.items.length).toBeGreaterThan(0));
            while (roster.state.current?.query.statesByServerId[home]?.hasNext) {
                await act(async () => roster.state.current?.query.loadNext());
            }
            await waitForSessionListQueryState(() => expect(roster.state.current?.items.map(item => item.sessionId).sort()).toEqual([...members].sort()));
            expect(reads).toBe(2);
        } finally { await roster.unmount(); }
    });

    it.each([true, false])('keeps finding Project members without the Project selector (filtered listing: %s)', async (filteredListingEnabled) => {
        const home = boundary.serverIds[0]!;
        await advertiseProjectSelector(home, null, filteredListingEnabled);
        const reads: string[] = [];
        for (const path of ['/v2/sessions', '/v2/sessions/query']) {
            boundary.http.answer(home, path, { select(input, request) {
                const query = (input ?? {}) as Readonly<{ projectKeys?: unknown; cursor?: string }>;
                expect(query.projectKeys).toBeUndefined();
                const cursor = query.cursor ?? (request.url ? new URL(request.url, 'https://home.test').searchParams.get('cursor') : null);
                reads.push(path);
                const page = cursor ? Number(cursor.split(':')[1]) : 0;
                const isMember = page === 2;
                const session = createSessionFixture({ id: isMember ? 'member' : `other-${page}`,
                    projectKey: isMember ? 'project-without-sessions' : 'other' });
                return { body: { sessions: [{ ...createPlainSessionCurrentProjectionRecordFixture({ id: session.id, projectKey: session.projectKey }),
                    viewer: createSessionOwnerViewerFixture(session) }], nextCursor: isMember ? null : `cursor_v2_page:${page + 1}`,
                hasNext: !isMember, attentionNextCursor: null, attentionHasNext: false } };
            } });
        }
        const { sync } = await import('@/sync/sync');
        if (!filteredListingEnabled) {
            // The incumbent ordinary owner retains its admitted frontier; refresh it
            // through the real Sync path before the Project consumes that frontier.
            await sync.refreshSessions({ awaitSessionListHydration: true });
        }
        const roster = await mountRoster(home);
        try {
            await waitForSessionListQueryState(() => {
                const state = roster.state.current?.query.statesByServerId[home];
                expect({ items: roster.state.current?.items.map(item => item.sessionId), state,
                    lifecycle: sync.readOrdinarySessionListLifecycle(), reads }).toMatchObject({ items: ['member'],
                    state: { phase: 'ready', hasNext: false } });
            });
            expect(reads).toHaveLength(3);
            expect(roster.state.current?.items.map(item => item.sessionId)).toEqual(['member']);
            expect(reads.every(path => path === (filteredListingEnabled ? '/v2/sessions/query' : '/v2/sessions'))).toBe(true);
        } finally { await roster.unmount(); }
    });

    it('hides private Project roster rows on sharing push and restores them without another inventory read', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { buildSessionOrganizationSessionKey } = await import('@/sync/domains/session/organization/keys');
        const { setScreenSharingPrivacyActive } = await import('@/desktop/capture/useNativeRecordingActive');
        const home = boundary.serverIds[0]!;
        await advertiseProjectSelector(home);
        const session = createSessionFixture({ id: 'private-project', projectKey: 'project-without-sessions' });
        boundary.http.answer(home, '/v2/sessions/query', { body: { sessions: [{
            ...createPlainSessionCurrentProjectionRecordFixture({ id: session.id, projectKey: session.projectKey }),
            viewer: createSessionOwnerViewerFixture(session),
        }], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false } });
        storage.setState({ settings: { ...storage.getState().settings, sessionListHiddenTagIdsWhileRecording: { [home]: ['secret'] } },
            sessionOrganizationTagAssignmentsBySessionKey: { [buildSessionOrganizationSessionKey(home, session.id)]: { sessionId: session.id, tagIds: ['secret'] } } });
        const roster = await mountRoster(home);
        try {
            await waitForSessionListQueryState(() => expect(roster.state.current?.items.map(item => item.sessionId)).toContain(session.id));
            await act(async () => setScreenSharingPrivacyActive(true));
            expect(roster.state.current?.items).toEqual([]);
            await act(async () => setScreenSharingPrivacyActive(false));
            await waitForSessionListQueryState(() => expect(roster.state.current?.items.map(item => item.sessionId)).toContain(session.id));
        } finally { await roster.unmount(); setScreenSharingPrivacyActive(false); }
    });
    it("asks the Home for every key the Project's Sessions may carry: its anchor and each joined checkout's own key", async () => {
        const home = boundary.serverIds[0]!;
        await advertiseProjectSelector(home);
        const reads = answerUnrelatedCorpus(home);
        const ref = (id: string) => ({ id, serverId: home, projectKey: 'project-without-sessions', machineId: 'machine',
            rootPath: `/${id}`, createdAtMs: 1 });
        applyProjectAccountRowsFixture(storage, { workspaceRefs: [ref('project-without-sessions'), ref('joined')] });
        const roster = await mountRoster(home);
        try {
            await waitForSessionListQueryState(() => expect(roster.state.current?.presentation.kind).toBe('ready'));
            const scoped = reads.filter(read => read.projectKeys !== null) as Array<Read & { projectKeys: { include: string[] } }>;
            expect([...scoped.at(-1)!.projectKeys.include].sort()).toEqual(['joined', 'project-without-sessions']);
        } finally {
            await roster.unmount();
        }
    });
    it('asks the Home for the Project instead of walking the Account corpus, and an Account change re-reads one page', async () => {
        const home = boundary.serverIds[0]!;
        await advertiseProjectSelector(home);
        const reads = answerUnrelatedCorpus(home);
        const roster = await mountRoster(home);
        try {
            await waitForSessionListQueryState(() => expect(roster.state.current?.presentation.kind).toBe('ready'));
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
            // One read, scoped to the Project; no continuation through unrelated Account pages.
            expect(reads).toHaveLength(1);
            expect(reads[0]).toMatchObject({ path: '/v2/sessions/query', cursor: null,
                projectKeys: { include: ['project-without-sessions'], exclude: [] } });
            expect(roster.state.current?.items).toEqual([]);

            // A row write in another Project that moves no Project identity (activity only) reads nothing.
            const beforeRowWrite = reads.length;
            await act(async () => publishHomeAccountChange(home, ['unrelated-session'], {
                changeKinds: ['session'], sessionListQueryAffects: 'structural',
                sessionListRowFacets: { attention: true, metadata: false, activity: true } }));
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
            expect(reads.length - beforeRowWrite).toBe(0);

            const before = reads.length;
            await act(async () => publishHomeAccountChange(home));
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)); });
            // An unqualified Account change replaces the first page only; it never restarts a corpus walk.
            expect(reads.length - before).toBeLessThanOrEqual(1);
            expect(reads.slice(before).every(read => read.cursor === null && read.projectKeys !== null)).toBe(true);
        } finally {
            await roster.unmount();
        }
    });
});
