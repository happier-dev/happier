import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { buildApprovalPreviewSummary } from '@happier-dev/protocol/actions/actionExecutor';
import { SESSION_SPAWN_NEW_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { preloadTranslations, setPreferredLanguageFromSettings } from '@/text';
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
