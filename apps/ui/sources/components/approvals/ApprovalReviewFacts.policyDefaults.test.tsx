import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { TEAM_POLICY_SET_ACTION_ID_V1 } from '@happier-dev/protocol/teams/actionIdsV1';
import { ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture, createMachineMetadataFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { storage } from '@/sync/domains/state/storage';
import { preloadTranslations, setPreferredLanguageFromSettings } from '@/text';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');

const homeId = 'srv_policy_review';
const machineId = 'f20c797b-449f-4aa6-8b89-01fcfcaed022';
const presetId = '67cffe92-bd4e-4b28-8512-706b1cc4ab77';

beforeEach(async () => {
    standardCleanup();
    await harness.reset();
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
});
afterEach(() => { standardCleanup(); setPreferredLanguageFromSettings('en'); });

it.each([true, false])('shows a Home Session default Machine through the viewer’s catalog (readable %s)', async readable => {
    const policyHomeId = readable ? homeId : 'srv_policy_other';
    const accountId = readable ? 'policy-reviewer' : 'other-reviewer';
    const serverId = await harness.addHome({ name: 'Review Home', serverUrl: `https://${accountId}.test`,
        serverIdentityId: homeId, accountId, currentAccount: true });
    storage.getState().activateProfileScope({ serverId, accountId });
    storage.setState({ settingsScope: { serverId, accountId } });
    storage.getState().applyMachines([createMachineFixture({ id: machineId,
        metadata: createMachineMetadataFixture({ displayName: 'Policy runner' }) })], true,
    { sourceServerId: serverId, sourceAccountId: accountId });
    storage.getState().markMachineListSettled(serverId);
    const actionId = 'home.policy.set';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ expectedRevision: 1,
        sessionDefaults: { placement: { kind: 'machine', target: { serverId: policyHomeId, machineId } } },
        teamProviderPolicy: { v: 1, allowedTeamProviderKinds: ['workos_sso', 'github_app_identity'], teamJitAllowed: false,
            approvedGitHubEnterpriseOrigins: [] },
    });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={serverId} testID="policy-review" />);
    try {
        const text = screen.getTextContent();
        expect(text).toContain(readable ? 'Policy runner' : '—');
        if (!readable) expect(text).not.toContain('Policy runner');
        expect(text).toContain('WorkOS');
        expect(text).toContain('GitHub');
        expect(text).not.toMatch(new RegExp([machineId, policyHomeId, 'workos_sso', 'github_app_identity'].join('|')));
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(machineId);
    } finally { await screen.unmount(); }
});

it('names an archived preset in the reviewed Team defaults', async () => {
    const serverId = await harness.addHome({ name: 'Review Home', serverUrl: 'https://policy-review.test',
        serverIdentityId: homeId, accountId: 'reviewer' });
    const preset = ManagedMachinePresetV1Schema.parse({ id: presetId, homeId, revision: 1,
        owner: { kind: 'account', accountId: 'reviewer' }, contentEncryptionMode: 'plain', recipients: [], archivedAt: 1,
        content: { t: 'plain', v: { v: 1, name: 'Previous contractor image', launch: { name: 'Guest',
            provider: { pluginId: 'developer.example', localId: 'machines' }, schemaVersion: 1, choices: {} } } } });
    harness.answer(serverId, 'POST /v1/machines/presets/get', { body: { kind: 'found', preset } });
    const actionId = TEAM_POLICY_SET_ACTION_ID_V1;
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ v: 1, teamId: 'research',
        managedGroupDefaults: { teamGroupId: 'contractors', defaults: { placement: { kind: 'preset', homeId, presetId } } },
    });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={serverId} testID="policy-review" />);
    try {
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Previous contractor image'));
        expect(screen.getTextContent()).not.toContain(presetId);
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(presetId);
    } finally { await screen.unmount(); }
});
