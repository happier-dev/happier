import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { resolveDeploymentDefinitionRoleForHost } from './deploymentDefinitionAdmission';
import * as persistence from '@/persistence';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol';

describe('deployment definition authority provenance', () => {
    afterEach(() => vi.restoreAllMocks());
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
        const settings = await persistence.readSettings();
        // Saved profiles are an OS persistence boundary; use the real Home
        // identity resolver rather than assuming a local profile id is signed.
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ ...settings, servers: { 'local-home': {
            id: 'local-home', name: 'Home', serverUrl: 'https://home.test', webappUrl: 'https://home.test',
            createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_fixture_home',
                canonicalServerUrl: 'https://home.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.test' }] }),
        } } });
        await expect(resolveDeploymentDefinitionRoleForHost({ ...context,
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
