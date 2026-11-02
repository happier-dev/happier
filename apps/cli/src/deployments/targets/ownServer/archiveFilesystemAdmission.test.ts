import { describe, expect, it } from 'vitest';
import { ExternalActionExecutionAuthorizationV1Schema, projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { DeploymentChildRpcV1Schema, RPC_METHODS } from '@happier-dev/protocol';
import { readDeploymentArchiveRpcAdmission } from './archiveFilesystemAdmission';

// Transport signatures and Home admission are boundary facts at this owner.
// Earlier signed proof shapes permit Domain routing plus archiveOrigin; that
// combination must never acquire native deployment archive custody here.
describe('deployment archive admission', () => {
    it.each(['domain', 'domainDiscover'] as const)('refuses %s child routing without an archive deployment', async kind => {
        const target = { kind: 'machine' as const, machineId: 'receiver' };
        const content = { contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 };
        const input = { serverId: 'home', environmentId: 'environment', domainId: 'domain' };
        const rootInput = { ...input, ...content, expectedRevision: 1, expectedDomainRevision: 1, requestKey: 'request', targetLinkId: 'runtime', expectedTargetLinkRevision: 1 };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root-proof', binding: {
            accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, custodianAccountId: 'owner', serverIdentityId: 'home',
            machineId: 'receiver', installationId: 'installed', actionId: 'deployments.domains.add', requestId: 'request',
            target, requestEnvelopeDigest: 'a'.repeat(43), accountEncryptionMode: 'plain', environmentId: 'environment',
            deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.domains.add', rootInput),
        } });
        const routing = DeploymentChildRpcV1Schema.parse(kind === 'domain' ? {
            v: 1, kind, actionId: 'deployments.domains.add', machineId: 'receiver', installationId: 'installed',
            input, expectedDomainRevision: 2, actionOperationId: 'operation', capture: {
                placement: { ...input, accountId: 'owner', targetLinkId: 'runtime', machineId: 'receiver',
                    installationId: 'installed', actionOperationId: 'operation', requestId: 'request', nativeServer: 'native' },
                content, desired: true, listener: 'public',
            },
        } : { v: 1, kind, actionId: 'deployments.domains.add', machineId: 'receiver', installationId: 'installed',
            input: { ...input, ...content, expectedRevision: 1, expectedDomainRevision: 1,
                requestKey: 'request', targetLinkId: 'runtime', expectedTargetLinkRevision: 1 } });
        const source = { v: 1 as const, authorization, target, installationId: 'installed', machineSignature: 's'.repeat(86),
            effectActionId: 'deployments.domains.add', deploymentChildRouting: routing };
        const method = RPC_METHODS.DAEMON_FILESYSTEM_COPY;
        const context: Parameters<typeof readDeploymentArchiveRpcAdmission>[0] = {
            callerInputAuthorization: authorization,
            machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'receiver',
                installationId: 'installed', role: 'manage', encryptionMode: 'plain' },
            async verifyMachineAdmissionCurrent() { throw new Error('Admission was already decided by transport'); },
            workspaceSyncSourceExecution: { method: 'receiver:' + method, requestId: 'copy-request', externalActionExecution: {
                v: 1, authorization, target, installationId: 'installed', machineSignature: 's'.repeat(86),
                effectActionId: 'daemon.filesystem.copy', deploymentChildExecution: {
                    method: 'receiver:' + RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, requestId: 'request', paramsPresent: true,
                    paramsDigest: 'd'.repeat(43), externalActionExecution: source,
                    archiveOrigin: { environmentId: 'environment', deploymentId: 'deployment',
                        holderMachineId: 'receiver', holderInstallationId: 'installed' },
                },
            } },
        };
        await expect(readDeploymentArchiveRpcAdmission(context, method)).rejects.toMatchObject({ code: 'action_forbidden' });
    });
});
