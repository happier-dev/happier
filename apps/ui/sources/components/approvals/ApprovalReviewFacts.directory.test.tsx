import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { TeamDirectoryGroupV1Schema } from '@happier-dev/protocol/teams';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { teamDirectorySourceFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { t } from '@/text';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');
const { captureServerCredentialAccountScopeLifetime, resolveServerCredentialAccountScope } =
    await import('@/sync/domains/scope/serverCredentialAccountScope');
const { managedIdentityQueryKey } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
const { teamDirectorySourcePages, teamDirectoryGroupObservationKey, teamDirectoryGroupPages } = await import('@/sync/store/teams/teamsSnapshots');

beforeEach(async () => { standardCleanup(); await harness.reset(); });
afterEach(async () => { standardCleanup(); await harness.reset(); });

it.each([
    ['teams.externalGroupBindings.set', true],
    ['teams.externalGroupBindings.remove', true],
    ['teams.externalGroupBindings.remove', false],
] as const)('reviews %s through the viewer’s directory projection (readable %s)', async (actionId, readable) => {
    const home = await harness.addHome({ name: 'Review Home', serverUrl: 'https://directory-review.test', accountId: 'reviewer' });
    const resolution = await resolveServerCredentialAccountScope(home);
    if (resolution.kind !== 'bound') throw new Error('Missing reviewer credentials');
    const binding = captureServerCredentialAccountScopeLifetime(resolution);
    const source = teamDirectorySourceFixture({ id: '9e9b44d4-2167-4837-adb5-92dc43f3b481', displayName: 'Research directory' });
    const externalGroupId = '3d703df7-5a51-4be7-91ec-dc877ae861ab';
    const bindingId = '67cffe92-bd4e-4b28-8512-706b1cc4ab77';
    const row = TeamDirectoryGroupV1Schema.parse({
        v: 1, id: 'directory-group', sourceId: source.id, externalGroupId, displayName: 'Research engineers',
        state: 'active', memberCount: null, boundAccountCount: null, unboundPeopleCount: null,
        lastCompleteObservationAt: null, sourceLabel: source.displayName,
        mapping: { state: 'bound', bindingId, mode: 'directory_created', teamGroupId: 'local-group', teamGroupName: null },
    });
    const scope = readable ? binding.scope : { ...binding.scope, accountId: 'other' };
    const address = { teamId: source.teamId, serverId: binding.scope.serverId };
    teamDirectorySourcePages.apply(managedIdentityQueryKey(scope, source.teamId), binding, { items: [source], nextCursor: null });
    teamDirectoryGroupPages.apply(teamDirectoryGroupObservationKey(scope, address, source.id, ''),
        binding, { items: [row], nextCursor: null });
    const args = getActionSpec(actionId).inputSchema.parse(actionId === 'teams.externalGroupBindings.set'
        ? { v: 1, teamId: source.teamId, externalGroupId, owner: { kind: 'directory_source', directorySourceId: source.id },
            target: { kind: 'directory_created' } }
        : { v: 1, teamId: source.teamId, bindingId });
    const exactId = actionId === 'teams.externalGroupBindings.set' ? externalGroupId : bindingId;
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={args}
        preview={null} status="open" serverId={home} testID="directory-mapping-case" />);
    try {
        await waitForHomeGovernance(() => {
            const text = screen.getTextContent();
            expect(text).toContain(readable ? row.displayName : t('common.unavailable'));
            if (!readable) expect(text).not.toContain(row.displayName);
            if (actionId === 'teams.externalGroupBindings.set') expect(text).toContain(source.displayName);
            expect(text).not.toContain(exactId);
        });
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(exactId);
    } finally { await screen.unmount(); }
});

it('reviews a GitHub organization directory by its picker kind and entered name', async () => {
    const actionId = 'teams.directory.sources.create';
    const installationId = '9e9b44d4-2167-4837-adb5-92dc43f3b481';
    const args = getActionSpec(actionId).inputSchema.parse({
        v: 1, teamId: 'research-team', kind: 'github_organization', displayName: 'Research organization',
        githubAppInstallationId: installationId,
    });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={args}
        preview={null} status="open" serverId={null} testID="directory-source-create-review" />);
    try {
        expect(screen.getTextContent()).toContain(t('teams.authentication.directory.kind.github'));
        expect(screen.getTextContent()).toContain('Research organization');
        expect(screen.getTextContent()).not.toContain(installationId);
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(installationId);
    } finally { await screen.unmount(); }
});

it.each(['active', 'paused', 'other Account'] as const)('reviews a directory sync against the scoped source name (%s)', async state => {
    const home = await harness.addHome({ name: 'Review Home', serverUrl: 'https://directory-review.test', accountId: 'reviewer' });
    const resolution = await resolveServerCredentialAccountScope(home);
    if (resolution.kind !== 'bound') throw new Error('Missing reviewer credentials');
    const binding = captureServerCredentialAccountScopeLifetime(resolution);
    const source = teamDirectorySourceFixture({ id: '9e9b44d4-2167-4837-adb5-92dc43f3b481', displayName: 'Research directory',
        state: state === 'paused' ? 'paused' : 'active' });
    const scope = state === 'other Account' ? { ...binding.scope, accountId: 'other' } : binding.scope;
    teamDirectorySourcePages.apply(managedIdentityQueryKey(scope, source.teamId), binding, { items: [source], nextCursor: null });
    const actionId = 'teams.directory.sources.sync';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ v: 1, teamId: source.teamId, sourceId: source.id });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={home} testID="directory-review" />);
    try {
        await waitForHomeGovernance(() => {
            const text = screen.getTextContent();
            expect(text).not.toContain(source.id);
            if (state === 'other Account') {
                expect(text).not.toContain(source.displayName);
                expect(text).toContain(t('common.unavailable'));
            } else expect(text).toContain(source.displayName);
        });
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(source.id);
    } finally { await screen.unmount(); }
});

it('labels the owners and admins roster filter', async () => {
    const actionId = 'teams.members.list';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ v: 1, teamId: 'research-team', filter: 'owners_admins', query: 'Ada' });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={null} testID="member-roster-review" />);
    try {
        const text = screen.getTextContent();
        expect(text).toContain(t('teams.members.filterOwnersAndAdmins'));
        expect(text).toContain('Ada');
        expect(text).not.toContain('owners_admins');
    } finally { await screen.unmount(); }
});


it('names the directory that owns the external Group mappings being read', async () => {
    const home = await harness.addHome({ name: 'Review Home', serverUrl: 'https://directory-review.test', accountId: 'reviewer' });
    const resolution = await resolveServerCredentialAccountScope(home);
    if (resolution.kind !== 'bound') throw new Error('Missing reviewer credentials');
    const binding = captureServerCredentialAccountScopeLifetime(resolution);
    const source = teamDirectorySourceFixture({ id: '9e9b44d4-2167-4837-adb5-92dc43f3b481', displayName: 'Research directory' });
    teamDirectorySourcePages.apply(managedIdentityQueryKey(binding.scope, source.teamId), binding, { items: [source], nextCursor: null });
    const actionId = 'teams.externalGroupBindings.list';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ v: 1, teamId: source.teamId,
        ownerKind: 'directory_source', directorySourceId: source.id });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={home} testID="directory-mapping-review" />);
    try {
        await waitForHomeGovernance(() => {
            const text = screen.getTextContent();
            expect(text).toContain(source.displayName);
            expect(text).toContain(t('teams.authentication.directory.section'));
            expect(text).not.toContain(source.id);
            expect(text).not.toContain('directory_source');
        });
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(source.id);
    } finally { await screen.unmount(); }
});
