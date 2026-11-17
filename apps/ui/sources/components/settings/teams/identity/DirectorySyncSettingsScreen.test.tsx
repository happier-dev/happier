import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { TeamDirectorySourcePageV1Schema, TeamDirectorySourceSetupOptionsV1Schema } from '@happier-dev/protocol/teams';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { createDeferred, renderScreen, standardCleanup, teamCapabilitiesFixture, teamSummaryFixture, teamDirectorySourceFixture, teamIdentityConnectionFixture } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

const routerPush = vi.hoisted(() => vi.fn());
const openExternalUrl = vi.hoisted(() => vi.fn(async () => true));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: routerPush } }).module);
vi.mock('react-native', async () => {
    const native = await (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock();
    return { ...native, Platform: { ...native.Platform, OS: 'ios' } };
});
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl }));
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { DirectorySyncSettingsScreen } = await import('./DirectorySyncSettingsScreen');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { Modal } = await import('@/modal');
const listPath = '/v1/teams/team-1/directory-sources';
const setupPath = '/v1/teams/team-1/directory-source-setup-options';
const createPath = listPath;
const connectionPath = '/v1/teams/identity/workos/connection/create';
const portalPath = '/v1/teams/identity/workos/admin-portal-link/create';
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
let serverId: string;
function requestsAt(path: string) {
    return harness.requests.filter(request => new URL(request.path, request.serverUrl).pathname === path);
}
function directorySource(id: string) {
    return teamDirectorySourceFixture({ id, displayName: id });
}
function setup(ids: string[] = ['installation-1'], nextCursor: string | null = null) {
    return TeamDirectorySourceSetupOptionsV1Schema.parse({ v: 1, items: ids.map(id => ({ kind: 'github_organization', displayName: 'happier-dev', githubAppInstallationId: id })), nextCursor, complete: nextCursor === null });
}
function connection(id = 'connection-1') {
    return teamIdentityConnectionFixture({ id, provider: { id: 'provider-1', kind: 'workos_sso', displayName: 'WorkOS' }, externalReference: { v: 1, kind: 'workos_sso', organizationId: null, connectionId: null }, settings: { v: 1, kind: 'workos_sso' }, enabled: false, firstEnabledAt: null, state: 'setting_up', lastObservation: null });
}
async function renderDirectory() {
    const screen = await renderScreen(<DirectorySyncSettingsScreen serverId={serverId} teamId="team-1" />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('team-directory-source-add'), screen.getTextContent()).not.toBeNull());
    return screen;
}
async function openSetup(screen: Awaited<ReturnType<typeof renderDirectory>>) {
    await screen.pressByTestIdAsync('team-directory-source-add');
    await waitForHomeGovernance(() => expect(screen.findByTestId('team-directory-setup-workos')).not.toBeNull());
}
async function changeTeams() {
    await act(async () => publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]));
}
beforeEach(async () => {
    standardCleanup();
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    await harness.reset();
    serverId = await harness.addHome({ name: 'Identity Home', serverUrl: 'https://identity-home.example', accountId: 'account-1', teamsEnabled: true });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageAuthentication: true }) }) });
    harness.answer(serverId, listPath, { body: TeamDirectorySourcePageV1Schema.parse({ items: [], nextCursor: null }) });
    harness.answer(serverId, setupPath, { body: setup() });
    routerPush.mockReset();
    openExternalUrl.mockReset().mockResolvedValue(true);
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(true);
});
describe('DirectorySyncSettingsScreen through real Home governance', () => {
    it('keeps setup discoverable but disabled for an archived Team', async () => {
        harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({ archivedAt: 1, capabilities: teamCapabilitiesFixture({ manageAuthentication: true }) }) });
        const screen = await renderDirectory();
        expect(screen.findByTestId('team-directory-source-add')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('team-directory-source-add');
        expect(requestsAt(setupPath)).toHaveLength(0);
    });
    it('creates from the exact server-projected installation and refreshes the mounted list', async () => {
        harness.answer(serverId, `POST ${createPath}`, { body: directorySource('source-1') });
        const screen = await renderDirectory();
        await openSetup(screen);
        await screen.pressByTestIdAsync('team-directory-setup-option:github_organization:installation-1');
        await waitForHomeGovernance(() => expect(routerPush).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/authentication/directory/source-1`));
        expect(requestsAt(createPath).find(request => request.method === 'POST')?.input).toEqual({ v: 1, kind: 'github_organization', displayName: 'happier-dev', githubAppInstallationId: 'installation-1' });
        expect(requestsAt(listPath).filter(request => request.method === 'GET').length).toBeGreaterThan(1);
        expect(screen.findByTestId('team-directory-setup-option:github_organization:installation-1')).toBeNull();
    });
    it.each([true, false])('settles source creation through native Ask (accepted=%s)', async accepted => {
        await harness.requireUiApproval(serverId, 'teams.directory.sources.create');
        vi.mocked(Modal.confirm).mockResolvedValue(accepted);
        harness.answer(serverId, `POST ${createPath}`, { body: directorySource('source-approved') });
        const screen = await renderDirectory();
        await openSetup(screen);
        await screen.pressByTestIdAsync('team-directory-setup-option:github_organization:installation-1');
        await waitForHomeGovernance(() => expect(Modal.confirm).toHaveBeenCalledOnce());
        if (accepted) {
            await waitForHomeGovernance(() => expect(routerPush).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/authentication/directory/source-approved`));
            expect(screen.findByTestId('team-directory-setup-option:github_organization:installation-1')).toBeNull();
        } else {
            expect(requestsAt(createPath).filter(request => request.method === 'POST')).toHaveLength(0);
            expect(routerPush).not.toHaveBeenCalled();
            expect(screen.findByTestId('team-directory-setup-option:github_organization:installation-1')).not.toBeNull();
        }
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
    });
    it('accumulates source pages and opens a source from the later page', async () => {
        harness.answer(serverId, listPath, { select: (_input, request) => ({ body: new URL(request.url).searchParams.has('cursor')
            ? TeamDirectorySourcePageV1Schema.parse({ items: [directorySource('directory-51')], nextCursor: null })
            : TeamDirectorySourcePageV1Schema.parse({ items: [directorySource('directory-1')], nextCursor: 'cursor-1' }) }) });
        const screen = await renderDirectory();
        await screen.pressByTestIdAsync('team-directory-sources-load-more');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-directory-source-directory-51')).not.toBeNull());
        expect(screen.findByTestId('team-directory-source-directory-1')).not.toBeNull();
        expect(requestsAt(listPath)[1]?.path).toContain('cursor=cursor-1');
        await screen.pressByTestIdAsync('team-directory-source-directory-51');
        expect(routerPush).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/authentication/directory/directory-51`);
    });
    it('retains a source but refuses its stale cursor after a failed refresh', async () => {
        harness.answer(serverId, listPath, { body: TeamDirectorySourcePageV1Schema.parse({ items: [directorySource('directory-1')], nextCursor: 'cursor-1' }) });
        const screen = await renderDirectory();
        harness.answer(serverId, listPath, { status: 503, body: { error: 'home_unreachable' } });
        await changeTeams();
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-directory-stale')).not.toBeNull());
        expect(screen.findByTestId('team-directory-source-directory-1')).not.toBeNull();
        expect(screen.findByTestId('team-directory-sources-load-more')).toBeNull();
    });
    it('paginates setup discovery with the server cursor', async () => {
        harness.answer(serverId, setupPath, { select: (_input, request) => ({ body: setup([new URL(request.url).searchParams.has('cursor') ? 'installation-51' : 'installation-1'], new URL(request.url).searchParams.has('cursor') ? null : 'cursor-1') }) });
        const screen = await renderDirectory();
        await openSetup(screen);
        await screen.pressByTestIdAsync('team-directory-setup-load-more');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-directory-setup-option:github_organization:installation-51')).not.toBeNull());
        expect(screen.findByTestId('team-directory-setup-option:github_organization:installation-1')).not.toBeNull();
        expect(requestsAt(setupPath)[1]?.path).toContain('cursor=cursor-1');
    });
    it('refreshes visible setup candidates only for the matching Home Team change', async () => {
        const screen = await renderDirectory();
        await openSetup(screen);
        await act(async () => { publishHomeAccountChange('another-home', [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]); publishHomeAccountChange(serverId, ['home-governance']); });
        expect(requestsAt(setupPath)).toHaveLength(1);
        harness.answer(serverId, setupPath, { body: setup(['installation-new']) });
        await changeTeams();
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-directory-setup-option:github_organization:installation-new')).not.toBeNull());
    });
    it('retains setup choices and offers recovery when discovery refresh fails', async () => {
        const screen = await renderDirectory();
        await openSetup(screen);
        harness.answer(serverId, setupPath, { status: 503, body: { error: 'home_unreachable' } });
        await screen.pressByTestIdAsync('team-directory-source-add');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-directory-setup-retry')).not.toBeNull());
        expect(screen.findByTestId('team-directory-setup-option:github_organization:installation-1')).not.toBeNull();
    });
    it('presents recovery when the native browser cannot open the WorkOS portal', async () => {
        harness.answer(serverId, connectionPath, { body: { connection: connection() } });
        harness.answer(serverId, portalPath, { body: { url: 'https://workos.example/portal' } });
        openExternalUrl.mockResolvedValue(false);
        const screen = await renderDirectory();
        await openSetup(screen);
        await screen.pressByTestIdAsync('team-directory-setup-workos');
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('identityAdministration.errorInvalid'));
        expect(screen.getTextContent()).not.toContain('workos_portal_open_failed');
    });
    it('says who can configure WorkOS when the Home lacks it', async () => {
        harness.answer(serverId, connectionPath, { status: 503, body: { error: 'workos_platform_unavailable' } });
        const screen = await renderDirectory();
        await openSetup(screen);
        await screen.pressByTestIdAsync('team-directory-setup-workos');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-directory-setup-workos-unavailable')).not.toBeNull());
        expect(screen.getTextContent()).toContain('identityAdministration.errorWorkosPlatformUnavailable');
        expect(screen.getTextContent()).toMatch(/teams\.authentication\.add\.ask(Named|Unnamed)/);
    });
    it('confirms WorkOS creation and portal separately through native Ask', async () => {
        await harness.requireUiApproval(serverId, ['teams.identity.workos.connection.create', 'teams.identity.workos.adminPortalLink.create']);
        harness.answer(serverId, connectionPath, { body: { connection: connection('connection-approved') } });
        harness.answer(serverId, portalPath, { body: { url: 'https://workos.example/approved' } });
        const screen = await renderDirectory();
        await openSetup(screen);
        await screen.pressByTestIdAsync('team-directory-setup-workos');
        await waitForHomeGovernance(() => expect(openExternalUrl).toHaveBeenCalledWith('https://workos.example/approved'));
        expect(requestsAt(portalPath)[0]?.input).toEqual({ v: 1, teamId: 'team-1', connectionId: 'connection-approved', intent: 'dsync' });
        expect(Modal.confirm).toHaveBeenCalledTimes(2);
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
    });
    it('blocks setup while the authoritative directory read is refreshing', async () => {
        const screen = await renderDirectory();
        const held = createDeferred<void>();
        harness.answer(serverId, listPath, { body: TeamDirectorySourcePageV1Schema.parse({ items: [], nextCursor: null }), respondAfter: held.promise });
        await changeTeams();
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-directory-source-add')?.props.disabled).toBe(true));
        await screen.pressByTestIdAsync('team-directory-source-add');
        expect(requestsAt(setupPath)).toHaveLength(0);
        await act(async () => held.resolve());
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-directory-source-add')?.props.disabled).toBe(false));
    });
});
