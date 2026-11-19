import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { admitUseDeploymentDefinition, resolveDeploymentDefinitionRoleForHost } from './deploymentDefinitionAdmission';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import * as persistence from '@/persistence';
import { createDeploymentTargetRoleAdmissionFixture } from './targets/deploymentTargetRoleAdmission.testkit';

describe('deployment definition authority provenance', () => {
    afterEach(() => vi.restoreAllMocks());
    it('retains a rollback receipt without ingress after Manage adds Environment ingress', () => {
        const environment = createDeploymentEnvironmentDetailV1();
        environment.content.ingress = { kind: 'edgeCaddy', edgeMachineId: 'edge' };
        const content = createDeploymentReceiptDetailV1().content;
        const link = environment.targetLinks[0]!.targetLink;
        content.machines = link.machines;
        content.buildMachineId = environment.environment.buildMachineId ?? environment.environment.controllerMachineId;
        delete content.ingress;
        expect(() => admitUseDeploymentDefinition(environment, content, link.id, structuredClone(content))).not.toThrow();
    });
    // Platform candidates record the method the link's resolver selected. A Use
    // member's full-input Deploy must consume that same resolution, not re-derive it.
    it.each([
        ['unrecorded link', undefined, 'gitIntegration', true],
        ['recorded Git integration', 'gitIntegration', 'gitIntegration', true],
        ['recorded upload', 'upload', 'upload', true],
        ['override of a recorded upload', 'upload', 'gitIntegration', false],
    ] as const)('admits a Use platform Deploy over a repository definition for %s', (_name, recorded, method, admitted) => {
        const { state, input } = createDeploymentTargetRoleAdmissionFixture('deploy');
        const environment = state.environment;
        const row = environment.targetLinks.find(item => item.targetLink.id === input.targetLinkId)!;
        if (recorded) row.content = { ...row.content, sourceMethod: recorded };
        const content = { ...state.receipt.content, sourceIntent: environment.content.definition, sourceMethod: method };
        const admit = () => admitUseDeploymentDefinition(environment, content, input.targetLinkId);
        if (admitted) expect(admit).not.toThrow();
        else expect(admit).toThrow('action_forbidden');
    });
    it('consumes signed grants, never a synthesized role on an older foreign root', async () => {
        const identity = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
            resolveHostIdentity: async () => ({ machineId: 'machine-a', installationId: 'installation-a', custodianAccountId: 'owner' }) });
        const host = { serverId: 'home', machineId: 'machine-a', async resolveRequesterIdentity(context: RpcActionExecutorContext) {
            const requester = await identity.resolveActionRequester!(context);
            try { return requester.identity; } finally { await requester.dispose(); }
        } };
        const target = { kind: 'machine' as const, machineId: 'machine-a' };
        const envelope = { v: 1 as const, requestId: 'definition-grant', target,
            input: { serverId: 'home', environmentId: 'environment' } };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-root', binding: {
            serverIdentityId: 'home', accountId: 'member', authentication: { kind: 'account', tokenEpoch: 1 },
            actionId: 'deployments.deploy', requestId: envelope.requestId, target, machineId: 'machine-a',
            installationId: 'installation-a', custodianAccountId: 'owner', accountEncryptionMode: 'plain',
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } });
        const context: RpcActionExecutorContext = { authority: 'present_user', signal: new AbortController().signal,
            externalActionExecutionAuthorization: authorization,
            machineAdmission: { actorAccountId: 'member', custodianAccountId: 'owner', machineId: 'machine-a',
                installationId: 'installation-a', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
        // This would become Manage if an operation-selected machineAdmission
        // were mistaken for the absent signed Home fact.
        await expect(resolveDeploymentDefinitionRoleForHost(context, host)).rejects.toMatchObject({ code: 'action_forbidden' });
        const routingParent = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization,
            binding: { ...authorization.binding, actionId: 'machines.setup.plan', machineId: 'routing-host',
                target: { kind: 'machine', machineId: 'routing-host' }, admittedMachineRole: 'manage' } });
        // Selecting Manage in a local context is not an admitted target Plan.
        await expect(resolveDeploymentDefinitionRoleForHost({ ...context, externalActionExecutionAuthorization: routingParent }, host))
            .rejects.toMatchObject({ code: 'action_forbidden' });
        for (const role of ['use', 'manage'] as const) {
            const signed = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization,
                binding: { ...authorization.binding, admittedMachineRole: role } });
            await expect(resolveDeploymentDefinitionRoleForHost({ ...context, externalActionExecutionAuthorization: signed }, host))
                .resolves.toBe(role);
        }
        // OS persistence must not re-decide the already admitted Home.
        vi.spyOn(persistence, 'readSettings').mockRejectedValue(new Error('Admitted Home must not re-read profiles'));
        await expect(resolveDeploymentDefinitionRoleForHost({ ...context,
            serverId: 'local-home', serverIdentityId: 'srv_fixture_home',
            externalActionExecutionAuthorization: { ...authorization, binding: { ...authorization.binding,
                serverIdentityId: 'srv_fixture_home', admittedMachineRole: 'use' } } },
        { ...host, serverId: 'local-home' })).resolves.toBe('use');
        await expect(resolveDeploymentDefinitionRoleForHost({}, host)).rejects.toMatchObject({ code: 'action_forbidden' });
        const ownerAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization,
            binding: { ...authorization.binding, accountId: 'owner' } });
        await expect(resolveDeploymentDefinitionRoleForHost({ ...context, externalActionExecutionAuthorization: ownerAuthorization,
            machineAdmission: { ...context.machineAdmission!, actorAccountId: 'owner' } }, host)).resolves.toBe('manage');
    });
});
