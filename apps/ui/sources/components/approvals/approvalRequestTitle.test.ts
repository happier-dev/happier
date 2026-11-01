import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { describe, expect, it } from 'vitest';

import { resolveApprovalRequestTitle } from './approvalRequestTitle';

describe('resolveApprovalRequestTitle', () => {
    const args = { controllerMachineId: 'machine-1', relationshipId: 'relationship_1' };

    it('titles a request by its Action when the stored first line only restates the request\'s own summary', () => {
        // A request stored before its Action copy was reworded still carries the old generated sentence.
        const stored = 'Synchronize this linked workspace relationship now.';
        const resolved = resolveApprovalRequestTitle({
            storedTitle: stored, previewSummary: stored, actionId: 'workspace.sync.relationship.flush', actionArgs: args,
        });
        expect(resolved.title).toBe('Sync workspace now');
        expect(resolved.actionTitle).toBeNull();
    });

    it('keeps an authored title that differs from the request summary', () => {
        const resolved = resolveApprovalRequestTitle({
            storedTitle: 'Release night sync', previewSummary: 'Synchronize these linked folders now.',
            actionId: 'workspace.sync.relationship.flush', actionArgs: args,
        });
        expect(resolved.title).toBe('Release night sync');
    });

    it('titles an Agent-requested Service Stop or Restart by the Service, from the summary the request stores', () => {
        const target = { kind: 'managed_service', managedServiceId: 'managed-a', machineId: 'worker',
            declaration: { workspaceRefId: 'checkout', selection: { kind: 'manifest', name: 'httpPort' } } };
        for (const [actionId, action, summary, title] of [
            ['localServices.actions.stopManaged', 'stop_managed', 'Stop httpPort.', 'Stop httpPort?'],
            ['localServices.actions.restartManaged', 'restart_managed', 'Restart httpPort.', 'Restart httpPort?'],
        ] as const) {
            expect(resolveApprovalRequestTitle({ storedTitle: summary, actionId, actionArgs: { requestId: 'r', target, action } }).title).toBe(title);
        }
    });
});

    it('recognizes a stored generated installation title with punctuation instead of repeating its Action', () => {
        const spec = getActionSpec('machines.managed.bootstrap.respond');
        const result = resolveApprovalRequestTitle({ actionId: spec.id, storedTitle: `${spec.title}.` });
        expect(result.title).toBe(spec.title);
        expect(result.actionTitle).toBeNull();
    });
