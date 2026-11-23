import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installApprovalCommonModuleMocks } from './approvalsTestHelpers';
installApprovalCommonModuleMocks({ text: () => vi.importActual<typeof import('@/text')>('@/text') });
const { ActionApprovalFieldsCard } = await import('./ActionApprovalFieldsCard');
const { describeApprovalActionFields } = await import('./approvalFieldValues');
const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
afterEach(standardCleanup);
it('keeps the answering-client transport selector in the existing Technical details disclosure', async () => {
    const clientId = '3d703df7-5a51-4be7-91ec-dc877ae861ab';
    const presentation = describeApprovalActionFields({ actionId: 'app.updates.check',
        actionArgs: getActionSpec('app.updates.check').inputSchema.parse({ clientId }) });
    const screen = await renderScreen(<ActionApprovalFieldsCard anatomy="page" presentation={presentation} />);
    expect(screen.getTextContent()).not.toContain(clientId);
    await screen.pressByTestIdAsync('approvals.technical-details.header');
    expect(screen.getTextContent()).toContain(clientId);
    await screen.unmount();
});
