import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1} from '@happier-dev/protocol/changes';
import { TeamDirectoryPersonV1Schema } from '@happier-dev/protocol/teams';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const routerPush = vi.hoisted(() => vi.fn());
installSettingsViewCommonModuleMocks({
    storage: 'real',
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: routerPush } }).module,
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { DirectoryPeopleList } = await import('./DirectoryPeopleList');
beforeEach(() => installHomeGovernanceBoundaries(harness));
afterEach(async () => { standardCleanup(); routerPush.mockReset(); await harness.reset(); });

const path = '/v1/teams/team-1/directory-sources/source-1/people?limit=50';
const person = TeamDirectoryPersonV1Schema.parse({
    v: 1, id: 'person-1', sourceId: 'source-1', externalUserId: 'external-1',
    displayName: 'Ada', email: null, externalLogin: null, state: 'active',
    accountBinding: { state: 'unbound' }, sourceLabel: 'Directory',
});

async function mountPeople() {
    const serverId = await harness.addHome({ name: 'Directory Home', serverUrl: 'https://directory-people.example', accountId: 'account-1', teamsEnabled: true });
    harness.answer(serverId, path, { body: { items: [person], nextCursor: 'next' } });
    const screen = await renderScreen(<DirectoryPeopleList scope={{ serverId, accountId: 'account-1' }} address={{ serverId, teamId: 'team-1' }} sourceId="source-1" />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('directory-person:person-1'), JSON.stringify(harness.requests.map((request) => request.path))).not.toBeNull());
    return { serverId, screen };
}

describe('Directory people read outcomes', () => {
    it('distinguishes provisioned people from bound members and opens only a bound membership', async () => {
        const serverId = await harness.addHome({ name: 'Directory Home', serverUrl: 'https://directory-people.example', accountId: 'account-1', teamsEnabled: true });
        const bound = TeamDirectoryPersonV1Schema.parse({ ...person, id: 'person-bound', externalUserId: 'external-bound', displayName: 'Grace Member',
            accountBinding: { state: 'bound', accountId: 'account-grace', teamMembershipId: 'membership-grace' } });
        harness.answer(serverId, path, { body: { items: [person, bound], nextCursor: null } });
        const screen = await renderScreen(<DirectoryPeopleList scope={{ serverId, accountId: 'account-1' }} address={{ serverId, teamId: 'team-1' }} sourceId="source-1" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('directory-person:person-bound')).not.toBeNull());
        expect(screen.getTextContent()).toContain('teams.authentication.directory.people.provisioned');
        expect(screen.findByTestId('directory-person:person-1')?.props.onPress).toBeUndefined();
        expect(screen.getTextContent()).toContain('teams.authentication.directory.people.member');
        await screen.pressByTestIdAsync('directory-person:person-bound');
        expect(routerPush).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/members/membership-grace`);
    });

    it('withdraws previously loaded people after an authoritative denial without showing a false empty state', async () => {
        const { serverId, screen } = await mountPeople();
        harness.answer(serverId, `${path}&cursor=next`, { status: 403, body: { error: 'forbidden' } });
        await screen.pressByTestIdAsync('directory-people-load-more');
        await waitForHomeGovernance(() => expect(screen.findByTestId('directory-people-load-more')?.props.loading).not.toBe(true));
        expect(screen.findByTestId('directory-person:person-1')).toBeNull();
        expect(screen.findByTestId('directory-people-error')).not.toBeNull();
        expect(screen.findByTestId('directory-people-empty')).toBeNull();
        expect(screen.findByTestId('directory-people-retry')).toBeNull();
    });

    it('keeps a loaded page on transport failure and recovers through the rendered retry', async () => {
        const { serverId, screen } = await mountPeople();
        harness.answer(serverId, `${path}&cursor=next`, { dispatchThenFail: true });
        await screen.pressByTestIdAsync('directory-people-load-more');
        await waitForHomeGovernance(() => expect(screen.findByTestId('directory-people-retry')).not.toBeNull());
        expect(screen.findByTestId('directory-person:person-1')).not.toBeNull();
        expect(harness.requestsFor(`${path}&cursor=next`)).toHaveLength(1);
        harness.answer(serverId, path, { body: { items: [{ ...person, displayName: 'Ada refreshed' }], nextCursor: null } });
        await screen.pressByTestIdAsync('directory-people-retry');
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Ada refreshed'));
        expect(screen.findByTestId('directory-people-error')).toBeNull();
    });

    it('reloads its mounted roster for its own Home Team change and ignores another Home', async () => {
        const { serverId, screen } = await mountPeople();
        const before = harness.requestsFor(path).length;
        harness.answer(serverId, path, { body: { items: [{ ...person, displayName: 'After rename' }], nextCursor: null } });
        publishHomeAccountChange('other-home', [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]);
        await React.act(async () => { await Promise.resolve(); });
        expect(harness.requestsFor(path)).toHaveLength(before);
        expect(screen.getTextContent()).toContain('Ada');
        await React.act(async () => { publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]); });
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('After rename'));
    });
});
