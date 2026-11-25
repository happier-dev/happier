import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { t } from '@/text';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');

const managedId = 'f20c797b-449f-4aa6-8b89-01fcfcaed022';
const homeId = 'srv_erasure_review';
const accountId = 'person-to-erase';
const launchName = 'Research build host';
const machine = ManagedMachineFullV1Schema.parse({
    id: managedId, homeId, custodianAccountId: accountId,
    launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: launchName, choices: {} },
    controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'confirmed-absent', creationState: 'active',
    desired: 'stop', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
});

beforeEach(async () => { standardCleanup(); await harness.reset(); });
afterEach(async () => { standardCleanup(); await harness.reset(); });

it('uses the Home policy section label for a governance projection', async () => {
    const actionId = 'home.governance.get';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ projection: 'session_defaults' });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={null} testID="governance-projection-review" />);
    try {
        expect(screen.getTextContent()).toContain(t('teams.settings.sessionDefaultsSection'));
        expect(screen.getTextContent()).not.toContain('session_defaults');
    } finally { await screen.unmount(); }
});

it('keeps an audit filter without a target kind in Technical details', async () => {
    const actionId = 'home.audit.list';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({ targetId: managedId, limit: 25 });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={null} testID="audit-filter-review" />);
    try {
        expect(screen.getTextContent()).not.toContain(managedId);
        expect(screen.getTextContent()).toContain('25');
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(managedId);
    } finally { await screen.unmount(); }
});

it.each([true, false])('reviews an erasure disposition by the managed Machine name when readable (%s)', async readable => {
    const serverId = await harness.addHome({ name: 'Review Home', serverUrl: 'https://erasure-review.test',
        serverIdentityId: homeId, accountId: 'reviewer', teamsEnabled: true });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, managedMachineActionEndpointPathV1('machines.managed.get'), readable ? { body: machine } : { status: 404 });
    const actionId = 'home.accounts.delete';
    const actionArgs = getActionSpec(actionId).inputSchema.parse({
        accountId, managedResourceDispositions: [{ managedId, responsibility: 'manual', expectedIntentRevision: 1,
            expectedAllocation: machine.allocation }],
    });
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={null} status="open" serverId={serverId} testID="erasure-disposition-review" />);
    try {
        await waitForHomeGovernance(() => {
            const text = screen.getTextContent();
            expect(text).not.toContain(managedId);
            expect(text).toContain(readable ? launchName : '—');
            if (!readable) expect(text).not.toContain(launchName);
        });
        await screen.pressByTestIdAsync('approvals.technical-details.header');
        expect(screen.getTextContent()).toContain(managedId);
    } finally { await screen.unmount(); }
});
