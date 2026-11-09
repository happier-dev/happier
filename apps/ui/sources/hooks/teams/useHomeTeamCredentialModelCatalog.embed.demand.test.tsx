import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const frameWindow = vi.hoisted(() => {
    // The boot context is immutable. Start a real frame realm before any runtime imports.
    vi.resetModules();
    const frame = {
        location: new URL('https://app.example.test/embed/new'),
        addEventListener() {},
        removeEventListener() {},
    };
    vi.stubGlobal('window', frame);
    return frame;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { sync } = await import('@/sync/sync');
const { isEmbedWindowContext } = await import('@/embed/isEmbedWindowContext');
const { useHomeTeamCredentialModelCatalog } = await import('./useHomeTeamCredentialModelCatalog');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');

beforeEach(async () => {
    vi.stubGlobal('window', frameWindow);
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    resetTeamActionClientForTests();
    await home.reset();
});

afterEach(async () => {
    standardCleanup();
    sync.disposeEmbedSession();
    resetTeamsDirectoryEngineForTests();
    resetTeamsSnapshotsForTests();
    resetTeamActionClientForTests();
    await home.reset();
    vi.unstubAllGlobals();
});

describe('embed optional Team credential catalog demand', () => {
    it('settles disabled without Account Team discovery on mount or reload', async () => {
        expect(isEmbedWindowContext()).toBe(true);
        const serverId = 'https://catalog-embed.example.test';
        const token = 'hap_v1_child';
        const profileId = await home.addHome({ name: 'Scoped Home', serverUrl: serverId,
            accountId: 'account-ada', credentials: { token }, teamsEnabled: true, credentialResourcesEnabled: true });
        for (const route of ['/v1/teams/list', '/v1/actions/teams.list']) {
            home.answer(profileId, route, { status: 403, body: { error: 'credential_scope_denied' } });
        }
        home.answer(profileId, '/v2/cursor', { body: { cursor: 1, changesFloor: 0 } });
        home.answer(profileId, '/v2/sessions/created', { body: { session: createPlainSessionCurrentProjectionRecordFixture({ id: 'created' }) } });
        home.answer(profileId, '/v1/sessions/created/turns', { body: { v: 1, sessionId: 'created', updatedAt: 1, turns: [] } });
        home.answer(profileId, '/v1/sessions/created/messages', { body: { messages: [], nextAfterSeq: null } });
        home.answer(profileId, '/v2/sessions/created/pending', { body: { pending: [], pendingVersion: 0 } });
        await sync.create({ token }, null, undefined, { scope: { kind: 'embedSession', sessionId: 'created' },
            accountId: 'account-ada', endpointUrl: serverId, accountMode: 'plain', approvalGranted: false, isCurrent: () => true });
        const teamRequests = () => [...home.requestsFor('/v1/teams/list'), ...home.requestsFor('/v1/actions/teams.list')];

        const catalog = await renderHook(() => useHomeTeamCredentialModelCatalog({ serverId, enabled: true,
            agentTargetKey: 'agent:happier.agent.codex/codex', declarationProjection: null }));
        await act(async () => { await catalog.getCurrent().reload(); });
        await waitForHomeGovernance(() => expect(catalog.getCurrent().condition?.reason).not.toBe('loading'));
        expect(teamRequests()).toHaveLength(0);
        expect(home.requestsFor('/v1/teams/credential-resources/entitled/discover')).toHaveLength(0);
        expect(catalog.getCurrent()).toMatchObject({ resources: [], current: false, condition: null });

        window.location.pathname = '/embed/session/created';
        await catalog.rerender();
        await act(async () => { await catalog.getCurrent().reload(); });
        expect(teamRequests()).toHaveLength(0);
        expect(home.requestsFor('/v1/teams/credential-resources/entitled/discover')).toHaveLength(0);
        expect(catalog.getCurrent()).toMatchObject({ resources: [], current: false, condition: null });
    });
});
