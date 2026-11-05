import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1,
    createDeploymentReceiptDetailV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { DeploymentEnvironmentDetailV1, DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentTargetRoleV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import type { QualifiedConnectedAccountPurposeBindingTargetV1 } from '@happier-dev/protocol';
import type { DeploymentTargetRoleAdmissionHost, DeploymentTargetRoleAdmissionRequest } from './admitDeploymentTargetRoleForHost';

/** Actual admitted records; only the external stored-record readers are substituted. */
export function createDeploymentTargetRoleAdmissionFixture(role: DeploymentTargetRoleV1 = 'inspect',
    options: Readonly<{ target?: QualifiedConnectedAccountPurposeBindingTargetV1; preview?: boolean }> = {}) {
    const account = { service: { pluginId: 'acme.alpha', localId: 'account' }, accountId: 'provider-account' };
    const credentialPrincipal = { kind: 'account' as const, accountId: 'custody-account',
        purpose: { consumer: { pluginId: 'acme.alpha', localId: 'selection' }, purpose: 'action-account' },
        target: options.target ?? { kind: 'account' as const, account } };
    const dataRole = role.includes('.');
    const actionLocalId = role === 'uploadDeploy'
        ? 'upload-deploy'
        : dataRole ? role.toLowerCase().replaceAll('.', '-') : role;
    const providerIdentity = { providerAccountId: 'provider-owner', providerResourceId: 'provider-project',
        providerEnvironment: dataRole ? 'branch:branch-main' : 'preview:main' };
    const providerEnvironment = dataRole ? { kind: 'custom' as const, id: 'branch-main' }
        : { kind: 'preview' as const, gitBranch: 'main' };
    const targetLinkId = dataRole ? 'data-link' : 'target-link';
    const baseline = createDeploymentEnvironmentDetailV1();
    const environment = createDeploymentEnvironmentDetailV1({
        environment: { ...baseline.environment, owner: { kind: 'account', accountId: 'custody-account' },
            controllerMachineId: 'controller', buildMachineId: undefined,
            ...(options.preview ?? role === 'branches.delete' ? { purpose: 'preview' as const,
                previewTemplateEnvironmentId: 'parent-environment', previewRepositoryId: 'repository',
                previewPullRequestId: 'pull-request', previewTargetLinkId: 'parent-runtime' } : {}) },
        targetLinks: [{ targetLink: createDeploymentTargetLinkHeaderV1({ id: targetLinkId, createdByAccountId: credentialPrincipal.accountId,
            role: dataRole ? 'data' : 'runtime', source: { kind: 'plugin',
            contribution: { pluginId: 'acme.alpha', localId: 'platform' } }, targetKind: 'platform', machines: [], members: [] }),
            content: { credentialPrincipal, providerIdentity, providerEnvironment } }, ...(dataRole ? baseline.targetLinks : [])],
    });
    const native = createDeploymentReceiptDetailV1();
    const receipt = createDeploymentReceiptDetailV1({ deployment: createDeploymentReceiptHeaderV1({ state: 'queued',
        startedAtMs: undefined, settledAtMs: undefined, acceptedExecution: { v: 1, controller: { machineId: 'controller', installationId: 'installation-controller' } } }),
        content: { sourceIntent: native.content.sourceIntent, sourceMethod: 'gitIntegration', machines: [], images: [],
            machineResults: [], steps: [], platform: { targetLinkRevision: 1, credentialPrincipal, providerIdentity,
                providerEnvironment, observation: { v: 1, state: 'queued', observedAtMs: 1000 } } },
    });
    const state: { environment: DeploymentEnvironmentDetailV1; receipt: DeploymentReceiptDetailV1; reads: number } = {
        environment, receipt, reads: 0,
    };
    const lifecycle = !role.includes('.') && role !== 'inspect' && role !== 'link';
    const input = { v: 1, serverId: 'home', environmentId: environment.environment.id, expectedRevision: 1,
        targetLinkId, expectedTargetLinkRevision: 1, credentialRef: account, credentialPrincipal,
        providerIdentity, providerEnvironment,
        ...(lifecycle ? { deploymentId: receipt.deployment.id, expectedDeploymentRevision: 1, actionOperationId: receipt.deployment.actionOperationId } : {}),
        ...(role === 'deploy' || role === 'uploadDeploy' ? { sourceIntent: receipt.content.sourceIntent,
            sourceMethod: role === 'uploadDeploy' ? 'upload' : 'gitIntegration' } : {}),
    };
    const request: DeploymentTargetRoleAdmissionRequest = { pluginId: 'acme.alpha', localId: actionLocalId,
        bindings: [{ targetLocalId: 'platform', targetKind: 'platform', role }], executionTarget: 'account', input,
        context: { signal: new AbortController().signal, operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } },
        purposeAuthorization: { action: { pluginId: 'acme.alpha', localId: actionLocalId },
            purpose: { consumer: { pluginId: 'acme.alpha', localId: actionLocalId }, purpose: 'action-account' }, serviceRefs: [account.service] },
    };
    const host: DeploymentTargetRoleAdmissionHost = { serverId: 'home', machineId: 'controller', installationId: 'installation-controller',
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
        credentials: { token: 'fixture-account-token', encryption: null }, serverHttpBaseUrl: 'https://home.test',
        credentialOwnerAccountId: 'custody-account',
        readEnvironment: async () => { state.reads++; return state.environment; },
        readReceipt: async () => { state.reads++; return state.receipt; },
        assertCurrent: async context => { context.signal?.throwIfAborted(); },
    };
    return { request, host, state, input };
}
