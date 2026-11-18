/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { projectSessionAccessCapabilitiesV1, type SessionEffectiveAccessV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';

import {
    createPlainSessionCurrentProjectionRecordFixture,
    createSessionFixture,
    createSessionOwnerViewerFixture,
} from '@/dev/testkit/fixtures/sessionFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { sync } from '@/sync/sync';
import {
    ActivityPersonalSessionMembershipProvider,
    useActivityPersonalSessionMembership,
    type ActivityPersonalSessionMembership,
} from '@/activity/source/activityPersonalSessionMembership';

// Each cold load is a fresh Home, so no features snapshot or list state carries over between loads.
let homeUrl = '';
let coldLoads = 0;
const features = createRootLayoutFeaturesResponse({ features: {
    sessions: { enabled: true, filteredListing: { enabled: true } },
    workflows: { enabled: false }, automations: { enabled: false },
    social: { friends: { enabled: false } },
    encryption: { plaintextStorage: { enabled: true } },
} });

/**
 * One Home's Sessions as its server would rank them (newest first). The ordinary GET
 * sees owner-or-direct rows; the personal query sees `my_work` over effective access,
 * where newer Team-shared rows displace the oldest owned rows from page one.
 */
const OWNED = Array.from({ length: 55 }, (_, index) => `owned-${String(index).padStart(2, '0')}`);
const OWNER_VIEWER = createSessionOwnerViewerFixture(createSessionFixture({ id: 'viewer-template' }));
const recipientAccess = (level: 'view' | 'edit', sources: SessionEffectiveAccessV1['sources']): SessionEffectiveAccessV1 => ({
    v: 1, level, sources,
    capabilities: projectSessionAccessCapabilitiesV1({ owner: false,
        grants: [{ accessLevel: level, canApprovePermissions: false }] }),
});

function row(id: string, activity: number, overrides: Readonly<{ effectiveAccess?: SessionEffectiveAccessV1; archivedAt?: number }> = {}) {
    const record = createPlainSessionCurrentProjectionRecordFixture({ id, createdAt: activity, updatedAt: activity,
        activeAt: activity, archivedAt: overrides.archivedAt ?? null, metadata: { name: `Session ${id}` } });
    if (!overrides.effectiveAccess) return { ...record, viewer: OWNER_VIEWER };
    // A recipient reads the shared projection only; the owner-private envelope is never sent to it.
    const { ownerMetadata: _ownerMetadata, ...shared } = record;
    return { ...shared, effectiveAccess: overrides.effectiveAccess, viewer: OWNER_VIEWER,
        share: { accessLevel: overrides.effectiveAccess.level === 'edit' ? 'edit' : 'view', canApprovePermissions: false } };
}

const owned = OWNED.map((id, index) => row(id, 100_000 - index));
const direct = row('direct-share', 197_000, { effectiveAccess: recipientAccess('view', [{ kind: 'direct', shareId: 'share-direct' }]) });
// Directly shared and Team-shared: each reader projects its own access facts for the same Session.
const bothOrdinary = row('direct-and-team', 198_000, { effectiveAccess: recipientAccess('view', [{ kind: 'direct', shareId: 'share-both' }]) });
const bothQuery = row('direct-and-team', 198_000, { effectiveAccess: recipientAccess('edit', [
    { kind: 'direct', shareId: 'share-both' }, { kind: 'team', teamId: 'team-1', requiredByTeamPolicy: false }]) });
const teamFollowed = row('team-followed', 200_000, { effectiveAccess: recipientAccess('view', [{ kind: 'team', teamId: 'team-1', requiredByTeamPolicy: false }]) });
const teamMentioned = row('team-mentioned', 199_000, { effectiveAccess: recipientAccess('view', [{ kind: 'team', teamId: 'team-1', requiredByTeamPolicy: false }]) });
const pinnedOld = owned[54]!;

// Page one of each reader, including the pinned row each initial page adds.
const ORDINARY_PAGE = {
    sessions: [bothOrdinary, direct, ...owned.slice(0, 48), pinnedOld],
    observationCursor: 7, nextCursor: 'ordinary-page-2', hasNext: true,
    attentionNextCursor: null, attentionHasNext: false,
};
const QUERY_PAGE = {
    sessions: [teamFollowed, teamMentioned, bothQuery, direct, ...owned.slice(0, 46), pinnedOld],
    nextCursor: 'query-page-2', hasNext: true, attentionNextCursor: null, attentionHasNext: false,
};

let advertiseOrdinaryPage = false;
const listReads: string[] = [];

/** The server's rule: an ordinary row identical to the query row of the same Session is sent once. */
function carryOrdinaryPage() {
    const queryRows = new Map(QUERY_PAGE.sessions.map(session => [session.id, JSON.stringify(session)]));
    const { sessions, ...members } = ORDINARY_PAGE;
    return { ...QUERY_PAGE, ordinary: { ...members, sessionIds: sessions.map(session => session.id),
        sessions: sessions.filter(session => queryRows.get(session.id) !== JSON.stringify(session)) } };
}

async function respond(url: Parameters<typeof fetch>[0], init?: RequestInit) {
    const target = new URL(String(url));
    if (target.origin !== homeUrl) throw new Error('Unexpected Home');
    if (target.pathname === '/v2/sessions/read-batch') return null;
    if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
    if (target.pathname === '/v1/features' || target.pathname === '/v1/features/authenticated') return Response.json({
        ...features, features: { ...features.features, sessions: { ...features.features.sessions,
            filteredListing: { enabled: true, ...(advertiseOrdinaryPage ? { ordinaryPageVersion: 1 } : {}) } } },
    });
    if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
    if (target.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
    if (target.pathname === '/v2/account/settings') return Response.json(AccountSettingsV2GetResponseSchema.parse({
        content: { t: 'plain', v: {} }, version: 1,
    }));
    if (target.pathname === '/v2/cursor') return Response.json({ cursor: 0, changesFloor: 0 });
    if (target.pathname === '/v2/session-organization') return Response.json(SessionOrganizationSnapshotResponseSchema.parse({
        snapshot: { schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION, version: 0, pins: [], folders: [],
            folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [] },
    }));
    if (target.pathname === '/v1/machines') return Response.json([]);
    if (target.pathname === '/v2/sessions/active') return Response.json(V2SessionListResponseSchema.parse({
        sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
    }));
    if (target.pathname === '/v2/sessions/query') {
        const body = JSON.parse(String(init?.body)) as { cursor?: string; ordinaryPage?: unknown };
        if (body.cursor) throw new Error('Cold load must not page the query');
        listReads.push(body.ordinaryPage ? 'POST /v2/sessions/query+ordinary' : 'POST /v2/sessions/query');
        return Response.json(body.ordinaryPage ? carryOrdinaryPage() : QUERY_PAGE);
    }
    if (target.pathname === '/v2/sessions') {
        if (target.searchParams.get('cursor')) throw new Error('Cold load must not page the ordinary list');
        listReads.push('GET /v2/sessions');
        return Response.json(ORDINARY_PAGE);
    }
    return new Response('{}', { status: 404 });
}

type ColdLoadResult = Readonly<{
    listReads: readonly string[];
    ordinaryMembership: readonly string[] | undefined;
    activityMembership: readonly string[] | undefined;
    frontier: unknown;
    rows: Record<string, unknown>;
}>;

let dispose: (() => Promise<void>) | null = null;

/** The app's cold load on one Home: Sync's restore plus the personal list a mounted Activity surface reads. */
async function coldLoad(advertise: boolean): Promise<ColdLoadResult> {
    advertiseOrdinaryPage = advertise;
    homeUrl = `https://cold-page-one-${++coldLoads}.test`;
    listReads.length = 0;
    storage.setState(storage.getInitialState(), true);
    const connected = new Promise<void>((resolve) => {
        installDisconnectedServerSocketBoundary((socket) => {
            vi.spyOn(socket, 'connect').mockImplementation(() => {
                socket.connected = true;
                for (const listener of socket.listeners('connect')) listener();
                resolve();
                return socket;
            });
        });
    });
    const connection = await restoreServerAccountForTest({ serverUrl: homeUrl, accountId: 'cold-page-one', request: respond });
    await connected;
    const serverId = connection.home.id;
    const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const membership: { current: ActivityPersonalSessionMembership | null } = { current: null };
    function Observer() {
        membership.current = useActivityPersonalSessionMembership();
        return null;
    }
    dispose = async () => {
        await act(async () => root.unmount());
        container.remove();
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
        await connection.dispose();
        storage.setState(storage.getInitialState(), true);
        vi.restoreAllMocks();
        dispose = null;
    };
    await act(async () => root.render(
        <ActivityPersonalSessionMembershipProvider enabled><Observer /></ActivityPersonalSessionMembershipProvider>,
    ));
    await vi.waitFor(async () => {
        await act(async () => {});
        expect(membership.current?.statesByServerId[serverId]).toMatchObject({ phase: 'ready' });
        expect(storage.getState().ordinarySessionListMembershipByServerId[serverId]?.length).toBeGreaterThan(0);
        expect(sync.readOrdinarySessionListLifecycle().fetchInFlight).toBe(false);
    });
    const ids = new Set([...ORDINARY_PAGE.sessions, ...QUERY_PAGE.sessions].map(session => session.id));
    const rows = storage.getState().sessionListRowsByServerId[serverId] ?? {};
    const result: ColdLoadResult = {
        listReads: [...listReads],
        ordinaryMembership: storage.getState().ordinarySessionListMembershipByServerId[serverId],
        activityMembership: membership.current?.membershipByServerId[serverId],
        frontier: sync.readOrdinarySessionListLifecycle().frontier,
        // Every field of every row; only the per-load Home identity is set aside.
        rows: JSON.parse(JSON.stringify(Object.fromEntries([...ids].map(id => [id, rows[id]])),
            (key, value: unknown) => key === 'serverId' && value === serverId ? 'HOME' : value)) as Record<string, unknown>,
    };
    await dispose();
    return result;
}

describe('cold Session-list page one', () => {
    beforeAll(async () => {
        vi.stubGlobal('__DEV__', true);
        vi.stubGlobal('self', globalThis);
        await initializeRealAppRuntimeForTests();
    });
    afterEach(async () => { await dispose?.(); });

    it('reads own and Team-shared page one once on a Home that carries the ordinary page', async () => {
        const after = await coldLoad(true);
        expect(after.listReads).toEqual(['POST /v2/sessions/query+ordinary']);
    });

    it('leaves every membership, row, access fact and frontier exactly as the two reads did', async () => {
        const before = await coldLoad(false);
        expect(before.listReads.slice().sort()).toEqual(['GET /v2/sessions', 'POST /v2/sessions/query']);
        const after = await coldLoad(true);
        expect(after.listReads).toEqual(['POST /v2/sessions/query+ordinary']);
        // First-page truncation: the oldest owned rows on the ordinary page are absent from the query page.
        expect(before.ordinaryMembership).toEqual(expect.arrayContaining(['owned-46', 'owned-47', 'direct-and-team']));
        expect(before.activityMembership).not.toContain('owned-47');
        expect(after.ordinaryMembership).toEqual(before.ordinaryMembership);
        expect(after.activityMembership).toEqual(before.activityMembership);
        expect(after.frontier).toEqual(before.frontier);
        expect(after.rows).toEqual(before.rows);
    });
});
