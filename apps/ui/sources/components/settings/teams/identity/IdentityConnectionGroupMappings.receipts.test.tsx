import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamDirectoryGroupV1, TeamDirectorySourceSummaryV1, TeamExternalGroupBindingV1 } from '@happier-dev/protocol/teams';
import { TeamGroupNameProjectionV1Schema } from '@happier-dev/protocol/teams';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';

import { createDeferred, renderScreen, standardCleanup, teamCapabilitiesFixture, teamGroupFixture, teamSummaryFixture } from '@/dev/testkit';
import { teamCredentialDisplayNameFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

installSettingsViewCommonModuleMocks({ storage: 'real', modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
} });
// The third-party recycler needs native layout measurements that this host
// renderer cannot supply. Keep Happier's list owner and domain reads real.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>() }).module;
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Load real surfaces after boundary installation, outside any case's deadline.
const { IdentityConnectionGroupMappings } = await import('./IdentityConnectionGroupMappings');
const { DirectorySourceDetailScreen } = await import('./DirectorySourceDetailScreen');
const PATH = '/v1/teams/team-1/external-group-bindings';
const LIST_PATH = bindHomeDomainActionHttpRequestV1('teams.externalGroupBindings.list', {
    v: 1, teamId: 'team-1', ownerKind: 'identity_connection', teamIdentityConnectionId: 'connection-1', limit: 50, cursor: null,
}).path;
const binding: TeamExternalGroupBindingV1 = {
    v: 1, id: 'binding-1', teamId: 'team-1',
    owner: { kind: 'identity_connection', teamIdentityConnectionId: 'connection-1' },
    externalGroupId: 'engineering', mode: 'directory_created',
    target: { teamGroupId: 'group-1', name: TeamGroupNameProjectionV1Schema.parse({
        kind: 'available', label: teamCredentialDisplayNameFixture('Engineering'),
    }), archivedAt: null },
};

beforeEach(async () => { await harness.reset(); });
afterEach(standardCleanup);

describe('IdentityConnectionGroupMappings list refusals', () => {
    async function renderMappings(serverId: string) {
        return renderScreen(<IdentityConnectionGroupMappings
            scope={{ serverId, accountId: 'owner' }} address={{ serverId, teamId: 'team-1' }}
            connectionId="connection-1" mutationsAvailable requestApproval={() => undefined}
        />);
    }

    it.each([
        { status: 403, code: 'team_authentication_required', message: 'session.access.authenticationRequired', action: 'sign-in' },
        { status: 503, code: 'team_authentication_unavailable', message: 'teams.credentials.externalApi.authenticationUnavailable', action: null },
        { status: 403, code: 'team_forbidden', message: 'errors.permissionDenied', action: null },
        { status: 404, code: 'team_not_found', message: 'teams.errors.notFound', action: null },
        { status: 409, code: 'team_archived', message: 'teams.errors.archived', action: null },
        { status: 400, code: 'directory_group_mapping_invalid', message: 'identityAdministration.errorMissing', action: null },
        { status: 400, code: 'invalid_team_input', message: 'homeGovernance.invalidRead', action: null },
        { status: 404, code: 'teams_unavailable', message: 'teams.unavailable.disabled', action: null },
        { status: 502, code: 'server_error', message: 'teams.errors.loadFailed', action: 'retry' },
    ])('presents the $code refusal and only the available recovery', async ({ status, code, message, action }) => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://identity-home.example', accountId: 'owner', teamsEnabled: true });
        harness.answer(serverId, `GET ${LIST_PATH}`, { status, body: { error: code } });
        const screen = await renderMappings(serverId);
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(message));
        expect(screen.getTextContent().split(message)).toHaveLength(2);
        expect(screen.findByTestId('identity-group-bindings-retry') !== null).toBe(action === 'retry');
        expect(screen.findByTestId('identity-group-bindings-sign-in') !== null).toBe(action === 'sign-in');
    });

    it('opens a fresh first page after a rejected continuation', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://identity-home.example', accountId: 'owner', teamsEnabled: true });
        const continuation = bindHomeDomainActionHttpRequestV1('teams.externalGroupBindings.list', {
            v: 1, teamId: 'team-1', ownerKind: 'identity_connection', teamIdentityConnectionId: 'connection-1', limit: 50, cursor: 'expired',
        }).path;
        harness.answer(serverId, `GET ${LIST_PATH}`, { body: { items: [binding], nextCursor: 'expired' } });
        harness.answer(serverId, `GET ${continuation}`, { status: 400, body: { error: 'invalid_team_cursor' } });
        const screen = await renderMappings(serverId);
        await waitForHomeGovernance(() => expect(screen.findByTestId('identity-group-bindings-load-more')).not.toBeNull());
        await screen.pressByTestIdAsync('identity-group-bindings-load-more');
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('teams.errors.listCursorExpired'));
        expect(screen.findByTestId('identity-group-bindings-retry')).toBeNull();
        harness.answer(serverId, `GET ${LIST_PATH}`, { body: { items: [], nextCursor: null } });
        await screen.pressByTestIdAsync('identity-group-bindings-reload');
        await waitForHomeGovernance(() => expect(screen.getTextContent()).not.toContain('teams.errors.listCursorExpired'));
        expect(harness.requestsFor(LIST_PATH)).toHaveLength(2);
        expect(harness.requestsFor(continuation)).toHaveLength(1);
    });
});

