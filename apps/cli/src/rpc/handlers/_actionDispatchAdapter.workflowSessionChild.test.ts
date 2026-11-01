import { expect, it } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { buildActionExecutorContextForRpc } from './_actionDispatchAdapter';

it('restores the admitted Session child through the RPC context boundary without host relabeling', () => {
    const target = { kind: 'machine' as const, machineId: 'installed' };
    const caller = { kind: 'session' as const, sessionId: 'leaf-session', starterDepth: 2, turnDepth: 3 };
    const attribution = { requestRef: 'retained-input', requester: { serverId: 'home', accountId: 'requester' },
        persona: { serverId: 'home', sessionId: 'original-session' }, origin: null };
    const origin = { runId: 'run', requestId: 'child', sessionLeaf: { invocationId: 'invocation', caller,
        authorization: { principal: { kind: 'host' as const }, admittedPermissionCeiling: 'default' as const },
        workspaceWrites: 'deny' as const, actionRequestAttributionV1: attribution } };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-by-ingress', binding: {
        serverIdentityId: 'srv_home', accountId: 'requester', custodianAccountId: 'requester', accountEncryptionMode: 'plain',
        authentication: { kind: 'account', tokenEpoch: 0 }, actionId: 'workflow.definition.create', requestId: 'child',
        machineId: 'installed', installationId: 'installation', target, workflowActionOrigin: origin,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'child', target, input: {} }),
    } });
    const context = buildActionExecutorContextForRpc({ callerInputAuthorization: authorization });
    expect(context).toMatchObject({ actionCaller: caller, surface: 'agent', authority: 'account_automation',
        actionRequestId: 'child', executionRunWorkflowRunId: 'run', defaultSessionId: 'leaf-session',
        callerPermissionMode: 'default', workspaceWrites: 'deny', actionRequestAttributionV1: attribution });
    expect(context.externalActionExecutionAuthorization?.binding.workflowActionOrigin).toEqual(origin);
});
