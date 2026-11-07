import { describe, expect, it } from 'vitest';
import { ExternalActionExecutionAuthorizationBindingV1Schema, ReviewedActionChildHttpProofV1Schema,
    type ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { deriveApprovalRequestSourceIdFromIdentityV1 } from '@happier-dev/protocol/approvals/creation';
import { deriveAccountScopedArtifactIdV1 } from '@happier-dev/protocol/artifacts/idScope';
import { MACHINE_SETUP_APPLY_ACTION_ID_V1, SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { MachineSetupApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { deriveMachineSetupCombinedRunIdV1 } from '@happier-dev/protocol/workflows/workflowInvocationIdentityV1';
import { isExternalActionApprovalArtifactPurpose } from './externalActionApprovalArtifactPurpose';
import { isMachineSetupCombinedRunHttpPurpose } from './externalActionMachineSetupWorkflowPurpose';

function patBinding(overrides: Partial<ExternalActionExecutionAuthorizationBindingV1> = {}) {
    return ExternalActionExecutionAuthorizationBindingV1Schema.parse({
        serverIdentityId: 'home', accountId: 'requester', principalId: 'requester', credentialId: 'setup-pat',
        grant: API_TOKEN_FULL_GRANT_V1, machineId: 'machine', custodianAccountId: 'requester',
        installationId: 'installation', admittedMachineRole: 'manage', accountEncryptionMode: 'plain',
        actionId: MACHINE_SETUP_APPLY_ACTION_ID_V1, requestId: 'original-request',
        requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' }, ...overrides,
    });
}

function approvalIdentity(binding: ExternalActionExecutionAuthorizationBindingV1) {
    const sourceId = deriveApprovalRequestSourceIdFromIdentityV1({
        homeId: binding.serverIdentityId, accountId: binding.accountId,
        requesterId: 'principalId' in binding ? binding.principalId : binding.accountId,
        requestId: binding.requestId, actionId: binding.actionId, target: binding.target,
    });
    return { sourceId, artifactId: deriveAccountScopedArtifactIdV1(binding.accountId, sourceId) };
}

describe('retained Action approval Artifact purpose', () => {
    const binding = patBinding();
    const { sourceId, artifactId } = approvalIdentity(binding);
    const purpose = { binding, effectActionId: binding.actionId };

    it('allows the deterministic Ask lifecycle through its scoped and retained source identities', () => {
        for (const id of [artifactId, sourceId]) {
            expect(isExternalActionApprovalArtifactPurpose({ ...purpose,
                method: 'GET', path: `/v1/artifacts/${id}`, body: undefined })).toBe(true);
            expect(isExternalActionApprovalArtifactPurpose({ ...purpose,
                method: 'POST', path: `/v1/artifacts/${id}`, body: { expectedVersion: 1, body: 'settlement' } })).toBe(true);
        }
        expect(isExternalActionApprovalArtifactPurpose({ ...purpose,
            method: 'POST', path: '/v1/artifacts', body: { id: artifactId } })).toBe(true);
    });

    it('does not lend Ask authority to another request, effect or Account', () => {
        const read = { ...purpose, method: 'GET', path: `/v1/artifacts/${artifactId}`, body: undefined };
        const otherArtifact = approvalIdentity(patBinding({ requestId: 'another-request' })).artifactId;
        expect(isExternalActionApprovalArtifactPurpose({ ...read, path: `/v1/artifacts/${otherArtifact}` })).toBe(false);
        expect(isExternalActionApprovalArtifactPurpose({ ...read,
            effectActionId: SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action })).toBe(false);
        expect(isExternalActionApprovalArtifactPurpose({ ...read,
            binding: patBinding({ accountId: 'another-account', principalId: 'another-account' }) })).toBe(false);
        expect(isExternalActionApprovalArtifactPurpose({ ...purpose,
            method: 'POST', path: '/v1/artifacts', body: { id: otherArtifact } })).toBe(false);
        expect(isExternalActionApprovalArtifactPurpose({ ...read, method: 'DELETE' })).toBe(false);
    });
});

describe('retained Machine Setup combined Run purpose', () => {
    const operand = MachineSetupApplyInputV1Schema.parse({ homeId: 'home', machineId: 'machine', targets: [{
        homeId: 'home', machineId: 'machine', sources: [{ kind: 'direct', setup: {} }],
        desiredRevision: 1, recipePlans: [],
    }] });
    const reviewedChild = ReviewedActionChildHttpProofV1Schema.parse({
        actionId: SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.action,
        role: SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.apply.role,
        inputDigest: computeActionInputApprovalDigestV1(MACHINE_SETUP_APPLY_ACTION_ID_V1, operand),
    });

    for (const reviewed of [false, true]) {
        const binding = patBinding(reviewed ? { actionId: 'session.spawn_new' } : {});
        const verified = { binding, target: binding.target, effectActionId: MACHINE_SETUP_APPLY_ACTION_ID_V1,
            ...(reviewed ? { reviewedChildAdmission: reviewedChild } : {}) };
        const runId = deriveMachineSetupCombinedRunIdV1({ homeId: binding.serverIdentityId,
            accountId: binding.accountId, requestId: binding.requestId,
            ...(reviewed ? { reviewedChild } : {}) });
        const proof = { method: 'POST', path: '/v3/automations/runs/workflow-storage',
            body: { operation: 'get', runId, publisherMachineId: binding.machineId } };

        it(`allows ${reviewed ? 'reviewed child' : 'direct Setup'} storage only for its derived combined Run`, () => {
            for (const operation of ['get', 'admit', 'wait', 'run-key.census', 'run-key.commit',
                'invocations.list', 'invocations.get', 'invocations.current']) {
                expect(isMachineSetupCombinedRunHttpPurpose(verified,
                    { ...proof, body: { ...proof.body, operation } }), operation).toBe(true);
            }
            const anotherRun = deriveMachineSetupCombinedRunIdV1({ homeId: binding.serverIdentityId,
                accountId: binding.accountId, requestId: 'another-request',
                ...(reviewed ? { reviewedChild } : {}) });
            expect(isMachineSetupCombinedRunHttpPurpose(verified,
                { ...proof, body: { ...proof.body, runId: anotherRun } })).toBe(false);
            expect(isMachineSetupCombinedRunHttpPurpose(verified,
                { ...proof, body: { ...proof.body, publisherMachineId: 'another-machine' } })).toBe(false);
            expect(isMachineSetupCombinedRunHttpPurpose({ ...verified,
                effectActionId: SESSION_SPAWN_MACHINE_SETUP_CHILDREN_V1.plan.action }, proof)).toBe(false);
            for (const operation of ['cancel', 'list', 'invocations.publish_draft']) {
                expect(isMachineSetupCombinedRunHttpPurpose(verified,
                    { ...proof, body: { ...proof.body, operation } }), operation).toBe(false);
            }
        });

        if (reviewed) it('cannot reuse a reviewed Run after its admitted operand or role changes', () => {
            const changedOperand = MachineSetupApplyInputV1Schema.parse({ ...operand,
                targets: operand.targets.map(target => ({ ...target, desiredRevision: target.desiredRevision + 1 })) });
            const changedChild = ReviewedActionChildHttpProofV1Schema.parse({ ...reviewedChild,
                inputDigest: computeActionInputApprovalDigestV1(MACHINE_SETUP_APPLY_ACTION_ID_V1, changedOperand) });
            expect(isMachineSetupCombinedRunHttpPurpose({ ...verified,
                reviewedChildAdmission: changedChild }, proof)).toBe(false);
            expect(isMachineSetupCombinedRunHttpPurpose({ ...verified,
                reviewedChildAdmission: { ...reviewedChild, role: 'another-reviewed-role' } }, proof)).toBe(false);
            const { reviewedChildAdmission: _child, ...withoutChild } = verified;
            expect(isMachineSetupCombinedRunHttpPurpose(withoutChild, proof)).toBe(false);
        });
    }
});