describe('IdentityConnectionGroupMappings acknowledged writes', () => {
    it('offers only a supported mapping target on a sign-in connection', async () => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://identity-home.example', accountId: 'owner', teamsEnabled: true });
        harness.answer(serverId, `GET ${LIST_PATH}`, { body: { items: [], nextCursor: null } });
        const screen = await renderScreen(<IdentityConnectionGroupMappings
            scope={{ serverId, accountId: 'owner' }} address={{ serverId, teamId: 'team-1' }}
            connectionId="connection-1" mutationsAvailable requestApproval={() => undefined}
        />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('identity-group-map-existing')).not.toBeNull());
        expect(screen.findByTestId('identity-group-map-create')).toBeNull();
    });


    it.each(['set', 'remove'] as const)('releases %s pending state while its list revalidation is pending', async (operation) => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://identity-home.example', accountId: 'owner', teamsEnabled: true });
        harness.answer(serverId, `GET ${LIST_PATH}`, { body: { items: operation === 'remove' ? [binding] : [], nextCursor: null } });
        harness.answer(serverId, '/v1/teams/groups/list', { body: { items: [teamGroupFixture({ name: 'Engineering' })], nextCursor: null } });
        harness.answer(serverId, `PUT ${PATH}`, { body: { ...binding, mode: 'native_target' } });
        harness.answer(serverId, `DELETE ${PATH}/binding-1`, { body: { v: 1, outcome: 'removed' } });
        const screen = await renderScreen(<IdentityConnectionGroupMappings
            scope={{ serverId, accountId: 'owner' }} address={{ serverId, teamId: 'team-1' }}
            connectionId="connection-1" mutationsAvailable requestApproval={() => undefined}
        />);
        await vi.waitFor(() => expect(harness.requestsFor(LIST_PATH), screen.getTextContent()).toHaveLength(1));
        if (operation === 'set') {
            act(() => screen.changeTextByTestId('identity-external-group-id', 'engineering'));
            await screen.pressByTestIdAsync('identity-group-map-existing');
            await waitForHomeGovernance(() => expect(screen.findByTestId('identity-group-native-target:group-1')).not.toBeNull());
        } else {
            await waitForHomeGovernance(() => expect(screen.findByTestId('identity-group-binding:binding-1')).not.toBeNull());
        }
        const refresh = createDeferred<void>();
        harness.answer(serverId, `GET ${LIST_PATH}`, { body: { items: [binding], nextCursor: null }, respondAfter: refresh.promise });
        const control = operation === 'set' ? 'identity-group-map-existing' : 'identity-group-binding:binding-1';
        act(() => screen.pressByTestId(operation === 'set' ? 'identity-group-native-target:group-1' : control));
        try {
            // The accepted write has reached the list revalidation. That read
            // remains held; only the acknowledged write should release pending.
            await vi.waitFor(() => expect(harness.requestsFor(LIST_PATH)).toHaveLength(2));
            if (operation === 'set') {
                expect(harness.requestsFor(PATH)[0]?.input).toMatchObject({ target: { kind: 'native_target', teamGroupId: 'group-1' } });
            }
            await vi.waitFor(() => {
                expect(screen.findByTestId(control)).not.toBeNull();
                expect(screen.findAllByTestId(control).some(node => node.props.loading === true)).toBe(false);
            });
        } finally {
            await act(async () => { refresh.resolve(); });
        }
    });
});

