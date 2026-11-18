import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';
import { PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { useTeamSharedResourcesSummary } = await import('./useTeamSharedResourcesSummary');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { publishHomeAccountChange, publishHomeAccountChangeWake } = await import('@/sync/runtime/orchestration/homeAccountChange');

beforeEach(async () => { resetTeamActionClientForTests(); await home.reset(); });
afterEach(async () => { standardCleanup(); resetTeamActionClientForTests(); await home.reset(); });

it('counts only on visible demand, existing resource pushes and reopening without loading resource pages', async () => {
    const serverId = await home.addHome({ name: 'Resource Home', serverUrl: 'https://resource-demand.example.test',
        accountId: 'resource-reader', teamsEnabled: true });
    const scope = { serverId, accountId: 'resource-reader' };
    const address = { serverId, teamId: 'selected-team' };
    const request = bindHomeDomainActionHttpRequestV1(TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1, { v: 1, teamId: address.teamId });
    const answer = (count: number) => ({ teamId: address.teamId, kinds: [
        { kind: 'projectSources', status: 'available', count },
        { kind: 'credentials', status: 'unavailable', count: null, reason: 'team_authentication_required' },
    ] });
    home.answer(serverId, request.path, { body: answer(1) });
    const screen = await renderHook((values: { enabled: boolean }) => useTeamSharedResourcesSummary({
        scope: { ...scope }, address: { ...address }, enabled: values.enabled,
    }), { initialProps: { enabled: false } });
    expect(home.requestsFor(request.path)).toHaveLength(0);
    await screen.rerender({ enabled: true });
    await waitForHomeGovernance(() => expect(screen.getCurrent().isCurrent).toBe(true));
    expect(screen.getCurrent().kinds).toEqual(answer(1).kinds);
    const rows = screen.getCurrent().kinds;
    await screen.rerender({ enabled: true });
    expect(screen.getCurrent().kinds).toBe(rows);
    expect(home.requestsFor(request.path)).toHaveLength(1);
    home.answer(serverId, request.path, { body: answer(2) });
    await act(async () => { publishHomeAccountChange(serverId, [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1]); });
    await waitForHomeGovernance(() => expect(screen.getCurrent().kinds).toEqual(answer(2).kinds));
    expect(home.requestsFor(request.path)).toHaveLength(2);
    await screen.rerender({ enabled: false });
    await act(async () => { publishHomeAccountChange(serverId, [PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1]); });
    expect(home.requestsFor(request.path)).toHaveLength(2);
    await screen.rerender({ enabled: true });
    await waitForHomeGovernance(() => expect(screen.getCurrent().isCurrent).toBe(true));
    expect(home.requestsFor(request.path)).toHaveLength(3);
    expect(home.requests.filter(row => row.path.includes('/projects/sources') || row.path.includes('/artifacts') || row.path.includes('/machines'))).toEqual([]);
    await act(async () => { await home.switchAccount(serverId, 'replacement-reader'); });
    await waitForHomeGovernance(() => expect(screen.getCurrent().kinds).toEqual([]));
    expect(screen.getCurrent().isCurrent).toBe(false);
});

it('never retargets a Team address to another Home credential', async () => {
    const serverId = await home.addHome({ name: 'Selected Home', serverUrl: 'https://resource-scope.example.test',
        accountId: 'scope-reader', teamsEnabled: true });
    const screen = await renderHook(() => useTeamSharedResourcesSummary({
        scope: { serverId, accountId: 'scope-reader' }, address: { serverId: 'another-home', teamId: 'selected-team' }, enabled: true,
    }));
    expect(screen.getCurrent().kinds).toEqual([]);
    expect(screen.getCurrent().isCurrent).toBe(false);
    expect(home.requests.some(row => row.path.includes('/shared-resources/summary'))).toBe(false);
});

it('shows the retained summary rows immediately when the Team page is reopened', async () => {
    const serverId = await home.addHome({ name: 'Retained Home', serverUrl: 'https://retained-summary.example.test',
        accountId: 'retained-reader', teamsEnabled: true });
    const scope = { serverId, accountId: 'retained-reader' };
    const address = { serverId, teamId: 'selected-team' };
    const request = bindHomeDomainActionHttpRequestV1(TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1, { v: 1, teamId: address.teamId });
    const first = { teamId: address.teamId, kinds: [{ kind: 'sessions', status: 'available', count: 4 }] } as const;
    const second = { teamId: address.teamId, kinds: [{ kind: 'sessions', status: 'available', count: 5 }] } as const;
    home.answer(serverId, request.path, { body: first });
    const firstScreen = await renderHook(() => useTeamSharedResourcesSummary({ scope, address, enabled: true }));
    await waitForHomeGovernance(() => expect(firstScreen.getCurrent().isCurrent).toBe(true));
    await firstScreen.unmount();

    const pending = new Promise<void>(() => {});
    home.answer(serverId, request.path, { body: second, respondAfter: pending });
    const reopened = await renderHook(() => useTeamSharedResourcesSummary({ scope, address, enabled: true }));
    expect(reopened.getCurrent().kinds).toEqual(first.kinds);
    expect(reopened.getCurrent().status).toBe('loading');
    await reopened.unmount();
});

it('ignores known settings and profile changes while retaining membership, share and recovery refreshes', async () => {
    const serverId = await home.addHome({ name: 'Routing Home', serverUrl: 'https://resource-routing.example.test',
        accountId: 'routing-reader', teamsEnabled: true });
    const scope = { serverId, accountId: 'routing-reader' };
    const address = { serverId, teamId: 'selected-team' };
    const request = bindHomeDomainActionHttpRequestV1(TEAM_SHARED_RESOURCES_SUMMARY_ACTION_ID_V1, { v: 1, teamId: address.teamId });
    home.answer(serverId, request.path, { body: { teamId: address.teamId, kinds: [
        { kind: 'projectSources', status: 'available', count: 1 },
    ] } });
    const screen = await renderHook(() => useTeamSharedResourcesSummary({ scope, address, enabled: true }));
    await waitForHomeGovernance(() => expect(screen.getCurrent().isCurrent).toBe(true));
    const rows = screen.getCurrent().kinds;
    await act(async () => {
        for (let version = 1; version <= 20; version++) {
            publishHomeAccountChangeWake(serverId, { t: 'account-settings-changed', settingsVersion: version }, 'socket');
            publishHomeAccountChangeWake(serverId, { t: 'account-change', changeKinds: ['account'], entityIds: ['public-profile'] }, 'socket');
        }
    });
    expect(home.requestsFor(request.path)).toHaveLength(1);
    expect(screen.getCurrent().kinds).toBe(rows);
    for (const entityId of [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1, PROJECT_SOURCES_ACCOUNT_CHANGE_ENTITY_ID_V1]) {
        const before = home.requestsFor(request.path).length;
        await act(async () => { publishHomeAccountChangeWake(serverId, {
            t: 'account-change', changeKinds: ['account'], entityIds: [entityId],
        }, 'socket'); });
        await waitForHomeGovernance(() => expect(home.requestsFor(request.path)).toHaveLength(before + 1));
    }
    home.answer(serverId, request.path, { body: { teamId: address.teamId, kinds: [
        { kind: 'sessions', status: 'available', count: 2 },
    ] } });
    await act(async () => { publishHomeAccountChangeWake(serverId, {
        t: 'account-change', changeKinds: ['share'], entityIds: ['shared-session'],
    }, 'socket'); });
    await waitForHomeGovernance(() => expect(home.requestsFor(request.path)).toHaveLength(4));
    await waitForHomeGovernance(() => expect(screen.getCurrent().kinds).toEqual([
        { kind: 'sessions', status: 'available', count: 2 },
    ]));
    await act(async () => { publishHomeAccountChange(serverId, undefined, { source: 'snapshot' }); });
    await waitForHomeGovernance(() => expect(home.requestsFor(request.path)).toHaveLength(5));
    await act(async () => { publishHomeAccountChange(serverId, undefined, { source: 'connected' }); });
    await waitForHomeGovernance(() => expect(home.requestsFor(request.path)).toHaveLength(6));
    await act(async () => { publishHomeAccountChange(serverId); });
    await waitForHomeGovernance(() => expect(home.requestsFor(request.path)).toHaveLength(7));
});
