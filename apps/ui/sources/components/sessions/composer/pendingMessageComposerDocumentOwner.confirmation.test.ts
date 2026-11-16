import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';

import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createEphemeralComposerDocumentOwner } from './composerDocumentOwner';
import { withdrawPendingMessageToComposerWithActionApproval } from './pendingMessageComposerDocumentOwner';

const scope = { serverId: 'home', accountId: 'account' };
const document = { text: 'Original typed input', structuredInputMentions: [], composerAttachments: [] };

// The real Action executor and approval policy run; the confirmation dialog, approval store and withdraw owner are the boundaries.
async function withdraw(confirm: boolean, requireUiApproval = false) {
    const record = { confirmations: 0, withdrawals: 0, approvals: 0 };
    const executor = createActionExecutor({
        readActionsSettings: () => normalizeActionsSettingsV1({ v: 1, ...(requireUiApproval ? {
            actions: { 'session.pending.withdraw': { approvalRequiredSurfaces: ['ui'] } },
        } : {}) }),
        presentUserActionConfirmation: async () => {
            record.confirmations += 1;
            expect(record.withdrawals).toBe(0);
            return confirm;
        },
        approvalsCreate: async () => { record.approvals += 1; return { artifactId: 'approval-1' }; },
        sessionPendingWithdraw: async () => { record.withdrawals += 1; return { outcome: 'removed' }; },
    } as Partial<ActionExecutorDeps> as ActionExecutorDeps);
    const composer = createEphemeralComposerDocumentOwner({
        ref: { kind: 'session', sessionId: 'session-a' }, capabilities: { text: true, references: true, attachments: true, submit: true },
    });
    const result = await withdrawPendingMessageToComposerWithActionApproval({
        composer, document, isCurrent: () => true, actionExecutor: executor, scope,
        withdrawInput: { sessionId: 'session-a', localId: 'pending-a', serverId: scope.serverId },
        context: { serverId: scope.serverId, surface: 'ui', authority: 'present_user', defaultSessionId: 'session-a' },
        registerApproval: () => { record.approvals += 1; },
    });
    return { result, record };
}

describe('pending withdrawal confirmation', () => {
    it('withdraws and restores the draft without a default confirmation or approval Artifact', async () => {
        const { result, record } = await withdraw(false);
        expect(result).toEqual({ outcome: 'removed', status: 'restored' });
        expect(record).toEqual({ confirmations: 0, withdrawals: 1, approvals: 0 });
    });

    it('confirms an explicit Ask in place, then withdraws and restores the draft without an approval Artifact', async () => {
        const { result, record } = await withdraw(true, true);
        expect(result).toEqual({ outcome: 'removed', status: 'restored' });
        expect(record).toEqual({ confirmations: 1, withdrawals: 1, approvals: 0 });
    });

    it('withdraws nothing when the person declines an explicit Ask', async () => {
        const { result, record } = await withdraw(false, true);
        expect(result.status).toBe('not_removed');
        expect(record).toEqual({ confirmations: 1, withdrawals: 0, approvals: 0 });
    });
});
