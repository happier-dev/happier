import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { buildApprovalPreviewSummary } from '@happier-dev/protocol/actions/actionExecutor';
import { SESSION_SPAWN_NEW_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { HOME_ACCOUNTS_DELETE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/accountLifecycleActionIdsV1';
import { AccountErasureReviewV1Schema } from '@happier-dev/protocol/auth/accountErasureReview';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';

installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const { ApprovalReviewFacts } = await import('./ApprovalReviewFacts');

beforeEach(async () => {
    await preloadTranslations('fr');
    setPreferredLanguageFromSettings('fr');
});
afterEach(() => { standardCleanup(); setPreferredLanguageFromSettings('en'); });

it.each([undefined, 'host'] as const)('names the selected shared credential for signed Start with summary placement %s', async (summaryPlacement) => {
    const actionId = SESSION_SPAWN_NEW_ACTION_ID_V1;
    const spec = getActionSpec(actionId);
    const teamCredentialSources = [{ teamId: 'research', resourceId: 'resource-work', teamName: 'Research', accountName: 'Work account' }];
    const actionArgs = spec.inputSchema.parse({
        executionTarget: { serverId: 'home', machineId: 'workstation' }, directory: { kind: 'managed' },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, teamId: 'research',
            resourceId: 'resource-work', expectedResourceRevision: 4, deliveryMode: 'brokered' }],
    });
    const preview = { summary: buildApprovalPreviewSummary(spec, actionArgs, { teamCredentialSources }), teamCredentialSources };
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={preview} summaryPlacement={summaryPlacement} serverId={null} testID="governance-review" />);
    try {
        const text = screen.getTextContent();
        expect(text.split('Utilise le compte partagé Work account de Research.')).toHaveLength(2);
        expect(text).not.toContain('Uses Research');
    } finally { await screen.unmount(); }
});

it('shows the named shared environments and affected member counts in a Home Account erasure review', async () => {
    const actionId = HOME_ACCOUNTS_DELETE_ACTION_ID_V1;
    const spec = getActionSpec(actionId);
    const actionArgs = spec.inputSchema.parse({ accountId: 'home-account' });
    const accountErasure = AccountErasureReviewV1Schema.parse({ sharedEnvironments: [
        { environmentId: 'environment-staging', name: 'Shared staging', memberCount: 3 },
        { environmentId: 'environment-release', name: 'Release rehearsals', memberCount: 1 },
    ] });
    const preview = { summary: buildApprovalPreviewSummary(spec, actionArgs), accountErasure };
    const screen = await renderScreen(<ApprovalReviewFacts actionId={actionId} actionArgs={actionArgs}
        preview={preview} serverId={null} testID="governance-review" />);
    try {
        const text = screen.getTextContent();
        for (const environment of accountErasure.sharedEnvironments) {
            expect(text).toContain(t('homeGovernance.erasureSharedEnvironment', environment));
            expect(text).not.toContain(environment.environmentId);
        }
    } finally { await screen.unmount(); }
});
