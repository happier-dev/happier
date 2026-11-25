import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { managedIdentityProviderFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { teamIdentityConnectionFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');
const { captureServerCredentialAccountScopeLifetime, resolveServerCredentialAccountScope } =
    await import('@/sync/domains/scope/serverCredentialAccountScope');
const { identityConnectionObservations, managedIdentityProviderObservations, managedIdentityQueryKey } =
    await import('@/sync/store/home/governance/homeGovernanceSnapshots');

const providerId = '67cffe92-bd4e-4b28-8512-706b1cc4ab77';
const connectionId = '299c21a2-4015-40ad-8940-38867c442c2c';
const teamId = '3d703df7-5a51-4be7-91ec-dc877ae861ab';
const providerName = 'Corporate sign-in';
const connectionName = 'Research sign-in';

beforeEach(async () => { standardCleanup(); await harness.reset(); });
afterEach(async () => { standardCleanup(); await harness.reset(); });

it.each(['readable', 'disabled', 'other Account'] as const)(
    'reads a Team identity connection through its authorized projection (%s)',
    async state => {
        const home = await harness.addHome({ name: 'Review Home', serverUrl: 'https://identity-review.test', accountId: 'reviewer' });
        const resolution = await resolveServerCredentialAccountScope(home);
        if (resolution.kind !== 'bound') throw new Error('Missing reviewer credentials');
        const binding = captureServerCredentialAccountScopeLifetime(resolution);
        const scope = state === 'other Account' ? { ...binding.scope, accountId: 'other' } : binding.scope;
        identityConnectionObservations.apply(managedIdentityQueryKey(scope, teamId), binding, {
            items: [teamIdentityConnectionFixture({ id: connectionId, teamId, enabled: state !== 'disabled',
                provider: { id: providerId, kind: 'oidc', displayName: connectionName } })],
            eligibleProviders: [],
        });
        const actionId = 'teams.identity.connections.disable';
        const actionArgs = getActionSpec(actionId).inputSchema.parse({ v: 1, teamId, connectionId, expectedRevision: 1 });
        const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
            preview={null} status="open" serverId={home} testID="identity-review" />);
        try {
            await waitForHomeGovernance(() => {
                const text = screen.getTextContent();
                expect(text).toContain(state === 'other Account' ? '—' : connectionName);
                if (state === 'other Account') expect(text).not.toContain(connectionName);
                expect(text).not.toContain(connectionId);
            });
            await screen.pressByTestIdAsync('approvals.technical-details.header');
            expect(screen.getTextContent()).toContain(connectionId);
        } finally { await screen.unmount(); }
    },
);

it('names the Home sign-in provider a request selects from the reviewer’s catalog', async () => {
    const home = await harness.addHome({ name: 'Review Home', serverUrl: 'https://identity-review.test', accountId: 'reviewer' });
    const resolution = await resolveServerCredentialAccountScope(home);
    if (resolution.kind !== 'bound') throw new Error('Missing reviewer credentials');
    const binding = captureServerCredentialAccountScopeLifetime(resolution);
    managedIdentityProviderObservations.apply(managedIdentityQueryKey(binding.scope, null), binding, {
        items: [managedIdentityProviderFixture({ id: providerId, displayName: providerName })],
        unreadableCount: 0,
    });
    const connection = teamIdentityConnectionFixture();
    const actionId = 'home.identity.connections.create';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ v: 1, providerInstanceId: providerId,
        externalReference: connection.externalReference, settings: connection.settings });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={home} testID="provider-review" />);
    try {
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(providerName));
        expect(screen.getTextContent()).not.toContain(providerId);
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(providerId);
    } finally { await screen.unmount(); }
});
