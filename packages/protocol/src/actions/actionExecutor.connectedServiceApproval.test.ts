import { describe, expect, it } from 'vitest';
import { createActionExecutor } from './actionExecutor.js';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '../approvals/approvalRequestV1.js';
import { executeConnectedServiceConfigurationActionV1, type ConnectedServiceConfigurationActionHostV1 } from '../connect/executeConfigurationActionV1.js';
import { QualifiedConnectedAccountPurposeBindingsV1Schema } from '../connect/connectedAccountPurposeBindings.js';
import { ConnectedServiceCredentialRevisionV1Schema } from '../connect/connectedServiceSchemas.js';

describe('Connected Account revoke approval origin', () => {
  it.each([
    ['ui', false], ['ui', true], ['agent', false], ['mcp', false],
  ] as const)('preserves the native revoke approval contract on %s with completed confirmation=%s', async (surface, confirmed) => {
    const approvals: ApprovalRequestV2[] = [];
    let revokes = 0;
    let confirmations = 0;
    const account = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
    const input = { machineId: 'controller', account,
      expectedCredentialRevision: ConnectedServiceCredentialRevisionV1Schema.parse('csr_abcdefghijklmnopqrstuv'),
      cleanupGroupReferences: false };
    let purposeBindings = QualifiedConnectedAccountPurposeBindingsV1Schema.parse({ v: 1, bindings: [] });
    const unused = async (): Promise<never> => { throw new Error('Unexpected boundary in native revoke'); };
    // Artifact storage, native Machine RPC and purpose storage are boundaries.
    // The Action, revoke parser, domain execution and default cleanup stay real.
    const host: ConnectedServiceConfigurationActionHostV1 = {
      assertCurrent() {}, request: unused, resolveAgent: unused, resetQuota: unused,
      mutatePurposeBindings: async mutate => {
        const result = mutate(purposeBindings, {});
        if (result) purposeBindings = result.purposeBindings;
      },
      controlCommand: async (machineId, command) => {
        expect(machineId).toBe(input.machineId);
        expect(command).toMatchObject({ operation: 'revokeAccount', account,
          expectedCredentialRevision: input.expectedCredentialRevision });
        revokes++;
        return { status: 'revoked', account, remoteStatus: 'remoteUnsupported' };
      },
    };
    const executor = createActionExecutor({
      presentUserActionConfirmation: async () => { confirmations++; return true; },
      approvalsCreate: async ({ request }) => {
        approvals.push(ApprovalRequestV2Schema.parse(request));
        return { artifactId: 'revoke-approval' };
      },
      connectedServiceAction: ({ actionId, input }) => executeConnectedServiceConfigurationActionV1(host, actionId, input),
    });
    const result = await executor.execute('connectedServices.accounts.revoke', input, {
      surface, authority: surface === 'ui' ? 'present_user' : 'account_automation',
      ...(surface === 'ui' ? { actionCaller: { kind: 'host' as const } } : {}),
      ...(confirmed ? { presentUserConfirmation: { actionId: 'connectedServices.accounts.revoke' as const } } : {}),
      serverId: 'test-home', actionRequestId: 'revoke-request',
    });
    if (surface === 'ui') {
      expect(result).toMatchObject({ ok: true, result: { status: 'revoked', account } });
      expect(approvals).toHaveLength(0);
      expect(confirmations).toBe(confirmed ? 0 : 1);
      expect(revokes).toBe(1);
    } else {
      expect(result).toMatchObject({ ok: true, result: { kind: 'approval_request_created',
        actionId: 'connectedServices.accounts.revoke' } });
      expect(approvals).toHaveLength(1);
      expect(confirmations).toBe(0);
      expect(approvals[0]).toMatchObject({ actionId: 'connectedServices.accounts.revoke', status: 'open' });
      expect(revokes).toBe(0);
    }
  });
});