describe('DirectorySourceDetailScreen acknowledged mappings', () => {
    it.each(['set', 'remove'] as const)('releases %s pending state while its directory list revalidation is pending', async (operation) => {
        const serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://directory-home.example', accountId: 'owner', teamsEnabled: true });
        const source: TeamDirectorySourceSummaryV1 = {
            v: 1, id: 'source-1', teamId: 'team-1', kind: 'github_organization', displayName: 'Engineering',
            state: 'active', allowedActions: [], error: null,
            sync: { mode: 'full_only', attempt: 'succeeded', freshness: 'fresh', lastAttemptAt: null,
                lastSuccessAt: null, lastFullReconcileAt: null, nextScheduledAt: null },
        };
        const group: TeamDirectoryGroupV1 = {
            v: 1, id: 'external-1', sourceId: source.id, externalGroupId: binding.externalGroupId,
            displayName: 'Engineering', state: 'active', memberCount: 0, boundAccountCount: 0, unboundPeopleCount: 0,
            mapping: operation === 'remove'
                ? { state: 'bound', bindingId: binding.id, mode: binding.mode, teamGroupId: binding.target.teamGroupId,
                    teamGroupName: binding.target.name }
                : { state: 'unbound' },
            lastCompleteObservationAt: null, sourceLabel: source.displayName,
        };
        const groupsPath = bindHomeDomainActionHttpRequestV1('teams.directory.groups.list', {
            v: 1, teamId: 'team-1', sourceId: source.id, limit: 50, cursor: null,
        }).path;
        const peoplePath = bindHomeDomainActionHttpRequestV1('teams.directory.people.list', {
            v: 1, teamId: 'team-1', sourceId: source.id, limit: 50, cursor: null,
        }).path;
        harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({
            capabilities: teamCapabilitiesFixture({ manageAuthentication: true, manageGroups: true }),
        }) });
        harness.answer(serverId, '/v1/teams/groups/list', { body: { items: [], nextCursor: null } });
        harness.answer(serverId, '/v1/teams/team-1/directory-sources/source-1', { body: source });
        harness.answer(serverId, peoplePath, { body: { items: [], nextCursor: null } });
        harness.answer(serverId, groupsPath, { body: { items: [group], nextCursor: null } });
        harness.answer(serverId, `PUT ${PATH}`, { body: { ...binding, owner: { kind: 'directory_source', directorySourceId: source.id } } });
        harness.answer(serverId, `DELETE ${PATH}/binding-1`, { body: { v: 1, outcome: 'removed' } });
        const screen = await renderScreen(<DirectorySourceDetailScreen serverId={serverId} teamId="team-1" sourceId={source.id} />);
        await vi.waitFor(() => expect(screen.findByTestId('directory-group:external-1'), screen.getTextContent()).not.toBeNull());
        await screen.pressByTestIdAsync('directory-group:external-1');
        const refresh = createDeferred<void>();
        harness.answer(serverId, groupsPath, { body: { items: [group], nextCursor: null }, respondAfter: refresh.promise });
        act(() => screen.pressByTestId(operation === 'set' ? 'directory-group-map-create' : 'directory-group-remove-mapping'));
        try {
            await vi.waitFor(() => expect(harness.requestsFor(groupsPath)).toHaveLength(2));
            await vi.waitFor(() => {
                expect(screen.findByTestId('directory-group:external-1')).not.toBeNull();
                expect(screen.findAllByTestId('directory-group:external-1').some(node => node.props.loading === true)).toBe(false);
            });
        } finally {
            await act(async () => { refresh.resolve(); });
        }
    });
});
