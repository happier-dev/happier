/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionListQuerySourceHarness, waitForSessionListQueryState, type SessionListQuerySourceHarness } from '@/dev/testkit/harness/sessionListQuerySourceHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { useProjectSessions, type ProjectSessionsState } from './useProjectSessions';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

let boundary: SessionListQuerySourceHarness;
beforeEach(async () => { boundary = await createSessionListQuerySourceHarness(); });
afterEach(async () => { await boundary.dispose(); });

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

});
