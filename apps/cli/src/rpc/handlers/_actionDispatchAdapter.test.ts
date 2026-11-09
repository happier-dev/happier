import { describe, expect, it } from 'vitest';
import { CallerInputConstraintsV1Schema } from '@happier-dev/protocol/auth/callerInputConstraintsV1';
import { isPermissionModeGrantedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { WorkspaceSyncSourceContextV1Schema } from '@happier-dev/protocol/socketRpc';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { requesterActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { ExternalActionRequesterInvocationV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';

import {
    buildActionExecutorContextForRpc,
    dispatchActionFromRpc,
    type RpcActionExecutor,
} from './_actionDispatchAdapter';

describe('RPC action dispatch adapter', () => {
    it.each(['owner', 'unknown', 'other_account', 'other_home', 'terminal', 'session', 'workflow', 'plugin'] as const)(
        'admits only qualified private host attribution at the RPC receiver (%s)', kind => {
        const cause = { requestRef: 'original-input', requester: kind === 'unknown' ? null : {
            accountId: kind === 'other_account' ? 'another-person' : 'person',
            serverId: kind === 'other_home' ? 'srv_other' : 'srv_home',
        }, persona: { serverId: 'srv_home', sessionId: 'original-session' }, origin: null };
        const invocation = ExternalActionRequesterInvocationV1Schema.parse({ caller: { kind: 'host' }, surface: 'mcp',
            authority: 'account_automation', actionRequestAttributionV1: cause });
        const target = { kind: 'machine' as const, machineId: 'machine' };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-root', binding: {
            accountId: 'person', custodianAccountId: 'owner',
            authentication: { kind: kind === 'terminal' ? 'terminal' : 'account', tokenEpoch: 0 },
            accountEncryptionMode: 'plain', machineId: 'machine', installationId: 'installation', serverIdentityId: 'srv_home',
            actionId: 'machines.managed.list', requestId: 'host-request', target,
            ...(kind === 'session' ? { sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId: 'agent', starterDepth: 0, turnDepth: 0 },
                sourceTurnId: 'turn', requestId: 'host-request', callerPermissionMode: 'default' },
                sessionActionSource: { machineId: 'machine', installationId: 'installation' } } : {}),
            ...(kind === 'workflow' ? { workflowActionOrigin: { runId: 'workflow-run', requestId: 'host-request' } } : {}),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId: 'host-request', target, input: {} }),
        } });
        // The socket boundary has already admitted this private host context;
        // retain the actual classifier and RPC projection beneath it.
        Object.defineProperty(authorization, 'requesterAccountProjection', { value: Object.defineProperty({}, requesterActionContext,
            { value: { invocation } }) });
        const receive = () => buildActionExecutorContextForRpc({ callerInputAuthorization: authorization,
            ...(kind === 'plugin' ? { transportPluginCaller: { kind: 'plugin' as const, pluginId: 'acme.agent',
                contributionLocalId: 'write' } } : {}) });
        if (kind === 'owner' || kind === 'unknown') expect(receive()).toMatchObject({ authority: 'account_automation', actionRequestAttributionV1: cause });
        else expect(receive).toThrowError(expect.objectContaining({ rpcErrorCode: 'RPC_FORBIDDEN' }));
    });

    it('keeps an installed Machine Workflow origin on live agent policy without inventing Session authority', () => {
        const target = { kind: 'machine' as const, machineId: 'receiving-machine' };
        const requestId = 'workflow-run/leaf-record/0';
        // This adapter consumes an already verified transport operand. The
        // cross-package Workflow composition test proves Home issuance.
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'verified-home-root', binding: {
            accountId: 'requester', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
            accountEncryptionMode: 'plain', machineId: target.machineId, installationId: 'receiving-installation', serverIdentityId: 'home',
            actionId: 'machines.setup.apply', requestId, target,
            workflowActionOrigin: { runId: 'workflow-run', requestId },
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId, target, input: {} }),
        } });
        const context = buildActionExecutorContextForRpc({ callerInputAuthorization: authorization });
        expect(context).toMatchObject({ surface: 'agent', authority: 'account_automation', actionRequestId: requestId,
            executionRunWorkflowRunId: 'workflow-run', executionRunTargetMachineId: target.machineId,
            externalActionExecutionAuthorization: authorization, externalActionTarget: target, serverIdentityId: 'home' });
        expect(context.actionCaller).toBeUndefined();
        expect(context.callerPermissionMode).toBeUndefined();
        expect(context.workspaceWrites).toBeUndefined();
    });

    it('preserves the explicit original authorization before host-local authorization', () => {
        const target = { kind: 'machine' as const, machineId: 'machine' };
        const requestId = 'original-action';
        const authorization = (token: string) => ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token, binding: {
            accountId: 'requester', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
            accountEncryptionMode: 'plain', machineId: 'machine', installationId: 'installation', serverIdentityId: 'home',
            actionId: 'action.invoke', requestId, target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId, target, input: {} }),
        } });
        // These are host-local context operands, not admission of a public proof.
        const local = authorization('local-root');
        const explicit = authorization('explicit-root');
        expect(buildActionExecutorContextForRpc({ localActionContext: { externalActionExecutionAuthorization: local } })
            .externalActionExecutionAuthorization).toBe(local);
        expect(buildActionExecutorContextForRpc({ externalActionExecutionAuthorization: explicit,
            localActionContext: { externalActionExecutionAuthorization: local } }).externalActionExecutionAuthorization).toBe(explicit);
    });

    it('retains the admitted caller permission constraints when building physical SOURCE authority', () => {
        const models = [{ agentTargetKey: 'agent:codex', providerConnectionId: null, modelId: 'admitted-model' }];
        const callerInputConstraints = CallerInputConstraintsV1Schema.parse({ models, permissionModes: ['read-only'] });
        const machineAdmission = { actorAccountId: 'shared-actor', custodianAccountId: 'owner', machineId: 'child',
            installationId: 'child-installation', role: 'use' as const, encryptionMode: 'plain' as const };
        const admitted = { callerAuthority: 'account_automation' as const, machineAdmission, callerInputConstraints };
        const context = buildActionExecutorContextForRpc(admitted);
        const sourceContext = WorkspaceSyncSourceContextV1Schema.parse({ machineAdmission: context.machineAdmission,
            callerAuthority: context.authority, callerInputConstraints: context.callerInputConstraints });
        const inheritedConstraints = sourceContext.callerInputConstraints ?? { models: null, permissionModes: null };
        expect(isPermissionModeGrantedV1(inheritedConstraints, 'acceptEdits')).toBe(false);
        expect(isPermissionModeGrantedV1(inheritedConstraints, 'read-only')).toBe(true);
        expect(sourceContext.machineAdmission.actorAccountId).toBe('shared-actor');
        expect(sourceContext.callerInputConstraints?.models).toEqual(models);
    });

    it('uses verified forwarded authority and refuses an unstamped forwarded caller', () => {
        expect(buildActionExecutorContextForRpc({ callerAuthority: 'present_user' }))
            .toMatchObject({ authority: 'present_user' });
        expect(buildActionExecutorContextForRpc({ callerAuthority: 'account_automation' }))
            .toMatchObject({ authority: 'account_automation' });
        expect(buildActionExecutorContextForRpc({}))
            .toMatchObject({ authority: 'account_automation' });
    });
    it('maps RPC invocation context to the accepted action executor surface', async () => {
        const calls: unknown[] = [];
        const executor: RpcActionExecutor = {
            execute: async (actionId, input, context) => {
                calls.push({ actionId, input, context });
                return { ok: true as const, result: { dispatched: true } };
            },
        };

        const result = await dispatchActionFromRpc({
            actionId: 'session.message.send',
            input: { sessionId: 'session-1', message: 'hello' },
            defaultSessionId: 'session-1',
            serverId: 'server-1',
            localActionContext: { surface: 'rpc', authority: 'present_user' },
            executor,
        });

        expect(result).toEqual({ ok: true, result: { dispatched: true } });
        expect(calls).toEqual([
            {
                actionId: 'session.message.send',
                input: { sessionId: 'session-1', message: 'hello' },
                context: {
                    defaultSessionId: 'session-1',
                    serverId: 'server-1',
                    surface: 'rpc',
                    authority: 'present_user',
                },
            },
        ]);
    });

    it('omits empty routing hints instead of passing placeholder values', () => {
        expect(buildActionExecutorContextForRpc({
            defaultSessionId: '  ',
            serverId: null,
    })).toEqual({ surface: 'rpc', authority: 'account_automation' });
    });

    it('preserves host-only active-turn authority for a local agent dispatch', () => {
        const causalPermissionAuthority = {
            kind: 'admittedSessionInputV1',
            admittedPermissionCeiling: 'default',
        };

        expect(buildActionExecutorContextForRpc({
            defaultSessionId: 'session-1',
            localActionContext: {
                surface: 'agent',
                callerPermissionMode: 'yolo',
                causalPermissionAuthority,
            },
        })).toEqual({
            defaultSessionId: 'session-1',
            surface: 'agent',
            authority: 'account_automation',
            callerPermissionMode: 'yolo',
            causalPermissionAuthority,
        });
    });

    it('defaults progress-only local context to automation authority', () => {
        expect(buildActionExecutorContextForRpc({
            defaultSessionId: 'session-1',
            localActionContext: { operationProgress: { update: () => undefined } },
        })).toMatchObject({ surface: 'rpc', authority: 'account_automation' });
    });
});
