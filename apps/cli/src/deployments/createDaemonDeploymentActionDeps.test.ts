import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { readHomeRequestArtifactReference } from './homeRequestBody.testkit';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import axios from 'axios';
import type { PluginApi } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as vercelDomainPlugin from '../../../../packages/plugins/deploy-vercel/src/index';
import { normalizeGithubWebhookDelivery } from '../../../../packages/plugins/scm-github/src/observations/githubWebhookNormalization';
import { logger } from '@/ui/logger';
import { isRecord } from '@happier-dev/protocol/common/records';
import { z } from 'zod/mini';
import { createHash, randomBytes } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { x25519 } from '@noble/curves/ed25519';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { encodePlainArtifactStoredContent, decodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1, createDeploymentReceiptHeaderV1, createDeploymentVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { ActionExecuteFailureSchema, createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionOutputDiagnostic } from '@happier-dev/protocol/actions/executor/actionFailureDiagnostic';
import { createActionAutomationPortV1 } from '@happier-dev/protocol/actions/executor/actionAutomationAdmission';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
    DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, DEPLOYMENT_TEARDOWN_STEPS_V1,
    DeploymentContentV1Schema, DeploymentEnvironmentContentV1Schema, DeploymentProviderTeardownContentV1Schema, DeploymentPlatformContentV1Schema,
    OwnServerDeploymentInputBasisV1Schema, DeploymentOwnServerContentV1Schema,
    readDeploymentEnvironmentArtifactHeaderV1, readDeploymentEnvironmentArtifactV1 } from '@happier-dev/deployment-protocol';
import { ArtifactJsonUpdateHttpInputV1Schema, DeploymentTransitionInputV1Schema, DeploymentEnvironmentGetResultV1Schema, DeploymentReceiptGetResultV1Schema,
    DeploymentReceiptListResultV1Schema, DeploymentReceiptResultV1Schema, DeploymentPendingDeployV1Schema,
    doesDeploymentChildInputMatchRootV1 } from '@happier-dev/protocol';
import { createOwnServerDockerBoundary } from './targets/ownServer/ownServerDeployment.testkit';
import { createOwnServerDeploymentRuntimeForHost } from './targets/ownServer/ownServerDeploymentHostRuntime';
import { createOwnServerTeardownForHost } from './targets/ownServer/teardown';
import { DeploymentActionFailureV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { resolveOwnServerDeploymentIdentityForHost } from './targets/ownServer/paths';
import { readEnvironmentSecretLaunchAdmissionForHost } from './secrets/readEnvironmentSecretLaunchAdmissionForHost';
import { prepareEnvironmentSecretBindings } from './secrets/environmentSecretBindingService';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture, retireAdmittedPluginRuntimeRegistry } from '@/plugins/testkit/admittedRuntime';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { DeploymentTargetLinkProviderContentV1Schema, DeploymentTargetRoleInputProtocolSchemasV1, DeploymentTargetRoleResultV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/v2';
import { DeploymentTargetVariablesReadResultV1ProtocolSchema, DeploymentTargetVariablesSyncResultV1ProtocolSchema, DeploymentTargetLogsResultV1ProtocolSchema, DeploymentTargetDomainResultV1ProtocolSchema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { DeploymentDomainContentV1Schema, DeploymentDomainHeaderV1Schema, DeploymentDomainTransitionInputV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import * as installationStore from '@/daemon/identity/store';
import { createPlainProjectAccountRefRow, mockProjectAccountRowsHttpBoundary, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createDaemonHostResourceRead } from '@/rpc/handlers/daemonHostResourceRead';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { PluginAvailabilityIntentReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability/actions';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { callExactMachineRpc, readMachineRpcRequestDisposition } from '@/session/transport/rpc/machineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createDeploymentArtifactForHost } from './createArtifactForHost';
import { ArtifactAccessGrantSetInputV1Schema, type ArtifactAccessGrantRowV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { DeploymentActionInputSchemasV1, DeploymentEnvironmentCreateIntentInputV1Schema, DeploymentTeardownInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { buildApprovalExecutionOriginV1, createActionExecutor, createHostReviewedChildPortV1, type ActionExecuteResult, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ApprovalRequestV2Schema, resolveApprovalExecutor } from '@happier-dev/protocol';
import { createDaemonApprovalExecutionOriginCurrentness, createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { ActionsSettingsV1Schema, sealExternalActionRequestV2 } from '@happier-dev/protocol/actions';
import { DeploymentChildRpcV1Schema } from '@happier-dev/protocol';
import { prepareStoredPromotionCandidate } from './storedPromotionCandidate';
import { projectDeploymentFailure } from './deploymentFailure';
import { createDaemonApprovalExecutionAuthorizationPreparer } from '@/daemon/externalActions/approvalExecutionAuthorization';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { decryptWithDataKey, encryptWithDataKey, libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { signAccountContentKeyBindingV1, computeContentPublicKeyFingerprint,
    openEncryptedDataKeyEnvelopeV1, MachineInstallationIdentityV1Schema } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import * as persistence from '@/persistence';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { buildDeploymentAccountChangeV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { accountSettingsParse } from '@happier-dev/protocol';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    ExternalActionExecutionAuthorizationV1Schema, createDeploymentCandidatePublicationV1, projectExternalActionApprovalDecisionAdmissionV1,
    projectExternalActionDeploymentPreparationEnvelopeAdmissionV1, projectDeploymentReadAdmissionV1,
    projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { ExternalActionExecutionAuthorizationRequestV1Schema, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import { createProductionWorkflowRunCoordinator } from '@/daemon/workflows/production';
import { createCliProjectSourceActionDeps } from '@/session/actions/projectSourceActionDeps';
import { isReviewedDeploymentChild } from '@/api/externalActionExecutionAuthorization';
import { createFilesystemEffectAdmission } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemEffectAdmission';
import { projectDaemonRequesterWorkAttribution } from '@/daemon/lifecycle/requesterWorkAttribution';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { handleActionsCommand } from '@/cli/commands/actions';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { DeploymentDeployIntentInputV1Schema, DeploymentDeployInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { WorkflowDefinitionV1Schema, openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1,
    deriveAutomationOccurrenceKeyV1, AutomationRunCauseSchema, ActionIdSchema, admitAgentStartV1, DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '@happier-dev/protocol';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { AutomationRunPluginEventTriggerEvidenceV1Schema } from '@happier-dev/protocol/automations/automationRunExecutionRecipeV1';
import { AutomationDefinitionDetailSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1, AutomationTriggerIdSchema, PluginJsonValueV2Schema } from '@happier-dev/protocol';
import { AutomationSourceSelectorIdV1Schema } from '@happier-dev/protocol/automations/automationEventJsonBoundsV1';
import { createAccountWorkflowTriggerActions } from '@happier-dev/protocol/actions/executor/workflowTriggerAccountHost';
import { createWorkflowApprovedOperationReader } from '@/daemon/workflows/workflowApprovedOperation';
import { buildWorkflowActionContext } from '@/daemon/workflows/workflowActionContext';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { sealWorkflowProgressStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { resolveActionApprovalRouting } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { createCommittedContributedActionInvoker, listRuntimeContributedActionDefinitions } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { normalizeStoredComposeDefinitionInput } from '@/workspaces/projectSetup/nativeComposeSource';
import { DeploymentTemplateInstantiateInputV1Schema, DeploymentTemplateInstantiateResultV1Schema } from '@happier-dev/protocol';
import { createRegistryHostV1, DeploymentTemplateV1Schema, REGISTRY_ACTION_OUTPUT_SCHEMAS_V1,
    type RegistrySourceDescriptorV1 } from '@happier-dev/protocol/registries';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowsListResponseV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { DeploymentTargetLinkInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol';
import { projectSettledApprovalExecution } from '@happier-dev/protocol/actions/executor/approvalResults';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { configuration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { resolveOwnServerDeploymentEnvironmentInstanceIdForHost } from './targets/ownServer/paths';
import { projectDeploymentPreparationAdmissionV1 } from '@happier-dev/protocol/deployments/deploymentPreparationAdmissionV1';

// Socket.IO is the network boundary; the pending observer and runner stay real.
const pendingSocket = vi.hoisted(() => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const connections = new Set<(event: string, ...args: unknown[]) => void>();
    let nextConnection = 0;
    const emit = (event: string, ...args: unknown[]) => {
        for (const receive of [...connections]) receive(event, ...args);
    };
    const createSocket = () => {
        // Account currentness and pending observation own separate connections.
        // Disposing the waiter must not disconnect the requester's live custody.
        const id = nextConnection++;
        const key = (event: string) => `${id}:${event}`;
        const receive = (event: string, ...args: unknown[]) => {
            for (const listener of [...(listeners.get(key(event)) ?? [])]) listener(...args);
        };
        const socket = { connected: false, io: { timeout() {}, on() {}, off() {} },
            on(event: string, listener: (...args: unknown[]) => void) {
                const group = listeners.get(key(event)) ?? new Set(); group.add(listener); listeners.set(key(event), group);
            },
            off(event: string, listener: (...args: unknown[]) => void) { listeners.get(key(event))?.delete(listener); },
            connect() { connections.add(receive); socket.connected = true; receive('connect'); },
            disconnect() { connections.delete(receive); socket.connected = false; receive('disconnect', 'client disconnect'); },
            removeAllListeners() {
                for (const eventKey of [...listeners.keys()]) if (eventKey.startsWith(`${id}:`)) listeners.delete(eventKey);
            }, offAny() {},
        };
        return socket;
    };
    return { createSocket, emit, listeners };
});
vi.mock('socket.io-client', () => ({ io: () => pendingSocket.createSocket() }));

const stageLogWriteBoundary = vi.hoisted(() => ({ diskFull: false }));
vi.mock('node:fs', async importOriginal => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, writeSync: (...args: Parameters<typeof actual.writeSync>) => {
        if (stageLogWriteBoundary.diskFull && args[1] instanceof Uint8Array
            && Buffer.from(args[1]).includes('controller build stdout')) {
            throw Object.assign(new Error('Stage log disk is full'), { code: 'ENOSPC' });
        }
        return Reflect.apply(actual.writeSync, actual, args);
    } };
});

afterEach(() => { stageLogWriteBoundary.diskFull = false; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const ownerContext: RpcActionExecutorContext = { authority: 'present_user', signal: new AbortController().signal,
    machineAdmission: { actorAccountId: 'owner', custodianAccountId: 'owner', machineId: 'machine-a',
        installationId: 'installation-a', role: 'manage', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
const ownerContextFor = (machineId: string): RpcActionExecutorContext => ({ ...ownerContext,
    machineAdmission: { ...ownerContext.machineAdmission!, machineId } });
const ownerIdentity = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
    resolveHostIdentity: async () => ({ machineId: 'machine-a', installationId: 'installation-a', custodianAccountId: 'owner' }) });
const resolveOwnerRequesterIdentity = async (context: import('@happier-dev/protocol').ActionExecutorContext) => {
    const requester = await ownerIdentity.resolveActionRequester!(context);
    try { return requester.identity; } finally { await requester.dispose(); }
};

describe('installed deployment storage and target composition', () => {
    it('signs adoption create preparation as the admitted adoption root through the real requester projection', async () => {
        const serverHttpBaseUrl = 'https://adopt-preparation.test';
        const credentials: StoredCredentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
        const keys = tweetnacl.sign.keyPair();
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'installation-a', createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'),
            privateKey: Buffer.from(keys.secretKey).toString('base64url') });
        const destination = { projectSourceId: 'source', name: 'Adopted', protection: 'nonProduction' as const,
            purpose: 'standard' as const, deployerMode: 'managers' as const };
        const adopt = { serverId: 'home', machineId: 'machine-a', serviceId: 'watched-service', expectedGeneration: 'generation',
            requestKey: 'adopt-create', profiles: [], mode: 'apply', reviewedDigest: `sha256:${'a'.repeat(64)}`,
            destination, bindingsConfirmed: true, bindings: [] };
        const target = { kind: 'machine' as const, machineId: 'machine-a' };
        const envelope = { v: 1 as const, requestId: 'adopt-request', target, input: adopt };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-adoption', binding: {
            serverIdentityId: 'home', accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
            admittedMachineRole: 'manage', custodianAccountId: 'owner', machineId: 'machine-a', installationId: 'installation-a',
            actionId: 'machines.services.adopt', requestId: envelope.requestId, accountEncryptionMode: 'plain', target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('machines.services.adopt', adopt),
        } });
        const signedPaths: string[] = [];
        const assertSigned = (method: string, path: string, headers: Record<string, unknown> | undefined, body?: unknown,
            effectActionId = 'machines.services.adopt') => {
            expect(headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe(effectActionId);
            expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                effectActionId, target, installationId: 'installation-a', requestId: envelope.requestId,
                method, path, body, publicKey: keys.publicKey,
                signature: String(headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
            signedPaths.push(path);
        };
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const url = new URL(request.url!);
            const path = url.pathname;
            assertSigned('GET', `${path}${url.search}`, request.headers, undefined,
                path === '/v1/projects/sources/source' ? 'projects.sources.read' : 'machines.services.adopt');
            if (path === '/v1/projects/sources/source') return { status: 200, data: { ok: true, canManage: true,
                source: { id: 'source', revision: 1, name: 'Project', owner: { kind: 'account', accountId: 'owner' }, audience: [], createdByAccountId: 'owner' } } };
            if (path === '/v1/projects/source/deployment-defaults') return { status: 200,
                data: { ok: true, projectSourceId: 'source', sourceRevision: 1, revision: 0, content: null } };
            throw new Error(`Unexpected adoption preparation request ${path}`);
        });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            throw new Error(`Unexpected adoption custody read ${path}`);
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
            const path = new URL(url).pathname;
            if (path.endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
            expect(path).toBe('/v1/artifacts');
            assertSigned('POST', path, config?.headers, body);
            return { status: 200, data: { id: readCarrierMutation(body).id, headerVersion: 1, bodyVersion: 1 } };
        });
        const deps = createDaemonDeploymentActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl,
            machineId: 'machine-a', resolveRequesterIdentity: resolveOwnerRequesterIdentity,
            runtime: createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'home', serverHttpBaseUrl,
                machineId: 'machine-a', resolveRequesterIdentity: resolveOwnerRequesterIdentity,
                async acquirePluginRuntimeRegistryLease() { throw new Error('Create preparation must not acquire native work'); } }) });
        const requester = await prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
            machineId: 'machine-a', installationId: 'installation-a', installationPrivateKey: keys.secretKey,
            serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl, ownCredentials: credentials,
            isCurrent: async () => true, createExecutor: () => createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps }) });
        if (!requester) throw new Error('Expected admitted adoption requester custody');
        try {
            const prepared = await deps.prepareDeploymentEnvironmentCreate({ input: { ...destination, serverId: 'home',
                requestKey: adopt.requestKey, controllerMachineId: 'machine-a',
                definition: { from: 'image', image: 'nginx:1', port: 80 } },
                context: { externalActionExecutionAuthorization: requester.authorization, originalActionEnvelope: envelope } });
            expect(prepared).toMatchObject({ input: { projectSourceId: 'source', contentArtifactId: expect.any(String) } });
            expect(signedPaths).toContain('/v1/projects/source/deployment-defaults?serverId=home');
            expect(signedPaths).toContain('/v1/artifacts');
        } finally { await requester.dispose(); }
    });
    it.each([
        { actionId: 'deployments.receipts.observe', selection: 'active', entry: 'command' },
        { actionId: 'deployments.receipts.observe', selection: 'retained', entry: 'command' },
        { actionId: 'deployments.observation.get', selection: 'active', entry: 'command' },
        { actionId: 'deployments.receipts.observe', selection: 'active', entry: 'credentialed' },
    ] as const)(
        'routes CLI $actionId to the receipt owner for a cold native receipt ($selection, $entry)', async ({ actionId, selection, entry }) => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-native-observation-',
            env: { HAPPIER_SERVER_URL: 'https://home.test', HAPPIER_WEBAPP_URL: 'https://home.test' } }, async () => {
        const detail = createDeploymentEnvironmentDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        const link = detail.targetLinks[0]!.targetLink;
        if (selection === 'retained') detail.environment.runtimeTargetLinkId = undefined;
        const keys = tweetnacl.sign.keyPair();
        const machine = { id: 'machine-a', kind: 'persistent', active: true, activeAt: Date.now(),
            installationId: 'installation-a', installationPublicKey: Buffer.from(keys.publicKey).toString('base64'),
            revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
        receipt.deployment.environmentId = detail.environment.id;
        receipt.deployment.targetLinkId = link.id;
        const documents = new Map<string, { row: Pick<typeof receipt.deployment,
            'contentArtifactId' | 'contentHeaderVersion' | 'contentBodyVersion'>; kind: string; content: unknown }>([
            [detail.environment.contentArtifactId, { row: detail.environment, kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, content: detail.content }],
            [link.contentArtifactId, { row: link, kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, content: detail.targetLinks[0]!.content }],
            [receipt.deployment.contentArtifactId, { row: receipt.deployment, kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, content: receipt.content }],
        ]);
        // Home metadata and the Account Artifact transport are system boundaries.
        const transportPaths: string[] = [];
        vi.spyOn(axios, 'request').mockImplementation(async request => ({ status: 200,
            data: String(request.url).includes('/receipts/')
                ? { ok: true, deployment: receipt.deployment, cancellable: false }
                : { ok: true, environment: detail.environment, secretScope: detail.secretScope, targetLinks: [link] } }));
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(url).pathname;
            transportPaths.push(`GET ${path}`);
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            if (path === '/v1/account/encryption/currentness') return { status: 200,
                data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
            if (path === '/v1/features/authenticated') return { status: 200,
                data: { features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_native_home' } } } };
            if (path === '/v1/machines/machine-a') return { status: 200, data: { machine } };
            if (path === '/v1/machines') return { status: 200, data: [machine] };
            const document = documents.get(path.slice('/v1/artifacts/'.length));
            if (!document) throw new Error('Unexpected Artifact read');
            return { status: 200, data: { id: document.row.contentArtifactId, ownerAccountId: 'owner',
                access: 'owner', publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent({ kind: document.kind, title: 'Native deployment' }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(document.content) }),
                headerVersion: document.row.contentHeaderVersion, bodyVersion: document.row.contentBodyVersion,
                seq: 1, createdAt: 1, updatedAt: 1 } };
        });
        const deps = createDaemonDeploymentActionDeps({ credentials: { token: 'fixture', encryption: null },
            serverId: 'srv_native_home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
            resolveRequesterIdentity: resolveOwnerRequesterIdentity,
            runtime: { async acquire() { throw new Error('Observation cannot acquire native runtime'); } } });
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps });
        const input = { serverId: 'srv_native_home', environmentId: detail.environment.id, deploymentId: receipt.deployment.id,
            ...(actionId === 'deployments.observation.get' ? { targetLinkId: link.id } : {}) };
        const context = { ...ownerContext, surface: 'cli' as const, serverId: 'srv_native_home',
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) };
        const expected = {
            ok: false, errorCode: 'unsupported_action', effectAttempted: false,
            details: { reason: 'target_not_supported', targetKind: 'ownServer',
                requiredFact: 'providerDeploymentObservation', supportedAction: 'deployments.receipts.get',
                remedy: expect.stringMatching(/\S/) },
        };
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
        const profile = { id: configuration.activeServerId, name: 'Home', serverUrl: 'https://home.test', webappUrl: 'https://home.test',
            createdAt: 1, updatedAt: 1, homeConnectionDescriptorAuthority: 'exact' as const,
            homeConnectionDescriptor: { v: 1 as const, homeServerIdentityId: 'srv_native_home', canonicalServerUrl: 'https://home.test',
                revision: 1, endpoints: [{ kind: 'https' as const, url: 'https://home.test' }] } };
        await persistence.updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [profile.id]: profile } }));
        persistence.writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
            controlToken: 'fixture-control', machineId: 'machine-a', accountId: 'owner' });
        const received: string[] = [];
        // Home admits these private-content roots even on the own Machine.
        // Substitute HTTP only; the CLI dispatcher and receiving daemon Action owners stay real.
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            transportPaths.push(`POST ${new URL(String(url)).pathname}`);
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(request.envelope.target).toEqual({ kind: 'machine', machineId: machine.id });
            if (String(url).endsWith('/execution-authorization')) return { status: 200, data: { v: 1, token: 'home-proof', binding: {
                accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
                admittedMachineRole: 'manage', environmentId: detail.environment.id,
                serverIdentityId: 'srv_native_home', custodianAccountId: 'owner', machineId: machine.id, installationId: machine.installationId,
                actionId, requestId: request.envelope.requestId, target: request.envelope.target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
            } } };
            received.push(actionId);
            if (request.envelope.v !== 1) throw new Error('The plain-Account fixture sends v1 envelopes');
            const result = await executor.execute(actionId, request.envelope.input, context);
            return { status: 200, data: { v: 1, actionId, requestId: request.envelope.requestId, execution: result } };
        });
        let output = '';
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
            output += String(chunk);
            const callback = args.find(argument => typeof argument === 'function');
            if (typeof callback === 'function') callback();
            return true;
        });
        try {
            if (entry === 'credentialed') {
                const lifetime = new AbortController();
                const cli = createCliActionExecutorFromCredentials({ credentials, readCredentials: async () => credentials,
                    serverId: profile.id, serverIdentityId: 'srv_native_home', serverApiUrl: profile.serverUrl,
                    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }),
                }).bindInvocation(lifetime.signal, { actionId, signal: lifetime.signal, surface: 'cli' });
                try {
                    const result = await cli.execute(actionId, input, { surface: 'cli', authority: 'present_user',
                        actionCaller: { kind: 'host' }, serverId: profile.id, serverIdentityId: 'srv_native_home',
                        externalActionTarget: { kind: 'machine', machineId: machine.id }, signal: lifetime.signal });
                    expect(received, JSON.stringify({ result, transportPaths })).toEqual([actionId]);
                    expect(result).toMatchObject(expected);
                } finally { lifetime.abort(); }
                return;
            }
            await handleActionsCommand(['invoke', actionId, '--input-json', JSON.stringify(input),
                '--server-id', profile.id, '--machine-id', 'machine-a', '--json'], {
                readCredentialsFn: async () => credentials, readCredentialsForServerIdFn: async () => credentials,
                getServerProfileFn: async () => ({ ...profile, lastUsedAt: 1 }),
                createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
                    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }) }),
            });
            expect(received, JSON.stringify({ output: JSON.parse(output), transportPaths })).toEqual([actionId]);
            expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: 'unsupported_action', details: expected.details } });
        } finally { vi.unstubAllGlobals(); process.exitCode = undefined; }
        });
    });

    it.each([
        { actionId: 'deployments.receipts.observe', selection: 'active' },
        { actionId: 'deployments.receipts.observe', selection: 'retained' },
        { actionId: 'deployments.observation.get', selection: 'active' },
    ] as const)(
        'routes CLI $actionId to the receipt owner for a cold native receipt ($selection)', async ({ actionId, selection }) => {
        await withConfiguredDaemonTestHome({ prefix: 'happier-native-observation-',
            env: { HAPPIER_SERVER_URL: 'https://home.test', HAPPIER_WEBAPP_URL: 'https://home.test' } }, async () => {
        const detail = createDeploymentEnvironmentDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        const link = detail.targetLinks[0]!.targetLink;
        if (selection === 'retained') detail.environment.runtimeTargetLinkId = undefined;
        const keys = tweetnacl.sign.keyPair();
        const machine = { id: 'machine-a', kind: 'persistent', active: true, activeAt: Date.now(),
            installationId: 'installation-a', installationPublicKey: Buffer.from(keys.publicKey).toString('base64'),
            revokedAt: null, replacedByMachineId: null, dataEncryptionKey: null, runnerContentKeyBinding: null,
            access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
        receipt.deployment.environmentId = detail.environment.id;
        receipt.deployment.targetLinkId = link.id;
        const documents = new Map<string, { row: Pick<typeof receipt.deployment,
            'contentArtifactId' | 'contentHeaderVersion' | 'contentBodyVersion'>; kind: string; content: unknown }>([
            [detail.environment.contentArtifactId, { row: detail.environment, kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, content: detail.content }],
            [link.contentArtifactId, { row: link, kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, content: detail.targetLinks[0]!.content }],
            [receipt.deployment.contentArtifactId, { row: receipt.deployment, kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, content: receipt.content }],
        ]);
        // Home metadata and the Account Artifact transport are system boundaries.
        const transportPaths: string[] = [];
        vi.spyOn(axios, 'request').mockImplementation(async request => ({ status: 200,
            data: String(request.url).includes('/receipts/')
                ? { ok: true, deployment: receipt.deployment, cancellable: false }
                : { ok: true, environment: detail.environment, secretScope: detail.secretScope, targetLinks: [link] } }));
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(url).pathname;
            transportPaths.push(`GET ${path}`);
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            if (path === '/v1/account/encryption/currentness') return { status: 200,
                data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
            if (path === '/v1/features/authenticated') return { status: 200,
                data: { features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_native_home' } } } };
            if (path === '/v1/machines/machine-a') return { status: 200, data: { machine } };
            if (path === '/v1/machines') return { status: 200, data: [machine] };
            const document = documents.get(path.slice('/v1/artifacts/'.length));
            if (!document) throw new Error('Unexpected Artifact read');
            return { status: 200, data: { id: document.row.contentArtifactId, ownerAccountId: 'owner',
                access: 'owner', publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent({ kind: document.kind, title: 'Native deployment' }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(document.content) }),
                headerVersion: document.row.contentHeaderVersion, bodyVersion: document.row.contentBodyVersion,
                seq: 1, createdAt: 1, updatedAt: 1 } };
        });
        const deps = createDaemonDeploymentActionDeps({ credentials: { token: 'fixture', encryption: null },
            serverId: 'srv_native_home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
            resolveRequesterIdentity: resolveOwnerRequesterIdentity,
            runtime: { async acquire() { throw new Error('Observation cannot acquire native runtime'); } } });
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps });
        const input = { serverId: 'srv_native_home', environmentId: detail.environment.id, deploymentId: receipt.deployment.id,
            ...(actionId === 'deployments.observation.get' ? { targetLinkId: link.id } : {}) };
        const context = { ...ownerContext, surface: 'cli' as const, serverId: 'srv_native_home',
            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) };
        const expected = {
            ok: false, errorCode: 'unsupported_action', effectAttempted: false,
            details: { reason: 'target_not_supported', targetKind: 'ownServer',
                requiredFact: 'providerDeploymentObservation', supportedAction: 'deployments.receipts.get',
                remedy: expect.stringMatching(/\S/) },
        };
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 1,
            provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
        const credentials = { token, encryption: null, credentialProvenance: 'stored_session' as const };
        const profile = { id: configuration.activeServerId, name: 'Home', serverUrl: 'https://home.test', webappUrl: 'https://home.test',
            createdAt: 1, updatedAt: 1, homeConnectionDescriptorAuthority: 'exact' as const,
            homeConnectionDescriptor: { v: 1 as const, homeServerIdentityId: 'srv_native_home', canonicalServerUrl: 'https://home.test',
                revision: 1, endpoints: [{ kind: 'https' as const, url: 'https://home.test' }] } };
        await persistence.updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [profile.id]: profile } }));
        persistence.writeDaemonState({ pid: process.pid, httpPort: 43123, startedAt: Date.now(), startedWithCliVersion: 'test',
            controlToken: 'fixture-control', machineId: 'machine-a', accountId: 'owner' });
        const received: string[] = [];
        // Home admits these private-content roots even on the own Machine.
        // Substitute HTTP only; the CLI dispatcher and receiving daemon Action owners stay real.
        vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
            transportPaths.push(`POST ${new URL(String(url)).pathname}`);
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(request.envelope.target).toEqual({ kind: 'machine', machineId: machine.id });
            if (String(url).endsWith('/execution-authorization')) return { status: 200, data: { v: 1, token: 'home-proof', binding: {
                accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
                admittedMachineRole: 'manage', environmentId: detail.environment.id,
                serverIdentityId: 'srv_native_home', custodianAccountId: 'owner', machineId: machine.id, installationId: machine.installationId,
                actionId, requestId: request.envelope.requestId, target: request.envelope.target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
            } } };
            received.push(actionId);
            if (request.envelope.v !== 1) throw new Error('The plain-Account fixture sends v1 envelopes');
            const result = await executor.execute(actionId, request.envelope.input, context);
            return { status: 200, data: { v: 1, actionId, requestId: request.envelope.requestId, execution: result } };
        });
        let output = '';
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
            output += String(chunk);
            const callback = args.find(argument => typeof argument === 'function');
            if (typeof callback === 'function') callback();
            return true;
        });
        try {
            await handleActionsCommand(['invoke', actionId, '--input-json', JSON.stringify(input),
                '--server-id', profile.id, '--machine-id', 'machine-a', '--json'], {
                readCredentialsFn: async () => credentials, readCredentialsForServerIdFn: async () => credentials,
                getServerProfileFn: async () => ({ ...profile, lastUsedAt: 1 }),
                createExecutorFn: params => createCliActionExecutorFromCredentials({ ...params,
                    actionsSettingsProvider: createActionSettingsProvider({ accountSettings: accountSettingsParse({}) }) }),
            });
            expect(received, JSON.stringify({ output: JSON.parse(output), transportPaths })).toEqual([actionId]);
            expect(JSON.parse(output)).toMatchObject({ ok: false, error: { code: 'unsupported_action', details: expected.details } });
        } finally { vi.unstubAllGlobals(); process.exitCode = undefined; }
        });
    });

    it('keeps own-server runtime log preparation independent of private Account content', async () => {
        const detail = createDeploymentEnvironmentDetailV1();
        const link = detail.targetLinks[0]!.targetLink;
        vi.spyOn(axios, 'request').mockResolvedValue({ status: 200,
            data: { ok: true, environment: detail.environment, secretScope: detail.secretScope, targetLinks: [link] } });
        const artifacts = vi.spyOn(axios, 'get').mockRejectedValue(new Error('Runtime log recovery cannot acquire private content'));
        const deps = createDaemonDeploymentActionDeps({ credentials: { token: 'fixture', encryption: null },
            serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
            resolveRequesterIdentity: resolveOwnerRequesterIdentity,
            runtime: { async acquire() { throw new Error('Preparation must leave native execution to its reader'); } } });
        await expect(deps.prepareHostReviewedChildren!({ actionId: 'deployments.logs.read', context: ownerContext,
            input: { serverId: 'home', environmentId: detail.environment.id, deploymentId: 'retained', targetLinkId: link.id,
                machineId: 'machine-a', installationId: 'installation-a', kind: 'runtime', service: { kind: 'deployment',
                    machineId: 'machine-a', environmentId: detail.environment.id, environmentInstanceId: 'instance',
                    composeService: 'app', serviceId: 'instance/app' } } })).resolves.toBeNull();
        expect(artifacts).not.toHaveBeenCalled();
    });

    it('refuses platform build logs before opening them as an own-server receipt', async () => {
        const detail = createDeploymentEnvironmentDetailV1();
        const link = { ...detail.targetLinks[0]!.targetLink, targetKind: 'vercel', machines: [], members: [],
            source: { kind: 'plugin' as const, contribution: { pluginId: 'happier.deploy.vercel', localId: 'runtime' } } };
        const receipt = createDeploymentReceiptDetailV1();
        receipt.deployment = { ...receipt.deployment, environmentId: detail.environment.id, targetLinkId: link.id };
        const keys = tweetnacl.sign.keyPair();
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({
            version: 1, installationId: 'installation-a', createdAt: 1,
            publicKey: Buffer.from(keys.publicKey).toString('base64url'),
            privateKey: Buffer.from(keys.secretKey).toString('base64url'),
        });
        vi.spyOn(axios, 'request').mockImplementation(async config => ({ status: 200,
            data: String(config.url).includes('/receipts/')
                ? { ok: true, deployment: receipt.deployment, cancellable: false }
                : { ok: true, environment: detail.environment, secretScope: detail.secretScope, targetLinks: [link] } }));
        const artifacts = vi.spyOn(axios, 'get').mockRejectedValue(new Error('Platform logs must not open own-server content'));
        const deps = createDaemonDeploymentActionDeps({ credentials: { token: 'fixture', encryption: null },
            serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
            resolveRequesterIdentity: resolveOwnerRequesterIdentity,
            runtime: { async acquire() { throw new Error('Unsupported logs cannot acquire native runtime'); } } });
        const result = await deps.deploymentAction('deployments.logs.read', { serverId: 'home',
            environmentId: detail.environment.id, deploymentId: receipt.deployment.id, targetLinkId: link.id,
            machineId: 'machine-a', installationId: 'installation-a', kind: 'build' }, ownerContext);
        expect(result).toMatchObject({ ok: false, errorCode: 'unsupported_action', details: {
            requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/) } });
        expect(artifacts).not.toHaveBeenCalled();
    });

    it.each([
        { input: { mode: 'preview', definition: { from: 'image', image: 'nginx:alpine', port: 80 } }, path: ['name'] },
        { input: { contentArtifactId: 'content' }, path: ['contentHeaderVersion'] },
        { input: { mode: 'unsupported' }, path: ['mode'] },
        { input: { mode: 'apply', name: 'App', definition: { from: 'image', image: 'nginx:alpine', port: 80 } }, path: ['mode'] },
        { input: { name: 'App', definition: { from: 'image', image: 'nginx:alpine', port: 80 } }, path: ['mode'] },
    ])('reports actionable create input issues at $path instead of client custody', async ({ input, path }) => {
        const deps = createDaemonDeploymentActionDeps({ credentials: { token: 'fixture', encryption: null },
            serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
            resolveRequesterIdentity: resolveOwnerRequesterIdentity,
            runtime: { async acquire() { throw new Error('Invalid input cannot acquire execution'); } } });
        const result = await deps.deploymentAction('deployments.environments.create', {
            serverId: 'home', projectSourceId: 'source', requestKey: 'create',
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'machine-a',
            ...input,
        }, ownerContext);
        expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: {
            issues: expect.arrayContaining([expect.objectContaining({ path })]),
        } });
    });

    it.each(['action', 'preparation'] as const)('names the missing controller and repair through create %s', async entry => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const deps = createDaemonDeploymentActionDeps({ credentials: { token, encryption: null },
            serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
            resolveRequesterIdentity: resolveOwnerRequesterIdentity,
            runtime: { async acquire() { throw new Error('Missing controller cannot acquire execution'); } } });
        const input = DeploymentEnvironmentCreateIntentInputV1Schema.parse({
            serverId: 'home', requestKey: 'create', mode: 'preview', name: 'App',
            newProject: { name: 'Project', requestKey: 'project', owner: { kind: 'team', teamId: 'team' } },
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            definition: { from: 'image', image: 'nginx:alpine', port: 80 },
        });
        const result = entry === 'action'
            ? await deps.deploymentAction('deployments.environments.create', input, ownerContext)
            : await deps.prepareDeploymentEnvironmentCreate({ input, context: ownerContext });
        expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: {
            requiredFact: 'controller_machine', remedy: 'pass_controllerMachineId_or_set_project_default',
            issues: [{ code: 'custom', path: ['controllerMachineId'] }],
        } });
    });

    it.each(['plain', 'e2ee'] as const)('projects failure and cancellation facts from %s content without reopening metadata', async mode => {
        const receipt = createDeploymentReceiptDetailV1();
        receipt.content.failure = { phase: 'build', code: 'build_failed',
            failureCause: { phase: 'deployment.native.build.build_failed', errorClass: 'Error',
                errorCode: 'deployment_disk_full', httpStatus: null },
            sourceAdmission: { phase: 'deployment_source_admission', reason: 'requester_authority_unavailable',
                requiredFact: 'verified_root_requester', remedy: 'retry_original_request' } };
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null
            : { type: 'legacy', secret: new Uint8Array(32).fill(23) } };
        const key = await createResourceDataKey({ credentials, mode });
        const encode = (value: unknown) => key.mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : Buffer.from(encryptWithDataKey(value, key.dataKey)).toString('base64');
        let contentReads = 0;
        let content: unknown = receipt.content;
        let available = true;
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 0 } };
            expect(path).toBe(`/v1/artifacts/${receipt.deployment.contentArtifactId}`);
            contentReads++;
            if (!available) return { status: 404, data: {} };
            return { status: 200, data: { id: receipt.deployment.contentArtifactId, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                encryptionMode: mode, dataEncryptionKey: key.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : key.dataEncryptionKey,
                header: encode({ kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: 'Private deployment' }),
                body: encode({ body: JSON.stringify(content) }),
                headerVersion: receipt.deployment.contentHeaderVersion, bodyVersion: receipt.deployment.contentBodyVersion,
                seq: 1, createdAt: 1, updatedAt: 1 } };
        });
        let deployment = { ...receipt.deployment, state: 'succeeded' as 'succeeded' | 'failed' | 'running' };
        const metadata = vi.spyOn(axios, 'request').mockImplementation(async request => {
            expect(new URL(request.url!).searchParams.has('projection')).toBe(false);
            return { status: 200, data: { ok: true, deployment, cancellable: false } };
        });
        const deps = createDaemonDeploymentActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
            resolveRequesterIdentity: resolveOwnerRequesterIdentity,
            runtime: { async acquire() { throw new Error('Receipt read cannot acquire deployment runtime'); } } });
        const input = { serverId: 'home', environmentId: receipt.deployment.environmentId, deploymentId: receipt.deployment.id };
        await expect(deps.deploymentAction('deployments.receipts.get', input, {})).resolves.toEqual({ ok: true, deployment, cancellable: false });
        expect(contentReads).toBe(0);
        deployment = { ...deployment, state: 'failed' };
        const source = receipt.content.sourceIntent;
        if (source.kind !== 'repository') throw new Error('Expected repository receipt fixture');
        const failed = DeploymentReceiptGetResultV1Schema.parse(await deps.deploymentAction('deployments.receipts.get',
            { ...input, projection: 'investigation' }, {}));
        expect(failed).toMatchObject({ ok: true, deployment, cancellable: false, failureSummary: { phase: 'build', code: 'build_failed',
            requiredFact: 'verified_root_requester', remedy: 'retry_original_request' }, investigation: {
            source: { kind: 'repository', projectSourceId: source.projectSourceId,
                sourceRevision: source.sourceRevision, sha: source.sha },
            failure: receipt.content.failure,
        } });
        expect(JSON.stringify(failed)).not.toContain('sourceIntent');
        expect(contentReads).toBe(1);
        expect(metadata).toHaveBeenCalledTimes(2);
        deployment = { ...deployment, state: 'running' };
        content = { ...receipt.content, machineResults: receipt.content.machineResults.map(result => ({ ...result,
            activation: 'pending', incumbentStopped: true })) };
        const stopped = await deps.deploymentAction('deployments.receipts.get', input, {});
        expect(DeploymentReceiptGetResultV1Schema.parse(stopped)).toMatchObject({ ok: true,
            cancellationConsequence: { kind: 'service-down-until-rollback' } });
        content = { ...receipt.content, machineResults: receipt.content.machineResults.map(result => ({ ...result,
            activation: 'pending', incumbentStopped: false })) };
        await expect(deps.deploymentAction('deployments.receipts.get', input, {})).resolves.not.toHaveProperty('cancellationConsequence');
        expect(contentReads).toBe(3);
        expect(metadata).toHaveBeenCalledTimes(4);
        deployment = { ...deployment, state: 'failed' };
        content = { ...receipt.content, failure: { phase: 'send', code: 'plugin_action_execution_failed' } };
        await expect(deps.deploymentAction('deployments.receipts.get', input, {}))
            .resolves.toMatchObject({ ok: true, failureSummary: { phase: 'send', code: 'plugin_action_execution_failed',
                requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/) } });
        content = { ...receipt.content, failure: undefined };
        await expect(deps.deploymentAction('deployments.receipts.get', input, {}))
            .resolves.toMatchObject({ ok: true, failureSummary: null });
        content = { ...receipt.content, failure: { phase: 'invented', code: 'build_failed' } };
        await expect(deps.deploymentAction('deployments.receipts.get', input, {}))
            .resolves.toMatchObject({ ok: false, errorCode: 'deployment_content_unavailable' });
        available = false;
        await expect(deps.deploymentAction('deployments.receipts.get', input, {}))
            .resolves.toMatchObject({ ok: false, errorCode: 'deployment_content_unavailable' });
        deployment = { ...deployment, environmentId: 'another-environment' };
        await expect(deps.deploymentAction('deployments.receipts.get', input, {}))
            .resolves.toMatchObject({ ok: false, errorCode: 'target_mismatch' });
        expect(contentReads).toBe(7);
    });
    it('uses signed PAT HTTP authority for keyless health, logs and detach while retaining content custody', async () => {
        const homeDir = await mkdtemp(join(tmpdir(), 'happier-keyless-deployment-'));
        const previousHome = Object.getOwnPropertyDescriptor(configuration, 'happyHomeDir')!;
        const previousSettings = Object.getOwnPropertyDescriptor(configuration, 'settingsFile')!;
        try {
        Object.defineProperty(configuration, 'happyHomeDir', { configurable: true, value: homeDir });
        Object.defineProperty(configuration, 'settingsFile', { configurable: true, value: join(homeDir, 'settings.json') });
        const profile = await addServerProfile({ name: 'home', serverUrl: 'https://home.test', webappUrl: 'https://home.test' });
        await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
            v: 1, homeServerIdentityId: 'srv_keyless_home', canonicalServerUrl: profile.serverUrl, revision: 1,
            endpoints: [{ kind: 'https', url: profile.serverUrl }],
        } });
        const detail = createDeploymentEnvironmentDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        const link = detail.targetLinks[0]!.targetLink;
        detail.environment.controllerMachineId = 'machine-a';
        detail.environment.runtimeTargetLinkId = link.id;
        link.members = [{ machineId: 'machine-a', installationId: 'installation-a', state: 'active' }];
        receipt.deployment.environmentId = detail.environment.id;
        receipt.deployment.targetLinkId = link.id;
        const target = { kind: 'machine' as const, machineId: 'machine-a' };
        const input = { serverId: 'home', machineId: target.machineId,
            environmentId: detail.environment.id, targetLinkId: link.id };
        const envelope = { v: 1 as const, requestId: 'keyless-health', target, input };
        const authorization: ExternalActionExecutionAuthorizationV1 = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-pat-root', binding: {
            accountId: 'owner', principalId: 'principal', credentialId: '00000000-0000-4000-8000-000000000001',
            grant: API_TOKEN_FULL_GRANT_V1, serverIdentityId: 'home', machineId: target.machineId,
            custodianAccountId: 'owner', installationId: 'installation-a', accountEncryptionMode: 'e2ee',
            actionId: 'deployments.health.current', requestId: envelope.requestId, target,
            deploymentReadAdmission: projectDeploymentReadAdmissionV1('deployments.health.current', input),
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } });
        Object.defineProperty(authorization, 'requesterHttpProjection', { enumerable: false, value: {
            accountId: 'owner', serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test',
            accountEncryptionMode: 'e2ee', isCurrent: async () => true,
            createRequestHeaders: async () => ({ 'x-signed-root': 'admitted' }),
        } });
        let priorReceipt: ReturnType<typeof createDeploymentReceiptHeaderV1> | null = null;
        let priorReceiptLists = 0;
        const requests = vi.spyOn(axios, 'request').mockImplementation(async request => {
            expect(request.headers).toMatchObject({ 'x-signed-root': 'admitted' });
            expect(request.headers).not.toHaveProperty('Authorization');
            const path = new URL(request.url!).pathname;
            if (path.endsWith('/deployments')) {
                priorReceiptLists++;
                return { status: 200, data: DeploymentReceiptListResultV1Schema.parse({ ok: true,
                    items: priorReceipt ? [priorReceipt] : [], nextCursor: null }) };
            }
            if (path.endsWith(`/receipts/${receipt.deployment.id}`)) return { status: 200,
                data: DeploymentReceiptGetResultV1Schema.parse({ ok: true, deployment: receipt.deployment }) };
            if (path.endsWith('/teardown')) return { status: 200, data: { ok: true,
                environmentId: detail.environment.id, revision: detail.environment.revision + 1,
                targetLinkId: link.id, targetLinkRevision: link.revision + 1, detached: true } };
            return { status: 200, data: { ok: true, environment: detail.environment, secretScope: detail.secretScope,
                targetLinks: detail.targetLinks.map(row => row.targetLink) } };
        });
        const keys = tweetnacl.sign.keyPair();
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({
            version: 1, installationId: 'installation-a', createdAt: 1,
            publicKey: Buffer.from(keys.publicKey).toString('base64url'),
            privateKey: Buffer.from(keys.secretKey).toString('base64url'),
        });
        const artifacts = vi.spyOn(axios, 'get');
        const deps = createDaemonDeploymentActionDeps({ credentials: { token: 'installed-bearer', encryption: null },
            serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: target.machineId,
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
            readOperation: async () => null,
            runtime: { async acquire() { throw new Error('Keyless read cannot acquire native deployment runtime'); } } });
        const context: ActionExecutorContext = { authority: 'account_automation', runtimeAccountId: 'owner',
            externalActionTarget: target, externalActionExecutionAuthorization: authorization };
        const health = await deps.deploymentAction('deployments.health.current', input, context);
        expect(health, JSON.stringify(health)).toMatchObject({ ok: true, observation: null });
        expect(requests).toHaveBeenCalled();
        // A platform (Vercel-shaped) runtime link reaches the same controller owner,
        // which answers with a typed reason instead of an authorization refusal.
        const ownServerRow = detail.targetLinks[0]!;
        detail.targetLinks[0] = { ...ownServerRow, targetLink: { ...link, targetKind: 'platform', machines: [], members: [],
            source: { kind: 'plugin', contribution: { pluginId: 'happier.deploy.vercel', localId: 'vercel' } } } };
        await expect(deps.deploymentAction('deployments.health.current', input, context)).resolves.toMatchObject({
            ok: false, errorCode: 'unsupported_action', effectAttempted: false,
            details: { reason: 'target_not_supported', targetKind: 'platform', supportedAction: 'deployments.observation.get' } });
        detail.targetLinks[0] = ownServerRow;
        detail.environment.controllerMachineId = 'machine-b';
        await expect(deps.deploymentAction('deployments.health.current', input, context)).resolves.toMatchObject({
            ok: false, errorCode: 'target_mismatch', details: { reason: 'controller_placement', controllerMachineId: 'machine-b' } });
        detail.environment.controllerMachineId = 'machine-a';
        const logsInput = { serverId: 'home', machineId: target.machineId, installationId: 'installation-a',
            environmentId: detail.environment.id, deploymentId: receipt.deployment.id,
            targetLinkId: link.id, kind: 'runtime' as const,
            service: { kind: 'deployment' as const, machineId: target.machineId,
                environmentId: detail.environment.id,
                environmentInstanceId: resolveOwnServerDeploymentEnvironmentInstanceIdForHost('srv_keyless_home', detail.environment.id),
                composeService: 'app', serviceId: `${resolveOwnServerDeploymentEnvironmentInstanceIdForHost('srv_keyless_home', detail.environment.id)}/app` } };
        const logsEnvelope = { v: 1 as const, requestId: 'keyless-logs', target, input: logsInput };
        const logsAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({
            v: 1, token: 'signed-pat-logs', binding: { ...authorization.binding,
                actionId: 'deployments.logs.read', requestId: logsEnvelope.requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(logsEnvelope),
                deploymentReadAdmission: projectDeploymentReadAdmissionV1('deployments.logs.read', logsInput),
            },
        });
        Object.defineProperty(logsAuthorization, 'requesterHttpProjection', { enumerable: false,
            value: authorization.requesterHttpProjection });
        // The OS executable boundary is intentionally unavailable on every host.
        vi.stubEnv('PATH', '');
        const logs = await deps.deploymentAction('deployments.logs.read', logsInput,
            { ...context, externalActionExecutionAuthorization: logsAuthorization });
        await expect(deps.deploymentAction('deployments.observation.get', {
            serverId: 'home', environmentId: detail.environment.id, targetLinkId: link.id,
        }, context)).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action',
            details: { reason: 'target_not_supported', targetKind: 'ownServer', requiredFact: 'providerDeploymentObservation' } });
        expect(artifacts).not.toHaveBeenCalled();
        priorReceipt = createDeploymentReceiptHeaderV1({ environmentId: detail.environment.id, targetLinkId: link.id,
            state: 'queued', actionOperationId: 'prior-operation', requestedByAccountId: 'owner',
            acceptedExecution: { v: 1, controller: { machineId: target.machineId, installationId: 'installation-a' } } });
        const detachInput = { serverId: 'home', environmentId: detail.environment.id,
            expectedRevision: detail.environment.revision, targetLinkId: link.id,
            expectedTargetLinkRevision: link.revision, requestKey: 'keyless-detach', reason: 'manual' as const,
            detachKeepRunning: true as const };
        const detachEnvelope = { v: 1 as const, requestId: 'keyless-detach', target, input: detachInput };
        const detachAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({
            v: 1, token: 'signed-pat-detach', binding: { ...authorization.binding,
                actionId: 'deployments.teardown', requestId: detachEnvelope.requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(detachEnvelope),
                deploymentReadAdmission: undefined,
            },
        });
        Object.defineProperty(detachAuthorization, 'requesterHttpProjection', { enumerable: false,
            value: authorization.requesterHttpProjection });
        const detach = await deps.deploymentAction('deployments.teardown', detachInput,
            { ...context, externalActionExecutionAuthorization: detachAuthorization });
        expect(detach, JSON.stringify(detach)).toMatchObject({ ok: true, detached: true });
        expect(priorReceiptLists).toBe(0);
        expect(artifacts).not.toHaveBeenCalled();
        expect(logs, JSON.stringify({ logs, paths: requests.mock.calls.map(([request]) => new URL(request.url!).pathname) }))
            .toMatchObject({ ok: false, errorCode: 'plugin_exec_system_tool_unavailable',
                details: { kind: 'systemToolUnavailable', toolId: 'docker' } });
        } finally {
            Object.defineProperty(configuration, 'happyHomeDir', previousHome);
            Object.defineProperty(configuration, 'settingsFile', previousSettings);
            await rm(homeDir, { recursive: true, force: true });
        }
    });
    it('retains validated top-level owner causes with the deployment failure code', () => {
        const failureCause = { phase: 'deployment.artifact.create', errorClass: 'Error', errorCode: null, httpStatus: 503 };
        const failure = projectDeploymentFailure('create_failed', { failureCause, message: 'private-server-message' });
        expect(ActionExecuteFailureSchema.parse(failure))
            .toEqual({ ok: false, errorCode: 'create_failed', error: 'create_failed', failureCause,
                details: { requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/) } });
        expect(readActionOutputDiagnostic({ ...failure })).toMatchObject({ failureCause });
        expect(JSON.stringify(failure)).not.toContain('private-server-message');
    });
    it.each([
        ['off', 'compact', 'deployment_access_denied'],
        ['off', 'prepared', 'deployment_access_denied'],
        ['approveEachCommit', 'compact', 'present_user_required'],
        ['approveEachCommit', 'prepared', 'present_user_required'],
    ] as const)('refuses %s fork preview %s deployment before candidate or credential acquisition', async (forkPreviews, entry, errorCode) => {
        const environment = createDeploymentEnvironmentDetailV1();
        const template = createDeploymentEnvironmentDetailV1();
        template.environment.id = 'preview-template';
        template.environment.contentArtifactId = 'preview-template-content';
        for (const row of template.targetLinks) row.targetLink.environmentId = template.environment.id;
        const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'owner/app' };
        environment.environment.purpose = 'preview';
        environment.environment.previewTemplateEnvironmentId = template.environment.id;
        environment.environment.previewRepositoryId = 'source-repository';
        environment.environment.previewPullRequestId = '17';
        environment.environment.previewTargetLinkId = template.targetLinks[0].targetLink.id;
        environment.content.previewProvenance = { v: 1, templateEnvironmentId: template.environment.id,
            runtimeTargetLinkId: template.targetLinks[0].targetLink.id, repository, pullRequestId: '17', pullRequestNumber: 17,
            author: { id: 'contributor', login: 'contributor' }, headRepository: { ...repository, repository: 'contributor/app' } };
        template.content.previewTemplate = { v: 1, enabled: true, forkPreviews, repository,
            runtimeTargetLinkId: template.targetLinks[0].targetLink.id, domain: null, bindingBlueprints: [], data: [] };
        const receipt = createDeploymentReceiptDetailV1();
        const documents = new Map<string, { kind: string; content: unknown }>();
        for (const detail of [environment, template]) {
            documents.set(detail.environment.contentArtifactId, { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, content: detail.content });
            for (const row of detail.targetLinks) documents.set(row.targetLink.contentArtifactId,
                { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, content: row.content });
        }
        documents.set(receipt.deployment.contentArtifactId, { kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, content: receipt.content });
        // HTTP and runtime acquisition are genuine system boundaries; all private
        // Artifact decoding and daemon candidate admission remain production code.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
            const document = documents.get(id);
            if (!document) return { status: 404, data: {} };
            return { status: 200, data: { id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent({ kind: document.kind, title: 'Preview' }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(document.content) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
        });
        const effects: unknown[] = [];
        vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
            effects.push({ url, body });
            throw new Error('Fork must fail before Artifact mutation');
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (request.method !== 'GET') { effects.push(request); throw new Error('Fork must fail before mutation'); }
            const path = new URL(request.url!).pathname;
            if (path.endsWith('/deployments')) return { status: 200, data: { ok: true, items: [], nextCursor: null } };
            if (path.endsWith(`/receipts/${receipt.deployment.id}`))
                return { status: 200, data: { ok: true, deployment: receipt.deployment } };
            const detail = path.endsWith(`/${template.environment.id}`) ? template : environment;
            return { status: 200, data: { ok: true, environment: detail.environment, secretScope: detail.secretScope,
                targetLinks: detail.targetLinks.map(row => row.targetLink) } };
        });
        const acquire = vi.fn(async () => { throw createActionExecuteFailureError({ ok: false, error: 'fork_acquisition_reached', errorCode: 'fork_acquisition_reached' }); });
        const acquireCandidate = vi.fn(async () => { throw createActionExecuteFailureError({ ok: false, error: 'fork_acquisition_reached', errorCode: 'fork_acquisition_reached' }); });
        const deps = createDaemonDeploymentActionDeps({ credentials: { token: 'fixture', encryption: null },
            serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
            resolveRequesterIdentity: resolveOwnerRequesterIdentity, runtime: { acquire, acquireCandidate } });
        const execute = () => entry === 'compact'
            ? deps.prepareDeployCandidate({ environmentId: environment.environment.id, context: ownerContext })
            : deps.prepareDeploymentAction({ actionId: 'deployments.deploy', context: ownerContext, input: {
                serverId: 'home', environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
                targetLinkId: environment.targetLinks[0].targetLink.id, expectedTargetLinkRevision: environment.targetLinks[0].targetLink.revision,
                requestKey: 'fork-deploy', contentArtifactId: receipt.deployment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 } });
        expect(await execute()).toMatchObject({ ok: false, errorCode });
        expect(effects).toEqual([]);
        expect(acquire).not.toHaveBeenCalled();
        expect(acquireCandidate).not.toHaveBeenCalled();
        // A same-repository head passes preview policy and reaches this exact
        // fixture's acquisition boundary, so absence above is discriminating.
        environment.content.previewProvenance.headRepository = repository;
        expect(await execute()).toMatchObject({ ok: false, errorCode: 'fork_acquisition_reached' });
        expect(entry === 'compact' ? acquireCandidate : acquire).toHaveBeenCalled();
    });
    it('requires Manage for definition writes and Use source overrides before native acquisition', async () => {
        const environment = createDeploymentEnvironmentDetailV1();
        vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true,
            environmentId: environment.environment.id, revision: 1 } });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            return { status: 200, data: { id: 'definition', ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'App' }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(environment.content) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
        });
        const deps = createDaemonDeploymentActionDeps({
            credentials: { token: 'fixture', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
            machineId: 'machine-a', resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
            runtime: { async acquire() { throw new Error('Denied definitions cannot acquire runtime'); } },
        });
        const context = { machineAdmission: { actorAccountId: 'member', custodianAccountId: 'owner', machineId: 'machine-a',
            installationId: 'installation-a', role: 'use' as const, encryptionMode: 'plain' as const },
            verifyMachineAdmissionCurrent: async () => true };
        const prepared = { serverId: 'home', contentArtifactId: 'definition', contentHeaderVersion: 1, contentBodyVersion: 1 };
        await expect(deps.deploymentAction('deployments.environments.create', { ...prepared, projectSourceId: 'source-app',
            requestKey: 'create', protection: 'nonProduction', purpose: 'standard', deployerMode: 'members', controllerMachineId: 'machine-a' }, context))
            .resolves.toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
        for (const mode of ['apply', 'preview'] as const) {
            await expect(deps.deploymentAction('deployments.environments.create', { serverId: 'home', projectSourceId: 'source-app',
                requestKey: 'authored-create', mode, name: 'App', definition: { from: 'image', image: 'nginx:1', port: 80 },
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'members', controllerMachineId: 'machine-a' }, context))
                .resolves.toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
        }
        expect(axios.request).not.toHaveBeenCalled();
        await expect(deps.deploymentAction('deployments.environments.update', { ...prepared,
            environmentId: environment.environment.id, expectedRevision: 1 }, context))
            .resolves.toMatchObject({ ok: false, errorCode: 'action_forbidden' });
        for (const override of [{ sha: 'a'.repeat(40) }, { sourceMethod: 'upload' as const }, { services: ['database'] },
            { sourceIntent: createDeploymentReceiptDetailV1().content.sourceIntent }]) {
            await expect(deps.prepareDeployCandidate({ environmentId: environment.environment.id, context, ...override }))
                .resolves.toMatchObject({ ok: false, errorCode: 'action_forbidden' });
        }
        await expect(deps.deploymentAction('deployments.environments.create', { ...prepared, projectSourceId: 'source-app',
            requestKey: 'manage-create', protection: 'nonProduction', purpose: 'standard', deployerMode: 'members', controllerMachineId: 'machine-a' },
        { ...context, machineAdmission: { ...context.machineAdmission, role: 'manage' } }))
            .resolves.toMatchObject({ ok: true });
        await expect(deps.deploymentAction('deployments.environments.update', { ...prepared,
            environmentId: environment.environment.id, expectedRevision: 1 }, {}))
            .resolves.toMatchObject({ ok: false, errorCode: 'action_forbidden' });
        const target = { kind: 'machine' as const, machineId: 'machine-a' };
        const envelope = { v: 1 as const, requestId: 'old-root', target, input: prepared };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'old-root', binding: {
            serverIdentityId: 'home', accountId: 'member', authentication: { kind: 'account', tokenEpoch: 1 },
            actionId: 'deployments.deploy', requestId: envelope.requestId, target, machineId: 'machine-a',
            installationId: 'installation-a', custodianAccountId: 'owner', accountEncryptionMode: 'plain',
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } });
        await expect(deps.prepareDeployCandidate({ environmentId: environment.environment.id,
            context: { ...context, externalActionExecutionAuthorization: authorization } }))
            .resolves.toMatchObject({ ok: false, errorCode: 'action_forbidden' });
        for (const binding of [{ ...authorization.binding, admittedMachineRole: 'use' as const },
            { ...authorization.binding, machineId: 'foreign-machine', admittedMachineRole: 'manage' as const }]) {
            const signed = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, binding });
            await expect(deps.deploymentAction('deployments.environments.create', { ...prepared, projectSourceId: 'source-app',
                requestKey: 'signed-create', protection: 'nonProduction', purpose: 'standard', deployerMode: 'members', controllerMachineId: 'machine-a' },
            { ...context, machineAdmission: { ...context.machineAdmission, role: 'manage' }, externalActionExecutionAuthorization: signed }))
                .resolves.toMatchObject({ ok: false, errorCode: binding.admittedMachineRole === 'use'
                    ? 'deployment_access_denied' : 'action_forbidden' });
        }
    });
    it('rejects Use candidates that replace stored environment, ports, or service definitions', async () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const storedDefinition = (services: unknown) => {
            const document = JSON.stringify({ services });
            return { kind: 'stored' as const, contentRevision: 1, document,
                composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['app'] };
        };
        environment.content.definition = storedDefinition({ app: { image: 'example/app:1' } });
        const receipt = createDeploymentReceiptDetailV1();
        receipt.content.sourceIntent = environment.content.definition;
        receipt.content.machines = environment.targetLinks[0].targetLink.machines;
        receipt.content.buildMachineId = environment.environment.buildMachineId!;
        vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true, environment: environment.environment, secretScope: environment.secretScope,
            targetLinks: environment.targetLinks.map(row => row.targetLink) } });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            const id = new URL(url).pathname.split('/').at(-1)!;
            const isEnvironment = id === environment.environment.contentArtifactId;
            return { status: 200, data: { id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent({ kind: isEnvironment ? DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1
                    : id === receipt.deployment.contentArtifactId ? DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 : DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: 'App' }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(isEnvironment ? environment.content
                    : id === receipt.deployment.contentArtifactId ? receipt.content : {}) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
        });
        const deps = createDaemonDeploymentActionDeps({ credentials: { token: 'fixture', encryption: null },
            serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
            runtime: { async acquire() { throw new Error('Definition overrides cannot acquire runtime'); } } });
        const context = { machineAdmission: { actorAccountId: 'member', custodianAccountId: 'owner', machineId: 'machine-a',
            installationId: 'installation-a', role: 'use' as const, encryptionMode: 'plain' as const }, verifyMachineAdmissionCurrent: async () => true };
        const input = { serverId: 'home', environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
            targetLinkId: environment.targetLinks[0].targetLink.id, expectedTargetLinkRevision: environment.targetLinks[0].targetLink.revision,
            requestKey: 'prepared', contentArtifactId: receipt.deployment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 };
        for (const services of [{ app: { image: 'example/app:1', environment: { COMMAND: 'changed' } } },
            { app: { image: 'example/app:1', ports: ['8080:80'] } }, { app: { image: 'example/app:2' } }]) {
            receipt.content.sourceIntent = storedDefinition(services);
            await expect(deps.prepareDeploymentAction({ actionId: 'deployments.deploy', input, context }))
                .resolves.toMatchObject({ ok: false, errorCode: 'action_forbidden' });
        }
    });
    it('prepares the exact Cloudflare Account child from private Domain custody before parent approval', async () => {
        const credentials: StoredCredentials = { token: `h.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.s`, encryption: null };
        const environment = createDeploymentEnvironmentDetailV1();
        const link = environment.targetLinks[0].targetLink;
        const credentialRef = { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'cloudflare-profile' };
        const controller = { accountId: 'vendor-account', zoneId: 'vendor-zone',
            tunnel: { kind: 'create', name: 'environment-tunnel' }, owned: [], dnsOwnership: [],
            connector: { imageRef: 'cloudflare/cloudflared:2026.10.0', version: '2026.10.0' } };
        const domain = DeploymentDomainContentV1Schema.parse({ hostname: 'app.example.test', target: { service: 'web', containerPort: 8080 },
            healthCheck: { path: '/health', expectStatus: 200 }, ingress: {
                provider: { kind: 'builtin', id: 'cloudflareNamed' }, config: { hostname: 'app.example.test', controller },
                credentialRefs: [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount', account: credentialRef } }],
            } });
        const input = DeploymentActionInputSchemasV1['deployments.domains.add'].parse({ serverId: 'home',
            environmentId: environment.environment.id, domainId: 'domain', expectedRevision: environment.environment.revision,
            targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: 'cloudflare-domain-add',
            contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1 });
        if (!('contentArtifactId' in input)) throw new Error('Expected prepared Domain input');
        const reads: string[] = [];
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            expect(request.method).toBe('GET');
            expect(new URL(request.url!).pathname).toBe(`/v1/deployments/environments/${environment.environment.id}`);
            return { status: 200, data: { ok: true, environment: environment.environment, secretScope: environment.secretScope,
                targetLinks: environment.targetLinks.map(item => item.targetLink) } };
        });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/encryption/currentness') return { status: 200,
                data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            const isEnvironment = path === `/v1/artifacts/${environment.environment.contentArtifactId}`;
            const isTargetLink = path === `/v1/artifacts/${link.contentArtifactId}`;
            if (!isEnvironment && !isTargetLink) expect(path).toBe('/v1/artifacts/domain-content');
            reads.push(path);
            return { status: 200, data: { id: isEnvironment ? environment.environment.contentArtifactId
                : isTargetLink ? link.contentArtifactId : input.contentArtifactId,
                ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent({ kind: isEnvironment ? DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1
                    : isTargetLink ? DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 : 'deployment-domain.v1', title: 'Domain' }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(isEnvironment ? environment.content
                    : isTargetLink ? environment.targetLinks[0].content : domain) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
        });
        const deps = createDaemonDeploymentActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://domain.test',
            machineId: 'controller', resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
            runtime: { async acquire() { throw new Error('Review cannot acquire native custody'); } } });
        const prepared = await deps.prepareHostReviewedChildren!({ actionId: 'deployments.domains.add', input,
            context: { serverId: 'home', runtimeAccountId: 'owner', surface: 'cli', actionCaller: { kind: 'host' } } });
        expect(prepared, JSON.stringify({ prepared, reads })).toEqual({ children: [{ action: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare-named/configure' },
            role: 'configure', scopeInput: { credentialRef, accountId: controller.accountId, zoneId: controller.zoneId,
                tunnel: controller.tunnel, owned: controller.owned, dnsOwnership: controller.dnsOwnership } }] });
        expect(reads).toEqual([`/v1/artifacts/${environment.environment.contentArtifactId}`, `/v1/artifacts/${link.contentArtifactId}`,
            '/v1/artifacts/domain-content', `/v1/artifacts/${environment.environment.contentArtifactId}`, `/v1/artifacts/${link.contentArtifactId}`]);
    });

    it('does not report Domain admission as native activation', async () => {
        const credentials: StoredCredentials = { token: `h.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.s`, encryption: null };
        const environment = createDeploymentEnvironmentDetailV1();
        const link = environment.targetLinks[0].targetLink;
        const input = DeploymentActionInputSchemasV1['deployments.domains.add'].parse({ serverId: 'home',
            environmentId: environment.environment.id, domainId: 'domain', expectedRevision: environment.environment.revision,
            targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: 'domain-add',
            contentArtifactId: 'domain-content', contentHeaderVersion: 1, contentBodyVersion: 1,
            placements: [{ machineId: 'runtime', installationId: 'runtime-installation', dockerEngineId: 'observed-engine', nativeServer: 'observed-native', listener: 'privateOrigin' }] });
        if (!('contentArtifactId' in input)) throw new Error('Expected prepared Domain input');
        const domain = { v: 1, id: input.domainId, environmentId: input.environmentId, targetLinkId: link.id, revision: 1,
            state: 'applying', contentArtifactId: input.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1,
            createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1,
            placements: [{ placement: { serverId: 'home', accountId: 'owner', environmentId: input.environmentId,
                targetLinkId: link.id, domainId: input.domainId, machineId: 'runtime', installationId: 'runtime-installation',
                nativeServer: 'observed-native', actionOperationId: 'domain-operation', requestId: 'domain-request' },
                listener: 'privateOrigin', desired: true,
                content: { contentArtifactId: input.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 } }] };
        vi.spyOn(axios, 'request').mockResolvedValue({ status: 200,
            data: { ok: true, environmentId: input.environmentId, revision: input.expectedRevision + 1, domain } });
        const deps = createDaemonDeploymentActionDeps({
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            credentials, serverId: 'home', serverHttpBaseUrl: 'https://domain.test',
            machineId: 'controller', runtime: { async acquire() { throw new Error('Domain changes cannot redeploy services'); } } });
        await expect(deps.deploymentAction('deployments.domains.add', input, {
            actionRequestId: 'domain-request', operationAcceptance: { operationId: 'domain-operation', accept() {} },
        })).resolves.toMatchObject({ ok: false, errorCode: 'action_forbidden' });
    });

    it.each([['plain', 'current', true], ['e2ee', 'current', true], ['plain', 'forbidden', true], ['plain', 'stale', true],
        ['plain', 'current', false]] as const)(
        'prepares provider data link content in %s custody before the sole storage association (%s, provider: %s)', async (mode, admission, managed) => {
        const token = `h.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.s`;
        const machineKey = new Uint8Array(32).fill(47);
        const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null : {
            type: 'dataKey', machineKey, publicKey: libsodiumPublicKeyFromSecretKey(machineKey) } };
        const environment = createDeploymentEnvironmentDetailV1();
        if (admission === 'forbidden') environment.environment.capabilities.manageTargets = false;
        const provider = DeploymentTargetLinkProviderContentV1Schema.parse({ credentialPrincipal: { kind: 'account', accountId: 'owner',
            purpose: { consumer: { pluginId: 'example.data', localId: 'link' }, purpose: 'manage' },
            target: { kind: 'account', account: { service: { pluginId: 'example.data', localId: 'service' }, accountId: 'credential' } } },
            providerIdentity: { providerAccountId: 'organization', providerResourceId: 'project', providerEnvironment: 'branch' },
            providerEnvironment: { kind: 'custom', id: 'branch' } });
        const input = DeploymentActionInputSchemasV1['deployments.targets.link'].parse({ serverId: 'home',
            environmentId: environment.environment.id, expectedRevision: environment.environment.revision, requestKey: 'link-data',
            ...(managed ? { role: 'data', targetId: 'managed-data', targetKind: 'database', title: 'Customer database',
                source: { kind: 'plugin', contribution: { pluginId: 'example.data', localId: 'database' } }, machines: [], provider }
                : { role: 'runtime', targetId: 'own-server', machines: [{ machineId: 'runtime', installationId: 'installation-runtime' }] }) });
        if (admission === 'stale') input.expectedRevision++;
        const documents = new Map<string, Record<string, unknown>>();
        const reads: string[] = [];
        const associations: unknown[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 0 } };
            const row = documents.get(path.split('/').at(-1)!);
            if (!row) throw new Error(`Unexpected link read ${path}`);
            return { status: 200, data: row };
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, raw: unknown) => {
            expect(new URL(String(url)).pathname).toBe('/v1/artifacts');
            const body = readCarrierMutation(raw);
            const id = z.string().parse(body.id);
            documents.set(id, { ...body, id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                encryptionMode: mode, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(request.url!).pathname;
            if (request.method === 'GET') {
                reads.push(path);
                return { status: 200, data: { ok: true, environment: environment.environment, secretScope: environment.secretScope,
                    targetLinks: environment.targetLinks.map(row => row.targetLink) } };
            }
            if (path === '/v1/deployments/targets/list') {
                expect(request.data).toMatchObject({ selection: { source: input.source, targetKind: input.targetKind } });
                return { status: 200, data: { ok: true, items: [], nextCursor: null, coverage: 'complete' } };
            }
            expect(path).toBe(`/v1/deployments/environments/${input.environmentId}/targets`);
            associations.push(DeploymentTargetLinkInputV1Schema.parse(request.data));
            if (admission !== 'current') return { status: admission === 'forbidden' ? 403 : 409,
                data: { ok: false, error: admission === 'forbidden' ? 'deployment_access_denied' : 'deployment_conflict' } };
            return { status: 200, data: { ok: true, environmentId: input.environmentId,
                revision: input.expectedRevision + 1, targetLinkId: 'data-link', targetLinkRevision: 1 } };
        });
        const runtime = createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://link.test',
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            machineId: 'controller', acquirePluginRuntimeRegistryLease: async () => { throw new Error('A link has no native execution'); } });
        const deps = createDaemonDeploymentActionDeps({
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            credentials, serverId: 'home', serverHttpBaseUrl: 'https://link.test',
            machineId: 'controller', runtime });
        const result = await deps.deploymentAction('deployments.targets.link', input, {});
        if (admission !== 'current') {
            expect(result).toMatchObject({ ok: false, error: admission === 'forbidden' ? 'deployment_access_denied' : 'deployment_conflict' });
            // The locked server writer owns refusal; local preparation may leave one private Artifact.
            expect(associations).toHaveLength(1);
            expect(associations[0]).not.toHaveProperty('provider');
            expect(documents.size).toBe(1);
            return;
        }
        expect(result).toMatchObject({ ok: true, targetLinkId: 'data-link' });
        expect(reads).toEqual([`/v1/deployments/environments/${input.environmentId}`]);
        expect(associations).toHaveLength(1);
        expect(associations[0]).not.toHaveProperty('provider');
        expect(documents.size).toBe(1);
        const id = [...documents.keys()][0]!;
        const artifacts = createCredentialedAccountArtifactStore(credentials);
        const opened = await runWithServerHttpBaseUrl('https://link.test', () => artifacts.read(id, { prepareRecipients: false, includeSharedAudience: false }));
        if (!opened || typeof opened.body !== 'string') throw new Error('Expected text link content');
        expect(opened.header).toMatchObject({ kind: 'deployment-target-link.v1', title: managed ? 'Customer database' : '' });
        expect(JSON.parse(opened.body)).toEqual(managed ? provider : {});
        if (mode === 'e2ee') expect(JSON.stringify(documents.get(id))).not.toContain('providerResourceId');
    });

    it.each(['build', 'member', 'missing envelope', 'quota transition', 'pending transition', 'storage transition', 'thrown storage transition', 'private transition', 'thrown private transition'] as const)('dispatches the admitted %s without reopening the sender receipt', async scenario => {
        const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => {});
        const kind = scenario === 'build' ? 'build' : 'member';
        const credentials: StoredCredentials = { token: `h.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.s`, encryption: null };
        const environment = createDeploymentEnvironmentDetailV1();
        environment.environment.owner = { kind: 'account', accountId: 'owner' };
        environment.environment.buildMachineId = 'future-builder';
        const link = environment.targetLinks[0].targetLink;
        delete link.activeDeploymentId;
        const receipt = createDeploymentReceiptDetailV1();
        receipt.deployment = { ...receipt.deployment, state: 'queued', startedAtMs: undefined, settledAtMs: undefined,
            acceptedExecution: { v: 1, controller: { machineId: 'machine-a', installationId: 'installation-a' },
                builder: { machineId: 'captured-builder', installationId: 'captured-installation' } } };
        receipt.content = { ...receipt.content, buildMachineId: 'captured-builder', machineResults: [],
            ownServer: { approvedInputBasis: OwnServerDeploymentInputBasisV1Schema.parse({ v: 1,
                environmentId: environment.environment.id, environmentRevision: environment.environment.revision,
                targetLinkId: link.id, targetLinkRevision: link.revision, sourceIntent: receipt.content.sourceIntent,
                manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'dispatch', toolVersion: '2.40.1',
                services: ['app'], profiles: [], bindings: [], images: receipt.content.images,
                ownServer: environment.content.ownServer, members: link.members.map(({ machineId, installationId }) => ({ machineId, installationId })),
                ...(kind === 'build' ? { buildServices: ['app'] } : {}) }) } };
        const documents = new Map<string, Record<string, unknown>>();
        const put = (id: string, artifactKind: string, content: unknown) => documents.set(id, { id, ownerAccountId: 'owner', access: 'owner',
            publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: artifactKind, title: 'Dispatch' }), body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        put(environment.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, environment.content);
        put(link.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, {});
        put(receipt.deployment.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, receipt.content);
        let receiptReadsAfterTransition = 0;
        const dispatchTrace: string[] = [];
        const childLookups: Array<{ machineId: string; receiptReads: number }> = [];
        const result = () => DeploymentReceiptResultV1Schema.parse({ ok: true, environmentId: environment.environment.id,
            deploymentId: receipt.deployment.id, revision: environment.environment.revision,
            deploymentRevision: receipt.deployment.revision, state: receipt.deployment.state });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(request.url!).pathname;
            if (request.method === 'POST' && path.endsWith('/deploy')) return { status: 200, data: result() };
            if (request.method === 'GET' && path.endsWith(`/receipts/${receipt.deployment.id}`)) {
                dispatchTrace.push(`receipt:${receipt.deployment.revision}:${receipt.deployment.state}`);
                receiptReadsAfterTransition++;
                return { status: 200, data: DeploymentReceiptGetResultV1Schema.parse({ ok: true, deployment: receipt.deployment }) };
            }
            if (request.method === 'GET' && path.endsWith('/deployments')) return { status: 200,
                data: DeploymentReceiptListResultV1Schema.parse({ ok: true, items: [], nextCursor: null }) };
            if (request.method === 'POST' && path.endsWith('/transitions')) {
                const wire = z.record(z.string(), z.unknown()).parse(request.data);
                dispatchTrace.push(`transition:${wire.state}`);
                if (scenario === 'quota transition') return { status: 413, data: DeploymentReceiptResultV1Schema.parse({
                    ok: false, error: 'quota_exceeded', budget: 'document', limitBytes: 1, usedBytes: 2,
                }) };
                if (scenario === 'pending transition') return { status: 200, data: DeploymentReceiptResultV1Schema.parse({
                    ok: true, kind: 'pending', environmentId: environment.environment.id, revision: environment.environment.revision,
                    actionOperationId: receipt.deployment.actionOperationId,
                }) };
                if (scenario.endsWith('storage transition') || scenario.endsWith('private transition')) {
                    const response = { status: 503, data: {
                        error: scenario.endsWith('storage transition') ? 'database_transaction_conflict_exhausted' : 'PRIVATE_ERROR',
                        statusCode: 503, message: 'PRIVATE_MESSAGE', token: 'PRIVATE_TOKEN',
                    } };
                    if (scenario.startsWith('thrown ')) throw Object.assign(new Error('PRIVATE_EXCEPTION'), {
                        code: 'ERR_BAD_RESPONSE', response,
                    });
                    return response;
                }
                const mutation = readCarrierMutation(wire.contentUpdate);
                const body = z.string().parse(mutation.body);
                const row = documents.get(receipt.deployment.contentArtifactId)!;
                receipt.deployment = { ...receipt.deployment, state: z.enum(['running', 'failed']).parse(wire.state),
                    revision: receipt.deployment.revision + 1, contentHeaderVersion: receipt.deployment.contentHeaderVersion + 1,
                    contentBodyVersion: receipt.deployment.contentBodyVersion + 1 };
                documents.set(receipt.deployment.contentArtifactId, { ...row, ...mutation,
                    headerVersion: receipt.deployment.contentHeaderVersion, bodyVersion: receipt.deployment.contentBodyVersion });
                receipt.content = DeploymentOwnServerContentV1Schema.parse(JSON.parse(z.object({ body: z.string() }).parse(decodePlainArtifactStoredContent(body)).body));
                receiptReadsAfterTransition = 0;
                return { status: 200, data: result() };
            }
            return { status: 200, data: DeploymentEnvironmentGetResultV1Schema.parse({ ok: true,
                environment: environment.environment, secretScope: environment.secretScope, targetLinks: [link] }) };
        });
        vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
            const path = new URL(url).pathname;
            if (path.startsWith('/v1/machines/')) {
                const machineId = path.split('/').at(-1)!;
                // Settlement notices also read display labels with the host bearer.
                // Only the signed child transport owns the dispatch cost contract.
                if (config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]) {
                    dispatchTrace.push(`machine:${machineId}`);
                    childLookups.push({ machineId, receiptReads: receiptReadsAfterTransition });
                }
                // The actual transport owner refuses this server row before native acquisition.
                return { status: 200, data: { machine: { id: machineId, revokedAt: 1 } } };
            }
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
            if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
            return { status: 200, data: documents.get(path.split('/').at(-1)!) };
        });
        vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'home' } } }));
        const keys = tweetnacl.sign.keyPair();
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'installation-a', createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'),
            privateKey: Buffer.from(keys.secretKey).toString('base64url') });
        const deps = createDaemonDeploymentActionDeps({
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            credentials, serverId: 'home', serverHttpBaseUrl: 'https://dispatch.test', machineId: 'machine-a',
            runtime: createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://dispatch.test', machineId: 'machine-a',
                resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
                acquirePluginRuntimeRegistryLease: async () => { throw new Error('Transport refusal must not acquire native work'); } }) });
        const input = DeploymentDeployInputV1Schema.parse({ serverId: 'home', environmentId: environment.environment.id, targetLinkId: link.id,
            expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision,
            requestKey: receipt.deployment.requestKey, contentArtifactId: receipt.deployment.contentArtifactId,
            contentHeaderVersion: 1, contentBodyVersion: 1 });
        const target = { kind: 'machine' as const, machineId: 'machine-a' };
        const envelope = { v: 1 as const, requestId: 'dispatch-request', target, input };
        const requestEnvelopeDigest = computeExternalActionRequestEnvelopeDigestV1(envelope);
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'dispatch-root', binding: {
            serverIdentityId: 'home', accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
            admittedMachineRole: 'manage',
            custodianAccountId: 'owner', machineId: 'machine-a', installationId: 'installation-a', actionId: 'deployments.deploy',
            environmentId: environment.environment.id, deploymentChildRoot: true, requestId: envelope.requestId, accountEncryptionMode: 'plain', target, requestEnvelopeDigest,
            deploymentCandidatePublication: createDeploymentCandidatePublicationV1({ accountId: 'owner', serverIdentityId: 'home',
                actionId: 'deployments.deploy', requestId: envelope.requestId, requestEnvelopeDigest,
                environmentId: environment.environment.id, source: { id: environment.environment.projectSourceId, revision: 1 } }) } });
        const requester = await prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
            machineId: 'machine-a', installationId: 'installation-a', installationPrivateKey: keys.secretKey,
            serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://dispatch.test', ownCredentials: credentials,
            isCurrent: async () => true, createExecutor: () => createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps }) });
        if (!requester) throw new Error('Expected admitted requester custody');
        try {
            const child = DeploymentChildRpcV1Schema.parse({ v: 1, kind, actionId: 'deployments.deploy', input,
                deploymentId: receipt.deployment.id, actionOperationId: receipt.deployment.actionOperationId,
                machineId: kind === 'build' ? 'captured-builder' : 'machine-a',
                installationId: kind === 'build' ? 'captured-installation' : 'installation-a',
                ...(kind === 'member' ? { phase: 'activate', selectedDeploymentId: receipt.deployment.id } : {}) });
            expect(await isReviewedDeploymentChild({ authorization: requester.authorization, envelope,
                actionId: 'deployments.deploy', machineId: child.machineId, params: child })).toBe(true);
            const settled = await deps.deploymentAction('deployments.deploy', input, { externalActionExecutionAuthorization: requester.authorization,
                ...(scenario === 'missing envelope' ? {} : { originalActionEnvelope: envelope }), externalActionTarget: target,
                operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } });
            if (scenario === 'missing envelope') {
                expect(settled).toMatchObject({ ok: false, errorCode: 'action_forbidden' });
                expect(childLookups).toEqual([]);
                const refusals = warnings.mock.calls.filter(([message]) => message === '[Deployment] child dispatch refused');
                expect(refusals).toEqual([['[Deployment] child dispatch refused', {
                    rpc: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, branch: 'action_forbidden (child_dispatch_context_missing)',
                    requesterAvailable: true, installationAvailable: true, envelopeAvailable: false,
                }]]);
                for (const secret of [credentials.token, authorization.token, JSON.stringify(input), installationStore.readInstallationIdentityIfExistsSync()!.privateKey]) {
                    expect(JSON.stringify(refusals)).not.toContain(secret);
                }
                return;
            }
            if (scenario !== 'build' && scenario !== 'member') {
                expect(settled).toMatchObject(scenario === 'quota transition' ? {
                    ok: false, errorCode: 'quota_exceeded', details: { budget: 'document', limitBytes: 1, usedBytes: 2 },
                } : { ok: false, errorCode: 'outcome_unknown',
                    error: scenario.endsWith('storage transition') ? expect.stringContaining('database_transaction_conflict_exhausted') : 'outcome_unknown' });
                expect(JSON.stringify(settled)).not.toMatch(/PRIVATE_/);
                expect(childLookups).toEqual([]);
                expect(receipt.deployment.state).toBe('queued');
                expect(receipt.content.machineResults).toEqual([]);
                expect(dispatchTrace.filter(event => event.startsWith('transition:'))).toEqual(['transition:running']);
                return;
            }
            expect(settled, JSON.stringify({ settled, childLookups })).toMatchObject({ ok: false, errorCode: 'machine_target_not_current' });
            expect(childLookups, JSON.stringify(dispatchTrace)).toEqual([{ machineId: kind === 'build' ? 'captured-builder' : 'machine-a', receiptReads: 1 }]);
        } finally { await requester.dispose(); }
    });
    it.each(['controller build failure', 'controller build success', 'controller build log write failure', 'provider teardown Cloudflare absence', 'provider teardown Vercel absence', 'provider teardown changed identity', 'provider teardown preview', 'provider teardown linked default', 'provider teardown created default', 'provider teardown explicit unlink', 'provider teardown', 'provider teardown ambiguous', 'provider teardown ambiguous unverified', 'provider teardown recovery', 'provider teardown queued observation', 'provider teardown review', 'provider teardown denied', 'promote retained platform', 'rollback retained platform', 'provider Domain add', 'provider Domain Vercel active add', 'provider Domain verify', 'provider Domain remove', 'provider Domain retained native teardown', 'variable telemetry remote endpoint', 'variable telemetry managed header cleanup', 'variable synchronization', 'variable metadata', 'variable sync storage conflict', 'leased target preparation', 'explicit failure policy', 'build logs', 'runtime logs', 'teardown without role', 'teardown without role, descriptor unavailable', 'teardown without role, remove Environment', 'teardown with data target', 'compact repository missing SCM provider', 'reviewed child', 'upload source', 'retained receipt observe', 'background receipt observe', 'uncertain receipt observe', 'SDK background receipt observe', 'settlement pointer changed', 'provider failure', 'Home source read refusal', 'source admission failure', 'root source custodian', 'root source approval custodian', 'root source approval missing Home', 'root source foreign', 'root source missing proof', 'requester revoked', 'receipt source differs', 'admission cause retained approval', 'child policy requires approval', 'qualified child policy requires approval'] as const)(
    'admits the declared platform target without native history, a builder or an app-host Machine (%s)', async scenario => {
        const pluginId = 'example.platform';
        const providerTeardown = scenario.startsWith('provider teardown');
        const retainedTraffic = scenario === 'promote retained platform' || scenario === 'rollback retained platform';
        const variableScenario = scenario.startsWith('variable ');
        const telemetryRemoteEndpoint = scenario === 'variable telemetry remote endpoint' || scenario === 'variable telemetry managed header cleanup';
        const telemetryManagedCleanup = scenario === 'variable telemetry managed header cleanup';
        const nativeVariableRequests: { method: string; path: string; body?: unknown }[] = [];
        let nativeVariableSecretReads = 0;
        const runtimeLogs = scenario === 'runtime logs';
        const domainScenario = scenario.startsWith('provider Domain');
        const domainTeardown = scenario === 'provider Domain retained native teardown';
        const domainRemove = scenario === 'provider Domain remove';
        const vercelActiveDomainAdd = scenario === 'provider Domain Vercel active add';
        const domainAdd = scenario === 'provider Domain add' || vercelActiveDomainAdd;
        const domainState = vercelActiveDomainAdd ? 'active' as const : 'warning' as const;
        const nativeDomainRequests: { method: string; path: string }[] = [];
        const domainRole = domainTeardown || domainRemove ? 'domains.remove' as const : domainAdd ? 'domains.add' as const : 'domains.verify' as const;
        const rootSource = scenario.startsWith('root source ');
        const rootSourceForeign = scenario === 'root source foreign';
        const rootApproval = scenario.startsWith('root source approval ');
        const rootApprovalHomeUnavailable = scenario === 'root source approval missing Home';
        const sourceRequesters: { identity: Awaited<ReturnType<typeof resolveOwnerRequesterIdentity>>; hasAccountContext: boolean; sameHomeUrl: boolean }[] = [];
        const rootSourceIntent = createDeploymentReceiptDetailV1().content.sourceIntent;
        if (rootSourceIntent.kind !== 'repository') throw new Error('Repository source fixture required');
        const controllerBuildFailure = scenario === 'controller build failure';
        const controllerLogWriteFailure = scenario === 'controller build log write failure';
        const controllerBuildOutput = controllerBuildFailure || scenario === 'controller build success' || controllerLogWriteFailure;
        const sourceAdmissionFailure = scenario === 'source admission failure';
        const roleFails = controllerBuildFailure || scenario === 'provider failure' || scenario === 'Home source read refusal' || sourceAdmissionFailure;
        const roleErrorCode = controllerBuildFailure ? 'deployment_failed' : sourceAdmissionFailure ? 'agent_isolation_unavailable'
            : scenario === 'Home source read refusal' ? 'plugin_action_execution_failed' : 'provider_request_failed';
        const sourceAdmission = { phase: 'deployment_source_admission', reason: 'requester_authority_unavailable',
            requiredFact: 'verified_root_requester', remedy: 'retry_original_request' } as const;
        const sdkBackgroundObservation = scenario === 'SDK background receipt observe';
        const backgroundObservation = scenario === 'background receipt observe' || scenario === 'uncertain receipt observe' || sdkBackgroundObservation;
        const settlementPointerChanged = scenario === 'settlement pointer changed';
        {
            // Saved-profile persistence is the OS boundary, as in the native materialization fixture below.
            const settings = await persistence.readSettings();
            vi.spyOn(persistence, 'readSettings').mockResolvedValue({ ...settings, servers: { home: {
                id: 'home', name: 'Home', serverUrl: 'https://platform.test', webappUrl: 'https://platform.test',
                createdAt: 1, updatedAt: 1, homeConnectionDescriptorAuthority: 'exact',
                homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_platform_home',
                    canonicalServerUrl: 'https://platform.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://platform.test' }] }),
            } } });
        }
        const preparedNative = { projectName: 'captured-project', gitSource: { type: 'github' as const, repoId: '123' },
            triggerUuid: 'captured-trigger-uuid', previewId: 'captured-preview-id', gitBranch: 'feature/x',
            workerTag: 'captured-worker-tag', scriptName: 'captured-script-name',
            ...(scenario === 'reviewed child' ? { reviewNotice: 'Provider review notice.' } : {}) };
        const repositoryAccess = { status: 'ready' as const,
            repository: { kind: 'github' as const, deployment: 'https://github.com', repository: 'owner/project' } };
        // Retained older links/receipts did not carry a native preparation.
        const capturedPreparation = scenario === 'retained receipt observe' ? {} : { preparedNative, repositoryAccess };
        const roles = ['inspect', 'link', 'deploy', 'observe', 'uploadDeploy', ...(retainedTraffic ? ['promote' as const, 'rollback' as const] : []), ...(scenario === 'build logs' ? ['logs.build' as const] : []), ...(runtimeLogs ? ['logs.runtime' as const] : []), ...(variableScenario ? ['variables.read' as const, 'variables.sync' as const] : []), ...(domainScenario ? [domainRole, ...(domainTeardown ? ['teardown' as const] : [])] : []), ...(providerTeardown ? ['teardown' as const] : [])] as const;
        const credentials: StoredCredentials = { token: `h.${Buffer.from(JSON.stringify({ sub: 'owner', ...(sdkBackgroundObservation ? {
            tokenEpoch: 1, provenance: { v: 1, kind: 'account', authority: 'present_user' } } : {}) })).toString('base64url')}.s`, encryption: null };
        let sdkHomeUrl = 'https://platform.test';
        let releaseSdkHome = () => {};
        if (sdkBackgroundObservation) {
            const ready = new Promise<void>(resolve => { releaseSdkHome = resolve; });
            // Authored runtime imports have their own HTTP client instance.
            // Use the genuine socket boundary and share the Home fixture below.
            const home = createServer(async (request, response) => {
                try {
                    await ready;
                    const chunks: Buffer[] = [];
                    for await (const chunk of request) chunks.push(Buffer.from(chunk));
                    const raw = Buffer.concat(chunks).toString('utf8');
                    const url = `https://platform.test${request.url}`;
                    const config = { headers: request.headers };
                    const result = request.method === 'GET' ? await axios.get(url, config)
                        : await axios.post(url, raw ? JSON.parse(raw) : undefined, config);
                    response.writeHead(result.status, { 'Content-Type': 'application/json' });
                    response.end(JSON.stringify(result.data));
                } catch (error) { response.writeHead(500); response.end(JSON.stringify({ error: String(error) })); }
            });
            await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
            const address = home.address();
            if (!address || typeof address === 'string') throw new Error('Missing fixture Home address');
            sdkHomeUrl = `http://127.0.0.1:${address.port}`;
            onTestFinished(() => new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve())));
        }
        let purposeBindings: QualifiedConnectedAccountPurposeBindingsV1 = { v: 1, bindings: [] };
        // Persistence and current Account projection are boundaries; purpose admission stays real.
        const connectedAccounts = createConnectedAccountPurposeBindingOwner({
            store: { read: async () => purposeBindings, update: async mutate => (purposeBindings = mutate(purposeBindings)),
                subscribe: () => ({ dispose() {} }) },
            selectTarget: async () => { throw new Error('Invocation must not open Account selection'); },
            resolveTarget: async target => target.kind === 'account' && target.account.service.pluginId === pluginId
                && target.account.service.localId === 'service' && target.account.accountId === 'credential'
                ? { displayName: 'Platform fixture', account: target.account } : null,
            materializeAccount: async () => { throw new Error('Fixture role must not materialize provider credentials'); },
            materializeNative: async () => { throw new Error('Fixture role must not materialize native credentials'); },
            projectTargetAccounts: async () => { throw new Error('Invocation must not enumerate Accounts'); },
            assertTargetAccountMaterializable: async () => { throw new Error('Invocation must not enumerate Accounts'); },
        });
        const nativeDomainKit = vercelActiveDomainAdd ? await createPluginTestkit({
            manifest: vercelDomainPlugin.manifest, module: vercelDomainPlugin,
            services: { http: createPluginHttpFixture({ async request(request) {
                const path = new URL(request.url).pathname;
                nativeDomainRequests.push({ method: request.method, path });
                const body = path.endsWith('/config') ? { misconfigured: false }
                    : { name: 'app.example.test', apexName: 'example.test', projectId: 'project',
                        gitBranch: null, customEnvironmentId: null, verified: true };
                return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
            } }) },
        }) : null;
        if (nativeDomainKit) onTestFinished(() => nativeDomainKit.dispose());
        const unsupportedSecretMutation = async (): Promise<never> => { throw new Error('Unexpected Secret mutation'); };
        const nativeVariablesKit = telemetryRemoteEndpoint ? await createPluginTestkit({
            manifest: vercelDomainPlugin.manifest, module: vercelDomainPlugin,
            services: { secrets: { readSavedSecret: async () => { nativeVariableSecretReads++; return 'fixture-telemetry-token'; },
                saveShared: unsupportedSecretMutation, status: unsupportedSecretMutation, get: unsupportedSecretMutation,
                set: unsupportedSecretMutation, delete: unsupportedSecretMutation },
            http: createPluginHttpFixture({ async request(request) {
                const body = request.body ? JSON.parse(new TextDecoder().decode(request.body)) : undefined;
                nativeVariableRequests.push({ method: request.method, path: new URL(request.url).pathname, body });
                const response = request.method === 'DELETE' ? {} : request.method === 'GET' ? { envs: [
                    { id: 'remote-endpoint', key: 'OTEL_EXPORTER_OTLP_ENDPOINT', type: 'plain', target: ['production'],
                        value: 'https://own.example.test', updatedAt: 1 },
                    { id: 'remote-header', key: 'OTEL_EXPORTER_OTLP_HEADERS', type: 'sensitive', target: ['production'],
                        value: 'Authorization=own', updatedAt: 1 },
                ] } : { created: { ...body, id: body.key === 'MODE' ? 'provider-mode' : 'provider-headers', updatedAt: 10 } };
                return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(response)) };
            } }) },
        }) : null;
        if (nativeVariablesKit) onTestFinished(() => nativeVariablesKit.dispose());
        const runtime = await runWithServerHttpBaseUrl(sdkHomeUrl, () => createAuthoredAdmittedPluginRuntimeFixture({
            // Observe only the physically admitted fixture plugin, independent of bundled dependencies.
            ...(scenario === 'background receipt observe' || providerTeardown ? { resolveContributes: async (happyHomeDir: string) => createResolvedContributionRegistry(
                projectLoadedPluginContributes({ loadResult: await loadInstalledPlugins({ happyHomeDir }),
                    provenance: 'external' })) } : {}),
            // SCM materialization consumes the real daemon-applied registry owner.
            ...(scenario === 'upload source' ? { controller: pluginReloadController } : {}),
            runtimeOptions: { resolveCurrentMachineId: () => 'machine-a', connectedAccounts,
                ...(scenario === 'build logs' || runtimeLogs || variableScenario || domainScenario || providerTeardown ? { deploymentAccountExecution: { credentials, serverUrl: sdkHomeUrl,
                    serverId: 'home', serverIdentityId: 'home', machineId: 'machine-a', isCurrent: async () => true } } : {}),
                ...(rootApproval ? { readDaemonRequesterWorkAttribution: () => projectDaemonRequesterWorkAttribution({
                    serverId: 'profile-home', custodianAccountId: 'owner', machineId: 'machine-a', installationId: 'installation-a' }, rootApprovalHomeUnavailable ? null : 'home') } : {}),
                ...(sdkBackgroundObservation ? { scopedActionRuntime: { credentials,
                    actionsSettingsProvider: createActionSettingsProvider({ allowEnvironmentOverride: false }) },
                    externalActionHomeBinding: { serverId: 'home', serverIdentityId: 'home' },
                    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'home', machineId: 'machine-a' }) } : {}),
                actionFormConnectedAccounts: connectedAccounts }, plugins: [{
            ...(vercelActiveDomainAdd || telemetryRemoteEndpoint ? { instantiateCommittedModule: module => ({ ...module, async activate(api: PluginApi) {
                if (typeof module.activate !== 'function') throw new Error('Expected fixture daemon activation');
                await module.activate(api);
                const kit = nativeDomainKit ?? nativeVariablesKit;
                if (!kit) throw new Error('Expected the Vercel Account runtime');
                // Portable Account activation supplies its own context; the daemon child forwards only operands/cancellation.
                const actionId = telemetryRemoteEndpoint ? 'variables-sync' : 'domains-add';
                api.actions.register(actionId, (input, context) => kit.invokeAction(actionId, input, { signal: context.signal }));
            } }) } : {}),
            manifest: { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Platform',
                entrypoints: { daemon: './daemon.mjs' }, hostAccess: { required: [{ id: 'manage', capability: 'connectedAccounts',
                    reason: 'Use the linked deployment account.', scope: { serviceRefs: ['service'],
                        operations: ['use'], materializationKinds: ['httpHeaders'] } }], optional: [] },
                contributes: { ...(controllerBuildOutput ? { systemTools: [{ id: 'build-fixture', title: 'Build fixture', executableNames: ['git'] }] } : {}), ...(sdkBackgroundObservation ? { backgroundServices: [{ id: 'observer', title: 'Platform observer' }] } : {}),
                    connectedAccountDescriptors: [{ id: 'service', title: 'Platform account', authentication: {
                    defaultModeId: 'manual', modes: [{ id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
                        fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }] }] } }],
                    actions: [...roles.map(id => ({ id: id === 'uploadDeploy' ? 'upload-deploy' : id === 'logs.build' ? 'build-logs-read' : id === 'logs.runtime' ? 'runtime-logs-read' : id === 'variables.read' ? 'variables-read' : id === 'variables.sync' ? 'variables-sync' : id === 'domains.verify' ? 'domains-verify' : id === 'domains.remove' ? 'domains-remove' : id === 'domains.add' ? 'domains-add' : id, title: id, scopes: ['global'], surfaces: ['plugin'],
                    placementBindings: [],
                    execution: { target: 'daemon' },
                    hostAccess: ['manage'],
                    connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'manage' }],
                    dangerLevel: id === 'inspect' || id === 'observe' || id === 'logs.build' || id === 'logs.runtime' || id === 'variables.read' || id === 'domains.verify' ? 'safe' : 'writesLocal',
                    ...(id === 'logs.runtime' ? { readOnly: true } : {}),
                    inputSchema: DeploymentTargetRoleInputProtocolSchemasV1[id].jsonSchema,
                    resultSchema: id === 'domains.verify' || id === 'domains.remove' || id === 'domains.add' ? DeploymentTargetDomainResultV1ProtocolSchema.jsonSchema : id === 'variables.read' ? DeploymentTargetVariablesReadResultV1ProtocolSchema.jsonSchema
                        : id === 'variables.sync' ? DeploymentTargetVariablesSyncResultV1ProtocolSchema.jsonSchema
                        : id === 'logs.build' || id === 'logs.runtime' ? DeploymentTargetLogsResultV1ProtocolSchema.jsonSchema : DeploymentTargetRoleResultV1ProtocolSchema.jsonSchema,
                })), ...(scenario === 'upload source' ? [{ id: 'source-check', title: 'Check retired source', scopes: ['global'],
                    surfaces: ['cli'], placementBindings: [], execution: { target: 'daemon' }, dangerLevel: 'safe',
                    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                    resultSchema: { type: 'object', properties: { checked: { type: 'boolean' } }, required: ['checked'], additionalProperties: false } }] : [])], deploymentTargets: [{ id: 'runtime', title: 'Platform', icon: 'server-outline', targetKind: 'platform',
                    targetSchema: { type: 'object', properties: {}, additionalProperties: false },
                    linkSchema: { type: 'object', properties: {}, additionalProperties: false },
                    ...(scenario === 'teardown with data target' ? { role: 'data' } : { role: 'runtime',
                        actions: { inspect: 'inspect', link: 'link', deploy: 'deploy', observe: 'observe', uploadDeploy: 'upload-deploy',
                            ...(retainedTraffic ? { promote: 'promote', rollback: 'rollback' } : {}),
                            ...(scenario === 'build logs' ? { logs: { build: 'build-logs-read' } } : runtimeLogs ? { logs: { runtime: 'runtime-logs-read' } } : {}),
                            ...(variableScenario ? { variables: { read: 'variables-read', sync: 'variables-sync' } } : {}),
                            ...(domainScenario ? { domains: domainRole === 'domains.remove' ? { remove: 'domains-remove' } : domainRole === 'domains.add' ? { add: 'domains-add' } : { verify: 'domains-verify' } } : {}),
                            ...(domainTeardown || providerTeardown ? { teardown: 'teardown' } : {}) } }) }] } },
            files: { 'daemon.mjs': `import { PluginError } from '@happier-dev/plugin-sdk/errors';
                import { readFile } from 'node:fs/promises';
                import { join } from 'node:path';
                let retainedSource;
                let observationCount = 0;
                let runtimeWatchCount = 0;
                let runtimeWatchDisposals = 0;
                let backgroundProbe;
                let finishBackground;
                const backgroundCompletion = new Promise(resolve => { finishBackground = resolve; });
                export function readBackgroundProbe() { return backgroundProbe; }
                export function waitForBackgroundCompletion() { return backgroundCompletion; }
                export function readObservationCount() { return observationCount; }
                export function readRuntimeWatchCounts() { return { opened: runtimeWatchCount, disposed: runtimeWatchDisposals }; }
                export function activate(api) {
                ${sdkBackgroundObservation ? `api.backgroundServices.register('observer', async context => {
                    try {
                        const results = [];
                        for (let i = 0; i < 3; i++) results.push(await context.services.actions.execute('deployments.receipts.observe', {
                            serverId: 'home', environmentId: 'environment-staging', deploymentId: 'platform-receipt' }, { signal: context.signal }));
                        backgroundProbe = { results };
                    }
                    catch (error) { backgroundProbe = { errorCode: error.code, error: error.message }; }
                    finally { finishBackground(); }
                });` : ''}
                ${roles.filter(role => (!vercelActiveDomainAdd || role !== 'domains.add') && (!telemetryRemoteEndpoint || role !== 'variables.sync')).map(role => `api.actions.register('${role === 'uploadDeploy' ? 'upload-deploy' : role === 'logs.build' ? 'build-logs-read' : role === 'logs.runtime' ? 'runtime-logs-read' : role === 'variables.read' ? 'variables-read' : role === 'variables.sync' ? 'variables-sync' : role === 'domains.verify' ? 'domains-verify' : role === 'domains.remove' ? 'domains-remove' : role === 'domains.add' ? 'domains-add' : role}', async (input, context) => {
                    ${providerTeardown && (role === 'teardown' || role === 'observe') ? `if (input.providerIdentity.providerResourceId !== 'project' || input.providerIdentity.providerAccountId !== 'provider-account' || input.providerIdentity.providerEnvironment !== 'production' || input.operation !== 'teardown') throw new Error('Wrong exact resource');
                    observationCount++; return { v: 1, ${scenario === 'provider teardown Vercel absence' ? "providerDeploymentId: 'dpl_retained'," : ''} state: '${scenario === 'provider teardown ambiguous unverified' ? 'running_unverified' : 'succeeded'}', observedAtMs: 1, ${scenario.startsWith('provider teardown ambiguous') ? '' : 'providerResourceAbsent: true'} };` : ''}
                    ${role === 'domains.remove' ? `return { v: 1, hostname: input.domain.hostname, state: 'removed', dns: [] };` : ''}
                    ${role === 'domains.verify' || role === 'domains.add' ? `return { v: 1, hostname: input.domain.hostname, state: 'pending', dns: [{ type: 'TXT', name: '_verification.example.test', value: 'private-dns-token' }] };` : ''}
                    ${role === 'variables.read' ? `observationCount++; return { v: 1, variables: [{ key: 'MODE', providerId: 'provider-mode', present: true, secret: false, owned: true, drift: 'current', providerRevision: '10' }] };` : ''}
                    ${role === 'variables.sync' ? `if (input.set[0]?.name !== 'MODE' || input.set[0]?.source.value !== 'release' || input.owned.length !== 0) throw new Error('Wrong reviewed variables');
                    return { v: 1, owned: [{ key: 'MODE', providerId: 'provider-mode', desiredRevision: input.desiredRevision, providerRevision: '10' }],
                        variables: [{ key: 'MODE', providerId: 'provider-mode', present: true, secret: false, owned: true, drift: 'current', providerRevision: '10' }], failures: [] };` : ''}
                    ${role === 'logs.build' ? `if (input.providerDeploymentId !== 'existing-provider-deployment') throw new Error('Wrong retained deployment');
                    return { kind: 'page', page: { sourceRevision: input.providerDeploymentId, text: 'Build complete\\n', nextCursor: null, truncated: false } };` : ''}
                    ${role === 'logs.runtime' ? `if (input.providerDeploymentId !== 'existing-provider-deployment' || input.service) throw new Error('Wrong retained platform receipt');
                    observationCount++;
                    return { kind: 'page', page: { sourceRevision: input.providerDeploymentId,
                        text: 'Runtime ready\\n', truncated: true, nextCursor: null } };` : ''}
                    ${backgroundObservation && role === 'observe' ? `if (++observationCount === 1) return {
                        v: 1, state: 'queued', providerDeploymentId: 'existing-provider-deployment', observedAtMs: 2 };` : ''}
                    ${rootApproval && role === 'uploadDeploy' ? `
                    await context.services.deploymentSource.materialize({ environmentId: input.environmentId, deploymentId: input.deploymentId });
                    ` : ''}
                    ${scenario === 'upload source' && role === 'uploadDeploy' ? `
                    const request = { environmentId: input.environmentId, deploymentId: input.deploymentId };
                    const refused = async (effect, code) => { try { await effect(); } catch (error) {
                        if (error.code === code) return; throw error;
                    } throw new Error('Expected source refusal: ' + code); };
                    await refused(() => context.services.deploymentSource.materialize({ ...request, deploymentId: 'another-receipt' }), 'target_mismatch');
                    retainedSource = await context.services.deploymentSource.materialize(request);
                    if (await readFile(join(retainedSource.rootPath, 'compose.yaml'), 'utf8') !== 'services: {}'
                        || retainedSource.environmentId !== input.environmentId || retainedSource.deploymentId !== input.deploymentId
                        || retainedSource.machineId !== 'machine-a' || retainedSource.installationId !== 'installation-a'
                        || !retainedSource.manifestFingerprint) throw new Error('Wrong exact source');
                    await retainedSource.assertCurrent();
                    await retainedSource.commit();
                    ` : ''}
                    ${controllerBuildOutput && role === 'uploadDeploy' ? `
                    const tool = await context.services.exec.systemTools.resolve({ toolId: 'build-fixture', purpose: 'Reproduce controller build output' });
                    const child = await context.services.exec.spawn({ executable: tool.executable, cwd: ${JSON.stringify(configuration.happyHomeDir)},
                        args: ['-c', 'alias.controller-build=!echo controller build stdout; echo controller build stderr >&2; exit ${controllerBuildFailure ? 1 : 0}', 'controller-build'] },
                        { outputDelivery: 'invocation', signal: context.signal });
                    try { const result = await child.wait();
                        if (result.termination.observed.kind !== 'exit' || result.termination.observed.exitCode !== ${controllerBuildFailure ? 1 : 0})
                            throw new Error('Unexpected build fixture termination');
                    } finally { await child.dispose(); }
                    ${controllerBuildFailure ? `throw new PluginError({ code: 'deployment_failed', details: { phase: 'build' } });` : ''}
                    ` : ''}
                    ${roleFails ? `throw new PluginError({ code: '${roleErrorCode}', details: ${JSON.stringify(sourceAdmissionFailure ? sourceAdmission : { phase: 'send' })} });` : `return {v:1,state:'succeeded',providerDeploymentId:'${role === 'observe' ? 'existing-provider-deployment' : 'provider-deployment'}',observedAtMs:1,steps:[{id:'build',label:'Provider build',state:'succeeded',streamRef:'masked-provider-stream'}],urls:['https://app.example.test']};`}
                }${role === 'logs.runtime' ? `, { observeRead(input, observation, context) {
                    runtimeWatchCount++;
                    let stopped = false;
                    const delivery = Promise.resolve().then(async () => {
                        for (const text of ['Follow first\\n', 'Follow second\\n']) {
                            if (stopped || context.signal.aborted) return;
                            await observation.emit({ kind: 'page', page: { sourceRevision: input.providerDeploymentId,
                                text, nextCursor: null, truncated: true } });
                        }
                    }).catch(error => { if (!stopped) observation.retire(error); });
                    return { async dispose() { if (stopped) return; stopped = true; runtimeWatchDisposals++; await delivery; } };
                } }` : ''});`).join(' ')}
                ${scenario === 'upload source' ? `api.actions.register('source-check', async (_input, context) => {
                    let refused = false;
                    try { await context.services.deploymentSource.materialize({ environmentId: retainedSource.environmentId,
                        deploymentId: retainedSource.deploymentId }); } catch (error) {
                        if (error.code !== 'plugin_service_unavailable') throw error; refused = true;
                    }
                    if (!refused) throw new Error('Source acquisition escaped invocation');
                    if (await readFile(join(retainedSource.rootPath, 'compose.yaml'), 'utf8') !== 'services: {}')
                        throw new Error('Committed native custody was removed');
                    return { checked: true };
                });` : ''}
                api.connectedAccounts.register('service', {
                    authentication: { modes: { manual: { kind: 'manual', async complete() {
                        return { status: 'connected', displayName: 'Platform fixture', scopes: [] };
                    } } } },
                    async status() { return { status: 'connected', displayName: 'Platform fixture', scopes: [] }; },
                    async refresh() { return { status: 'connected', displayName: 'Platform fixture', scopes: [] }; },
                    async revoke() { return { status: 'remoteUnsupported' }; },
                    async materialize() { throw new Error('Fixture role must not materialize provider credentials'); },
                });
            }` },
        }] }));
        let requesterPreparation: Awaited<ReturnType<typeof prepareRequesterAccountActionContext>> = null;
        try {
            expect(runtime.registry.pluginDiagnosticsByPluginId[pluginId] ?? []).toEqual([]);
            const environment = createDeploymentEnvironmentDetailV1();
            environment.environment.owner = { kind: 'account', accountId: 'owner' };
            delete environment.environment.buildMachineId;
            const row = environment.targetLinks[0];
            row.targetLink.source = { kind: 'plugin', contribution: { pluginId, localId: 'runtime' } };
            if (scenario === 'teardown with data target') row.targetLink.role = 'data';
            row.targetLink.targetKind = 'platform'; row.targetLink.machines = []; row.targetLink.members = [];
            row.targetLink.createdByAccountId = 'owner';
            // Unlike upload, a daemon-hosted observer uses the target's admitted installation.
            if (scenario === 'compact repository missing SCM provider' || scenario === 'retained receipt observe' || backgroundObservation || retainedTraffic || providerTeardown) Object.assign(row.targetLink,
                { machineId: 'machine-a', installationId: 'installation-a' });
            row.content = { credentialPrincipal: { kind: 'account', accountId: 'owner',
                purpose: { consumer: { pluginId, localId: 'link' }, purpose: 'manage' },
                target: { kind: 'account', account: { service: { pluginId, localId: 'service' }, accountId: 'credential' } } },
                providerIdentity: { providerAccountId: 'provider-account', providerResourceId: 'project', providerEnvironment: 'production' },
                providerEnvironment: { kind: 'production' }, ...capturedPreparation };
            environment.content.definition = await normalizeStoredComposeDefinitionInput({ from: 'compose',
                document: 'services: {}', profiles: [], services: [] });
            const sourceIntent = environment.content.definition;
            if (providerTeardown || scenario === 'compact repository missing SCM provider') environment.content.definition = { kind: 'repository', ref: 'main' };
            if (variableScenario) environment.content.bindings.push({ purpose: 'registry', targetLinkId: row.targetLink.id,
                access: 'pull', registryOrigin: 'https://registry.example.test',
                source: { kind: 'secret', ref: 'happier:shared-secret:v1:registry', resourceRevision: 1 } });
            if (telemetryRemoteEndpoint) {
                environment.content.bindings.push({ ...createDeploymentVariableBindingV1({ phase: 'runtime',
                    name: 'OTEL_EXPORTER_OTLP_HEADERS', source: { kind: 'value', value: 'Authorization=own' } }),
                    ...(telemetryManagedCleanup ? { managedBy: 'telemetry' as const, valueFormat: 'otelAuthorizationHeader' as const } : {}) });
                row.content = { ...row.content, ownedVariables: [{ key: 'OTEL_EXPORTER_OTLP_HEADERS', providerId: 'remote-header',
                    desiredRevision: 1, providerRevision: '1' }] };
            }
            const documents = new Map<string, Record<string, unknown>>();
            let settling = false;
            const settlementReads = { metadata: 0, environmentBodies: 0, targetBodies: 0 };
            const put = (id: string, kind: string, content: unknown) => documents.set(id, {
                id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent({ kind, title: 'Platform' }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }), headerVersion: 1, bodyVersion: 1,
                seq: 1, createdAt: 1, updatedAt: 1 });
            put(environment.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, environment.content);
            put(row.targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, row.content);
            let nativeReads = 0;
            let candidatesCreated = 0;
            vi.spyOn(axios, 'request').mockImplementation(async request => {
                if ((scenario === 'compact repository missing SCM provider' || rootSource) && new URL(request.url!).pathname === `/v1/projects/sources/${environment.environment.projectSourceId}`) return { status: 200,
                    data: { ok: true, canManage: true, source: { id: environment.environment.projectSourceId, revision: 1,
                        name: 'Repository without attachment', audience: [], createdByAccountId: 'owner', attachments: [],
                        repository: { protocol: 'https', provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                            repository: { nameWithOwner: 'example/app', cloneUrl: 'https://github.com/example/app.git' } } } } };
                if (new URL(request.url!).pathname.endsWith('/deployments')) {
                    if (request.method === 'GET' && new URL(request.url!).searchParams.get('inProgressOnly') === 'true') return {
                        status: 200, data: DeploymentReceiptListResultV1Schema.parse({ ok: true, items: [], nextCursor: null }),
                    };
                    nativeReads++; throw new Error('Platform has no native history');
                }
                if (settling) settlementReads.metadata++;
                return { status: 200, data: DeploymentEnvironmentGetResultV1Schema.parse({ ok: true,
                    environment: environment.environment, secretScope: environment.secretScope, targetLinks: environment.targetLinks.map(item => item.targetLink) }) };
            });
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                if (new URL(url).pathname === '/v4/connect/qualified/accounts') return { status: 200,
                    data: { service: { pluginId, localId: 'service' }, accounts: [{
                        ref: { service: { pluginId, localId: 'service' }, accountId: 'credential' },
                        status: 'connected', authenticationModeId: 'manual', configurationReady: true, configurationRevision: null,
                        revisionSemantics: 'revisioned', credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', scopes: [],
                    }] } };
                if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
                if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'owner' } };
                if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain',
                    v: rootApproval ? { actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1 }) } : {} }, version: 1 } };
                if (rootApproval && new URL(url).pathname === '/v1/machines/machine-a') return { status: 200, data: { machine: {
                    id: 'machine-a', active: true, kind: 'persistent', revokedAt: null, replacedByMachineId: null,
                    installationId: 'installation-a', installationPublicKey: Buffer.from(identity.publicKey).toString('base64'),
                    access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } } } };
                const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
                if (settling && id === environment.environment.contentArtifactId) settlementReads.environmentBodies++;
                if (settling && id === row.targetLink.contentArtifactId) settlementReads.targetBodies++;
                return { status: documents.has(id) ? 200 : 404, data: documents.get(id) ?? {} };
            });
            vi.spyOn(axios, 'post').mockImplementation(async (url, value) => {
                if (url.endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
                if (new URL(url).pathname.startsWith('/v1/account/project-rows/')) return projectAccountRowsReadHttpResponse(rootSource
                    ? [createPlainProjectAccountRefRow({ id: 'root-source-workspace', serverId: 'home', machineId: 'machine-a',
                        rootPath: '/root-source-checkout', createdAtMs: 1,
                        source: { sourceId: rootSourceIntent.projectSourceId, revision: rootSourceIntent.sourceRevision } })] : [], url, value);
                candidatesCreated++;
                const mutation = readCarrierMutation(value); const id = typeof mutation.id === 'string' ? mutation.id : new URL(url).pathname.split('/').at(-1)!;
                const version = Number(documents.get(id)?.bodyVersion ?? 0) + 1;
                documents.set(id, { ...documents.get(id), ...mutation, id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                    encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
                if (rootApproval) Object.assign(documents.get(id)!, { dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    headerVersion: version, bodyVersion: version });
                return { status: 200, data: { id, success: true, headerVersion: rootApproval ? version : 1, bodyVersion: rootApproval ? version : 1 } };
            });
            const identity = tweetnacl.sign.keyPair();
            vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(MachineInstallationIdentityV1Schema.parse({ version: 1,
                installationId: 'installation-a', createdAt: 1, publicKey: Buffer.from(identity.publicKey).toString('base64url'),
                privateKey: Buffer.from(identity.secretKey).toString('base64url') }));
            const retainedLease = scenario === 'leased target preparation' ? runtime.controller.tryAcquireRuntimeRegistry() : null;
            if (scenario === 'leased target preparation') {
                if (!retainedLease) throw new Error('Expected the preparation registry lease');
                await retireAdmittedPluginRuntimeRegistry(runtime);
            }
            const retainedDomainOperations = createActionOperationStore();
            let retiredProviderDomain = false;
            let reachedNativeTeardown = false;
            const deps = createDaemonDeploymentActionDeps({
                readOperation: async operationId => retainedDomainOperations.get({ accountId: 'owner', machineId: 'machine-a' }, operationId),
                ...(domainTeardown ? { teardownBoundary: {
                    async observe() {
                        reachedNativeTeardown = true;
                        expect(retiredProviderDomain).toBe(true);
                        return { kind: 'failed' as const, reason: 'native-boundary-fixture' };
                    },
                    async execute() { throw new Error('Native effects are outside the provider Domain cleanup contract'); },
                } } : {}),
                resolveRequesterIdentity: rootSourceForeign ? async current => {
                    const owner = createFilesystemEffectAdmission({ resolveHomeServerIdentityId: async () => 'home',
                        resolveHostIdentity: async () => ({ machineId: 'machine-a', installationId: 'installation-a', custodianAccountId: 'machine-owner' }) });
                    const requester = await owner.resolveActionRequester!(current);
                    try { return requester.identity; } finally { await requester.dispose(); }
                } : async current => {
                    const identity = await resolveOwnerRequesterIdentity(current);
                    if (rootApproval) {
                        const custody = readRequesterAccountActionContext(current.externalActionExecutionAuthorization);
                        sourceRequesters.push({ identity, hasAccountContext: Boolean(custody), sameHomeUrl: custody?.serverHttpBaseUrl === 'https://platform.test' });
                    }
                    return identity;
                },
                credentials,
                serverId: 'home', serverHttpBaseUrl: 'https://platform.test', machineId: 'machine-a',
                acquirePluginRuntimeRegistryLease: async () => {
                    const lease = retainedLease ?? runtime.controller.tryAcquireRuntimeRegistry();
                    if (!lease) throw new Error('Fixture registry retired');
                    return lease;
                },
                runtime: { async acquire() { throw new Error('Platform must not acquire native execution'); } } });
            if (providerTeardown) {
                const denied = scenario === 'provider teardown denied';
                if (scenario === 'provider teardown created default') {
                    row.content = { ...row.content, providerResourceOrigin: 'created' };
                    put(row.targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, row.content);
                }
                if (denied) environment.environment.capabilities.deploy = false;
                const intent = { serverId: 'home', environmentId: environment.environment.id,
                    targetLinkId: row.targetLink.id, reason: 'manual' as const, requestKey: 'provider-delete',
                    ...(scenario === 'provider teardown explicit unlink' ? { providerRemoval: 'unlink' as const }
                        : scenario === 'provider teardown linked default' || scenario === 'provider teardown created default' ? {}
                            : { providerRemoval: 'delete' as const }) };
                if (scenario === 'provider teardown preview') {
                    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps });
                    const result = await executor.execute('deployments.teardown', { ...intent, mode: 'preview' }, {
                        ...ownerContext, surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
                        runtimeAccountId: 'owner', serverId: 'home', serverIdentityId: 'home',
                        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) });
                    expect(result).toMatchObject({ ok: false, errorCode: 'unsupported_action', effectAttempted: false });
                    expect(candidatesCreated).toBe(0);
                    expect(nativeReads).toBe(0);
                    const module = runtime.modulesByPluginId.get(pluginId);
                    if (typeof module?.readObservationCount !== 'function') throw new Error('Expected provider invocation probe');
                    expect(module.readObservationCount()).toBe(0);
                    return;
                }
                const prepared = await deps.prepareDeploymentTeardown!({ input: intent, context: ownerContext,
                    readWorkflowInvocation: async () => { throw new Error('Runtime deletion has no Workflow custody'); } });
                if (scenario === 'provider teardown linked default' || scenario === 'provider teardown explicit unlink') {
                    expect(prepared).toMatchObject({ input: { detachKeepRunning: true } });
                    expect(candidatesCreated).toBe(0);
                    expect(nativeReads).toBe(0);
                    return;
                }
                if (denied) {
                    expect(prepared).toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
                    expect(candidatesCreated).toBe(0);
                    return;
                }
                expect(prepared, JSON.stringify(prepared)).toMatchObject({ input: { serverId: intent.serverId, environmentId: intent.environmentId, targetLinkId: intent.targetLinkId, reason: intent.reason, requestKey: intent.requestKey,
                    expectedRevision: environment.environment.revision, expectedTargetLinkRevision: row.targetLink.revision },
                    hostReviewedChildren: { children: [{ role: 'teardown' }, { role: 'observe' }] } });
                if (!('input' in prepared) || !('contentArtifactId' in prepared.input)) throw new Error('Expected provider teardown candidate');
                const input = prepared.input;
                const document = documents.get(input.contentArtifactId)!;
                const content = DeploymentProviderTeardownContentV1Schema.parse(JSON.parse(z.object({ body: z.string() }).parse(
                    decodePlainArtifactStoredContent(String(document.body))).body));
                expect(content.sourceIntent).toBeUndefined();
                expect(content.sourceMethod).toBeUndefined();
                expect(content.platform).toMatchObject({ providerIdentity: row.content.providerIdentity,
                    credentialPrincipal: row.content.credentialPrincipal, observation: { state: 'queued' } });
                const receipt = createDeploymentReceiptHeaderV1({ id: 'provider-teardown', environmentId: intent.environmentId,
                    targetLinkId: row.targetLink.id, operation: 'teardown', requestKey: intent.requestKey,
                    actionOperationId: 'provider-delete-operation', state: scenario === 'provider teardown recovery' ? 'outcome_unknown' : 'queued',
                    startedAtMs: undefined, settledAtMs: undefined, contentArtifactId: input.contentArtifactId,
                    acceptedExecution: { v: 1, controller: { machineId: 'machine-a', installationId: 'installation-a' } } });
                const previousHttp = vi.mocked(axios.request).getMockImplementation()!;
                const states: string[] = [];
                vi.mocked(axios.request).mockImplementation(async request => {
                    const path = new URL(request.url!).pathname;
                    if (path.endsWith('/domains')) return { status: 200, data: { ok: true,
                        environmentId: intent.environmentId, revision: environment.environment.revision, domains: [], nextCursor: null } };
                    if (path.endsWith(`/receipts/${receipt.id}`)) return { status: 200, data: { ok: true, deployment: receipt } };
                    if (path.endsWith('/teardown')) return { status: 200, data: { ok: true, environmentId: intent.environmentId,
                        revision: environment.environment.revision, deploymentId: receipt.id, deploymentRevision: receipt.revision, state: receipt.state } };
                    if (path.endsWith('/transitions')) {
                        const transition = DeploymentTransitionInputV1Schema.parse(request.data);
                        states.push(transition.state);
                        if (transition.state === 'succeeded') {
                            // The real Home transition refuses successful teardown without this proof.
                            expect(transition.teardownProof).toMatchObject({
                                targetLinkRevision: row.targetLink.revision,
                                machines: [{ machineId: 'machine-a', installationId: 'installation-a' }],
                                workloadAbsent: true, retainedProviderResource: false,
                            });
                        }
                        if (scenario.startsWith('provider teardown ambiguous')) {
                            const body = transition.contentUpdate?.body;
                            if (typeof body !== 'string') throw new Error('Expected retained failure content');
                            const stored = JSON.parse(z.object({ body: z.string() }).parse(decodePlainArtifactStoredContent(body)).body);
                            expect(DeploymentProviderTeardownContentV1Schema.parse(stored)).toMatchObject({ failure: {
                                failureCause: { errorCode: 'provider_absence_unconfirmed', phase: 'deployment.teardown.observe' } } });
                        }
                        return { status: 200, data: { ok: true, environmentId: intent.environmentId,
                            revision: environment.environment.revision, deploymentId: receipt.id,
                            deploymentRevision: receipt.revision + 1, state: transition.state } };
                    }
                    return previousHttp(request);
                });
                const acquireLease = async () => {
                    const lease = runtime.controller.tryAcquireRuntimeRegistry();
                    if (!lease) throw new Error('Fixture registry retired');
                    return lease;
                };
                const operations = createHostActionOperationRuntime({ machineId: 'machine-a', resolveAccountId: async () => 'owner',
                    generateOperationId: () => receipt.actionOperationId });
                const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps,
                    runActionOperation: operations.runActionOperation,
                    listContributedActionDefinitions: selection => listRuntimeContributedActionDefinitions(runtime.registry, selection),
                    invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: acquireLease }) });
                const context: ActionExecutorContext = { ...ownerContext, surface: 'cli', authority: 'present_user',
                    serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'owner', actionRequestId: 'provider-delete-request',
                    actionCaller: { kind: 'host' }, interactivePresentation: 'unavailable',
                    actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'deployments.teardown': ['cli'],
                        ...(scenario === 'provider teardown queued observation' ? { 'deployments.receipts.observe': ['cli'] as const } : {}) },
                        ...(scenario === 'provider teardown review' ? { actions: {
                            [formatQualifiedPluginActionId({ pluginId, localId: 'teardown' })]: { approvalRequiredSurfaces: ['cli'] } } } : {}) }) };
                if (scenario === 'provider teardown changed identity') {
                    const linked = DeploymentTargetLinkProviderContentV1Schema.parse(row.content);
                    row.content = { ...linked, providerIdentity: { ...linked.providerIdentity, providerResourceId: 'different-project' } };
                    put(row.targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, row.content);
                }
                // COR6-171's loaded queued teardown has no providerDeploymentId: observe
                // must reach the provider absence check without serializing undefined.
                const result = scenario === 'provider teardown queued observation'
                    ? await executor.execute('deployments.receipts.observe', {
                        serverId: intent.serverId, environmentId: intent.environmentId, deploymentId: receipt.id,
                    }, context)
                    : await executor.execute('deployments.teardown', input, context);
                if (scenario === 'provider teardown changed identity') {
                    expect(result).toMatchObject({ ok: false, errorCode: 'deployment_access_denied', effectAttempted: false });
                    expect(states.at(-1)).toBe('failed');
                } else if (scenario === 'provider teardown review') {
                    expect(result).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
                    expect(states).toEqual([]);
                } else {
                    expect(result, JSON.stringify(result)).toMatchObject(scenario.startsWith('provider teardown ambiguous')
                        ? { ok: false, errorCode: 'outcome_unknown', details: { reason: 'provider_absence_unconfirmed' },
                            failureCause: { errorCode: 'provider_absence_unconfirmed', phase: 'deployment.teardown.observe' } } : { ok: true, result: { state: 'succeeded' } });
                    expect(states.at(-1)).toBe(scenario.startsWith('provider teardown ambiguous') ? 'outcome_unknown' : 'succeeded');
                }
                const module = runtime.modulesByPluginId.get(pluginId);
                if (typeof module?.readObservationCount !== 'function') throw new Error('Expected provider invocation probe');
                expect(module.readObservationCount()).toBe(scenario === 'provider teardown review' || scenario === 'provider teardown changed identity' ? 0 : 1);
                expect(nativeReads).toBe(0);
                return;
            }
            if (domainScenario) {
                Object.assign(row.targetLink, { machineId: 'machine-a', installationId: 'installation-a' });
                const content = { hostname: 'app.example.test', target: { kind: 'provider' } };
                const domain = DeploymentDomainHeaderV1Schema.parse({ v: 1, id: 'platform-domain', environmentId: environment.environment.id,
                    targetLinkId: row.targetLink.id, revision: 1, state: 'pending', provider: true,
                    providerPlacement: { serverId: 'home', accountId: 'owner', environmentId: environment.environment.id,
                        targetLinkId: row.targetLink.id, domainId: 'platform-domain', controller: { machineId: 'machine-a', installationId: 'installation-a' },
                        actionOperationId: 'domain-operation', requestId: 'domain-request' },
                    contentArtifactId: 'platform-domain-artifact', contentHeaderVersion: 1, contentBodyVersion: 1,
                    createdByAccountId: 'owner', createdAtMs: 1, updatedAtMs: 1 });
                put(domain.contentArtifactId, 'deployment-domain.v1', content);
                const previousHttp = vi.mocked(axios.request).getMockImplementation()!;
                vi.mocked(axios.request).mockImplementation(async request => {
                    const path = new URL(request.url!).pathname;
                    if (domainAdd && request.method === 'POST' && path.endsWith('/domains')) {
                        Object.assign(domain, DeploymentDomainHeaderV1Schema.parse({ ...domain,
                            ...readHomeRequestArtifactReference(request.data) }));
                        return { status: 200, data: { ok: true, environmentId: environment.environment.id,
                            revision: environment.environment.revision, domain } };
                    }
                    if (path.endsWith('/domains')) return { status: 200, data: { ok: true, environmentId: environment.environment.id,
                        revision: environment.environment.revision, domains: [domain], nextCursor: null } };
                    if (domainRemove && path.endsWith(`/domains/${domain.id}/remove`)) {
                        domain.state = 'removing'; domain.revision++;
                        environment.environment.revision++;
                        return { status: 200, data: { ok: true, environmentId: environment.environment.id,
                            revision: environment.environment.revision, domain } };
                    }
                    if (path.endsWith(`/domains/${domain.id}`)) return { status: 200, data: { ok: true,
                        environmentId: environment.environment.id, revision: environment.environment.revision, domain } };
                    if (path.endsWith(`/domains/${domain.id}/transitions`)) {
                        const wire = DeploymentDomainTransitionInputV1Schema.parse(request.data);
                        expect(wire).toMatchObject({ observations: [], providerObservation: { placement: domain.providerPlacement,
                            state: domainRemove || domainTeardown ? 'removed' : domainState, proof: expect.any(Object), contentUpdate: { expectedBodyVersion: 1 } } });
                        const privateBody = decodePlainArtifactStoredContent(String(wire.providerObservation!.contentUpdate!.body));
                        expect(privateBody).toMatchObject({ body: domainRemove || domainTeardown ? expect.stringContaining('\"state\":\"removed\"') : expect.stringContaining(vercelActiveDomainAdd ? '\"state\":\"active\"' : 'private-dns-token') });
                        retiredProviderDomain = true;
                        return { status: 200, data: { ok: true, environmentId: environment.environment.id,
                            revision: environment.environment.revision, domain: DeploymentDomainHeaderV1Schema.parse({ ...domain,
                                state: domainRemove || domainTeardown ? 'removing' : domainState,
                                ...(domainRemove || domainTeardown ? { deletedAtMs: 2 } : {}),
                                revision: domain.revision + 1, contentBodyVersion: 2 }) } };
                    }
                    return previousHttp(request);
                });
                if (domainTeardown) {
                    const native = createDeploymentEnvironmentDetailV1().targetLinks[0]!;
                    native.targetLink.id = 'native-after-migration';
                    native.targetLink.predecessorTargetLinkId = row.targetLink.id;
                    native.targetLink.contentArtifactId = 'native-after-migration-content';
                    environment.targetLinks.push(native);
                    environment.environment.runtimeTargetLinkId = native.targetLink.id;
                    put(native.targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, native.content);
                    const sample = createDeploymentReceiptDetailV1();
                    const receipt = createDeploymentReceiptDetailV1({ deployment: { ...sample.deployment,
                        id: 'teardown-receipt', operation: 'teardown', state: 'running', actionOperationId: 'domain-operation',
                        targetLinkId: native.targetLink.id, contentArtifactId: 'teardown-artifact' }, content: { ...sample.content,
                        teardown: { reason: 'manual', targetLinkRevision: native.targetLink.revision,
                            machines: native.targetLink.members.map(({ machineId, installationId }) => ({ machineId, installationId })),
                            resources: [], proofs: [] } } });
                    put(receipt.deployment.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, receipt.content);
                    const domainHttp = vi.mocked(axios.request).getMockImplementation()!;
                    vi.mocked(axios.request).mockImplementation(async request => new URL(request.url!).pathname.endsWith('/receipts/teardown-receipt')
                        ? { status: 200, data: DeploymentReceiptGetResultV1Schema.parse({ ok: true, deployment: receipt.deployment }) }
                        : domainHttp(request));
                    const input = { serverId: 'home', environmentId: environment.environment.id,
                        expectedRevision: environment.environment.revision, targetLinkId: native.targetLink.id,
                        expectedTargetLinkRevision: native.targetLink.revision, requestKey: 'retire-provider-domain', reason: 'manual' as const,
                        removeEnvironment: true as const,
                        contentArtifactId: 'teardown-artifact', contentHeaderVersion: 1, contentBodyVersion: 1 };
                    const plan = await deps.prepareHostReviewedChildren!({ actionId: 'deployments.teardown', input, context: ownerContext });
                    expect(plan, JSON.stringify(plan)).toMatchObject({ children: expect.arrayContaining([
                        expect.objectContaining({ role: 'domains.remove', input: expect.objectContaining({ domainId: domain.id,
                            domain: { hostname: content.hostname } }) }),
                    ]) });
                    if (!plan || !('children' in plan)) throw new Error('Expected reviewed retained provider Domain');
                    domain.state = 'removing';
                    domain.revision++;
                    retainedDomainOperations.create({ operationId: 'domain-operation', actionId: 'deployments.teardown',
                        scope: { accountId: 'owner', machineId: 'machine-a' }, title: 'Retained native teardown',
                        cancellation: 'unsupported', inputIdentity: JSON.stringify(input),
                        domainRef: { kind: 'deployment', serverId: 'home', environmentId: environment.environment.id, deploymentId: receipt.deployment.id } });
                    const context: ActionExecutorContext = { ...ownerContext, surface: 'cli', authority: 'present_user',
                        actionCaller: { kind: 'host' }, serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'owner',
                        actionRequestId: 'domain-request', resumeActionRequest: true,
                        operationAcceptance: { actionId: 'deployments.teardown', operationId: 'domain-operation', accept() {} } };
                    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps,
                        listContributedActionDefinitions: selection => listRuntimeContributedActionDefinitions(runtime.registry, selection),
                        invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: async () =>
                            runtime.controller.tryAcquireRuntimeRegistry() ?? (() => { throw new Error('Retired Domain registry'); })() }) });
                    const children = createHostReviewedChildPortV1({ actionId: 'deployments.teardown', input, context,
                        reviewAdmitted: true, plan, policies: plan.children.map(child => ({ action: child.action, role: child.role, surface: 'cli' })),
                        execute: (input, context, actionId) => executor.execute(actionId, input, context) });
                    const teardownResult = await deps.deploymentAction!('deployments.teardown', input, { ...context, hostReviewedChild: children });
                    expect(retiredProviderDomain, JSON.stringify(teardownResult)).toBe(true);
                    expect(reachedNativeTeardown, JSON.stringify(teardownResult)).toBe(true);
                    expect(nativeReads).toBe(0);
                    return;
                }
                const acquireLease = async () => runtime.controller.tryAcquireRuntimeRegistry() ?? (() => { throw new Error('Retired Domain registry'); })();
                const operations = createHostActionOperationRuntime({ machineId: 'machine-a', resolveAccountId: async () => 'owner',
                    generateOperationId: () => 'domain-operation' });
                const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps,
                    runActionOperation: operations.runActionOperation,
                    listContributedActionDefinitions: selection => listRuntimeContributedActionDefinitions(runtime.registry, selection),
                    invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: acquireLease }) });
                const rootAction = domainAdd ? 'deployments.domains.add' : domainRemove ? 'deployments.domains.remove' : 'deployments.domains.verify';
                const rootInput = { serverId: 'home', environmentId: environment.environment.id,
                    domainId: domain.id, expectedRevision: environment.environment.revision,
                    ...(domainAdd ? { targetLinkId: row.targetLink.id, expectedTargetLinkRevision: row.targetLink.revision, content }
                        : { expectedDomainRevision: domain.revision }), requestKey: 'check-domain' };
                let context: ActionExecutorContext = { ...ownerContext, surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: 'home',
                        serverIdentityId: 'home', runtimeAccountId: 'owner', actionRequestId: 'domain-request',
                        actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'deployments.domains.add': ['cli'], 'deployments.domains.remove': ['cli'] } }) };
                let disposeRequester: (() => Promise<void>) | undefined;
                if (domainAdd) {
                    const target = { kind: 'machine' as const, machineId: 'machine-a' };
                    const envelope = { v: 1 as const, requestId: 'domain-request', target, input: rootInput };
                    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'domain-root', binding: {
                        serverIdentityId: 'home', accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
                        admittedMachineRole: 'manage', custodianAccountId: 'owner', machineId: 'machine-a', installationId: 'installation-a',
                        actionId: rootAction, environmentId: environment.environment.id, deploymentChildRoot: true, requestId: envelope.requestId,
                        accountEncryptionMode: 'plain', target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                        deploymentNativeAdmission: projectDeploymentNativeAdmissionV1(rootAction, rootInput) } });
                    const requester = await prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
                        machineId: 'machine-a', installationId: 'installation-a', installationPrivateKey: identity.secretKey,
                        serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://platform.test', ownCredentials: credentials,
                        isCurrent: async () => true, createExecutor: () => executor });
                    if (!requester) throw new Error('Expected admitted authored Domain requester');
                    disposeRequester = () => requester.dispose();
                    context = { ...context, externalActionExecutionAuthorization: requester.authorization,
                        originalActionEnvelope: envelope, externalActionTarget: target,
                        signExternalActionApprovalInput: ({ actionId, input, target: approvalTarget, requesterConfirmation, sessionTargetsV1 }) =>
                            signExternalActionApprovalInputV1({ authorizationToken: authorization.token, actionId, input, target: approvalTarget,
                                ...(requesterConfirmation ? { requesterConfirmation } : {}), ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}),
                                privateKey: identity.secretKey }) };
                }
                let result: ActionExecuteResult;
                try { result = await executor.execute(rootAction, rootInput, context); }
                finally { await disposeRequester?.(); }
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true, domain: { id: domain.id,
                    state: domainRemove ? 'removing' : domainState, revision: domainRemove ? 3 : 2,
                    ...(domainRemove ? { deletedAtMs: 2 } : {}) } } });
                expect(JSON.stringify(result)).not.toContain('private-dns-token');
                if (vercelActiveDomainAdd) expect(nativeDomainRequests).toEqual([
                    { method: 'POST', path: '/v10/projects/project/domains' },
                    { method: 'GET', path: '/v6/domains/app.example.test/config' },
                ]);
                if (domainAdd) {
                    expect(candidatesCreated).toBe(1);
                    expect(domain.contentArtifactId).not.toBe('platform-domain-artifact');
                }
                expect(nativeReads).toBe(0);
                return;
            }
            if (variableScenario) {
                const acquireLease = async () => {
                    const lease = runtime.controller.tryAcquireRuntimeRegistry();
                    if (!lease) throw new Error('Fixture registry retired');
                    return lease;
                };
                const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps,
                    listContributedActionDefinitions: selection => listRuntimeContributedActionDefinitions(runtime.registry, selection),
                    invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: acquireLease }) });
                const context = { ...ownerContext, surface: 'cli' as const, authority: 'present_user' as const,
                    actionCaller: { kind: 'host' as const }, serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'owner',
                    actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
                        'deployments.bindings.set': ['cli'], 'deployments.observation.get': ['cli'] } }) };
                if (scenario === 'variable metadata') {
                    const module = runtime.modulesByPluginId.get(pluginId);
                    if (!module || !('readObservationCount' in module) || typeof module.readObservationCount !== 'function')
                        throw new Error('Missing provider observation probe');
                    const ordinary = await executor.execute('deployments.observation.get', { serverId: 'home',
                        environmentId: environment.environment.id, targetLinkId: row.targetLink.id }, context);
                    expect(ordinary, JSON.stringify(ordinary)).toMatchObject({ ok: true, result: { ok: true } });
                    expect(module.readObservationCount()).toBe(0);
                    const result = await executor.execute('deployments.observation.get', { serverId: 'home',
                        environmentId: environment.environment.id, targetLinkId: row.targetLink.id, variables: true }, context);
                    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true, providerVariables: { v: 1,
                        variables: [{ key: 'MODE', present: true, secret: false, owned: true, drift: 'current' }] } } });
                    expect(module.readObservationCount()).toBe(1);
                    expect(nativeReads).toBe(0);
                    return;
                }
                const previousHttp = vi.mocked(axios.request).getMockImplementation()!;
                vi.mocked(axios.request).mockImplementation(async request => {
                    if (!new URL(request.url!).pathname.endsWith('/bindings')) return previousHttp(request);
                    const prepared = request.data;
                    expect(prepared).toMatchObject({ grants: [], targetLinkContent: { targetLinkId: row.targetLink.id,
                        expectedTargetLinkRevision: row.targetLink.revision } });
                    if (!isRecord(prepared) || typeof prepared.contentArtifactId !== 'string' || !isRecord(prepared.targetLinkContent)
                        || typeof prepared.targetLinkContent.contentArtifactId !== 'string') throw new Error('Expected prepared bindings content references');
                    const environmentBody = decodePlainArtifactStoredContent(String(documents.get(prepared.contentArtifactId)!.body));
                    expect(environmentBody).toMatchObject({ body: expect.stringContaining('registry.example.test') });
                    const candidate = documents.get(prepared.targetLinkContent.contentArtifactId)!;
                    const body = decodePlainArtifactStoredContent(String(candidate.body));
                    expect(body).toMatchObject({ body: expect.stringContaining('provider-mode') });
                    return scenario === 'variable sync storage conflict'
                        ? { status: 409, data: { ok: false, error: 'deployment_conflict' } }
                        : { status: 200, data: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision + 1 } };
                });
                const result = await executor.execute('deployments.bindings.set', { serverId: 'home',
                    environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
                    set: [{ purpose: 'variable', phase: 'build', name: 'MODE', source: { kind: 'value', value: 'release' } },
                        ...(telemetryRemoteEndpoint ? [
                            { purpose: 'variable', phase: 'runtime', name: 'OTEL_EXPORTER_OTLP_ENDPOINT', managedBy: 'telemetry',
                                source: { kind: 'value', value: 'https://collector.example.test' } },
                            { purpose: 'variable', phase: 'runtime', name: 'OTEL_EXPORTER_OTLP_HEADERS', managedBy: 'telemetry',
                                valueFormat: 'otelAuthorizationHeader', source: { kind: 'secret',
                                    ref: 'happier:shared-secret:v1:telemetry', resourceRevision: 1 } },
                        ] : [])], remove: [], ...(telemetryRemoteEndpoint ? { providerVariables: {
                            useOurs: ['OTEL_EXPORTER_OTLP_HEADERS'], keepTheirs: ['OTEL_EXPORTER_OTLP_ENDPOINT'] } } : {}) }, context);
                if (telemetryRemoteEndpoint) {
                    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true,
                        providerVariables: { persisted: true, failures: [], variables: expect.arrayContaining([
                            expect.objectContaining({ key: 'MODE', owned: true }),
                            ...(telemetryManagedCleanup ? [] : [expect.objectContaining({ key: 'OTEL_EXPORTER_OTLP_HEADERS', owned: false })]),
                        ]) } } });
                    expect(nativeVariableRequests.filter(request => request.method !== 'GET'))
                        .toEqual([{ method: 'POST', path: '/v10/projects/project/env',
                            body: { key: 'MODE', value: 'release', type: 'plain', target: ['production'] } },
                            ...(telemetryManagedCleanup ? [{ method: 'DELETE', path: '/v9/projects/project/env/remote-header', body: undefined }] : [])]);
                    if (telemetryManagedCleanup) expect(result).not.toMatchObject({ result: { providerVariables: {
                        variables: expect.arrayContaining([expect.objectContaining({ key: 'OTEL_EXPORTER_OTLP_HEADERS' })]) } } });
                    expect(nativeVariableSecretReads).toBe(0);
                    expect(nativeReads).toBe(0);
                    return;
                }
                expect(result, JSON.stringify(result)).toMatchObject(scenario === 'variable sync storage conflict'
                    ? { ok: false, errorCode: 'deployment_conflict', effectAttempted: true, details: {
                        providerVariables: { persisted: false, failures: [], variables: [{ key: 'MODE', owned: true }] } } }
                    : { ok: true, result: { ok: true, providerVariables: { persisted: true, failures: [], variables: [{ key: 'MODE', owned: true }] } } });
                expect(nativeReads).toBe(0);
                return;
            }
            if (scenario === 'teardown without role' || scenario === 'teardown without role, descriptor unavailable'
                || scenario === 'teardown without role, remove Environment' || scenario === 'teardown with data target') {
                if (scenario === 'teardown without role, descriptor unavailable') row.targetLink.source = { kind: 'plugin',
                    contribution: { pluginId, localId: 'missing-runtime' } };
                const prepared = await deps.prepareDeploymentTeardown!({ input: { serverId: 'home',
                    environmentId: environment.environment.id, targetLinkId: row.targetLink.id,
                    reason: 'manual', requestKey: 'remove-no-teardown',
                    ...(scenario === 'teardown without role, remove Environment' ? { removeEnvironment: true as const } : {}) }, context: ownerContext,
                    readWorkflowInvocation: async () => { throw new Error('Detach has no Workflow custody'); } });
                if (scenario === 'teardown without role, remove Environment') {
                    expect(prepared).toMatchObject({ ok: false, errorCode: 'unsupported_action',
                        details: { reason: 'environment_removal_unavailable', requiredFact: 'environmentRemoval', provider: 'Platform', remedy: expect.any(String) } });
                    expect(candidatesCreated).toBe(0);
                    expect(nativeReads).toBe(0);
                    return;
                }
                if (scenario === 'teardown without role, descriptor unavailable') {
                    expect(prepared).toMatchObject({ ok: false, errorCode: 'deployment_target_role_unavailable' });
                    expect(candidatesCreated).toBe(0);
                    return;
                }
                expect(prepared).toMatchObject({ input: { serverId: 'home', environmentId: environment.environment.id,
                    expectedRevision: environment.environment.revision, targetLinkId: row.targetLink.id,
                    expectedTargetLinkRevision: row.targetLink.revision, requestKey: 'remove-no-teardown',
                    reason: 'manual', detachKeepRunning: true } });
                expect(prepared).not.toHaveProperty('hostReviewedChildren');
                expect(candidatesCreated).toBe(0);
                expect(nativeReads).toBe(0);
                return;
            }
            const environmentBodies = () => vi.mocked(axios.get).mock.calls.filter(([url]) =>
                new URL(url).pathname === `/v1/artifacts/${environment.environment.contentArtifactId}`).length;
            const bodiesBeforeCandidate = environmentBodies();
            if (scenario === 'explicit failure policy') {
                const candidate = await deps.prepareDeployCandidate({ environmentId: environment.environment.id,
                    sourceIntent, sourceMethod: 'upload', onFailure: 'keepPartial', context: ownerContext });
                expect(candidate).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
                expect(candidatesCreated).toBe(0);
                expect(nativeReads).toBe(0);
                const defaultCandidate = await deps.prepareDeployCandidate({ environmentId: environment.environment.id,
                    sourceIntent, sourceMethod: 'upload', context: ownerContext });
                if (!defaultCandidate.ok) throw new Error(defaultCandidate.errorCode);
                const prepared = await deps.prepareDeploymentAction({ actionId: 'deployments.deploy',
                    input: { ...defaultCandidate.input, onFailure: 'keepPartial' }, context: ownerContext });
                expect(prepared).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
                expect(nativeReads).toBe(0);
                return;
            }
            if (scenario === 'compact repository missing SCM provider') {
                const candidate = await deps.prepareDeployCandidate({ environmentId: environment.environment.id,
                    targetLinkId: row.targetLink.id, context: ownerContext });
                expect(candidate).toMatchObject({ ok: false, errorCode: 'scm_ref_resolution_unavailable' });
                expect(nativeReads).toBe(0);
                return;
            }
            const candidate = await deps.prepareDeployCandidate({ environmentId: environment.environment.id, sourceIntent, sourceMethod: 'upload', context: ownerContext });
            expect(candidate).toMatchObject({ ok: true, content: { sourceIntent, sourceMethod: 'upload', machines: [],
                images: [], machineResults: [], platform: { targetLinkRevision: row.targetLink.revision,
                    credentialPrincipal: row.content.credentialPrincipal, providerIdentity: row.content.providerIdentity,
                    providerEnvironment: row.content.providerEnvironment, ...capturedPreparation } } });
            expect(environmentBodies() - bodiesBeforeCandidate).toBe(1);
            expect(nativeReads).toBe(0);
            if (!candidate.ok) throw new Error(candidate.errorCode);
            if (scenario === 'leased target preparation') return;
            const platformCandidate = DeploymentPlatformContentV1Schema.parse(candidate.content);
            const prepared = await deps.prepareDeploymentAction({ actionId: 'deployments.deploy', input: candidate.input,
                context: ownerContext });
            expect(prepared, JSON.stringify(prepared)).toHaveProperty('input', candidate.input);
            if (scenario === 'reviewed child') expect(prepared).toMatchObject({ preview: {
                summary: expect.stringContaining(preparedNative.reviewNotice!),
            } });
            environment.environment.revision++;
            await expect(deps.prepareDeploymentAction({ actionId: 'deployments.deploy', input: candidate.input,
                context: ownerContext })).resolves.toHaveProperty('input', candidate.input);
            environment.environment.revision--;
            expect(candidate.content).not.toHaveProperty('ownServer');
            const created = candidatesCreated;
            const principal = row.content.credentialPrincipal;
            if (!principal || principal.kind !== 'account') throw new Error('Expected the captured Account principal');
            row.content = { ...row.content, credentialPrincipal: { ...principal, accountId: 'another-owner' } };
            put(row.targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, row.content);
            await expect(deps.prepareDeployCandidate({ environmentId: environment.environment.id, sourceIntent, sourceMethod: 'upload', context: ownerContext }))
                .resolves.toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
            row.content = { ...row.content, credentialPrincipal: principal };
            put(row.targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, row.content);
            environment.environment.controllerMachineId = 'replaced-controller';
            await expect(deps.prepareDeployCandidate({ environmentId: environment.environment.id, sourceIntent, sourceMethod: 'upload', context: ownerContext }))
                .resolves.toMatchObject({ ok: false, errorCode: 'machine_unavailable' });
            expect(candidatesCreated).toBe(created);
            expect(nativeReads).toBe(0);
            environment.environment.controllerMachineId = 'machine-a';
            let requesterCurrent = true;
            let reserved = false;
            let providerSends = 0;
            let childInvocations = 0;
            let childResult: ActionExecuteResult | undefined;
            let transitionWrites = 0;
            const observerRoots = new Map<string, string>();
            vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
                if (new URL(String(url)).origin === 'https://platform.test' || String(url).startsWith(sdkHomeUrl)) return Response.json({ features: {},
                    capabilities: { serverIdentity: { serverIdentityId: 'home' } } });
                providerSends++;
                throw new Error('Refused deployment must not reach the provider');
            });
            // Controller build cases create exclusive stage-log directories.
            const buildReceiptId = controllerBuildOutput ? `platform-receipt-${scenario.replaceAll(' ', '-')}` : undefined;
            const receipt = createDeploymentReceiptHeaderV1({ id: buildReceiptId ?? 'platform-receipt', environmentId: environment.environment.id,
                targetLinkId: row.targetLink.id, state: scenario === 'uncertain receipt observe' ? 'outcome_unknown' : scenario === 'build logs' ? 'succeeded' : scenario === 'retained receipt observe' ? 'running' : 'queued', requestKey: candidate.input.requestKey,
                actionOperationId: 'platform-operation', requestedByAccountId: 'owner',
                startedAtMs: undefined, settledAtMs: undefined, contentArtifactId: 'reserved-platform-content',
                acceptedExecution: { v: 1, controller: { machineId: 'machine-a', installationId: 'installation-a' } } });
            const receiptContent = scenario === 'receipt source differs'
                ? { ...candidate.content, sourceIntent: { ...sourceIntent, contentRevision: sourceIntent.contentRevision + 1 } }
                : scenario === 'build logs' || runtimeLogs || scenario === 'retained receipt observe' || backgroundObservation ? { ...platformCandidate,
                    ...(scenario === 'retained receipt observe' ? { actor: { actorKind: 'agent' as const,
                        sessionId: 'original-session', onBehalfOf: { serverId: 'original-home', accountId: 'original-requester' } } } : {}),
                    platform: { ...platformCandidate.platform, observation: { v: 1, state: backgroundObservation ? 'queued' : 'running',
                        providerDeploymentId: 'existing-provider-deployment', observedAtMs: 1,
                        ...(scenario === 'retained receipt observe' ? { uploadProvenance: { sourceManifestFingerprint: 'approved-manifest',
                            build: { location: 'provider' as const } } } : {}) } } }
                : scenario === 'admission cause retained approval' ? { ...platformCandidate,
                    platform: { ...platformCandidate.platform, providerIdentity: {
                        ...platformCandidate.platform.providerIdentity, providerResourceId: 'private-substituted-project' } } }
                : roleFails ? { ...platformCandidate,
                    steps: [{ id: 'build', label: 'Provider build', state: 'failed', streamRef: 'masked-provider-stream' }] }
                : candidate.content;
            put(receipt.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, scenario === 'uncertain receipt observe'
                ? { ...receiptContent, failure: { code: 'deployment_activation_not_observed', phase: 'observe' } }
                : receiptContent);
            if (retainedTraffic) {
                // #152: a protected Upload receipt contains provider provenance,
                // not own-server Machines, images or a controller build choice.
                receipt.state = 'succeeded';
                environment.content.definition = { kind: 'repository', ref: 'main' };
                put(environment.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, environment.content);
                put(receipt.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, DeploymentPlatformContentV1Schema.parse({
                    ...platformCandidate, sourceIntent: rootSourceIntent,
                    platform: { ...platformCandidate.platform, observation: { v: 1, state: 'succeeded',
                        providerDeploymentId: 'existing-provider-deployment', observedAtMs: 1 } },
                }));
                const readHttp = vi.mocked(axios.request).getMockImplementation()!;
                vi.mocked(axios.request).mockImplementation(async request => new URL(request.url!).pathname.endsWith(`/receipts/${receipt.id}`)
                    ? { status: 200, data: DeploymentReceiptGetResultV1Schema.parse({ ok: true, deployment: receipt }) }
                    : readHttp(request));
                // Activation advances the Link while the protected receipt keeps
                // the revision and exact provider deployment it originally captured.
                if (scenario === 'rollback retained platform') row.targetLink.revision++;
                const intent = { serverId: 'home', environmentId: environment.environment.id, requestKey: `retained-${scenario}` };
                const prepared = await deps.prepareDeploymentAction(scenario === 'promote retained platform'
                    ? { actionId: 'deployments.promote', input: { ...intent, sourceEnvironmentId: environment.environment.id,
                        sourceDeploymentId: receipt.id, artifact: 'image' }, context: ownerContext }
                    : { actionId: 'deployments.rollback', input: { ...intent, deploymentId: receipt.id }, context: ownerContext });
                expect(prepared, JSON.stringify(prepared)).toMatchObject({ input: { ...intent,
                    targetLinkId: row.targetLink.id }, hostReviewedChildren: { children: [
                    { role: scenario === 'promote retained platform' ? 'promote' : 'rollback' }, { role: 'observe' },
                ] } });
                if (!('input' in prepared)) throw new Error('Expected a prepared provider traffic change');
                const stored = decodePlainArtifactStoredContent(String(documents.get(prepared.input.contentArtifactId)!.body));
                const content = DeploymentPlatformContentV1Schema.parse(JSON.parse(z.object({ body: z.string() }).parse(stored).body));
                expect(content).toMatchObject({ sourceIntent: rootSourceIntent, sourceMethod: 'upload', machines: [], images: [],
                    platform: { targetLinkRevision: row.targetLink.revision,
                        credentialPrincipal: row.content.credentialPrincipal, providerIdentity: row.content.providerIdentity,
                        providerEnvironment: row.content.providerEnvironment,
                        observation: { state: 'succeeded', providerDeploymentId: 'existing-provider-deployment' } } });
                expect(content).not.toHaveProperty('buildMachineId');
                expect(nativeReads).toBe(0);
                if (scenario === 'rollback retained platform') {
                    // A new Link revision permits fresh review, not substituting
                    // the provider resource that owns the retained deployment.
                    const linkedProvider = DeploymentTargetLinkProviderContentV1Schema.parse(row.content);
                    row.content = { ...linkedProvider, providerIdentity: { ...linkedProvider.providerIdentity,
                        providerResourceId: 'another-provider-project' } };
                    put(row.targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, row.content);
                    await expect(deps.prepareDeploymentAction({ actionId: 'deployments.rollback',
                        input: { ...intent, deploymentId: receipt.id }, context: ownerContext }))
                        .resolves.toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
                }
                return;
            }
            const requestHttp = vi.mocked(axios.request).getMockImplementation()!;
            vi.mocked(axios.request).mockImplementation(async request => {
                const path = new URL(request.url!).pathname;
                if (request.method === 'POST' && path.endsWith('/deploy')) {
                    reserved = true;
                    environment.environment.revision = 7;
                    return { status: 200, data: DeploymentReceiptResultV1Schema.parse({ ok: true, environmentId: receipt.environmentId,
                        deploymentId: receipt.id, revision: 7, deploymentRevision: receipt.revision, state: receipt.state }) };
                }
                if (request.method === 'GET' && path.endsWith(`/receipts/${receipt.id}`)) {
                    if (scenario === 'requester revoked') requesterCurrent = false;
                    return { status: 200, data: DeploymentReceiptGetResultV1Schema.parse({ ok: true, deployment: receipt }) };
                }
                if (request.method === 'POST' && path.endsWith('/transitions')) {
                    if (sdkBackgroundObservation) {
                        const token = String(request.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]);
                        expect(request.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe('deployments.receipts.observe');
                        expect(verifyExternalActionMachineRequestV1({ authorizationToken: token,
                            effectActionId: 'deployments.receipts.observe', target: { kind: 'machine', machineId: 'machine-a' },
                            installationId: 'installation-a', requestId: observerRoots.get(token)!, method: 'POST', path,
                            body: request.data, publicKey: identity.publicKey,
                            signature: String(request.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
                    }
                    settling = false;
                    const transition = DeploymentTransitionInputV1Schema.parse(request.data);
                    // The server transaction applies this prepared mutation to the SAME receipt Artifact.
                    if (!transition.contentArtifactId || !transition.contentUpdate
                        || transition.contentUpdate.expectedHeaderVersion === undefined
                        || transition.contentUpdate.expectedBodyVersion === undefined) throw new Error('Expected the admitted receipt update');
                    const stored = documents.get(transition.contentArtifactId);
                    if (!stored) throw new Error('Expected the admitted receipt Artifact');
                    documents.set(transition.contentArtifactId, { ...stored, ...transition.contentUpdate,
                        headerVersion: transition.contentUpdate.expectedHeaderVersion + 1,
                        bodyVersion: transition.contentUpdate.expectedBodyVersion + 1 });
                    transitionWrites++;
                    if (backgroundObservation || controllerBuildOutput) {
                        expect(transition.actionOperationId).toBe('platform-operation');
                        expect(transition.machineId).toBe('machine-a');
                        receipt.state = transition.state;
                        receipt.revision++;
                        receipt.contentHeaderVersion = transition.contentUpdate.expectedHeaderVersion + 1;
                        receipt.contentBodyVersion = transition.contentUpdate.expectedBodyVersion + 1;
                    }
                    return { status: 200, data: DeploymentReceiptResultV1Schema.parse({ ok: true, environmentId: receipt.environmentId,
                        deploymentId: receipt.id, revision: environment.environment.revision + 1,
                        deploymentRevision: receipt.revision + 1,
                        state: backgroundObservation || controllerBuildOutput ? transition.state
                            : scenario === 'reviewed child' || scenario === 'upload source' || scenario === 'retained receipt observe' ? 'succeeded' : 'failed' }) };
                }
                return requestHttp(request);
            });
            const acquireLease = async () => {
                const lease = runtime.controller.tryAcquireRuntimeRegistry();
                if (!lease) throw new Error('Fixture registry retired');
                return lease;
            };
            const invoke = createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: acquireLease });
            const rootApprovalStore = createCliApprovalsArtifactStore({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://platform.test' });
            let operationSequence = 0;
            const operations = createHostActionOperationRuntime({ machineId: 'machine-a', resolveAccountId: async () => 'owner',
                generateOperationId: () => operationSequence++ === 0 ? 'platform-operation' : `platform-operation-${operationSequence}` });
            let replayPreparer: ReturnType<typeof createDaemonApprovalExecutionAuthorizationPreparer> | undefined;
            const resolveTarget = createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: 'https://platform.test' });
            const actionAutomations = controllerBuildOutput ? createActionAutomationPortV1({
                accountId: 'owner',
                // This Home has no automation triggers. The Action still runs real admission.
                seed: async () => ({ v: 1, rows: [] }),
                settle: async () => {},
            }) : undefined;
            if (actionAutomations) onTestFinished(() => actionAutomations.dispose());
            const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps,
                ...(actionAutomations ? { actionAutomations } : {}),
                ...(rootApproval ? { ...rootApprovalStore, runActionOperation: operations.runActionOperation,
                    prepareApprovalExecutionAuthorization: request => replayPreparer!(request),
                    isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentness({ accountId: 'owner', machineId: 'machine-a', serverId: 'home',
                        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'home', machineId: 'machine-a' }),
                        resolveTarget, isAccountCurrent: async () => requesterCurrent,
                        listAccountApiTokens: async () => { throw new Error('Account root must not read PATs'); },
                        externalActionMachinePublicKey: identity.publicKey, verifyExternalExecutionAuthorization: async () => true }) } : {}),
                // Observe the actual core-created port without replacing its proof, policy or invocation behavior.
                deploymentAction: (actionId, input, context) => deps.deploymentAction(actionId, input, {
                    ...context, ...(context.hostReviewedChild ? { hostReviewedChild: { invoke: async request => {
                        childInvocations++;
                        expect(request.input).toMatchObject(capturedPreparation);
                        if (scenario === 'retained receipt observe') expect(request.input).not.toHaveProperty('preparedNative');
                        childResult = await context.hostReviewedChild!.invoke(request);
                        if (childResult.ok) {
                            settling = true;
                            // The public metadata boundary now reports a real link change after the provider effect.
                            if (settlementPointerChanged) row.targetLink.revision++;
                        }
                        return childResult;
                    } } } : {}),
                }),
                listContributedActionDefinitions: selection => listRuntimeContributedActionDefinitions(runtime.registry, selection),
                invokeContributedAction: invoke });
            const requiresChildApproval = scenario === 'child policy requires approval' || scenario === 'qualified child policy requires approval';
            let context: import('@happier-dev/protocol').ActionExecutorContext = {
                ...ownerContext,
                surface: requiresChildApproval ? 'api' : 'cli', authority: 'present_user',
                serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'owner', actionRequestId: 'platform-request',
                interactivePresentation: 'unavailable',
                actionCaller: { kind: 'host' }, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
                    approvalWaivedSurfaces: { 'deployments.deploy': ['api', 'cli'] },
                    ...(requiresChildApproval ? { actions: {
                        [scenario === 'qualified child policy requires approval'
                            ? formatQualifiedPluginActionId({ pluginId, localId: 'upload-deploy' }) : 'action.invoke']:
                            { approvalRequiredSurfaces: ['api'] } } } : {}) }) };
            if (runtimeLogs) {
                const acceptedExecution = receipt.acceptedExecution;
                receipt.acceptedExecution = undefined;
                const result = await executor.execute('deployments.logs.read', { serverId: 'home', environmentId: receipt.environmentId,
                    deploymentId: receipt.id, kind: 'runtime' },
                context);
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true, kind: 'runtime', logs: {
                    kind: 'page', page: { sourceRevision: 'existing-provider-deployment', text: 'Runtime ready\n', truncated: true } } } });
                receipt.acceptedExecution = acceptedExecution;
                const hostRead = createDaemonHostResourceRead({ readAccountId: () => 'owner', resolveActionExecutor: async () => executor });
                const reference = { hostRead: 'deployments.logs' as const, sourceRevision: 'existing-provider-deployment', input: {
                    serverId: 'home', environmentId: receipt.environmentId, deploymentId: receipt.id, targetLinkId: receipt.targetLinkId,
                    machineId: 'machine-a', installationId: 'installation-a', kind: 'runtime' as const } };
                const resourceContext = { signal: new AbortController().signal, localActionContext: context };
                await expect(hostRead.read(reference, 'machine-a', resourceContext)).resolves.toMatchObject({ value: {
                    kind: 'page', page: { sourceRevision: 'existing-provider-deployment', text: 'Runtime ready\n', truncated: true } } });
                const { createStablePluginUiResourceWatchOwner } = await import('@/plugins/runtime/invocation/services/uiResourceWatch');
                const watches = createStablePluginUiResourceWatchOwner({ isPluginConsumerCurrent: () => false,
                    readPluginOccurrenceId: () => null });
                const subscription = { hostAccountId: 'owner', subscriptionId: 'runtime-follow', resource: reference };
                try {
                    await watches.openHost({ accountId: 'owner', subscriptionId: subscription.subscriptionId, resource: reference,
                        bind: (signal, emit, end) => hostRead.observe(reference, 'machine-a', resourceContext, signal, emit, end) });
                    for (const text of ['Follow first\n', 'Follow second\n']) {
                        const next = await watches.next(subscription);
                        expect(next).toMatchObject({ status: 'event', event: { kind: 'pages', pages: [expect.objectContaining({ contentType: 'application/json' })] } });
                        if (next.status !== 'event' || next.event.kind !== 'pages') throw new Error('Expected finite watch pages');
                        expect(JSON.parse(Buffer.from(next.event.pages[0]!.bytesBase64, 'base64').toString('utf8')))
                            .toEqual({ kind: 'page', page: { sourceRevision: 'existing-provider-deployment', text, nextCursor: null, truncated: true } });
                    }
                    expect(await watches.close(subscription)).toBe(true);
                    const module = runtime.modulesByPluginId.get(pluginId);
                    if (typeof module?.readObservationCount !== 'function' || typeof module?.readRuntimeWatchCounts !== 'function')
                        throw new Error('Expected authored runtime counters');
                    expect(module.readObservationCount()).toBe(2); // Direct Action + finite Resource read, none per followed page.
                    expect(module.readRuntimeWatchCounts()).toEqual({ opened: 1, disposed: 1 });
                } finally { watches.retire(); }
                expect(nativeReads).toBe(0);
                expect(transitionWrites).toBe(0);
                return;
            }
            if (scenario === 'build logs') {
                // QA #82: receipt revision1 remains readable after the same Link advances to2.
                row.targetLink.revision = 2;
                const compactInput = { serverId: 'home', environmentId: receipt.environmentId,
                    deploymentId: receipt.id, kind: 'build' as const };
                for (const mismatch of [{ targetLinkId: 'other-link' }, { machineId: 'other-machine' },
                    { installationId: 'other-installation' }]) {
                    await expect(executor.execute('deployments.logs.read', { ...compactInput, ...mismatch }, context))
                        .resolves.toMatchObject({ ok: false, errorCode: 'target_mismatch' });
                }
                const result = await executor.execute('deployments.logs.read', { serverId: 'home', environmentId: receipt.environmentId,
                    deploymentId: receipt.id, kind: 'build' }, context);
                if (!result.ok) throw new Error(JSON.stringify(result));
                expect(result).toMatchObject({ ok: true, result: { ok: true, kind: 'build', logs: { kind: 'page',
                    page: { sourceRevision: 'existing-provider-deployment', text: 'Build complete\n' } } } });
                await expect(executor.execute('deployments.logs.read', { ...compactInput, targetLinkId: receipt.targetLinkId,
                    machineId: 'machine-a', installationId: 'installation-a' }, context))
                    .resolves.toMatchObject({ ok: true, result: { ok: true, kind: 'build' } });
                await expect(executor.execute('deployments.logs.read', { serverId: 'home', environmentId: receipt.environmentId,
                    deploymentId: receipt.id, targetLinkId: receipt.targetLinkId, machineId: 'machine-a', installationId: 'installation-a',
                    kind: 'runtime', service: { kind: 'deployment', machineId: 'machine-a', environmentId: receipt.environmentId,
                        environmentInstanceId: 'instance', composeService: 'app', serviceId: 'instance/app' } }, context))
                    .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action', details: {
                        requiredFact: 'deploymentTarget.actions.logs.runtime' } });
                expect(nativeReads).toBe(0);
                expect(transitionWrites).toBe(0);
                return;
            }
            if (!sdkBackgroundObservation && (controllerBuildOutput || backgroundObservation || rootSource || scenario === 'requester revoked' || scenario === 'reviewed child' || scenario === 'upload source' || scenario === 'retained receipt observe' || roleFails || settlementPointerChanged)) {
                const target = { kind: 'machine' as const, machineId: 'machine-a' };
                const rootActionId = backgroundObservation ? 'deployments.receipts.observe' as const : 'deployments.deploy' as const;
                const rootInput = candidate.input;
                const envelope = { v: 1 as const, requestId: 'platform-request', target, input: backgroundObservation
                    ? { serverId: 'home', environmentId: receipt.environmentId, deploymentId: receipt.id } : rootInput };
                const requestEnvelopeDigest = computeExternalActionRequestEnvelopeDigestV1(envelope);
                let authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root-proof', binding: {
                    serverIdentityId: 'home', accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
                    admittedMachineRole: rootSourceForeign ? 'use' : 'manage',
                    custodianAccountId: rootSourceForeign ? 'machine-owner' : 'owner', machineId: 'machine-a', installationId: 'installation-a',
                    actionId: rootActionId, environmentId: environment.environment.id, requestId: 'platform-request',
                    accountEncryptionMode: 'plain', requestEnvelopeDigest, target,
                    ...(!backgroundObservation ? { deploymentCandidatePublication: createDeploymentCandidatePublicationV1({ accountId: 'owner', serverIdentityId: 'home',
                        actionId: 'deployments.deploy', requestId: envelope.requestId, requestEnvelopeDigest,
                        environmentId: environment.environment.id, source: { id: environment.environment.projectSourceId, revision: 1 } }) } : {}) } });
                if (rootSourceForeign || rootApproval) authorization = sealExternalActionRequesterAccountContextV1({ authorization,
                    purpose: { kind: 'external_action' }, credentials: { token: credentials.token, secret: null, encryption: null },
                    installationPublicKey: identity.publicKey, randomBytes: length => new Uint8Array(randomBytes(length)) });
                requesterPreparation = await prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
                    machineId: 'machine-a', installationId: 'installation-a', installationPrivateKey: identity.secretKey,
                    serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://platform.test', ownCredentials: credentials,
                    isCurrent: async () => requesterCurrent, createExecutor: () => executor });
                if (!requesterPreparation) throw new Error('Expected admitted requester custody');
                Object.assign(context, { serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'owner',
                    actionRequestId: 'platform-request', externalActionExecutionAuthorization: requesterPreparation.authorization,
                    originalActionEnvelope: envelope, externalActionTarget: target });
                if (scenario === 'reviewed child') {
                    const scopedCandidate = await deps.prepareDeployCandidate({ environmentId: environment.environment.id,
                        sourceIntent, sourceMethod: 'upload', context });
                    expect(scopedCandidate).toMatchObject({ ok: true, input: {
                        contentArtifactId: authorization.binding.deploymentCandidatePublication!.contentArtifactId } });
                }
                context = { ...context, signExternalActionApprovalInput: ({ actionId, input, target: approvalTarget, requesterConfirmation, sessionTargetsV1 }) =>
                    signExternalActionApprovalInputV1({ authorizationToken: authorization.token, actionId, input, target: approvalTarget,
                        ...(requesterConfirmation ? { requesterConfirmation } : {}), ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}),
                        privateKey: identity.secretKey }) };
                if (rootSource) {
                    // The actual replay preparer restores private root proof before
                    // core deployment preparation; only Home/installation IO is replaced.
                    const prepare = createDaemonApprovalExecutionAuthorizationPreparer({ machineId: 'machine-a', serverId: 'home',
                        serverBaseUrl: 'https://platform.test', daemonWorkSignal: new AbortController().signal,
                        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'home', machineId: 'machine-a' }),
                        prepareRequesterAccountContext: input => prepareRequesterAccountActionContext({ ...input,
                            purpose: { kind: 'external_action' }, machineId: 'machine-a', installationId: 'installation-a',
                            installationPrivateKey: identity.secretKey, serverId: 'home', serverIdentityId: 'home',
                            serverHttpBaseUrl: 'https://platform.test', ownCredentials: credentials,
                            isCurrent: async () => true, createExecutor: () => executor }) });
                    replayPreparer = prepare;
                    const replay = await prepare({ authorization: requesterPreparation.authorization });
                    if (!replay) throw new Error('Root replay custody unavailable');
                    onTestFinished(() => replay.dispose?.());
                    Object.assign(context, { authority: rootApproval ? 'present_user' : 'account_automation', machineAdmission: undefined,
                        verifyMachineAdmissionCurrent: undefined });
                    Object.assign(context, { externalActionExecutionAuthorization: scenario === 'root source missing proof'
                        ? Object.defineProperties({ ...replay.authorization }, Object.getOwnPropertyDescriptors(replay.authorization))
                        : replay.authorization });
                    environment.content.definition = { kind: 'repository', ref: 'main', compose: rootSourceIntent.compose };
                    put(environment.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, environment.content);
                    const rootContent = { ...candidate.content, sourceIntent: rootSourceIntent };
                    put(candidate.input.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, rootContent);
                    put(receipt.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, rootContent);
                    if (rootApproval) {
                        expect(readRequesterAccountActionContext(replay.authorization)).not.toBeNull();
                        const pending = await executor.execute('deployments.deploy', rootInput, { ...context, interactivePresentation: undefined,
                            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {
                                'deployments.deploy': { approvalRequiredSurfaces: ['cli'] } } }) });
                        expect(pending, JSON.stringify(pending)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
                        if (!pending.ok) throw new Error('Expected deployment approval');
                        const created = z.object({ kind: z.literal('approval_request_created'), artifactId: z.string() }).parse(pending.result);
                        const decideInput = { artifactId: created.artifactId, decision: 'approve', serverIdentityId: 'home', originServerId: 'home' };
                        const decideEnvelope = { v: 1 as const, requestId: 'root-upload-decision', target, input: decideInput };
                        const decideAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'decision-proof', binding: {
                            serverIdentityId: 'home', accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
                            custodianAccountId: authorization.binding.custodianAccountId, admittedMachineRole: authorization.binding.admittedMachineRole,
                            machineId: 'machine-a', installationId: 'installation-a', accountEncryptionMode: 'plain', target,
                            actionId: 'approval.request.decide', requestId: decideEnvelope.requestId,
                            approvalDecisionAdmission: projectExternalActionApprovalDecisionAdmissionV1(decideInput),
                            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(decideEnvelope) } });
                        sourceRequesters.length = 0;
                        const decided = await executeExternalAction({ actionId: 'approval.request.decide', envelope: decideEnvelope,
                            executionAuthorization: decideAuthorization, surface: 'ui', principal: { accountId: 'owner',
                                authentication: { kind: 'account', tokenEpoch: 1 }, authority: 'present_user' },
                            currentMachineId: 'machine-a', currentAccountId: 'owner', currentServerId: 'home',
                            currentServerHttpBaseUrl: 'https://platform.test', currentInstallationId: 'installation-a',
                            externalActionMachineRequestPrivateKey: identity.secretKey, resolveTarget,
                            // Home verification is the HTTP boundary; admission and replay remain real.
                            verifyExecutionAuthorization: async () => true, executor,
                            prepareRequesterAccountContext: input => prepareRequesterAccountActionContext({ ...input,
                                purpose: { kind: 'external_action' }, machineId: 'machine-a', installationId: 'installation-a',
                                installationPrivateKey: identity.secretKey, serverId: 'home', serverIdentityId: 'home',
                                serverHttpBaseUrl: 'https://platform.test', ownCredentials: credentials,
                                isCurrent: async () => requesterCurrent, createExecutor: () => executor }) });
                        expect(decided, JSON.stringify({ decided, sourceRequesters })).toMatchObject({ kind: 'response' });
                        const settled = await rootApprovalStore.approvalsGet({ artifactId: created.artifactId });
                        // This fixture has no SCM runtime. Both ROOT preparation and the
                        // real Upload child must resolve custody before that OS boundary.
                        expect(settled, JSON.stringify({ decided, sourceRequesters, childResult })).toMatchObject({ status: 'failed', execution: { ok: false } });
                        expect(sourceRequesters.length, JSON.stringify({ sourceRequesters, childResult })).toBeGreaterThan(0);
                        if (rootApprovalHomeUnavailable) expect(childResult, JSON.stringify(childResult)).toMatchObject({
                            ok: false, errorCode: 'agent_isolation_unavailable', details: { details: sourceAdmission },
                            failureCause: { phase: 'deployment.source.admission.requester_authority_unavailable' } });
                        else expect(childResult, JSON.stringify(childResult)).not.toMatchObject({ errorCode: 'agent_isolation_unavailable' });
                        expect(sourceRequesters.every(item => item.identity.kind !== 'unknown' && item.hasAccountContext && item.sameHomeUrl)).toBe(true);
                        expect(childInvocations, JSON.stringify({ execution: settled && 'execution' in settled ? settled.execution : undefined, sourceRequesters })).toBe(1);
                        return;
                    }
                    if (scenario === 'root source custodian') {
                        const admitted = await deps.prepareDeploymentAction({ actionId: 'deployments.deploy',
                            input: candidate.input, context });
                        expect(admitted, JSON.stringify(admitted)).toHaveProperty('input', candidate.input);
                        return;
                    }
                    const result = await executor.execute('deployments.deploy', candidate.input, context);
                    if (rootSourceForeign) {
                        expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'action_forbidden' });
                        expect(reserved).toBe(false);
                        expect(childInvocations).toBe(0);
                        expect(providerSends).toBe(0);
                        return;
                    }
                    const diagnostic = sourceAdmission;
                    expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'agent_isolation_unavailable' });
                    expect(reserved).toBe(false);
                    expect(childInvocations).toBe(0);
                    expect(providerSends).toBe(0);
                    const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'executing', createdAtMs: 1, updatedAtMs: 2,
                        createdBy: { surface: 'cli' }, requestedSurface: 'ui', actionId: 'deployments.deploy',
                        actionArgs: candidate.input, summary: 'Deploy repository upload',
                        executionOriginV1: { v: 1, authority: 'account_automation', surface: 'ui', caller: { kind: 'host' },
                            serverId: 'home', serverIdentityId: 'home', accountId: 'owner', machineId: 'machine-a', target,
                            actionId: 'deployments.deploy', requestId: 'platform-request' },
                        decision: { kind: 'approve', decidedAtMs: 2 } });
                    const settled = projectSettledApprovalExecution({ request, actionId: 'deployments.deploy',
                        exec: result, dispatchEffectAttempted: true, executedAtMs: 3 });
                    const artifactId = 'root-source-refusal-approval';
                    put(artifactId, 'approval_request.v1', settled.request);
                    documents.get(artifactId)!.header = encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(settled.request));
                    const approvalStore = createCliApprovalsArtifactStore({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://platform.test' });
                    const reader = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...approvalStore });
                    const observed = await runWithServerHttpBaseUrl('https://platform.test', () => reader.execute('approval.request.get',
                        { artifactId }, { ...ownerContext, surface: 'cli', authority: 'present_user', serverId: 'home' }));
                    expect(observed, JSON.stringify({ result, execution: settled.request.execution })).toMatchObject({ ok: true, result: { request: { execution: { ok: false,
                        errorCode: 'agent_isolation_unavailable', details: diagnostic,
                        failureCause: { phase: 'deployment.source.admission.requester_authority_unavailable' } } } } });
                    expect(result).toMatchObject({ details: diagnostic });
                    const opaque = projectSettledApprovalExecution({ request, actionId: 'deployments.deploy',
                        exec: { ok: false, errorCode: 'agent_isolation_unavailable', error: 'agent_isolation_unavailable',
                            details: { ...diagnostic, token: 'private-source-fixture' } }, dispatchEffectAttempted: true, executedAtMs: 3 });
                    expect(opaque.request.execution).not.toHaveProperty('details');
                    expect(JSON.stringify(observed)).not.toContain('private-source-fixture');
                    return;
                }
            }
            const scope = { accountId: 'owner', machineId: 'machine-a' };
            if (backgroundObservation) {
                const input = { serverId: 'home', environmentId: receipt.environmentId, deploymentId: receipt.id };
                if (sdkBackgroundObservation) {
                    // Home's HTTP boundary mints the root from the real SDK request;
                    // the real receiver opens its sealed plugin invocation below.
                    const sdkReceiver = createCliActionExecutorFromCredentials({ credentials, ...deps,
                        happyHomeDir: runtime.happyHomeDir,
                        serverId: 'home', serverApiUrl: 'https://platform.test', serverIdentityId: 'home', machineId: 'machine-a',
                        pluginActionExecutionOwner: 'current_process',
                        actionsSettingsProvider: createActionSettingsProvider({ allowEnvironmentOverride: false }),
                        listContributedActionDefinitions: selection => listRuntimeContributedActionDefinitions(runtime.registry, selection),
                        invokeContributedAction: invoke });
                    const machine = { id: 'machine-a', active: true, kind: 'persistent', revokedAt: null,
                        replacedByMachineId: null, installationId: 'installation-a',
                        installationPublicKey: Buffer.from(identity.publicKey).toString('base64'),
                        access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage',
                            resourceMode: 'plain', accessState: 'ready' } };
                    const getHttp = vi.mocked(axios.get).getMockImplementation()!;
                    vi.mocked(axios.get).mockImplementation(async (url, config) => {
                        const path = new URL(url).pathname;
                        if (path === '/v1/machines') return { status: 200, data: [machine] };
                        if (path === '/v1/machines/machine-a') return { status: 200, data: { machine } };
                        return getHttp(url, config);
                    });
                    const postHttp = vi.mocked(axios.post).getMockImplementation()!;
                    let rootAdmissions = 0;
                    let receivedPluginCalls = 0;
                    vi.mocked(axios.post).mockImplementation(async (url, value, config) => {
                        const path = new URL(url).pathname;
                        if (path === '/v1/plugins/availability/intents/read') return { status: 200,
                            data: PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 0,
                                hostingCapability: { enabled: false }, intent: null, release: null,
                                uiArtifacts: [], packageAssets: [] }) };
                        if (path.endsWith('/execution-authorization')) {
                            const proposal = ExternalActionExecutionAuthorizationRequestV1Schema.parse(value);
                            expect(proposal.machineId).toBe('machine-a');
                            rootAdmissions++;
                            observerRoots.set(`observer-root-${rootAdmissions}`, proposal.envelope.requestId!);
                            return { status: 200, data: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1,
                                token: `observer-root-${rootAdmissions}`, binding: {
                                    serverIdentityId: 'home', accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
                                    admittedMachineRole: 'manage', custodianAccountId: 'owner',
                                    machineId: 'machine-a', installationId: 'installation-a', actionId: 'deployments.receipts.observe',
                                    environmentId: receipt.environmentId, requestId: proposal.envelope.requestId, accountEncryptionMode: 'plain',
                                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(proposal.envelope), target: proposal.envelope.target } }) };
                        }
                        if (path.endsWith('/actions/deployments.receipts.observe')) {
                            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(value);
                            expect(request.executionAuthorization?.requesterAccountContext).toBeDefined();
                            const receiverInput = { actionId: 'deployments.receipts.observe',
                                envelope: request.envelope, executionAuthorization: request.executionAuthorization,
                                principal: { accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, authority: 'account_automation' },
                                currentMachineId: 'machine-a', currentAccountId: 'owner', currentServerId: 'home',
                                currentServerHttpBaseUrl: 'https://platform.test', currentInstallationId: 'installation-a',
                                externalActionMachineRequestPrivateKey: identity.secretKey,
                                resolveTarget: createDaemonExternalActionTargetResolver({ credentials, serverApiUrl: 'https://platform.test' }),
                                verifyExecutionAuthorization: async () => true, executor,
                                prepareRequesterAccountContext: input => prepareRequesterAccountActionContext({ ...input,
                                    purpose: { kind: 'external_action' }, machineId: 'machine-a', installationId: 'installation-a',
                                    installationPrivateKey: identity.secretKey, serverId: 'home', serverIdentityId: 'home',
                                    serverHttpBaseUrl: 'https://platform.test', ownCredentials: credentials, isCurrent: async () => true,
                                    createExecutor: () => ({ execute: async (actionId, input, context) => {
                                        expect(context?.surface).toBe('plugin');
                                        expect(context?.actionCaller).toMatchObject({ kind: 'plugin', pluginId,
                                            contributionLocalId: 'observer' });
                                        receivedPluginCalls++;
                                        return sdkReceiver.execute(actionId, input, context);
                                    } }) }) } satisfies Parameters<typeof executeExternalAction>[0];
                            const refused = await executeExternalAction({ ...receiverInput, currentMachineId: 'replacement-controller' });
                            expect(refused).toMatchObject({ kind: 'invalid_request',
                                errorCode: request.envelope.v === 2 ? 'invalid_encrypted_envelope' : 'invalid_envelope' });
                            const result = await executeExternalAction(receiverInput);
                            if (result.kind !== 'response') throw new Error('Expected settled Home delivery');
                            return { status: 200, data: result.response };
                        }
                        return postHttp(url, value, config);
                    });
                    releaseSdkHome();
                    runtime.registry.startAdoptedBackgroundServices?.();
                    const module = runtime.modulesByPluginId.get(pluginId);
                    if (!module || !('readBackgroundProbe' in module) || typeof module.readBackgroundProbe !== 'function') throw new Error('Missing SDK runner probe');
                    if (!('waitForBackgroundCompletion' in module) || typeof module.waitForBackgroundCompletion !== 'function')
                        throw new Error('Missing SDK runner completion');
                    await module.waitForBackgroundCompletion();
                    expect(module.readBackgroundProbe(), JSON.stringify({
                        probe: module.readBackgroundProbe(), rootAdmissions, receivedPluginCalls,
                        posts: vi.mocked(axios.post).mock.calls.map(([url]) => new URL(url).pathname),
                        gets: vi.mocked(axios.get).mock.calls.map(([url]) => new URL(url).pathname),
                    })).toMatchObject({ results: [
                        { ok: true, state: 'queued' }, { ok: true, state: 'succeeded' }, { ok: true, state: 'succeeded' }] });
                    expect(rootAdmissions).toBe(3);
                    expect(receivedPluginCalls).toBe(3);
                    expect(transitionWrites).toBe(1);
                    expect(providerSends).toBe(0);
                    expect(reserved).toBe(false);
                    expect(receipt.state).toBe('succeeded');
                    if (!('readObservationCount' in module) || typeof module.readObservationCount !== 'function') throw new Error('Missing provider observation probe');
                    expect(module.readObservationCount()).toBe(2);
                    return;
                }
                if (scenario === 'uncertain receipt observe') {
                    const first = await executor.execute('deployments.receipts.observe', input, context);
                    expect(first, JSON.stringify(first)).toMatchObject({ ok: true, result: { state: 'queued' } });
                    const observed = await executor.execute('deployments.receipts.observe', input, context);
                    expect(observed, JSON.stringify(observed)).toMatchObject({ ok: true, result: { state: 'succeeded' } });
                    expect(receipt.state).toBe('succeeded');
                    expect(transitionWrites).toBe(2);
                    const stored = decodePlainArtifactStoredContent(String(documents.get(receipt.contentArtifactId)!.body));
                    const content = DeploymentPlatformContentV1Schema.parse(JSON.parse(z.object({ body: z.string() }).parse(stored).body));
                    expect(content).not.toHaveProperty('failure');
                    expect(content).not.toHaveProperty('actor');
                    expect(reserved).toBe(false);
                    expect(providerSends).toBe(0);
                    return;
                }
                const observationContext = context;
                const controllerMachineId = environment.environment.controllerMachineId;
                environment.environment.controllerMachineId = 'replacement-controller';
                const reassigned = await executor.execute('deployments.receipts.observe', input, observationContext);
                expect(reassigned).toMatchObject({ ok: false, errorCode: 'machine_unavailable' });
                expect(transitionWrites).toBe(0);
                environment.environment.controllerMachineId = controllerMachineId;
                const unchanged = await executor.execute('deployments.receipts.observe', input, observationContext);
                expect(unchanged, JSON.stringify(unchanged)).toMatchObject({ ok: true, result: { state: 'queued' } });
                expect(transitionWrites).toBe(0);
                const result = await executor.execute('deployments.receipts.observe', input, observationContext);
                expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { state: 'succeeded', deploymentId: receipt.id } });
                expect(reserved).toBe(false);
                expect(transitionWrites).toBe(1);
                expect(providerSends).toBe(0);
                expect(receipt.state).toBe('succeeded');
                const repeated = await executor.execute('deployments.receipts.observe', input, observationContext);
                expect(repeated, JSON.stringify(repeated)).toMatchObject({ ok: true, result: { state: 'succeeded' } });
                expect(transitionWrites).toBe(1);
                const ownServer = createDeploymentEnvironmentDetailV1().targetLinks[0];
                row.targetLink = ownServer.targetLink;
                row.content = ownServer.content;
                put(row.targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, row.content);
                const receiptDocument = documents.get(receipt.contentArtifactId);
                if (!receiptDocument) throw new Error('Settled receipt document missing');
                receiptDocument.body = encodePlainArtifactStoredContent({
                    body: JSON.stringify(createDeploymentReceiptDetailV1().content) });
                expect(await executor.execute('deployments.receipts.observe', input, observationContext))
                    .toMatchObject({ ok: false, errorCode: 'unsupported_action', details: {
                        reason: 'target_not_supported', targetKind: 'ownServer', requiredFact: 'providerDeploymentObservation',
                        supportedAction: 'deployments.receipts.get', remedy: expect.stringMatching(/\S/),
                    } });
                expect(transitionWrites).toBe(1);
                return;
            }
            const invokeRoot = () => operations.runActionOperation({ actionId: 'deployments.deploy', input: candidate.input,
                context: { ...context, actionRequestId: 'platform-request' },
                execute: operationContext => executor.execute('deployments.deploy', candidate.input, operationContext) });
            const logWarnings = controllerLogWriteFailure ? vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {}) : undefined;
            stageLogWriteBoundary.diskFull = controllerLogWriteFailure;
            const result = await invokeRoot();
            stageLogWriteBoundary.diskFull = false;
            expect(reserved, JSON.stringify(result)).toBe(!requiresChildApproval);
            if (controllerBuildOutput) {
                if (controllerBuildFailure) expect(result, JSON.stringify(result)).toMatchObject({ ok: false, errorCode: 'deployment_failed', details: { failure: { phase: 'build' } } });
                else expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
                const stored = documents.get(receipt.contentArtifactId)!;
                const body = decodePlainArtifactStoredContent(String(stored.body));
                if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string')
                    throw new Error('Expected the retained failed receipt');
                const persisted = DeploymentPlatformContentV1Schema.parse(JSON.parse(body.body));
                if (controllerBuildFailure) expect(persisted.platform.observation).not.toHaveProperty('providerDeploymentId');
                else expect(persisted.platform.observation.providerDeploymentId).toBe('provider-deployment');
                if (controllerLogWriteFailure) {
                    expect(receipt.state).toBe('succeeded');
                    expect(persisted.failure).toBeUndefined();
                    expect(logWarnings).toHaveBeenCalledWith('[Deployment] Stage log write failed', expect.objectContaining({
                        errorCode: 'ENOSPC',
                    }));
                    expect(logWarnings).toHaveBeenCalledWith('[Deployment] Controller build log unavailable', expect.objectContaining({
                        errorCode: 'deployment_log_unavailable',
                    }));
                    expect(childInvocations).toBe(1);
                    return;
                }
                expect(persisted.platform.stageLogs?.[0]?.excerpt?.text).toContain('controller build stdout\n');
                expect(persisted.platform.stageLogs?.[0]?.excerpt?.text).toContain('controller build stderr\n');
                const readInput = { serverId: 'home', environmentId: receipt.environmentId, deploymentId: receipt.id,
                    targetLinkId: receipt.targetLinkId, kind: 'build' as const, machineId: 'machine-a', installationId: 'installation-a' };
                const page = await executor.execute('deployments.logs.read', readInput, { ...ownerContext, surface: 'cli', authority: 'present_user',
                    actionCaller: { kind: 'host' }, runtimeAccountId: 'owner', serverId: 'home', serverIdentityId: 'home' });
                expect(page, JSON.stringify(page)).toMatchObject({ ok: true, result: { logs: { kind: 'page', page: {
                    text: expect.stringContaining('controller build stdout\n'),
                } } } });
                expect(JSON.stringify(page)).toContain('controller build stderr\\n');
                expect(childInvocations).toBe(1);
                expect(providerSends).toBe(0);
                return;
            }

            if (scenario === 'admission cause retained approval' || roleFails) {
                const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'executing', createdAtMs: 1, updatedAtMs: 2,
                    createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'deployments.deploy',
                    actionArgs: candidate.input, summary: 'Deploy reviewed upload',
                    executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
                        serverId: 'home', serverIdentityId: 'home', accountId: 'owner', machineId: 'machine-a',
                        target: { kind: 'machine', machineId: 'machine-a' },
                        actionId: 'deployments.deploy', requestId: 'platform-request' },
                    decision: { kind: 'approve', decidedAtMs: 2 } });
                const settled = projectSettledApprovalExecution({ request, actionId: 'deployments.deploy',
                    exec: result, dispatchEffectAttempted: true, executedAtMs: 3 });
                const artifactId = 'upload-diagnostic-approval';
                put(artifactId, 'approval_request.v1', settled.request);
                documents.get(artifactId)!.header = encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(settled.request));
                const approvalStore = createCliApprovalsArtifactStore({ credentials, serverId: 'home',
                    serverHttpBaseUrl: 'https://platform.test' });
                const reader = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...approvalStore });
                const observed = await runWithServerHttpBaseUrl('https://platform.test', () => reader.execute('approval.request.get',
                    { artifactId }, { ...ownerContext, surface: 'cli', authority: 'present_user', serverId: 'home' }));
                if (roleFails) {
                    expect(childResult).toMatchObject({ ok: false, errorCode: roleErrorCode,
                        details: { details: sourceAdmissionFailure ? sourceAdmission : { phase: 'send' } } });
                    const stored = documents.get(receipt.contentArtifactId)!;
                    const body = decodePlainArtifactStoredContent(String(stored.body));
                    if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string')
                        throw new Error('Expected the written receipt body');
                    const recovery = sourceAdmissionFailure ? sourceAdmission : {
                        requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/) };
                    expect(DeploymentPlatformContentV1Schema.parse(JSON.parse(body.body)).failure).toMatchObject({
                        code: roleErrorCode, phase: 'send', requiredFact: recovery.requiredFact, remedy: recovery.remedy,
                        ...(sourceAdmissionFailure ? { sourceAdmission } : {}) });
                    expect(observed).toMatchObject({ ok: true, result: { request: { status: 'failed', execution: {
                        ok: false, errorCode: roleErrorCode, details: { failure: {
                            code: roleErrorCode, phase: 'send', requiredFact: recovery.requiredFact, remedy: recovery.remedy,
                            ...(sourceAdmissionFailure ? { sourceAdmission } : {}) } } } } } });
                    expect(childInvocations).toBe(1);
                    expect(providerSends).toBe(0);
                    return;
                }
                expect(observed).toMatchObject({ ok: true, result: { request: { status: 'failed', execution: {
                    ok: false, effectAttempted: false, errorCode: 'deployment_access_denied',
                    failureCause: { phase: 'deployment.target.admission.receipt.provider_identity',
                        errorClass: 'Error', errorCode: null, httpStatus: null } } } } });
                expect(JSON.stringify(observed)).not.toContain('private-substituted-project');
                expect(childInvocations).toBe(0);
                expect(providerSends).toBe(0);
                return;
            }
            const childSucceeds = scenario === 'reviewed child' || scenario === 'upload source' || scenario === 'retained receipt observe';
            if (scenario === 'upload source') {
                expect(childResult, JSON.stringify(childResult)).toMatchObject({ ok: true });
                await expect(invoke({ action: { pluginId, localId: 'source-check' }, input: {},
                    context: { surface: 'cli' } })).resolves.toMatchObject({ ok: true, result: { checked: true } });
            }
            if (childSucceeds || settlementPointerChanged) {
                expect(settlementReads).toEqual({ metadata: 1, environmentBodies: 0, targetBodies: 0 });
                if (settlementPointerChanged) {
                    expect(childResult).toMatchObject({ ok: true });
                    expect(transitionWrites).toBe(0);
                }
            }
            if (childSucceeds) {
                expect(childResult).toMatchObject({ ok: true, result: { v: 1, state: 'succeeded',
                    providerDeploymentId: scenario === 'retained receipt observe' ? 'existing-provider-deployment' : 'provider-deployment' } });
                expect(transitionWrites).toBe(1);
            }
            if (childSucceeds) {
                const stored = documents.get(receipt.contentArtifactId);
                if (!stored) throw new Error('Expected the existing receipt Artifact');
                const body = decodePlainArtifactStoredContent(String(stored.body));
                if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') {
                    throw new Error('Expected the written receipt body');
                }
                const persisted = DeploymentPlatformContentV1Schema.parse(JSON.parse(body.body));
                if (scenario === 'upload source') expect(persisted).toHaveProperty('actor', { actorKind: 'person', accountId: 'owner' });
                if (scenario === 'retained receipt observe') expect(persisted).toHaveProperty('actor', {
                    actorKind: 'agent', sessionId: 'original-session',
                    onBehalfOf: { serverId: 'original-home', accountId: 'original-requester' } });
                expect(persisted.steps).toContainEqual(expect.objectContaining({ streamRef: 'masked-provider-stream' }));
                expect(persisted.platform.observation.urls).toEqual(['https://app.example.test']);
                if (scenario === 'retained receipt observe') expect(persisted.platform.observation.uploadProvenance)
                    .toEqual({ sourceManifestFingerprint: 'approved-manifest', build: { location: 'provider' } });
            }
            if (childSucceeds) expect(result).not.toHaveProperty('errorCode');
            expect(result).toMatchObject(childSucceeds ? { ok: true } : { ok: false,
                errorCode: scenario === 'requester revoked' ? 'action_forbidden'
                    : settlementPointerChanged ? 'outcome_unknown'
                    : roleFails ? roleErrorCode
                        : requiresChildApproval ? 'action_interactive_review_required' : 'deployment_conflict' });
            expect(childInvocations).toBe(childSucceeds || settlementPointerChanged || roleFails ? 1 : 0);
            expect(providerSends).toBe(0);
            if (childSucceeds) {
                await expect(invokeRoot()).resolves.toEqual(result);
                expect(childInvocations).toBe(1);
            }
            if (scenario === 'receipt source differs') {
                // The Environment revision advanced on reservation. Re-execution
                // is a fresh admission after a proven no-effect refusal, and now
                // conflicts before any provider work.
                expect(environment.environment.revision).not.toBe(candidate.input.expectedRevision);
                await expect(invokeRoot()).resolves.toMatchObject({ ok: false, errorCode: 'deployment_conflict',
                    effectAttempted: false });
                expect(childInvocations).toBe(0);
                expect(providerSends).toBe(0);
            }
        } finally { await requesterPreparation?.dispose(); await runtime.dispose(); }
    });
    it('returns native named-volume backup choices through the public defaults preview before a target exists', async () => {
        const mounted = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
        const serverHttpBaseUrl = 'https://backup-first-configure.test';
        const settings = await persistence.readSettings();
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ ...settings, servers: { home: {
            id: 'home', name: 'Home', serverUrl: serverHttpBaseUrl, webappUrl: serverHttpBaseUrl,
            createdAt: 1, updatedAt: 1, homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_backup_home',
                canonicalServerUrl: serverHttpBaseUrl, revision: 1, endpoints: [{ kind: 'https', url: serverHttpBaseUrl }] }),
        } } });
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const credentials: StoredCredentials = { token, encryption: null };
        const operation = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createInvocationSavedSecretOperationContextV1({
            credentials, serverHttpBaseUrl, isCurrent: async () => true,
            snapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
                loadedAtMs: 1, scopeKey: resolveAccountSettingsScopeKey(credentials), settingsSecretsReadKeys: [] },
        }));
        const detail = createDeploymentEnvironmentDetailV1();
        detail.environment.runtimeTargetLinkId = undefined;
        detail.environment.buildMachineId = undefined;
        detail.targetLinks = [];
        const document = 'services:\n  web:\n    image: app\n    volumes:\n      - content:/srv/content\n      - content:/srv/mirror:ro\nvolumes:\n  content:\n    name: physical-content\n';
        detail.content.definition = { kind: 'stored', contentRevision: 1, document,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: [] };
        const root = await mkdtemp(join(tmpdir(), 'happier-backup-default-preview-'));
        const docker = await createOwnServerDockerBoundary(join(root, 'bin'));
        vi.stubEnv('PATH', `${join(root, 'bin')}${delimiter}${process.env.PATH ?? ''}`);
        const keys = tweetnacl.sign.keyPair();
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'installation-a', createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'),
            privateKey: Buffer.from(keys.secretKey).toString('base64url') });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(String(request.url)).pathname;
            expect(request.method).toBe('GET');
            if (path === `/v1/deployments/environments/${detail.environment.id}`) return { status: 200,
                data: { ok: true, environment: detail.environment, secretScope: detail.secretScope, targetLinks: [] } };
            if (path === `/v1/projects/sources/${detail.environment.projectSourceId}`) return { status: 200,
                data: { ok: true, canManage: true, source: { id: detail.environment.projectSourceId, revision: 6,
                    name: 'App', owner: { kind: 'account', accountId: 'owner' }, audience: [], createdByAccountId: 'owner' } } };
            if (path === `/v1/projects/${detail.environment.projectSourceId}/deployment-defaults`) return { status: 200,
                data: { ok: true, projectSourceId: detail.environment.projectSourceId, sourceRevision: 6, revision: 0, content: null } };
            throw new Error(`Unexpected backup preview transport ${path}`);
        });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            expect(new URL(url).pathname).toBe(`/v1/artifacts/${detail.environment.contentArtifactId}`);
            return { status: 200, data: { id: detail.environment.contentArtifactId, ownerAccountId: 'owner', access: 'owner',
                publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Backup preview' }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(detail.content) }),
                headerVersion: detail.environment.contentHeaderVersion, bodyVersion: detail.environment.contentBodyVersion,
                seq: 1, createdAt: 1, updatedAt: 1 } };
        });
        const runtime = createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'home', serverHttpBaseUrl,
            machineId: 'machine-a', resolveRequesterIdentity: resolveOwnerRequesterIdentity,
            async acquirePluginRuntimeRegistryLease() { throw new Error('Backup definition review must not acquire the runtime registry'); },
            async readEnvironmentSecretLaunchAdmission() { throw new Error('Backup definition review must not acquire launch secrets'); } });
        const deps = createDaemonDeploymentActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl,
            machineId: 'machine-a', resolveRequesterIdentity: resolveOwnerRequesterIdentity,
            savedSecretOperationContext: operation, runtime });
        try {
            const result = await deps.deploymentAction('deployments.environments.update', { serverId: 'home',
                environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
                contentArtifactId: detail.environment.contentArtifactId, contentHeaderVersion: detail.environment.contentHeaderVersion,
                contentBodyVersion: detail.environment.contentBodyVersion, mode: 'preview', defaultsFor: 'backups' }, ownerContext);
            expect(result).toMatchObject({ ok: true, backupSourceChoices: [
                { kind: 'volume', sourceId: expect.any(String), service: 'web', volume: 'content', consistency: 'stopDuringCopy' },
            ] });
            expect((await docker.readInvocations()).some(call => call.args.includes('config'))).toBe(true);
        } finally { try { await rm(root, { recursive: true, force: true }); } finally { await mounted.dispose(); } }
    });

    it('returns a typed refusal when a Home read inside a defaults preview is refused, not an unknown outcome', async () => {
        const serverHttpBaseUrl = 'https://backup-preview-refusal.test';
        const settings = await persistence.readSettings();
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ ...settings, servers: { home: {
            id: 'home', name: 'Home', serverUrl: serverHttpBaseUrl, webappUrl: serverHttpBaseUrl,
            createdAt: 1, updatedAt: 1, homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_backup_home',
                canonicalServerUrl: serverHttpBaseUrl, revision: 1, endpoints: [{ kind: 'https', url: serverHttpBaseUrl }] }),
        } } });
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const credentials: StoredCredentials = { token, encryption: null };
        const detail = createDeploymentEnvironmentDetailV1();
        // The preview is read-only: a refused preparation read proves no effect ran (J29, #130).
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(String(request.url)).pathname;
            if (path === `/v1/deployments/environments/${detail.environment.id}`) return { status: 200,
                data: { ok: true, environment: detail.environment, secretScope: detail.secretScope, targetLinks: [] } };
            return { status: 401, data: { error: 'invalid_token', authorizationRefusal: 'verification_purpose' } };
        });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            return { status: 401, data: { error: 'invalid_token', authorizationRefusal: 'verification_purpose' } };
        });
        const deps = createDaemonDeploymentActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl,
            machineId: 'machine-a', resolveRequesterIdentity: resolveOwnerRequesterIdentity,
            runtime: { async acquire() { throw new Error('Defaults preview cannot acquire native custody'); } } });
        const result = await deps.deploymentAction('deployments.environments.update', { serverId: 'home',
            environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
            contentArtifactId: detail.environment.contentArtifactId, contentHeaderVersion: detail.environment.contentHeaderVersion,
            contentBodyVersion: detail.environment.contentBodyVersion, mode: 'preview', defaultsFor: 'backups' }, ownerContext);
        expect(result).toMatchObject({ ok: false });
        expect(result).not.toMatchObject({ errorCode: 'action_outcome_unknown' });
    });

    it.each(['compact', 'prepared'] as const)('refuses unresolved template secret readiness before %s Deploy native effects', async entry => {
        const environment = createDeploymentEnvironmentDetailV1();
        environment.environment.buildMachineId = 'machine-a';
        const receipt = createDeploymentReceiptDetailV1();
        const documents = new Map<string, { kind: string; content: unknown }>();
        documents.set(environment.environment.contentArtifactId, { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, content: environment.content });
        for (const row of environment.targetLinks) documents.set(row.targetLink.contentArtifactId,
            { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, content: row.content });
        documents.set(receipt.deployment.contentArtifactId, { kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, content: receipt.content });
        let scope = { status: 'unavailable', reason: 'secret_scope_requirements_unavailable', requiredGrantCount: 0, missingGrantCount: 0 };
        let omitScope = true;
        const writes: unknown[] = [];
        // Home HTTP and native acquisition are genuine boundaries; admission and private Artifact decoding stay real.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
            const document = documents.get(id);
            if (!document) return { status: 404, data: {} };
            return { status: 200, data: { id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent({ kind: document.kind, title: 'Template' }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(document.content) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
            writes.push({ url, body }); throw new Error('Unresolved bindings cannot write candidates');
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (request.method !== 'GET') { writes.push(request); throw new Error('No native mutation'); }
            const path = new URL(request.url!).pathname;
            if (path.endsWith('/deployments')) return { status: 200, data: { ok: true, items: [], nextCursor: null } };
            if (path.endsWith(`/receipts/${receipt.deployment.id}`)) return { status: 200, data: { ok: true, deployment: receipt.deployment } };
            return { status: 200, data: { ok: true, environment: environment.environment,
                targetLinks: environment.targetLinks.map(row => row.targetLink), ...(omitScope ? {} : { secretScope: scope }) } };
        });
        let acquisitions = 0;
        const acquire = async (): Promise<never> => {
            acquisitions++; throw createActionExecuteFailureError({ ok: false, error: 'native_acquisition_reached', errorCode: 'native_acquisition_reached' });
        };
        const deps = createDaemonDeploymentActionDeps({ credentials: { token: 'fixture', encryption: null },
            serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
            resolveRequesterIdentity: resolveOwnerRequesterIdentity, runtime: { acquire, acquireCandidate: acquire } });
        const execute = () => deps.prepareDeploymentAction({ actionId: 'deployments.deploy', context: ownerContext,
            input: { serverId: 'home', environmentId: environment.environment.id,
                ...(entry === 'prepared' ? { expectedRevision: environment.environment.revision,
                    targetLinkId: environment.targetLinks[0]!.targetLink.id,
                    expectedTargetLinkRevision: environment.targetLinks[0]!.targetLink.revision,
                    contentArtifactId: receipt.deployment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 } : {}),
                requestKey: 'template-readiness' } });
        expect(await execute()).toMatchObject({ ok: false, errorCode: 'secret_scope_requirements_unavailable' });
        expect(acquisitions).toBe(0);
        omitScope = false;
        expect(await execute()).toMatchObject({ ok: false, errorCode: 'secret_scope_requirements_unavailable' });
        expect(acquisitions).toBe(0);
        expect(writes).toEqual([]);
        scope = { ...scope, status: 'actionNeeded', reason: 'secret_scope_grants_required', requiredGrantCount: 1, missingGrantCount: 1 };
        expect(await execute()).toMatchObject({ ok: false, errorCode: 'secret_scope_grants_required' });
        expect(acquisitions).toBe(0);
        scope = { ...scope, status: 'ready', reason: 'secret_scope_current', missingGrantCount: 0 };
        expect(await execute()).toMatchObject({ ok: false, errorCode: 'native_acquisition_reached' });
        expect(acquisitions).toBe(1);
    });

    it('prepares first-configuration choices through the existing update Action without writing or opening Environment content', async () => {
        const serverHttpBaseUrl = 'https://first-configure.test';
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const credentials: StoredCredentials = { token, encryption: null };
        const operation = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createInvocationSavedSecretOperationContextV1({
            credentials, serverHttpBaseUrl, isCurrent: async () => true,
            snapshot: { source: 'network', settings: accountSettingsParse({ deploymentDefaultsV1: {
                previewMachineId: 'preview-host', previewDatabase: 'branch', backupRetention: { kind: 'keep', daily: 14 },
            } }), settingsVersion: 1, loadedAtMs: 1, scopeKey: resolveAccountSettingsScopeKey(credentials), settingsSecretsReadKeys: [] },
        }));
        const detail = createDeploymentEnvironmentDetailV1();
        const link = detail.targetLinks[0]!.targetLink;
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(String(request.url)).pathname;
            expect(request.method).toBe('GET');
            if (path === `/v1/deployments/environments/${detail.environment.id}`) return { status: 200,
                data: { ok: true, environment: detail.environment, secretScope: detail.secretScope, targetLinks: [link] } };
            if (path === `/v1/projects/sources/${detail.environment.projectSourceId}`) return { status: 200,
                data: { ok: true, canManage: true, source: { id: detail.environment.projectSourceId, revision: 6,
                    name: 'App', owner: { kind: 'account', accountId: 'owner' }, audience: [], createdByAccountId: 'owner' } } };
            if (path === `/v1/projects/${detail.environment.projectSourceId}/deployment-defaults`) return { status: 200,
                data: { ok: true, projectSourceId: detail.environment.projectSourceId, sourceRevision: 6, revision: 0, content: null } };
            throw new Error(`Unexpected first-configuration transport ${path}`);
        });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            throw new Error(`First configuration must not open Environment content: ${String(url)}`);
        });
        const deps = createDaemonDeploymentActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl,
            machineId: 'machine-a', resolveRequesterIdentity: resolveOwnerRequesterIdentity, savedSecretOperationContext: operation,
            runtime: { async acquire() { throw new Error('Review cannot acquire native execution'); } } });
        const input = { serverId: 'home', environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
            contentArtifactId: detail.environment.contentArtifactId, contentHeaderVersion: detail.environment.contentHeaderVersion,
            contentBodyVersion: detail.environment.contentBodyVersion, mode: 'preview' as const, defaultsFor: 'previews' as const };
        const result = await deps.deploymentAction('deployments.environments.update', input, ownerContext);
        expect(result).toMatchObject({ ok: true, environmentId: detail.environment.id, revision: detail.environment.revision,
            creationDefaults: { values: { previewMachineId: 'preview-host', previewDatabase: 'branch',
                backupRetention: { kind: 'keep', daily: 14 } }, sources: { previewMachineId: 'account', previewDatabase: 'account',
                backupRetention: 'account' } } });
        expect(await deps.deploymentAction('deployments.environments.update', { ...input,
            expectedRevision: input.expectedRevision + 1 }, ownerContext)).toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
    });

    it('prepares Team creation with the admitted Source audience rather than personal Account defaults', async () => {
        const serverHttpBaseUrl = 'https://team-create.test';
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const credentials: StoredCredentials = { token, encryption: null };
        const operation = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createInvocationSavedSecretOperationContextV1({
            credentials, serverHttpBaseUrl, isCurrent: async () => true,
            snapshot: { source: 'network', settings: accountSettingsParse({ deploymentDefaultsV1: {
                controllerMachineId: 'personal-controller', buildMachineId: 'personal-builder', retainPreviousDeployments: 7,
            } }), settingsVersion: 1, loadedAtMs: 1, scopeKey: resolveAccountSettingsScopeKey(credentials), settingsSecretsReadKeys: [] },
        }));
        const documents = new Map<string, Record<string, unknown>>();
        const grants = new Map<string, unknown>();
        const environmentWrites: unknown[] = [];
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(String(request.url)).pathname;
            if (request.method === 'GET' && path === '/v1/projects/sources/source') return { status: 200,
                data: { ok: true, canManage: true, source: { id: 'source', revision: 6, name: 'Team Project',
                    owner: { kind: 'team', teamId: 'source-team' }, audience: [], createdByAccountId: 'owner' } } };
            if (request.method === 'GET' && path === '/v1/projects/source/deployment-defaults') return { status: 200,
                data: { ok: true, projectSourceId: 'source', sourceRevision: 6, revision: 0, content: null } };
            if (request.method === 'POST' && path === '/v1/deployments/environments') environmentWrites.push(request.data);
            throw new Error('Team review must not write an Environment');
        });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            if (path === '/v1/account/encryption/currentness') return { status: 200,
                data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }) };
            const row = documents.get(decodeURIComponent(path.split('/').at(-1)!));
            if (!row) throw new Error('Unexpected Team create content read');
            return { status: 200, data: row };
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, value) => {
            expect(url).toBe(`${serverHttpBaseUrl}/v1/artifacts`);
            const mutation = readCarrierMutation(value); const id = String(mutation.id);
            documents.set(id, { ...mutation, id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                encryptionMode: 'plain', headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
        });
        vi.spyOn(axios, 'put').mockImplementation(async (url, value) => {
            const mutation = readCarrierMutation(value); const artifactId = String(mutation.artifactId);
            expect(url).toBe(`${serverHttpBaseUrl}/v1/artifacts/${artifactId}/access/grants`);
            grants.set(artifactId, { principal: mutation.principal, accessLevel: mutation.accessLevel });
            return { status: 200, data: { artifactId, ownerAccountId: 'owner', access: 'owner', changed: true,
                grants: [{ principal: mutation.principal, accessLevel: mutation.accessLevel, createdByAccountId: 'owner',
                    createdAt: 1, display: { name: null } }] } };
        });
        const deps = createDaemonDeploymentActionDeps({
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            credentials, serverId: 'home', serverHttpBaseUrl,
            machineId: 'runtime', savedSecretOperationContext: operation,
            runtime: { async acquire() { throw new Error('Review cannot acquire native execution'); } } });
        const result = await deps.prepareDeploymentEnvironmentCreate({ input: {
            serverId: 'home', projectSourceId: 'source', requestKey: 'team-create', name: 'App',
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            definition: { from: 'image', image: 'nginx:1', port: 80 },
            firstTargetLink: { machines: [{ machineId: 'runtime', installationId: 'installed-runtime' }] },
        }, context: ownerContextFor('runtime') });
        expect(result).toMatchObject({ input: { controllerMachineId: 'runtime', buildMachineId: 'runtime' },
            preview: { creationDefaults: { values: { retainPreviousDeployments: 1 },
                sources: { controllerMachineId: 'builtin', buildMachineId: 'builtin', retainPreviousDeployments: 'builtin' } } } });
        if ('errorCode' in result || !('contentArtifactId' in result.input) || !result.input.firstTargetLink
            || !('contentArtifactId' in result.input.firstTargetLink)) throw new Error('Expected protected Team preparation');
        for (const id of [result.input.contentArtifactId, result.input.firstTargetLink!.contentArtifactId]) {
            expect(grants.get(id)).toEqual({ principal: { kind: 'team', teamId: 'source-team' }, accessLevel: 'admin' });
        }
        expect(environmentWrites).toEqual([]);
    });

    it.each(['plain', 'e2ee'] as const)('withdraws captured %s Account custody during real create preparation before any Artifact or Environment write', async mode => {
        const serverHttpBaseUrl = 'https://create-retirement.test';
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null
            : { type: 'legacy', secret: new Uint8Array(32).fill(31) } };
        let current = true;
        const operation = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => createInvocationSavedSecretOperationContextV1({
            credentials, serverHttpBaseUrl, isCurrent: async () => current,
            snapshot: { source: 'network', settings: accountSettingsParse({ deploymentDefaultsV1: {
                controllerMachineId: 'project-controller', buildMachineId: 'project-builder', retainPreviousDeployments: 0,
            } }), settingsVersion: 1, loadedAtMs: 1, scopeKey: resolveAccountSettingsScopeKey(credentials), settingsSecretsReadKeys: [] },
        }));
        let sourceRead = false;
        let defaultsRead = false;
        let accountModeReads = 0;
        const artifactWrites: unknown[] = [];
        const environmentWrites: unknown[] = [];
        // Only authenticated HTTP is replaced. The installed daemon composition,
        // Source/default readers, resolver, normalizer, Account custody and
        // Artifact codecs/beforeWrite callbacks all run as production owners.
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const url = new URL(String(request.url));
            expect(url.origin).toBe(serverHttpBaseUrl);
            if (request.method === 'GET' && url.pathname === '/v1/projects/sources/source') {
                sourceRead = true;
                return { status: 200, data: { ok: true, canManage: true, source: {
                    id: 'source', revision: 6, name: 'Project', owner: { kind: 'account', accountId: 'owner' },
                    audience: [], createdByAccountId: 'owner',
                } } };
            }
            if (request.method === 'GET' && url.pathname === '/v1/projects/source/deployment-defaults') {
                defaultsRead = true;
                return { status: 200, data: { ok: true, projectSourceId: 'source', sourceRevision: 6, revision: 0, content: null } };
            }
            if (request.method === 'POST' && url.pathname === '/v1/deployments/environments') {
                environmentWrites.push(request.data);
                return { status: 200, data: { ok: true, environmentId: 'unexpected-create', revision: 1 } };
            }
            throw new Error('Unexpected create preparation HTTP request');
        });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const address = new URL(String(url));
            expect(address.origin).toBe(serverHttpBaseUrl);
            if (address.pathname !== '/v1/account/encryption') throw new Error('Unexpected create preparation GET');
            expect(sourceRead).toBe(true);
            expect(defaultsRead).toBe(true);
            // No defaults Artifact exists in this fixture. This is therefore
            // the real new-Artifact Account-mode read after source normalization,
            // immediately before the caller-supplied beforeWrite must re-admit.
            accountModeReads += 1;
            current = false;
            return { status: 200, data: { mode, updatedAt: 0 } };
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
            expect(String(url)).toBe(`${serverHttpBaseUrl}/v1/artifacts`);
            artifactWrites.push(body);
            const wire = readCarrierMutation(body);
            return { status: 200, data: { id: wire.id, headerVersion: 1, bodyVersion: 1 } };
        });
        const deps = createDaemonDeploymentActionDeps({
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            credentials, serverId: 'home', serverHttpBaseUrl,
            machineId: 'runtime', savedSecretOperationContext: operation,
            runtime: { async acquire() { throw new Error('Creation preparation must not acquire native execution'); } } });
        const result = await deps.prepareDeploymentEnvironmentCreate({ input: {
            serverId: 'home', projectSourceId: 'source', requestKey: 'retired-create', name: 'App',
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            definition: { from: 'image', image: 'nginx:1', port: 80 },
            firstTargetLink: { machines: [{ machineId: 'runtime', installationId: 'installed-runtime' }] },
        }, context: ownerContextFor('runtime') });
        expect(accountModeReads).toBeGreaterThan(0);
        expect(result).toMatchObject({ ok: false, errorCode: 'action_forbidden' });
        expect(artifactWrites).toEqual([]);
        expect(environmentWrites).toEqual([]);
        expect(operation.readSnapshot()).toBeNull();
    });

    it.each(['live', 'unknown', 'teardown', 'mismatched Artifact'] as const)('refreshes %s history through the canonical receipt before deriving member proof', async kind => {
        const environment = createDeploymentEnvironmentDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        if (kind === 'live') receipt.deployment.state = 'running';
        if (kind === 'unknown') receipt.deployment.state = 'outcome_unknown';
        if (kind === 'teardown') { receipt.deployment.operation = 'teardown'; receipt.deployment.state = 'failed'; }
        const listed = structuredClone(receipt.deployment);
        receipt.deployment.revision++;
        receipt.deployment.contentHeaderVersion++;
        receipt.deployment.contentBodyVersion++;
        let canonicalReads = 0;
        const documents = new Map<string, Record<string, unknown>>();
        const put = (id: string, artifactKind: string, content: unknown, version = 1) => documents.set(id, {
            id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind: artifactKind, title: 'History' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }),
            headerVersion: version, bodyVersion: version, seq: 1, createdAt: 1, updatedAt: 1,
        });
        put(environment.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, environment.content);
        for (const item of environment.targetLinks) put(item.targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, item.content);
        put(receipt.deployment.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, receipt.content, 2);
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
            return { status: documents.has(id) ? 200 : 404, data: documents.get(id) ?? {} };
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(request.url!).pathname;
            if (path.endsWith(`/receipts/${receipt.deployment.id}`)) {
                canonicalReads++;
                return { status: 200, data: { ok: true, deployment: receipt.deployment } };
            }
            if (path.endsWith('/deployments')) return { status: 200,
                data: DeploymentReceiptListResultV1Schema.parse({ ok: true, items: [listed], nextCursor: null }) };
            return { status: 200, data: { ok: true, environment: environment.environment, secretScope: environment.secretScope,
                targetLinks: environment.targetLinks.map(item => item.targetLink) } };
        });
        const deps = createDaemonDeploymentActionDeps({
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            credentials: { token: 'fixture', encryption: null },
            serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
            runtime: { async acquire() { throw new Error('Candidate acquisition is unavailable'); } } });
        // The absent native candidate capability settles only after history was
        // opened and its real version/schema checks admitted the current proof.
        await expect(deps.prepareDeployCandidate({ environmentId: environment.environment.id, context: ownerContext }))
            .resolves.toMatchObject({ ok: false, errorCode: 'unsupported' });
        expect(canonicalReads).toBe(1);
    });
    it.each(['review', 'member', 'queued member', 'member wrong target', 'member wrong operation', 'member wrong installation'] as const)('validates promotion operands at review and consumes the admitted receipt for native child %s', async kind => {
        const member = kind !== 'review';
        const destination = createDeploymentEnvironmentDetailV1();
        const source = createDeploymentEnvironmentDetailV1();
        source.environment.id = 'source'; source.environment.contentArtifactId = 'source-content';
        source.targetLinks[0].targetLink.environmentId = source.environment.id;
        const receipt = createDeploymentReceiptDetailV1();
        receipt.deployment.id = 'source-release'; receipt.deployment.environmentId = source.environment.id;
        const document = JSON.stringify({ services: { app: { image: 'example/app:source' } } });
        receipt.content.sourceIntent = { kind: 'stored', document, contentRevision: 2,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, services: ['app'], profiles: [] };
        source.content.definition = receipt.content.sourceIntent;
        destination.content.definition = { ...receipt.content.sourceIntent, contentRevision: 1 };
        const link = destination.targetLinks[0].targetLink;
        const content = { ...receipt.content, machines: link.machines, buildMachineId: destination.environment.buildMachineId!,
            machineResults: [], steps: [], sourceIntent: prepareStoredPromotionCandidate(receipt, destination).definition };
        const admitted = createDeploymentReceiptDetailV1();
        admitted.deployment = { ...admitted.deployment, id: 'parent-release', operation: 'promote', state: 'running',
            requestKey: 'promotion', contentArtifactId: 'candidate', actionOperationId: 'parent-operation' };
        if (member) {
            if (kind === 'queued member') admitted.deployment.state = 'queued';
            destination.environment.revision++;
            admitted.deployment = createDeploymentReceiptHeaderV1({ ...admitted.deployment, acceptedExecution: { v: 1,
                controller: { machineId: destination.environment.controllerMachineId, installationId: 'installation-a' },
                builder: { machineId: content.buildMachineId, installationId: 'installation-a' }} });
            destination.content.definition = content.sourceIntent;
            admitted.deployment.contentHeaderVersion = 2;
            admitted.deployment.contentBodyVersion = 2;
            admitted.content = { ...content, ownServer: { approvedInputBasis: { v: 1,
                environmentId: destination.environment.id, environmentRevision: 1, targetLinkId: link.id, targetLinkRevision: link.revision,
                sourceIntent: content.sourceIntent, manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'promotion',
                toolVersion: '2.39.4', services: ['app'], profiles: [], members: link.members.map(({ machineId, installationId }) => ({ machineId, installationId })),
                bindings: [], images: content.images } } };
        }
        if (kind === 'member wrong target') admitted.deployment.targetLinkId = 'another-target';
        if (kind === 'member wrong operation') admitted.deployment.operation = 'deploy';
        const documents = new Map<string, Readonly<Record<string, unknown>>>();
        const put = (id: string, kind: string, value: unknown) => documents.set(id, { id, ownerAccountId: 'owner', access: 'owner',
            publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind, title: 'Promotion' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(value) }), headerVersion: 1, bodyVersion: 1,
            seq: 1, createdAt: 1, updatedAt: 1 });
        put(destination.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, destination.content);
        // Promotion needs the source header and pinned receipt, not another
        // private Environment definition or its native runtime artifacts.
        for (const environment of [source, destination]) for (const item of environment.targetLinks) {
            put(item.targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, item.content);
        }
        put(receipt.deployment.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, receipt.content);
        put('candidate', DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, member ? admitted.content : content);
        if (member) documents.set('candidate', { ...documents.get('candidate')!, headerVersion: 2, bodyVersion: 2 });
        put('destination-candidate', DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
            { ...prepareStoredPromotionCandidate(receipt, destination), name: 'Controller-substituted destination' });
        let sourceReceiptReads = 0;
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            const path = new URL(request.url!).pathname;
            if (path.endsWith('/secret-launch-admission')) return { status: 200, data: { ok: true, grants: [] } };
            if (path.endsWith('/source-release')) {
                sourceReceiptReads++;
                if (member) throw Object.assign(new Error('source_receipt_unavailable'), { code: 'source_receipt_unavailable' });
                return { status: 200, data: { ok: true, deployment: receipt.deployment } };
            }
            if (path.endsWith('/parent-release')) return { status: 200, data: { ok: true, deployment: admitted.deployment } };
            const environment = path.endsWith('/source') ? source : destination;
            return { status: 200, data: { ok: true, environment: environment.environment, secretScope: environment.secretScope, targetLinks: environment.targetLinks.map(item => item.targetLink) } };
        });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
            return { status: documents.has(id) ? 200 : 404, data: documents.get(id) ?? {} };
        });
        const keys = tweetnacl.sign.keyPair();
        vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
            installationId: 'installation-a', createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'),
            privateKey: Buffer.from(keys.secretKey).toString('base64url') });
        const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
        const runtime = createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            machineId: 'machine-a', async acquirePluginRuntimeRegistryLease() {
                const lease = pluginReloadController.tryAcquireRuntimeRegistry();
                if (!lease) throw new Error('No installed native plugin runtime');
                return lease;
            } });
        const deps = createDaemonDeploymentActionDeps({
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            credentials, serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a', runtime });
        const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: member ? 'member' : 'review', actionId: 'deployments.promote',
            machineId: 'machine-a', installationId: kind === 'member wrong installation' ? 'another-installation' : 'installation-a',
            input: { serverId: 'home', environmentId: destination.environment.id,
                targetLinkId: link.id, expectedRevision: 1, expectedTargetLinkRevision: link.revision,
                requestKey: 'promotion', contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1,
                sourceEnvironmentId: source.environment.id, sourceDeploymentId: receipt.deployment.id,
                artifact: 'image', destinationContent: { contentArtifactId: 'destination-candidate', contentHeaderVersion: 1, contentBodyVersion: 1 } },
            ...(member ? { phase: 'activate', selectedDeploymentId: admitted.deployment.id, deploymentId: admitted.deployment.id,
                actionOperationId: admitted.deployment.actionOperationId} : {}) });
        const result = await deps.deploymentChild(job, {});
        if (member) {
            expect(sourceReceiptReads).toBe(0);
            if (kind === 'member wrong target' || kind === 'member wrong operation') {
                expect(result).toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
            } else if (kind === 'member wrong installation') {
                expect(result).toMatchObject({ ok: false, errorCode: 'target_mismatch' });
            } else expect(result).not.toMatchObject({ errorCode: 'source_receipt_unavailable' });
        } else {
            expect(result).toMatchObject({ ok: false, errorCode: 'target_mismatch' });
            expect(sourceReceiptReads).toBe(1);
        }
    });
    it('reopens the canonical receipt before accepting a child operation reference', async () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        let acquisitions = 0;
        vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true, deployment: receipt.deployment } });
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            return { status: 200, data: { id: receipt.deployment.contentArtifactId, ownerAccountId: 'owner', access: 'owner',
                publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent({ kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: 'Child' }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(receipt.content) }),
                headerVersion: receipt.deployment.contentHeaderVersion, bodyVersion: receipt.deployment.contentBodyVersion,
                seq: 1, createdAt: 1, updatedAt: 1 } };
        });
        const deps = createDaemonDeploymentActionDeps({
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            credentials: { token: 'fixture', encryption: null }, serverId: 'home',
            serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a', runtime: {
                async acquire() { acquisitions++; throw new Error('Mismatched child must not acquire native custody'); },
            } });
        const result = await deps.deploymentChild({ v: 1, kind: 'member', actionId: 'deployments.deploy',
            input: { serverId: 'home', environmentId: environment.environment.id, targetLinkId: receipt.deployment.targetLinkId,
                expectedRevision: environment.environment.revision, expectedTargetLinkRevision: environment.targetLinks[0].targetLink.revision,
                requestKey: receipt.deployment.requestKey, contentArtifactId: receipt.deployment.contentArtifactId,
                contentHeaderVersion: receipt.deployment.contentHeaderVersion, contentBodyVersion: receipt.deployment.contentBodyVersion },
            machineId: 'machine-a', installationId: 'installation-a', phase: 'activate',
            selectedDeploymentId: receipt.deployment.id, deploymentId: receipt.deployment.id,
            actionOperationId: 'substituted-operation'}, {});
        expect(result).toMatchObject({ ok: false, errorCode: 'operation_unavailable' });
        expect(acquisitions).toBe(0);
    });
    it.each(['owned', 'foreign-inventory'] as const)('admits reviewed native teardown after ingress and Domain changes: %s', async shape => {
        const environment = createDeploymentEnvironmentDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        const link = environment.targetLinks[0].targetLink;
        environment.environment.revision = 5;
        environment.content.ingress = { kind: 'cloudflareTunnel' };
        link.revision = 2;
        link.state = 'deployed';
        link.activeDeploymentId = 'serving-before-domain-failure';
        receipt.content = DeploymentOwnServerContentV1Schema.parse({ ...receipt.content, teardown: {
            reason: 'decommission', targetLinkRevision: 2,
            machines: link.members.map(({ machineId, installationId }) => ({ machineId, installationId })),
            resources: [{ id: shape === 'owned' ? environment.environment.id : 'foreign-environment', kind: 'workload', machineId: 'machine-a',
                ownership: 'owned', disposition: 'remove' }], proofs: [],
        } });
        // The HTTP boundary retains CAS 5/2 after the ingress update and a
        // pending Domain mutation; neither changes the workload's target link.
        const documents = new Map<string, Record<string, unknown>>();
        const put = (id: string, kind: string, content: unknown) => documents.set(id, { id, ownerAccountId: 'owner', access: 'owner',
            publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind, title: 'Reviewed teardown' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        put(environment.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, environment.content);
        put(link.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, {});
        put(receipt.deployment.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, receipt.content);
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
            return { status: documents.has(id) ? 200 : 404, data: documents.get(id) ?? {} };
        });
        let allocated = false;
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (request.method === 'GET' && new URL(request.url!).pathname.endsWith('/deployments')) return { status: 200,
                data: { ok: true, items: [], nextCursor: null } };
            if (request.method === 'GET') return { status: 200, data: { ok: true, environment: environment.environment, secretScope: environment.secretScope,
                targetLinks: environment.targetLinks.map(item => item.targetLink) } };
            allocated = true;
            return { status: 409, data: { ok: false, error: 'deployment_conflict' } };
        });
        const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`, encryption: null };
        const resolveRequesterIdentity = async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const);
        const runtime = createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
            machineId: 'machine-a', resolveRequesterIdentity,
            async acquirePluginRuntimeRegistryLease() { throw new Error('Storage refusal precedes native acquisition'); } });
        const deps = createDaemonDeploymentActionDeps({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
            machineId: 'machine-a', resolveRequesterIdentity, runtime });
        const result = await deps.deploymentAction('deployments.teardown', { serverId: 'home', environmentId: environment.environment.id,
            expectedRevision: 5, targetLinkId: link.id, expectedTargetLinkRevision: 2, requestKey: 'reviewed-native-teardown',
            reason: 'decommission', contentArtifactId: receipt.deployment.contentArtifactId,
            contentHeaderVersion: 1, contentBodyVersion: 1 }, {
                operationAcceptance: { operationId: 'reviewed-teardown-operation', accept() {} },
            });
        expect(result, JSON.stringify(result)).toMatchObject(shape === 'owned' ? { ok: false, error: 'deployment_conflict' }
            : { ok: false, errorCode: 'unsupported_action', details: { reason: 'inventory_mismatch', remedy: expect.any(String) },
                failureCause: { phase: 'deployment.teardown.admission' } });
        expect(allocated).toBe(shape === 'owned');
    });

    it('prepares native teardown from the Environment already read for target selection', async () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const link = environment.targetLinks[0].targetLink;
        const candidate = { contentArtifactId: 'teardown-candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
        const teardown = createOwnServerTeardownForHost({
            credentials: { token: 'fixture-token', encryption: null }, serverId: 'home',
            serverHttpBaseUrl: 'https://home.test', machineId: link.machines[0]!,
            runtime: { async acquire() { throw new Error('Preparation must not execute'); },
                async acquireTeardown() { throw new Error('Preparation must not execute'); } },
            async readEnvironment() { throw new Error('The routing owner already read this Environment'); },
            async readReceipt() { throw new Error('No retained receipt'); },
            async *readBuildHistory() { yield createDeploymentReceiptDetailV1(); },
            async writeTransition() { throw new Error('Preparation must not settle'); },
            async findReceipt() { return null; }, async createCandidate() { return candidate; },
        });
        const prepared = await teardown.prepare({ input: { serverId: 'home', environmentId: environment.environment.id,
            targetLinkId: link.id, reason: 'manual', requestKey: 'native-pre-read' }, context: {},
            readWorkflowInvocation: async () => { throw new Error('No Workflow custody'); } }, environment);
        expect(prepared).toMatchObject({ input: { ...candidate, environmentId: environment.environment.id,
            expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision } });
    });

    it('prepares native teardown on the recorded controller for its remote sole target', async () => {
        const environment = createDeploymentEnvironmentDetailV1();
        environment.environment.controllerMachineId = 'recorded-controller-machine';
        const link = environment.targetLinks[0].targetLink;
        link.machines = ['native-target-machine'];
        link.members = [{ machineId: 'native-target-machine', installationId: 'target-installation', state: 'active' }];
        const candidate = { contentArtifactId: 'teardown-candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
        const teardown = createOwnServerTeardownForHost({
            credentials: { token: 'fixture-token', encryption: null }, serverId: 'home',
            serverHttpBaseUrl: 'https://home.test', machineId: environment.environment.controllerMachineId,
            runtime: { async acquire() { throw new Error('Preparation must not acquire native custody'); },
                async acquireTeardown() { throw new Error('Preparation must not acquire native custody'); } },
            async readEnvironment() { return environment; },
            async readReceipt() { throw new Error('Preparation must not read an uncreated receipt'); },
            async *readBuildHistory() { yield createDeploymentReceiptDetailV1(); },
            async writeTransition() { throw new Error('Preparation must not settle'); },
            async findReceipt() { return null; },
            async createCandidate(_environment, content) {
                expect(content.teardown?.resources).toEqual([{ id: environment.environment.id, kind: 'workload',
                    machineId: 'native-target-machine', ownership: 'owned', disposition: 'remove' }]);
                return candidate;
            },
        });
        const prepared = await teardown.prepare({ input: { serverId: 'home', environmentId: environment.environment.id,
            targetLinkId: link.id, reason: 'manual', requestKey: 'remote-native-teardown' }, context: {},
            readWorkflowInvocation: async () => { throw new Error('No Workflow custody'); } }, environment);
        expect(prepared).toMatchObject({ input: { ...candidate, targetLinkId: link.id,
            expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision } });
    });

    it('names the recorded controller Machine in native teardown placement refusals', async () => {
        const environment = createDeploymentEnvironmentDetailV1();
        environment.environment.controllerMachineId = 'recorded-controller-machine';
        const link = environment.targetLinks[0].targetLink;
        link.machines = ['native-target-machine'];
        link.members = [{ machineId: 'native-target-machine', installationId: 'target-installation', state: 'active' }];
        const teardown = createOwnServerTeardownForHost({
            credentials: { token: 'fixture-token', encryption: null }, serverId: 'home',
            serverHttpBaseUrl: 'https://home.test', machineId: 'unrelated-machine',
            runtime: { async acquire() { throw new Error('Refusal must precede native acquisition'); },
                async acquireTeardown() { throw new Error('Refusal must precede native acquisition'); } },
            async readEnvironment() { return environment; },
            async readReceipt() { throw new Error('Refusal must precede receipt acquisition'); },
            async *readBuildHistory() { throw new Error('Refusal must precede history reads'); },
            async writeTransition() { throw new Error('Refusal must not settle'); },
            async findReceipt() { throw new Error('Refusal must precede receipt allocation'); },
            async createCandidate() { throw new Error('Refusal must precede candidate creation'); },
        });
        const result = await teardown.prepare({ input: { serverId: 'home', environmentId: environment.environment.id,
            targetLinkId: link.id, reason: 'manual', requestKey: 'controller-placement-refusal' }, context: {},
            readWorkflowInvocation: async () => { throw new Error('No Workflow custody'); } }, environment);
        expect(DeploymentActionFailureV1Schema.parse(result)).toMatchObject({ ok: false,
            errorCode: 'unsupported_action', effectAttempted: false,
            details: { reason: 'target_placement_unsupported', requiredFact: 'controllerMachineId=recorded-controller-machine',
                remedy: expect.any(String) },
            failureCause: { phase: 'deployment.teardown.admission', errorCode: 'target_mismatch' } });
        const receipt = createDeploymentReceiptDetailV1();
        expect(await teardown.admit(environment, link.id, receipt.content, DeploymentTeardownInputV1Schema.parse({
            serverId: 'home', environmentId: environment.environment.id, targetLinkId: link.id,
            expectedRevision: environment.environment.revision, expectedTargetLinkRevision: link.revision,
            requestKey: 'controller-placement-refusal', reason: 'manual', contentArtifactId: receipt.deployment.contentArtifactId,
            contentHeaderVersion: receipt.deployment.contentHeaderVersion, contentBodyVersion: receipt.deployment.contentBodyVersion,
        }), {})).toEqual(result);
    });

    it('refuses caller-authored teardown completion before receipt allocation or native observation', async () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        const link = environment.targetLinks[0].targetLink;
        receipt.content.teardown = { reason: 'manual', targetLinkRevision: link.revision,
            machines: [{ machineId: 'machine-a', installationId: 'installation-a' }], resources: [],
            proofs: DEPLOYMENT_TEARDOWN_STEPS_V1.map(step => ({ step, machineId: 'machine-a',
                installationId: 'installation-a', state: 'succeeded', resources: [] })) };
        const documents = new Map<string, Record<string, unknown>>();
        const put = (id: string, kind: string, content: unknown) => documents.set(id, { id, ownerAccountId: 'owner', access: 'owner',
            publicAudience: 'none', encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ kind, title: 'Teardown' }),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        put(environment.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, environment.content);
        put(link.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, {});
        put(receipt.deployment.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, receipt.content);
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
            return { status: documents.has(id) ? 200 : 404, data: documents.get(id) ?? {} };
        });
        let receiptAllocations = 0;
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (request.method === 'GET' && new URL(request.url!).pathname.endsWith('/deployments')) return { status: 200,
                data: { ok: true, items: [], nextCursor: null } };
            if (request.method === 'GET') return { status: 200, data: { ok: true, environment: environment.environment, secretScope: environment.secretScope,
                targetLinks: environment.targetLinks.map(item => item.targetLink) } };
            receiptAllocations++;
            return { status: 409, data: { ok: false, error: 'deployment_conflict' } };
        });
        let nativeEffects = 0;
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const deps = createDaemonDeploymentActionDeps({
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            credentials: { token, encryption: null },
            serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
            runtime: { async acquire() { nativeEffects++; throw new Error('Teardown must not acquire deployment custody'); } },
            teardownBoundary: {
                async observe() { nativeEffects++; return { kind: 'proved', resources: [] }; },
                async execute() { nativeEffects++; return { kind: 'proved', resources: [] }; },
            } });
        const input = { serverId: 'home', environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
            targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: 'forged-teardown', reason: 'manual',
            contentArtifactId: receipt.deployment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const result = await deps.deploymentAction('deployments.teardown', input, {
            operationAcceptance: { operationId: 'teardown-operation', accept() {} },
        });
        expect(receiptAllocations).toBe(0);
        expect(result).toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
        expect(nativeEffects).toBe(0);
    });

    it.each((['plain', 'e2ee'] as const).flatMap(mode => (['prepared', 'simple'] as const).map(form => ({ mode, form }))))('prepares $mode $form Team promotion content with destination grants and recipient keys before any definition write', async ({ mode, form }) => {
        const settings = await persistence.readSettings();
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ ...settings, servers: { home: {
            id: 'home', name: 'Home', serverUrl: 'https://home.test', webappUrl: 'https://home.test',
            createdAt: 1, updatedAt: 1, homeConnectionDescriptorAuthority: 'exact',
            homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_preparation_home',
                canonicalServerUrl: 'https://home.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.test' }] }),
        } } });
        const root = await mkdtemp(join(tmpdir(), 'happier-promotion-review-'));
        const mounted = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
        try {
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
            const machineKey = new Uint8Array(32).fill(7);
            const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null
                : { type: 'dataKey', machineKey, publicKey: x25519.getPublicKey(machineKey) } };
            const seededKey = await createResourceDataKey({ credentials, mode });
            const encode = (value: unknown) => seededKey.mode === 'plain' ? encodePlainArtifactStoredContent(value)
                : Buffer.from(encryptWithDataKey(value, seededKey.dataKey)).toString('base64');
            const teammateSeed = new Uint8Array(32).fill(8);
            const teammatePublicKey = x25519.getPublicKey(teammateSeed);
            const signing = tweetnacl.sign.keyPair();
            const fingerprint = computeContentPublicKeyFingerprint(teammatePublicKey);
            const teammateContentKey = { status: 'available' as const,
                accountSigningPublicKey: Buffer.from(signing.publicKey).toString('hex'),
                contentPublicKey: Buffer.from(teammatePublicKey).toString('base64'),
                contentPublicKeySignature: Buffer.from(signAccountContentKeyBindingV1({ accountSigningSecretKey: signing.secretKey,
                    contentPublicKey: teammatePublicKey })).toString('base64') };
            const docker = await createOwnServerDockerBoundary(join(root, 'tools'));
            vi.stubEnv('PATH', `${join(root, 'tools')}${delimiter}${process.env.PATH ?? ''}`);
            const image = await docker.registerImage('app', 'X');
            const newerImage = await docker.registerImage('app', 'Y');
            const stored = (imageName: string, contentRevision: number) => {
                const document = JSON.stringify({ services: { app: { image: imageName } } });
                return { kind: 'stored' as const, contentRevision, document,
                    composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['app'] };
            };
            const destination = createDeploymentEnvironmentDetailV1();
            destination.environment.owner = { kind: 'team', teamId: 'destination-team' };
            destination.content.definition = stored('example/old:A', 3);
            // Team audience preparation uses the supported recreate runtime;
            // start-first cutover is owned by its separate native vertical.
            destination.content.ownServer = { rollout: 'recreate', autoRestorePreviousRelease: false };
            const servingDestination = createDeploymentReceiptDetailV1();
            servingDestination.deployment.id = 'destination-serving';
            servingDestination.deployment.contentArtifactId = 'destination-serving-content';
            servingDestination.content.sourceIntent = destination.content.definition;
            destination.targetLinks[0].targetLink.activeDeploymentId = servingDestination.deployment.id;
            const source = createDeploymentEnvironmentDetailV1();
            source.environment.owner = { kind: 'team', teamId: 'source-team' };
            source.environment.id = 'source-environment'; source.environment.contentArtifactId = 'source-environment-content';
            source.environment.runtimeTargetLinkId = 'source-target';
            source.targetLinks[0].targetLink.id = 'source-target'; source.targetLinks[0].targetLink.environmentId = source.environment.id;
            source.targetLinks[0].targetLink.contentArtifactId = 'source-target-content';
            source.content.definition = stored('example/mutable:Y', 20);
            const receipt = createDeploymentReceiptDetailV1();
            receipt.deployment.id = 'source-receipt'; receipt.deployment.environmentId = source.environment.id;
            receipt.deployment.targetLinkId = 'source-target';
            receipt.content.sourceIntent = stored(image.registryReference!, 19);
            receipt.content.images = [image]; receipt.content.machineResults = [];
            const documents = new Map<string, Record<string, unknown>>();
            const createdIds = new Set<string>();
            const teamGrants = new Map<string, unknown>();
            const recipientKeys = new Map<string, string>();
            const recipientProvenanceKeys = new Map<string, string>();
            const put = (id: string, kind: string, content: unknown) => documents.set(id, { id, ownerAccountId: 'owner', access: 'owner',
                publicAudience: 'none', encryptionMode: mode, dataEncryptionKey: seededKey.mode === 'plain'
                    ? ARTIFACT_PLAIN_DATA_KEY_MARKER : seededKey.dataEncryptionKey,
                header: encode({ kind, title: 'Promotion' }),
                body: encode({ body: JSON.stringify(content) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            put(source.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, source.content);
            put(destination.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, destination.content);
            put(destination.targetLinks[0].targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, {});
            put(source.targetLinks[0].targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, {});
            put(receipt.deployment.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, receipt.content);
            put(servingDestination.deployment.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, servingDestination.content);
            put('caller-candidate', DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, { ...receipt.content,
                sourceIntent: source.content.definition, images: [newerImage] });
            const keys = tweetnacl.sign.keyPair();
            vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
                installationId: 'installation-a', createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'),
                privateKey: Buffer.from(keys.secretKey).toString('base64url') });
            vi.spyOn(axios, 'get').mockImplementation(async url => {
                if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 0 } };
                const segments = new URL(url).pathname.split('/');
                if (url.endsWith('/access/grants')) return { status: 200, data: {
                    artifactId: decodeURIComponent(segments[3]!), ownerAccountId: 'owner', access: 'owner',
                    grants: [{ principal: destination.environment.owner, accessLevel: 'admin', createdByAccountId: 'owner',
                        createdAt: 1, display: { name: null } }],
                } };
                if (url.endsWith('/access/recipients')) {
                    const artifactId = decodeURIComponent(segments[3]!);
                    const row = documents.get(artifactId)!;
                    return { status: 200, data: { artifactId, ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
                        dataEncryptionKey: row.dataEncryptionKey, callerDataEncryptionKey: row.dataEncryptionKey,
                        ...(typeof row.provenanceDataEncryptionKey === 'string' ? {
                            provenanceDataEncryptionKey: row.provenanceDataEncryptionKey,
                            callerProvenanceDataEncryptionKey: row.provenanceDataEncryptionKey,
                        } : {}),
                        recipients: [{ recipientAccountId: 'teammate', contentKey: teammateContentKey,
                            contentPublicKeyFingerprint: fingerprint, encryptedDataKey: recipientKeys.get(artifactId) ?? null,
                            encryptedProvenanceDataKey: recipientProvenanceKeys.get(artifactId) ?? null,
                            recipientContentPublicKeyFingerprint: recipientKeys.has(artifactId) ? fingerprint : null }] } };
                }
                const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
                return { status: documents.has(id) ? 200 : 404, data: documents.get(id) ?? {} };
            });
            vi.spyOn(axios, 'put').mockImplementation(async (url, value) => {
                const mutation = readCarrierMutation(value);
                const artifactId = String(mutation.artifactId);
                expect(url).toBe(`https://home.test/v1/artifacts/${artifactId}/access/grants`);
                teamGrants.set(artifactId, { principal: mutation.principal, accessLevel: mutation.accessLevel });
                return { status: 200, data: { artifactId, ownerAccountId: 'owner', access: 'owner', changed: true,
                    grants: [{ principal: mutation.principal, accessLevel: mutation.accessLevel, createdByAccountId: 'owner',
                        createdAt: 1, display: { name: null } }] } };
            });
            vi.spyOn(axios, 'request').mockImplementation(async request => {
                const path = new URL(request.url!).pathname;
                if (path.endsWith('/secret-launch-admission')) return { status: 200, data: { ok: true, grants: [] } };
                const environment = path.endsWith(`/${source.environment.id}`) ? source : destination;
                if (request.method === 'GET' && path.includes('/environments/')) return { status: 200,
                    data: { ok: true, environment: environment.environment, secretScope: environment.secretScope, targetLinks: environment.targetLinks.map(item => item.targetLink) } };
                if (request.method === 'GET' && path.endsWith('/receipts/source-receipt')) return { status: 200,
                    data: { ok: true, deployment: receipt.deployment } };
                if (request.method === 'GET' && path.endsWith(`/receipts/${servingDestination.deployment.id}`)) return { status: 200,
                    data: { ok: true, deployment: servingDestination.deployment } };
                throw new Error(`Promotion review must not write definitions or admit effects: ${path}`);
            });
            vi.spyOn(axios, 'post').mockImplementation(async (url, value, config) => {
                if (url.endsWith('/access/key-envelopes')) {
                    const mutation = readCarrierMutation(value);
                    const envelope = (mutation.recipientKeyEnvelopes as { recipientAccountId: string; encryptedDataKey: string;
                        encryptedProvenanceDataKey?: string }[])[0]!;
                    expect(envelope.recipientAccountId).toBe('teammate');
                    const artifactId = String(mutation.artifactId);
                    const row = documents.get(artifactId)!;
                    expect(mutation.expectedDataEncryptionKey).toBe(row.dataEncryptionKey);
                    expect(mutation.expectedProvenanceDataEncryptionKey).toBe(row.provenanceDataEncryptionKey);
                    expect(envelope.encryptedProvenanceDataKey).toEqual(expect.any(String));
                    recipientKeys.set(artifactId, envelope.encryptedDataKey);
                    recipientProvenanceKeys.set(artifactId, envelope.encryptedProvenanceDataKey!);
                    return { status: 200, data: { appliedRecipientAccountIds: ['teammate'], skippedRecipientAccountIds: [] } };
                }
                const updatedId = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
                if (createdIds.has(updatedId)) {
                    const mutation = readCarrierMutation(value);
                    const row = documents.get(updatedId)!;
                    expect(mutation.expectedHeaderVersion).toBe(row.headerVersion);
                    expect(mutation.expectedBodyVersion).toBe(row.bodyVersion);
                    Object.assign(row, mutation, { headerVersion: Number(row.headerVersion) + 1,
                        bodyVersion: Number(row.bodyVersion) + 1 });
                    return { status: 200, data: { success: true, headerVersion: row.headerVersion, bodyVersion: row.bodyVersion } };
                }
                if (!url.endsWith('/v1/artifacts')) throw new Error(`Unexpected promotion Artifact request: ${url}`);
                const mutation = readCarrierMutation(value); const id = String(mutation.id);
                createdIds.add(id);
                // Receipt publication inherits the destination owner's grants
                // in the same server transaction as its content.
                teamGrants.set(id, { principal: destination.environment.owner, accessLevel: 'admin' });
                documents.set(id, { ...mutation, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                    encryptionMode: mode, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
                return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
            });
            const runtime = createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://home.test',
                resolveRequesterIdentity: resolveOwnerRequesterIdentity,
                machineId: 'machine-a', async acquirePluginRuntimeRegistryLease() { return mounted.lease; },
                readEnvironmentSecretLaunchAdmission: readEnvironmentSecretLaunchAdmissionForHost });
            const deps = createDaemonDeploymentActionDeps({
                resolveRequesterIdentity: resolveOwnerRequesterIdentity,
                credentials, serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a', runtime });
            const promotionInput = {
                serverId: 'home', environmentId: destination.environment.id, expectedRevision: destination.environment.revision,
                targetLinkId: destination.environment.runtimeTargetLinkId!, expectedTargetLinkRevision: 1, requestKey: 'promote',
                contentArtifactId: 'caller-candidate', contentHeaderVersion: 1, contentBodyVersion: 1,
                sourceEnvironmentId: source.environment.id, sourceDeploymentId: receipt.deployment.id,
                artifact: 'image' as const, destinationContent: { contentArtifactId: destination.environment.contentArtifactId,
                    contentHeaderVersion: 1, contentBodyVersion: 1 } };
            const simpleInput = { serverId: 'home', environmentId: destination.environment.id,
                sourceEnvironmentId: source.environment.id, sourceDeploymentId: receipt.deployment.id,
                artifact: 'image' as const, requestKey: 'promote' };
            if (form === 'simple') {
                source.environment.capabilities.deploy = false;
                expect(await deps.prepareDeploymentAction({ actionId: 'deployments.promote', context: ownerContext,
                    input: simpleInput })).toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
                source.environment.capabilities.deploy = true;
                destination.environment.capabilities.manage = false;
                expect(await deps.prepareDeploymentAction({ actionId: 'deployments.promote', context: ownerContext,
                    input: simpleInput })).toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
                destination.environment.capabilities.manage = true;
                expect(await deps.prepareDeploymentAction({ actionId: 'deployments.promote', context: ownerContext,
                    input: { ...simpleInput, artifact: 'rebuild' } })).toMatchObject({ ok: false, errorCode: 'unsupported' });
                expect(await deps.prepareDeploymentAction({ actionId: 'deployments.promote',
                    context: { ...ownerContext, approvedActionReplay: {} }, input: simpleInput }))
                    .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
                expect(createdIds.size).toBe(0);
            }
            const prepared = await deps.prepareDeploymentAction({ actionId: 'deployments.promote', context: ownerContext,
                input: form === 'prepared' ? promotionInput : simpleInput });
            expect(prepared).not.toHaveProperty('errorCode');
            if (!('input' in prepared) || !('destinationContent' in prepared.input)) throw new Error('Expected prepared promotion');
            const activation = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'member', actionId: 'deployments.promote',
                input: prepared.input, machineId: 'machine-a', installationId: 'installation-a',
                deploymentId: 'promotion-receipt', actionOperationId: 'promotion-operation', phase: 'activate',
                selectedDeploymentId: 'promotion-receipt' });
            expect(doesDeploymentChildInputMatchRootV1({ rootActionId: 'deployments.promote',
                rootInput: form === 'prepared' ? promotionInput : simpleInput, child: activation })).toBe(true);
            expect(createdIds.size).toBe(form === 'prepared' ? 3 : 2);
            expect(prepared.input).toMatchObject({ contentHeaderVersion: form === 'prepared' ? 1 : 2,
                contentBodyVersion: form === 'prepared' ? 1 : 2 });
            for (const id of createdIds) expect(teamGrants.get(id)).toEqual({
                principal: { kind: 'team', teamId: 'destination-team' }, accessLevel: 'admin' });
            const candidateRow = documents.get(prepared.input.destinationContent.contentArtifactId)!;
            if (typeof candidateRow.body !== 'string') throw new Error('Expected stored candidate body');
            let candidateBody: unknown;
            if (mode === 'plain') {
                expect(recipientKeys.size).toBe(0);
                candidateBody = decodePlainArtifactStoredContent(candidateRow.body);
            } else {
                expect(recipientKeys.size).toBe(createdIds.size);
                expect(recipientProvenanceKeys.size).toBe(createdIds.size);
                for (const id of createdIds) {
                    const key = openEncryptedDataKeyEnvelopeV1({ envelope: Buffer.from(recipientKeys.get(id)!, 'base64'), recipientSecretKeyOrSeed: teammateSeed });
                    expect(key).not.toBeNull();
                    const body = decryptWithDataKey(Buffer.from(String(documents.get(id)!.body), 'base64'), key!);
                    expect(body).toMatchObject({ body: expect.any(String) });
                    const provenanceKey = openEncryptedDataKeyEnvelopeV1({
                        envelope: Buffer.from(recipientProvenanceKeys.get(id)!, 'base64'), recipientSecretKeyOrSeed: teammateSeed });
                    expect(provenanceKey).not.toBeNull();
                    expect(decryptWithDataKey(Buffer.from(String(documents.get(id)!.provenance), 'base64'), provenanceKey!))
                        .toMatchObject({ artifactId: id, bodyVersion: documents.get(id)!.bodyVersion,
                            provenance: { savedBy: { kind: 'person', accountId: 'owner' } } });
                    if (id === prepared.input.destinationContent.contentArtifactId) candidateBody = body;
                }
            }
            if (!candidateBody || typeof candidateBody !== 'object' || !('body' in candidateBody) || typeof candidateBody.body !== 'string') {
                throw new Error('Expected the prepared destination content envelope');
            }
            expect(DeploymentEnvironmentContentV1Schema.parse(JSON.parse(candidateBody.body))).toEqual({ ...destination.content,
                definition: { ...receipt.content.sourceIntent, contentRevision: 4 } });
            expect(destination.content.definition).toMatchObject({ contentRevision: 3 });
            expect(prepared.preview).toMatchObject({ promotion: { artifact: 'image',
                candidateDocument: receipt.content.sourceIntent.document } });
            expect(prepared.preview).toMatchObject({ deployment: {
                revision: { kind: 'stored', contentRevision: 4 },
                replaces: { deploymentId: servingDestination.deployment.id, revision: { kind: 'stored', contentRevision: 3 } },
            } });
            expect((await docker.readInvocations()).some(invocation => invocation.args.includes('up') || invocation.args.includes('build'))).toBe(false);
        } finally { await mounted.dispose(); await rm(root, { recursive: true, force: true }); }
    });
    it('resolves exact admitted Environment metadata and its preview template approval scope', async () => {
        const detail = createDeploymentEnvironmentDetailV1();
        const requests: string[] = [];
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            requests.push(String(request.url));
            return { status: 200, data: { ok: true, environment: detail.environment, secretScope: detail.secretScope,
                targetLinks: detail.targetLinks.map(item => item.targetLink) } };
        });
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const deps = createDaemonDeploymentActionDeps({
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            credentials: { token, encryption: null },
            serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
            runtime: { async acquire() { throw new Error('Approval scope reads cannot acquire native custody'); } } });
        const resolve = deps.resolveEnvironmentApprovalScope!;
        const invocation = { actionId: 'deployments.deploy' as const,
            input: { serverId: 'home', environmentId: detail.environment.id }, context: {}, phase: 'prepare' as const };
        expect(await resolve(invocation)).toEqual({ scope: { kind: 'environment', environmentId: detail.environment.id } });
        expect(requests.map(url => new URL(url).pathname)).toEqual([`/v1/deployments/environments/${detail.environment.id}`]);
        expect(new URL(requests[0]!).searchParams.get('serverId')).toBe('home');
        detail.environment.deletedAtMs = 2_000;
        expect(await resolve({ ...invocation, actionId: 'deployments.receipts.list', phase: 'dispatch' }))
            .toEqual({ scope: { kind: 'environment', environmentId: detail.environment.id } });
        delete detail.environment.deletedAtMs;
        detail.environment.purpose = 'preview';
        detail.environment.previewTemplateEnvironmentId = 'admitted-template';
        detail.environment.previewRepositoryId = 'opaque-repository-selector';
        detail.environment.previewPullRequestId = 'preview-one';
        detail.environment.previewTargetLinkId = detail.environment.runtimeTargetLinkId;
        // The Home metadata owner already admitted this relation. The client
        // consumes its template scope and still refuses a missing relation.
        expect(await resolve({ ...invocation, phase: 'dispatch' })).toEqual({
            scope: { kind: 'environment', environmentId: detail.environment.id, inheritedEnvironmentId: 'admitted-template' },
        });
        delete detail.environment.previewTemplateEnvironmentId;
        expect(await resolve({ ...invocation, phase: 'dispatch' })).toMatchObject({ ok: false, errorCode: 'invalid_action_output' });
        expect(requests).toHaveLength(4);
        expect(await resolve({ ...invocation, input: { ...invocation.input, serverId: 'foreign' } }))
            .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
        expect(requests).toHaveLength(4);
    });
    it('admits Prepare scope from the authenticated Home and exact Source without inventing a handoff', async () => {
        const detail = createDeploymentEnvironmentDetailV1();
        const requests: string[] = [];
        const http = vi.spyOn(axios, 'request').mockImplementation(async request => {
            expect(request.method).toBe('GET');
            requests.push(String(request.url));
            return { status: 200, data: { ok: true, environment: detail.environment, secretScope: detail.secretScope,
                targetLinks: detail.targetLinks.map(item => item.targetLink) } };
        });
        const privateReads = vi.spyOn(axios, 'get').mockRejectedValue(new Error('Prepare scope cannot open private content'));
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const deps = createDaemonDeploymentActionDeps({
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            credentials: { token, encryption: null },
            serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
            runtime: { async acquire() { throw new Error('Prepare cannot acquire deployment native custody'); } } });
        const input = DeploymentActionInputSchemasV1['deployments.prepare'].parse({ projectSourceId: detail.environment.projectSourceId,
            sourceRevision: 1, repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
            baseCommit: 'a'.repeat(40), workspace: { kind: 'workspace-ref', serverId: 'home', id: 'checkout' },
            sessionRef: { serverId: 'home', sessionId: 'preparation-session' } });
        const context = { serverId: 'home', runtimeAccountId: 'owner', surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            interactivePresentation: 'unavailable', actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }) } as const;
        const resolve = deps.resolveEnvironmentApprovalScope!;
        const invocation = { actionId: 'deployments.prepare' as const, input, context, phase: 'prepare' as const };
        expect(await resolve(invocation)).toEqual({ scope: null });
        expect(http).not.toHaveBeenCalled();
        const scoped = { ...input, environmentId: detail.environment.id };
        expect(await resolve({ ...invocation, input: scoped }))
            .toEqual({ scope: { kind: 'environment', environmentId: detail.environment.id } });
        expect(new URL(requests[0]!).searchParams.get('serverId')).toBe(context.serverId);
        expect(await resolve({ ...invocation, input: { ...scoped, projectSourceId: 'another-source' } }))
            .toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
        expect(requests.map(url => new URL(url).pathname))
            .toEqual(Array(2).fill(`/v1/deployments/environments/${detail.environment.id}`));

        // The real executor has no P60 producer installed: scope admission must
        // not manufacture Session custody, dispatch storage writes or claim handoff.
        const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...deps });
        const beforeExecution = requests.length;
        expect(await executor.execute('deployments.prepare', input, context))
            .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
        expect(await executor.execute('deployments.prepare', { ...input,
            workspace: { ...input.workspace, serverId: 'foreign' } }, context))
            .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
        expect(requests).toHaveLength(beforeExecution);
        expect(privateReads).not.toHaveBeenCalled();
    });
    it('admits stored create and edit through the native source policy before storage, without native effects', async () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const document = JSON.stringify({ services: { app: { image: 'example/app:1', env_file: '.env' } } });
        environment.content.definition = { kind: 'stored', contentRevision: 1, document,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['app'] };
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            if (url.includes('/v1/artifacts/')) return { status: 200, data: {
                id: environment.environment.contentArtifactId, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                header: encodePlainArtifactStoredContent({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Stored' }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(environment.content) }),
                encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
                seq: 1, createdAt: 1, updatedAt: 1,
            } };
            throw new Error(`Unexpected HTTP read: ${url}`);
        });
        const writes: string[] = [];
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (request.method?.toUpperCase() === 'GET') return { status: 200, data: { ok: true,
                environment: environment.environment, secretScope: environment.secretScope, targetLinks: environment.targetLinks.map(item => item.targetLink) } };
            writes.push(request.method ?? '');
            return { status: 200, data: { ok: true, environmentId: environment.environment.id, revision: 1 } };
        });
        let acquisitions = 0;
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const deps = createDaemonDeploymentActionDeps({
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            credentials: { token, encryption: null },
            serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
            runtime: { async acquire() { acquisitions++; throw new Error('Definition writes must not acquire native custody'); } } });
        const content = { contentArtifactId: environment.environment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const createInput = { ...content, serverId: 'home',
            projectSourceId: 'source-app', requestKey: 'stored-create', protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', controllerMachineId: 'machine-a' } as const;
        const updateInput = { ...content, serverId: 'home', environmentId: environment.environment.id, expectedRevision: 1 };
        for (const source of [
            { services: { app: { image: 'example/app:1', env_file: '.env' } } },
            { services: { app: { image: 'example/app:1', volumes: ['../data:/data'] } } },
            { services: { app: { image: 'example/app:1', volumes: [{ type: 'bind', source: '../settings.json', target: '/settings' }] } } },
            { services: { app: { build: '.' } } },
            { services: { app: { extends: { file: './other.yaml', service: 'app' } } } },
            { include: './other.yaml', services: { app: { image: 'example/app:1' } } },
            { configs: { settings: { file: './settings.json' } }, services: { app: { image: 'example/app:1' } } },
            { secrets: { password: { file: './password' } }, services: { app: { image: 'example/app:1' } } },
        ]) {
            const document = JSON.stringify(source);
            environment.content.definition = { kind: 'stored', contentRevision: 1, document,
                composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['app'] };
            await expect(deps.deploymentAction('deployments.environments.create', createInput, ownerContext))
                .resolves.toMatchObject({ ok: false, errorCode: 'needs_repository' });
            await expect(deps.deploymentAction('deployments.environments.update', updateInput, ownerContext))
                .resolves.toMatchObject({ ok: false, errorCode: 'needs_repository' });
        }
        expect(writes, 'invalid stored content cannot reach either record writer').toHaveLength(0);
        const inlineDocument = JSON.stringify({ configs: { greeting: { content: 'hello' } },
            services: { app: { image: 'example/app:1', configs: ['greeting'], volumes: ['./data:/data',
                { type: 'bind', source: './settings.json', target: '/settings' }] } } });
        environment.content.definition = { ...environment.content.definition, document: inlineDocument,
            composeDigest: `sha256:${createHash('sha256').update(inlineDocument).digest('hex')}` };
        await expect(deps.deploymentAction('deployments.environments.create', { ...content, serverId: 'home',
            projectSourceId: 'source-app', requestKey: 'inline-create', protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', controllerMachineId: 'machine-a' }, ownerContext))
            .resolves.toMatchObject({ ok: true, environmentId: environment.environment.id });
        expect(writes).toHaveLength(1);
        await expect(deps.deploymentAction('deployments.environments.update', updateInput, ownerContext))
            .resolves.toMatchObject({ ok: true, environmentId: environment.environment.id });
        expect(writes).toHaveLength(2);
        environment.content.definition = { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: ['app'] } };
        await expect(deps.deploymentAction('deployments.environments.update', updateInput, ownerContext))
            .resolves.toMatchObject({ ok: true, environmentId: environment.environment.id });
        expect(writes).toHaveLength(3);
        expect(acquisitions).toBe(0);
    });
    it.each(['template install', 'template install artifact failure', 'template install native failure', 'template install docker access denied', 'template install preparation failure', 'template install failed receipt', 'template install pending receipt', 'stored preparation cost', 'stored preparation stale held', 'stored preparation failure reason', 'stored preparation removed required binding', 'stored preparation missing tool', 'machine Use stored definition', 'machine Use Team receipt history', 'machine Use pending stored definition', 'configured ref', 'stale Team grant', 'approved exact SHA', 'native tool version changes', 'compact exact SHA', 'pending exact SHA', 'retained rollback', 'retained rollback intent', 'retained rollback intent e2ee', 'trigger claim consent', 'trigger claim consent merge', 'missing native builder'] as const)('retains native review from %s without rewriting either Artifact', async selection => {
        const triggerConsentSelection = selection === 'trigger claim consent' || selection === 'trigger claim consent merge';
        const storedPreparation = selection.startsWith('stored preparation');
        const teamReceiptHistory = selection === 'machine Use Team receipt history';
        const mode = selection === 'retained rollback intent e2ee' ? 'e2ee' : 'plain';
        const homeServerIdentityId = mode === 'e2ee' ? 'srv_preparation_home' : 'home';
        const nativeReviewContext: RpcActionExecutorContext = { ...ownerContext, serverId: 'home', serverIdentityId: homeServerIdentityId };
        const nativeReviewIdentity = createFilesystemEffectAdmission({
            resolveHomeServerIdentityId: async () => homeServerIdentityId,
            resolveHostIdentity: async () => ({ machineId: 'machine-a', installationId: 'installation-a', custodianAccountId: 'owner' }),
        });
        const resolveNativeReviewRequesterIdentity = async (context: ActionExecutorContext) => {
            const requester = await nativeReviewIdentity.resolveActionRequester!(context);
            try { return requester.identity; } finally { await requester.dispose(); }
        };
        {
            // Saved-profile persistence is the OS boundary. Keep profile/Home
            // resolution real, with the exact Home used by this native fixture.
            const settings = await persistence.readSettings();
            vi.spyOn(persistence, 'readSettings').mockResolvedValue({ ...settings, servers: { home: {
                id: 'home', name: 'Home', serverUrl: 'https://home.test', webappUrl: 'https://home.test',
                createdAt: 1, updatedAt: 1, homeConnectionDescriptorAuthority: 'exact',
                homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_preparation_home',
                    canonicalServerUrl: 'https://home.test', revision: 1, endpoints: [{ kind: 'https', url: 'https://home.test' }] }),
            } } });
        }
        const templateSelection = selection.startsWith('template install');
        const rollbackSelection = selection.startsWith('retained rollback');
        let pendingPhase = 'runtime-fixture';
        const startedAt = performance.now();
        const milestones: { phase: string; elapsedMs: number; nativeInvocations?: number }[] = [];
        let nativeSummary: { count: number; lastCommand: readonly string[] } | undefined;
        if (templateSelection || selection === 'stored preparation cost' || selection === 'pending exact SHA' || selection === 'approved exact SHA' || selection === 'native tool version changes' || selection === 'configured ref' || selection === 'stale Team grant' || triggerConsentSelection) onTestFailed(() => {
            // Content-free phase only: native/runtime setup is not behavior RED.
            console.error('native_review_fixture_phase', { selection, phase: pendingPhase,
                elapsedMs: Math.round(performance.now() - startedAt), milestones,
                native: nativeSummary });
        });
        const phase = (name: string, nativeInvocations?: number) => {
            pendingPhase = name;
            if (selection !== 'pending exact SHA' && selection !== 'approved exact SHA' && selection !== 'native tool version changes' && !templateSelection
                && selection !== 'stored preparation cost') return;
            const now = performance.now();
            milestones.push({ phase: name, elapsedMs: Math.round(now - startedAt),
                ...(nativeInvocations === undefined ? {} : { nativeInvocations }) });
        };
        const root = await mkdtemp(join(tmpdir(), 'happier-daemon-deployment-'));
        const mounted = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
            runtimeOptions: storedPreparation || templateSelection
                ? { pluginIds: [], contributes: createResolvedContributionRegistry({}) }
                : { pluginIds: ['happier.scm.backend.git'] } });
        phase('plugin-mounted');
        let requesterPreparation: Awaited<ReturnType<typeof prepareRequesterAccountActionContext>> = null;
        let requesterCurrent = true;
        try {
            const docker = await createOwnServerDockerBoundary(join(root, 'tools'), {
                runtimeInventoryFailure: selection === 'stored preparation failure reason',
                sourceNormalizationFailure: selection === 'template install native failure',
                dockerAccessDenied: selection === 'template install docker access denied',
            });
            const nativePhase = async (name: string) => {
                if (selection === 'pending exact SHA' || selection === 'approved exact SHA' || templateSelection || selection === 'stored preparation cost') {
                    const calls = await docker.readInvocations();
                    nativeSummary = { count: calls.length, lastCommand: calls.at(-1)?.args.slice(0, 2) ?? [] };
                    phase(name, nativeSummary.count);
                }
            };
            vi.stubEnv('PATH', `${join(root, 'tools')}${delimiter}${process.env.PATH ?? ''}`);
            const image = await docker.registerImage('app', 'A');
            const previousImage = await docker.registerImage('app', 'B');
            phase('native-boundary-ready');
            const repository = join(root, 'repository');
            await mkdir(repository);
            const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
            git('init', '--quiet'); git('config', 'user.name', 'Deployment Fixture'); git('config', 'user.email', 'deployment@example.test');
            await writeFile(join(repository, 'compose.yaml'), JSON.stringify({ services: { app: { image: image.registryReference } } }));
            git('add', '.'); git('commit', '--quiet', '-m', 'A');
            const environment = createDeploymentEnvironmentDetailV1();
            environment.environment.serverId = homeServerIdentityId;
            if (selection === 'stored preparation stale held') environment.environment.revision = 3;
            const configuredRef = selection === 'configured ref' || selection === 'stale Team grant';
            environment.environment.owner = configuredRef ? { kind: 'team', teamId: 'deployment-team' }
                : { kind: 'account', accountId: 'owner' };
            const receipt = createDeploymentReceiptDetailV1();
            const currentTargetLinkId = environment.targetLinks[0].targetLink.id;
            // A first deployment to this configured fleet still has a retained
            // successful receipt from another fleet. It must not become either
            // the selected source or a fabricated active rollback baseline.
            const retainedTarget = { ...environment.targetLinks[0], targetLink: {
                ...environment.targetLinks[0].targetLink, id: 'retained-target-link',
                activeDeploymentId: receipt.deployment.id, detachedAtMs: 1,
            } };
            receipt.deployment.targetLinkId = retainedTarget.targetLink.id;
            environment.targetLinks.push(retainedTarget);
            delete environment.targetLinks[0].targetLink.activeDeploymentId;
            environment.targetLinks[0].targetLink.state = 'configured';
            receipt.content.sourceIntent = { kind: 'repository', projectSourceId: 'source-app', sourceRevision: 1,
                sha: git('rev-parse', 'HEAD'), compose: { path: 'compose.yaml', services: ['app'], profiles: [] } };
            git('branch', 'selected-release');
            environment.content.definition = { kind: 'repository', ref: 'selected-release',
                compose: receipt.content.sourceIntent.compose };
            await writeFile(join(repository, 'compose.yaml'), JSON.stringify({ services: { app: { image: previousImage.registryReference } } }));
            git('add', '.'); git('commit', '--quiet', '-m', 'Different checkout HEAD');
            if (!configuredRef) git('branch', '--force', 'selected-release', 'HEAD');
            await writeFile(join(repository, 'compose.yaml'), 'uncommitted bytes must not enter the candidate');
            receipt.content.images = [image];
            receipt.content.machineResults = [];
            const historical = createDeploymentReceiptDetailV1();
            historical.deployment.id = 'current-fleet-history';
            historical.deployment.targetLinkId = currentTargetLinkId;
            historical.deployment.contentArtifactId = 'current-fleet-history-content';
            if (rollbackSelection) historical.content = structuredClone(receipt.content);
            historical.content.machineResults = environment.targetLinks[0].targetLink.members.map(member => ({
                machineId: member.machineId, installationId: member.installationId,
                steps: [], activation: 'succeeded', health: 'healthy', currentDeploymentId: historical.deployment.id,
            }));
            const historicalReads = { headers: 0, bodies: 0 };
            let memberHistoryReads = 0;
            const preparationReads = { environments: 0, secretPhases: [] as unknown[] };
            const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
            const machineKey = new Uint8Array(32).fill(7);
            const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null
                : { type: 'dataKey', machineKey, publicKey: x25519.getPublicKey(machineKey) } };
            const memberToken = `header.${Buffer.from(JSON.stringify({ sub: 'member' })).toString('base64url')}.signature`;
            const requesterCredentials: StoredCredentials = teamReceiptHistory ? { token: memberToken, encryption: null } : credentials;
            // Use the same production key/envelope facades as the Team promotion
            // boundary above; neither seed nor candidate bypasses its decoder.
            const seededKey = await createResourceDataKey({ credentials, mode });
            const settingsContent = mode === 'plain' ? { t: 'plain' as const, v: {} }
                : { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
                    material: { type: 'dataKey', machineKey }, payload: {},
                    randomBytes: length => new Uint8Array(randomBytes(length)) }) };
            const encode = (value: unknown) => seededKey.mode === 'plain' ? encodePlainArtifactStoredContent(value)
                : Buffer.from(encryptWithDataKey(value, seededKey.dataKey)).toString('base64');
            const keys = tweetnacl.sign.keyPair();
            vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
                installationId: 'installation-a', createdAt: 1, publicKey: Buffer.from(keys.publicKey).toString('base64url'),
                privateKey: Buffer.from(keys.secretKey).toString('base64url') });
            const workspaceRow = createPlainProjectAccountRefRow({ id: 'checkout', serverId: homeServerIdentityId, machineId: 'machine-a',
                rootPath: repository, source: { sourceId: 'source-app', revision: 1 }, createdAtMs: 1 });
            if (mode === 'e2ee' && workspaceRow.content?.t === 'plain') workspaceRow.content = createProjectAccountRowCipherV1({
                mode, material: { type: 'dataKey', machineKey }, randomBytes: length => new Uint8Array(randomBytes(length)),
            }).seal(workspaceRow.content.v);
            mockProjectAccountRowsHttpBoundary([workspaceRow]);
            const documents = new Map<string, Record<string, unknown>>();
            const put = (id: string, kind: string, content: unknown) => documents.set(id, { id, ownerAccountId: 'owner', access: 'owner',
                publicAudience: 'none', encryptionMode: mode, dataEncryptionKey: seededKey.dataEncryptionKey ?? ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encode({ kind, title: kind === DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1
                    ? DeploymentEnvironmentContentV1Schema.parse(content).name : 'Staging' }), body: encode({ body: JSON.stringify(content) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            put(environment.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, environment.content);
            put(environment.targetLinks[0].targetLink.contentArtifactId, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, {});
            put(receipt.deployment.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, { ...receipt.content,
                sourceIntent: { ...receipt.content.sourceIntent, sha: git('rev-parse', 'HEAD') }, images: [previousImage] });
            if (!teamReceiptHistory) put(historical.deployment.contentArtifactId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, historical.content);
            const boundaryFailures: unknown[] = [];
            const triggerDeployRequests: unknown[] = [];
            let pendingEnvelope: ReturnType<typeof DeploymentPendingDeployV1Schema.parse> | undefined;
            let busy = true;
            const grantedCandidates = new Set<string>();
            const artifactGrants = new Map<string, ArtifactAccessGrantRowV1[]>();
            const environmentGrants: ArtifactAccessGrantRowV1[] = teamReceiptHistory || configuredRef ? [{
                principal: { kind: 'team', teamId: 'deployment-team' }, accessLevel: teamReceiptHistory ? 'view' : 'admin',
                createdByAccountId: 'owner', createdAt: 1, display: { name: null },
            }] : [];
            vi.spyOn(axios, 'put').mockImplementation(async (url, value) => {
                const mutation = ArtifactAccessGrantSetInputV1Schema.parse(readCarrierMutation(value));
                const artifactId = String(mutation.artifactId);
                if (teamReceiptHistory) expect(mutation).toMatchObject(mutation.accessLevel === 'admin'
                    ? { principal: { kind: 'account', accountId: 'owner' }, accessLevel: 'admin' }
                    : { principal: { kind: 'team', teamId: 'deployment-team' }, accessLevel: 'view' });
                else {
                    expect(mutation.principal).toEqual({ kind: 'team', teamId: 'deployment-team' });
                    expect(mutation.accessLevel).toBe('admin');
                }
                expect(url).toBe(`https://home.test/v1/artifacts/${artifactId}/access/grants`);
                grantedCandidates.add(artifactId);
                const grant = { principal: mutation.principal, accessLevel: mutation.accessLevel,
                    createdByAccountId: 'owner', createdAt: 1, display: { name: null } };
                const grants = [...(artifactGrants.get(artifactId) ?? []), grant];
                artifactGrants.set(artifactId, grants);
                return { status: 200, data: { artifactId, ownerAccountId: documents.get(artifactId)?.ownerAccountId ?? 'owner',
                    access: 'owner', changed: true, grants } };
            });
            vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
                if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
                if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 0 } };
                if (new URL(url).pathname === '/v1/machines/machine-a') return { status: 200, data: { machine: {
                    id: 'machine-a', active: true, kind: 'persistent', revokedAt: null, replacedByMachineId: null,
                    installationId: 'installation-a', installationPublicKey: Buffer.from(keys.publicKey).toString('base64'),
                    dataEncryptionKey: seededKey.dataEncryptionKey,
                    access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: mode, accessState: 'ready' },
                } } };
                const accountId = config?.headers?.Authorization === `Bearer ${memberToken}` || teamReceiptHistory
                    && config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === 'machine-use-stored-root' ? 'member' : 'owner';
                if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: accountId } };
                if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: settingsContent, version: 1 } };
                if (url.endsWith('/access/recipients')) {
                    const artifactId = decodeURIComponent(new URL(url).pathname.split('/').at(-3)!);
                    const stored = documents.get(artifactId)!;
                    return { status: 200, data: { artifactId, ownerAccountId: stored.ownerAccountId,
                        access: 'owner', encryptionMode: mode, dataEncryptionKey: stored.dataEncryptionKey,
                        callerDataEncryptionKey: stored.dataEncryptionKey,
                        ...(typeof stored.provenanceDataEncryptionKey === 'string' ? {
                            provenanceDataEncryptionKey: stored.provenanceDataEncryptionKey,
                            callerProvenanceDataEncryptionKey: stored.provenanceDataEncryptionKey,
                        } : {}), recipients: [] } };
                }
                const grantPath = /^\/v1\/artifacts\/([^/]+)\/access\/grants$/u.exec(new URL(url).pathname);
                if (grantPath) {
                    const artifactId = decodeURIComponent(grantPath[1]!);
                    if (artifactId === environment.environment.contentArtifactId) return { status: 401, data: { error: 'artifact_access_forbidden' } };
                    const ownerAccountId = documents.get(artifactId)?.ownerAccountId ?? 'owner';
                    return { status: 200, data: { artifactId, ownerAccountId,
                        access: accountId === ownerAccountId ? 'owner' : 'view', grants: artifactId === environment.environment.contentArtifactId
                            ? environmentGrants : artifactGrants.get(artifactId) ?? [] } };
                }
                const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1)!);
                if (id === historical.deployment.contentArtifactId) {
                    historicalReads.bodies++;
                    if (teamReceiptHistory && accountId === 'member') {
                        memberHistoryReads++;
                        // The verified signed root authenticates B; ordinary
                        // Artifact grants still decide B's content access.
                        expect(config?.headers?.Authorization).not.toBe(`Bearer ${token}`);
                        expect(config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe('machine-use-stored-root');
                        expect(artifactGrants.get(id)).toMatchObject([{ principal: { kind: 'team', teamId: 'deployment-team' }, accessLevel: 'view' }]);
                    }
                }
                const document = documents.get(id);
                return { status: document ? 200 : 404, data: document && accountId === 'member'
                    && document.ownerAccountId !== accountId ? { ...document, access: 'view' } : document ?? {} };
            });
            vi.spyOn(axios, 'request').mockImplementation(async request => {
                try {
                const path = new URL(request.url!).pathname;
                if (triggerConsentSelection && path.endsWith('/deploy') && request.method === 'POST') {
                    triggerDeployRequests.push(request.data);
                    // Home returns an idempotently settled receipt for this consent test.
                    return { status: 200, data: DeploymentReceiptResultV1Schema.parse({ ok: true,
                        environmentId: environment.environment.id, revision: environment.environment.revision,
                        deploymentId: 'trigger-deploy', deploymentRevision: 1, state: 'succeeded' }) };
                }
                if (selection === 'pending exact SHA' && path.endsWith('/deploy') && request.method === 'POST') {
                    const body = request.data as Record<string, unknown>;
                    pendingEnvelope = DeploymentPendingDeployV1Schema.parse(body.pendingDeploy);
                    return { status: 200, data: { ok: true, environmentId: environment.environment.id,
                        revision: environment.environment.revision, kind: 'pending', actionOperationId: body.actionOperationId } };
                }
                if (path.includes('/v1/projects/sources/')) return { status: 200, data: { ok: true, canManage: true,
                    source: { id: 'source-app', revision: 1, name: 'Source', owner: environment.environment.owner, audience: [], createdByAccountId: 'owner',
                        repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                            repository: { nameWithOwner: 'owner/source', cloneUrl: 'https://github.com/owner/source.git' }, protocol: 'https' } } } };
                if (path.endsWith('/secret-launch-admission')) {
                    preparationReads.secretPhases.push(isRecord(request.data) ? request.data.phase : undefined);
                    return { status: 200, data: { ok: true, grants: [] } };
                }
                if (path === `/v1/deployments/environments/${environment.environment.id}/deployments`) {
                    const inProgressOnly = new URL(request.url!).searchParams.get('inProgressOnly') === 'true';
                    return { status: 200, data: DeploymentReceiptListResultV1Schema.parse({ ok: true,
                        items: selection === 'pending exact SHA' && pendingEnvelope && busy
                            ? [{ ...historical.deployment, state: 'running' }]
                            : inProgressOnly ? [] : [historical.deployment, receipt.deployment], nextCursor: null }) };
                }
                if (path.endsWith(`/environments/${environment.environment.id}`)) {
                    preparationReads.environments++;
                    return { status: 200,
                    data: { ok: true, environment: environment.environment, secretScope: environment.secretScope, targetLinks: environment.targetLinks.map(item => item.targetLink),
                        ...(pendingEnvelope ? { pendingDeploy: pendingEnvelope } : {}),
                        ...(selection === 'machine Use pending stored definition' ? { pendingAdmission: {
                            requesterAccountId: 'owner', serverId: 'home', requestKey: 'use-pending',
                            actionOperationId: 'use-pending-operation', controller: { machineId: 'machine-a', installationId: 'installation-a' },
                            environmentRevision: environment.environment.revision,
                        } } : {}) } };
                }
                if (path.endsWith(`/receipts/${receipt.deployment.id}`)) return { status: 200, data: { ok: true, deployment: receipt.deployment } };
                if (path.endsWith(`/receipts/${historical.deployment.id}`)) {
                    historicalReads.headers++;
                    return { status: 200, data: { ok: true, deployment: historical.deployment } };
                }
                throw new Error(`Unexpected storage request: ${path}`);
                } catch (error) { boundaryFailures.push(error); throw error; }
            });
            let failTemplateArtifact = false;
            const originalPost = vi.mocked(axios.post).getMockImplementation()!;
            const posts = vi.spyOn(axios, 'post').mockImplementation(async (url, value, config) => {
                if (url.endsWith('/execution-authorization/verify')) return { status: 200, data: { ok: true } };
                const update = /^\/v1\/artifacts\/([^/]+)$/u.exec(new URL(url).pathname);
                if (update) {
                    const id = decodeURIComponent(update[1]!);
                    const stored = documents.get(id);
                    if (!stored) return { status: 404, data: { error: 'Artifact not found' } };
                    const mutation = ArtifactJsonUpdateHttpInputV1Schema.parse(readCarrierMutation(value));
                    if (mutation.header !== undefined && mutation.expectedHeaderVersion === undefined
                        || mutation.body !== undefined && mutation.expectedBodyVersion === undefined) {
                        return { status: 400, data: { error: 'Invalid parameters' } };
                    }
                    if (mutation.expectedHeaderVersion !== undefined && mutation.expectedHeaderVersion !== stored.headerVersion
                        || mutation.body !== undefined && mutation.expectedBodyVersion !== stored.bodyVersion) {
                        return { status: 200, data: { success: false, error: 'version-mismatch',
                            ...(mutation.header !== undefined || mutation.kind !== undefined
                                ? { currentHeaderVersion: stored.headerVersion, currentHeader: stored.header } : {}),
                            ...(mutation.body !== undefined ? { currentBodyVersion: stored.bodyVersion, currentBody: stored.body } : {}),
                        } };
                    }
                    const next = { ...stored,
                        ...(mutation.header === undefined ? {} : { header: mutation.header }),
                        ...(mutation.body === undefined ? {} : { body: mutation.body }),
                        ...(mutation.provenance === undefined ? {} : { provenance: mutation.provenance }),
                        ...(mutation.provenanceDataEncryptionKey === undefined ? {} : { provenanceDataEncryptionKey: mutation.provenanceDataEncryptionKey }),
                        headerVersion: Number(stored.headerVersion) + Number(mutation.header !== undefined),
                        bodyVersion: Number(stored.bodyVersion) + Number(mutation.body !== undefined),
                    };
                    documents.set(id, next);
                    return { status: 200, data: { success: true,
                        ...(mutation.header === undefined ? {} : { headerVersion: next.headerVersion }),
                        ...(mutation.body === undefined ? {} : { bodyVersion: next.bodyVersion }),
                    } };
                }
                if (!url.endsWith('/v1/artifacts')) return originalPost(url, value, config);
                if (failTemplateArtifact) return { status: 503, data: { error: 'private-artifact-response-sentinel' } };
                const mutation = readCarrierMutation(value);
                const id = String(mutation.id);
                const writer = teamReceiptHistory && config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] === 'machine-use-stored-root' ? 'member' : 'owner';
                documents.set(id, { ...mutation, ownerAccountId: writer, access: 'owner', publicAudience: 'none',
                    encryptionMode: mode, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
                // Authenticated storage applies the server-admitted receipt audience
                // at publication; the native producer never reads Environment grants.
                if (z.object({ kind: z.literal(DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1) }).safeParse(
                    decodePlainArtifactStoredContent(String(mutation.header))).success) {
                    const grant = (principal: ArtifactAccessGrantRowV1['principal'], accessLevel: ArtifactAccessGrantRowV1['accessLevel']): ArtifactAccessGrantRowV1 => ({
                        principal, accessLevel, createdByAccountId: writer, createdAt: 1, display: { name: null },
                    });
                    const owner = environment.environment.owner;
                    artifactGrants.set(id, [
                        ...(owner.kind === 'team' || owner.accountId !== writer ? [grant(owner, 'admin')] : []),
                        ...environmentGrants.filter(({ principal }) => JSON.stringify(principal) !== JSON.stringify(owner))
                            .map(({ principal }) => grant(principal, 'view')),
                    ]);
                    if (configuredRef) grantedCandidates.add(id);
                }
                return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
            });
            if (teamReceiptHistory) await runWithServerHttpBaseUrl('https://home.test', () => createDeploymentArtifactForHost({
                artifacts: createCredentialedAccountArtifactStore(credentials), owner: environment.environment.owner,
                assertCurrent: async () => {},
                content: { prepareRecipients: true, artifactId: historical.deployment.contentArtifactId, header: { kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: 'Historical deployment' },
                    body: JSON.stringify(historical.content) },
            }));
            const runtime = createOwnServerDeploymentRuntimeForHost({ credentials: requesterCredentials, serverId: homeServerIdentityId, serverHttpBaseUrl: 'https://home.test',
                resolveRequesterIdentity: resolveNativeReviewRequesterIdentity,
                machineId: 'machine-a', async acquirePluginRuntimeRegistryLease() { return mounted.lease; },
                readEnvironmentSecretLaunchAdmission: readEnvironmentSecretLaunchAdmissionForHost });
            let resumed = 0;
            const deps = createDaemonDeploymentActionDeps({
                resolveRequesterIdentity: resolveNativeReviewRequesterIdentity,
                credentials: requesterCredentials, installedCredentials: credentials, serverId: homeServerIdentityId, serverHttpBaseUrl: 'https://home.test',
                machineId: 'machine-a', runtime,
                async executePreparedPendingDeploy(input, context) {
                    pendingPhase = 'ordinary-policy-reentry';
                    resumed += 1;
                    expect(input.pendingDeploy).toEqual(pendingEnvelope);
                    if (!('input' in prepared)) throw new Error('Expected prepared pending deployment');
                    expect(input.contentArtifactId).not.toBe(prepared.input.contentArtifactId);
                    const opened = await deps.readPreparedDeploymentContent({ input, context });
                    expect(opened).toMatchObject({ ok: true, content: { sourceIntent: receipt.content.sourceIntent } });
                    // Re-entry consumes ordinary Action policy, not a native or
                    // approval bypass. Current refusal leaves protected intent.
                    return executor.execute('deployments.deploy', input, { ...context, authority: 'present_user',
                        surface: 'ui', actionCaller: { kind: 'host' }, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
                            actions: { 'deployments.deploy': { enabled: false } } }) });
                } });
            const sourceDeps = createCliProjectSourceActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: () => null,
                resolveRequestHeaders: () => ({ Authorization: `Bearer ${token}` }) });
            const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...sourceDeps, ...deps,
                // The mounted human confirmation is a host UI boundary.
                presentUserActionConfirmation: async () => true });
            if (templateSelection) {
                const source: RegistrySourceDescriptorV1 = { id: 'apps', title: 'Apps', format: 'happier-catalog', kinds: ['app'],
                    url: 'https://apps.test/catalog.json', enabled: true, addedAt: 1, origin: { kind: 'user' }, removable: true };
                const app = DeploymentTemplateV1Schema.parse({ schemaVersion: 1, title: 'App', compose: {
                    document: JSON.stringify({ services: { app: { image: image.registryReference } } }), profiles: [], services: ['app'] },
                    variables: [], generatedSecrets: [], domains: [], volumes: [] });
                const catalog = { schemaVersion: 1, apps: [{ itemId: 'app', app }] };
                const registry = createRegistryHostV1({ host: 'node', readSources: async () => [source], http: {
                    getJson: async () => ({ ok: true, value: catalog, fetchedAt: 1 }),
                    getText: async () => { throw new Error('No text catalog input'); },
                    getBytes: async () => { throw new Error('No binary catalog input'); },
                } });
                const selected = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(await registry.execute('registries.items.read', {
                    sourceId: source.id, kind: 'app', itemId: 'app' })).item;
                if (selected.payload.kind !== 'app') throw new Error('Expected canonical app selection');
                const { origin: _origin, removable: _removable, ...sourceRow } = source;
                const rows = PromptLibraryRowsListResponseV1Schema.parse({ status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({
                    key, revision: 1, content: key === 'registry-sources' ? { t: 'plain', v: { key,
                        value: { v: 2, sources: [sourceRow], disabledSourceIds: [] } } } : null,
                })) });
                vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
                    expect(String(url)).toBe(source.url);
                    return new Response(JSON.stringify(catalog), { status: 200 });
                });
                const read = vi.mocked(axios.get).getMockImplementation()!;
                vi.spyOn(axios, 'get').mockImplementation(async (url, config) => url.endsWith('/v1/account/entity-rows/prompt-library')
                    ? { status: 200, data: rows } : read(url, config));
                const transport = vi.mocked(axios.request).getMockImplementation()!;
                const effects: string[] = [];
                let nativeAtMetadata = 0;
                let deploying = false;
                vi.spyOn(axios, 'request').mockImplementation(async request => {
                    const path = new URL(request.url!).pathname;
                    const base = `/v1/deployments/environments/${environment.environment.id}`;
                    if (deploying && selection === 'template install preparation failure' && path.endsWith('/secret-launch-admission')
                        && isRecord(request.data) && isRecord(request.data.materialization)
                        && request.data.materialization.kind === 'review') return { status: 403,
                        data: { ok: false, error: 'deployment_access_denied' } };
                    if (!['POST', 'PATCH'].includes(request.method ?? '') || ![base, `${base}/bindings`, `${base}/template`, `${base}/deploy`].includes(path)) return transport(request);
                    const body = readCarrierMutation(request.data);
                    if (path.endsWith('/deploy')) {
                        expect(effects.slice(-3)).toEqual(['definition', 'bindings', 'metadata']);
                        expect(body.actionOperationId).toBe('template-operation');
                        effects.push('deploy');
                        if (selection === 'template install pending receipt') return { status: 200,
                            data: DeploymentReceiptResultV1Schema.parse({ ok: true, environmentId: environment.environment.id,
                                revision: environment.environment.revision, kind: 'pending', actionOperationId: 'template-operation' }) };
                        return { status: 200, data: DeploymentReceiptResultV1Schema.parse({ ok: true,
                            environmentId: environment.environment.id, revision: environment.environment.revision,
                            deploymentId: 'template-deployment', deploymentRevision: 1,
                            state: selection === 'template install failed receipt' ? 'failed' : 'succeeded' }) };
                    }
                    effects.push(path.endsWith('/bindings') ? 'bindings' : path.endsWith('/template') ? 'metadata' : 'definition');
                    environment.environment.contentArtifactId = String(body.contentArtifactId);
                    environment.environment.contentHeaderVersion = Number(body.contentHeaderVersion);
                    environment.environment.contentBodyVersion = Number(body.contentBodyVersion);
                    environment.environment.revision++;
                    if (path.endsWith('/template')) nativeAtMetadata = (await docker.readInvocations()).length;
                    return { status: 200, data: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision } };
                });
                // First exercise the legacy path with this exact HTTP/Artifact fixture.
                // The deploy-intent assertion below then fails only for the missing effect.
                for (const deploy of [false, true]) {
                    deploying = deploy;
                    environment.content.name = deploy ? 'Renamed app' : 'app-journey-b-1101';
                    environment.content.definition = { kind: 'stored', document: 'services: {}', contentRevision: 1,
                        composeDigest: `sha256:${createHash('sha256').update('services: {}').digest('hex')}`, profiles: [], services: [] };
                    put(environment.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, environment.content);
                    effects.length = 0;
                    const input = DeploymentTemplateInstantiateInputV1Schema.parse({ mode: 'apply', serverId: 'home', machineId: 'machine-a',
                        projectSourceId: environment.environment.projectSourceId,
                        templateRef: { sourceId: source.id, itemId: 'app', version: selected.summary.version!, ref: selected.payload.ref },
                        environment: { kind: 'existing', environmentId: environment.environment.id, expectedRevision: environment.environment.revision },
                        target: { kind: 'existing', targetLinkId: currentTargetLinkId, expectedRevision: environment.targetLinks[0].targetLink.revision,
                            installationId: 'installation-a' }, destination: { kind: 'stored', contentRevision: 1,
                            composeDigest: environment.content.definition.composeDigest }, bindings: [] });
                    const requested = { ...input, ...(deploy ? { deploy: { requestKey: 'template-install' } } : {}) };
                    const before = (await docker.readInvocations()).length;
                    pendingPhase = deploy ? 'template-deploy' : 'template-legacy-control';
                    const context = { ...nativeReviewContext, runtimeAccountId: 'owner', actionRequestId: 'template-request',
                        operationAcceptance: { actionId: 'deployments.templates.instantiate', operationId: 'template-operation', accept() {} } };
                    let rawResult: unknown;
                    // DEPLOY-APPLY-SETTINGS routes every template deploy through
                    // the executor's real reviewed child, including partial results.
                    if (deploy) {
                        if (selection === 'template install') {
                            for (const explicitDeployRequire of [false, true]) {
                                expect(await executor.execute('deployments.templates.instantiate', requested, { ...context,
                                    surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
                                    serverId: 'home', serverIdentityId: 'home', interactivePresentation: 'unavailable',
                                    actionsSettings: ActionsSettingsV1Schema.parse({ v: 1,
                                        ...(explicitDeployRequire ? { approvalWaivedSurfaces: { 'deployments.templates.instantiate': ['agent'] },
                                            actions: { 'deployments.deploy': { approvalRequiredSurfaces: ['agent'] } } } : { actions: {} }) }),
                                })).toMatchObject({ ok: false, errorCode: 'action_interactive_review_required' });
                                expect(effects).toEqual([]);
                            }
                            const preview = await deps.deploymentTemplateInstantiate({ ...requested, mode: 'preview' }, context);
                            expect(preview).toMatchObject({ kind: 'preview', review: { deploy: { requestKey: 'template-install' } } });
                            expect(effects).toEqual([]);
                        }
                        const prepared = await executor.prepare('deployments.templates.instantiate', requested, { ...context,
                            surface: 'ui', authority: 'present_user',
                            actionCaller: { kind: 'host' }, serverId: 'home', serverIdentityId: 'home',
                            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }) });
                        expect(prepared, JSON.stringify(prepared)).toMatchObject({ kind: 'ready' });
                        if (prepared.kind !== 'ready') throw new Error('Expected one reviewed template invocation');
                        failTemplateArtifact = selection === 'template install artifact failure';
                        const outcome = await prepared.invocation.run();
                        if (selection === 'template install artifact failure' || selection === 'template install native failure' || selection === 'template install docker access denied') {
                            const artifactFailure = selection === 'template install artifact failure';
                            const expectedCode = artifactFailure ? 'create_failed' : 'native_failed';
                            const expectedCause = { phase: artifactFailure ? 'deployment.template.instantiate' : selection === 'template install native failure'
                                ? 'deployment.native.compose.config.native_compose_command_failed'
                                : 'deployment.native.docker.version.native_compose_command_failed',
                                errorClass: artifactFailure ? 'HttpStatusError' : 'Error', errorCode: artifactFailure ? 'create_failed'
                                    : selection === 'template install docker access denied' ? 'EACCES' : null,
                                httpStatus: artifactFailure ? 503 : null };
                            expect(outcome).toMatchObject({ ok: false, errorCode: expectedCode, failureCause: expectedCause,
                                ...(artifactFailure ? {} : { details: { kind: 'partial', phase: 'deploy', environmentId: environment.environment.id,
                                    targetLinkId: currentTargetLinkId, definition: { kind: 'stored' } } }) });
                            if (artifactFailure) {
                                expect(effects).toEqual([]);
                                expect(outcome).toMatchObject({ details: {
                                    requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/) } });
                            }
                            expect(JSON.stringify(outcome)).not.toContain('private-source-config-sentinel');
                            expect((await docker.readInvocations()).some(call => call.args.includes('up'))).toBe(false);
                            const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'executing', createdAtMs: 1, updatedAtMs: 2,
                                createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'deployments.templates.instantiate',
                                actionArgs: requested, summary: 'Install reviewed native template',
                                executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
                                    serverId: 'home', serverIdentityId: 'home', accountId: 'owner', machineId: 'machine-a',
                                    target: { kind: 'machine', machineId: 'machine-a' },
                                    actionId: 'deployments.templates.instantiate', requestId: 'template-request' },
                                decision: { kind: 'approve', decidedAtMs: 2 } });
                            const settled = projectSettledApprovalExecution({ request: approval, actionId: approval.actionId,
                                exec: outcome, dispatchEffectAttempted: true, executedAtMs: 3 });
                            const artifactId = 'native-diagnostic-approval';
                            put(artifactId, 'approval_request.v1', settled.request);
                            documents.get(artifactId)!.header = encode(buildApprovalRequestArtifactHeaderV1(settled.request));
                            const reader = createActionExecutor({ ...createUnavailableActionTransportDeps(),
                                ...createCliApprovalsArtifactStore({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://home.test' }) });
                            const observed = await runWithServerHttpBaseUrl('https://home.test', () => reader.execute('approval.request.get',
                                { artifactId }, { ...nativeReviewContext, surface: 'cli', authority: 'present_user', serverId: 'home' }));
                            expect(observed).toMatchObject({ ok: true, result: { request: { status: 'failed', execution: {
                                ok: false, effectAttempted: true, errorCode: expectedCode, failureCause: expectedCause } } } });
                            expect(JSON.stringify(observed)).not.toContain('private-artifact-response-sentinel');
                            expect(JSON.stringify(observed)).not.toContain('private-source-config-sentinel');
                            return;
                        }
                        await nativePhase('template-owner-returned');
                        expect(boundaryFailures).toEqual([]);
                        if (selection === 'template install') expect(outcome).toMatchObject({ ok: true });
                        else expect(outcome).toMatchObject({ ok: false,
                            errorCode: selection === 'template install preparation failure' ? 'deployment_access_denied'
                                : selection === 'template install failed receipt' ? 'deployment_failed' : 'deployment_in_progress',
                            details: { kind: 'partial', phase: 'deploy' } });
                        rawResult = outcome.ok ? outcome.result : outcome.details;
                    } else {
                        const prepared = await executor.prepare('deployments.templates.instantiate', requested, { ...context,
                            surface: 'ui', authority: 'present_user',
                            actionCaller: { kind: 'host' }, serverId: 'home', serverIdentityId: 'home',
                            actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, actions: {} }) });
                        expect(prepared.kind, JSON.stringify(prepared)).toBe('ready');
                        if (prepared.kind !== 'ready') throw new Error('Expected reviewed template binding writes');
                        const outcome = await prepared.invocation.run();
                        expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true });
                        rawResult = outcome.ok ? outcome.result : outcome.details;
                        await nativePhase('template-owner-returned');
                    }
                    expect(boundaryFailures).toEqual([]);
                    const result = DeploymentTemplateInstantiateResultV1Schema.parse(rawResult);
                    // Inspect every produced Environment revision, including the
                    // definition write before the bindings writer replaces it.
                    const artifacts = createCredentialedAccountArtifactStore(credentials);
                    for (const [id, stored] of documents) {
                        const artifact = await runWithServerHttpBaseUrl('https://home.test', () => artifacts.read(id, {
                            prepareRecipients: false, includeSharedAudience: false,
                        }));
                        if (artifact?.header.kind !== DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1) continue;
                        const reference = { contentArtifactId: id, contentHeaderVersion: Number(stored.headerVersion),
                            contentBodyVersion: Number(stored.bodyVersion) };
                        const detail = readDeploymentEnvironmentArtifactV1(reference, artifact);
                        if (!detail.ok) throw new Error(`Environment detail refused: ${detail.error}`);
                        expect(readDeploymentEnvironmentArtifactHeaderV1(reference, artifact),
                            'Environment list and detail names must agree after creation and rename')
                            .toEqual({ ok: true, title: detail.content.name });
                    }
                    if (deploy && selection !== 'template install') expect(result).toMatchObject({ kind: 'partial', phase: 'deploy',
                        environmentId: environment.environment.id, revision: environment.environment.revision,
                        targetLinkId: currentTargetLinkId, definition: { kind: 'stored' }, savedSecrets: [],
                        errorCode: selection === 'template install preparation failure' ? 'deployment_access_denied'
                            : selection === 'template install failed receipt' ? 'deployment_failed' : 'deployment_in_progress',
                        ...(selection === 'template install failed receipt' ? { deployment: { deploymentId: 'template-deployment', state: 'failed' } }
                            : selection === 'template install pending receipt' ? { deployment: { kind: 'pending', actionOperationId: 'template-operation' } } : {}) });
                    else expect(result).toMatchObject({ kind: 'applied', environmentId: environment.environment.id,
                        ...(deploy ? { deployment: { ok: true, deploymentId: 'template-deployment', state: 'succeeded' } } : {}) });
                    if (selection === 'template install' && deploy) {
                        const inventory = await executor.execute('deployments.teardown', {
                            serverId: 'home', environmentId: environment.environment.id,
                            targetLinkId: currentTargetLinkId, reason: 'manual', mode: 'preview',
                        }, { ...nativeReviewContext, surface: 'ui', actionCaller: { kind: 'host' } });
                        expect(inventory, JSON.stringify(inventory)).toMatchObject({ ok: true,
                            result: { ok: true, kind: 'preview', volumes: [] } });
                    }
                    const native = (await docker.readInvocations()).slice(nativeAtMetadata);
                    if (deploy) {
                        expect(nativeAtMetadata).toBe(before);
                        expect(effects).toEqual(['definition', 'bindings', 'metadata',
                            ...(selection === 'template install preparation failure' ? [] : ['deploy'])]);
                        if (selection !== 'template install preparation failure') expect(native.some(call => call.args.includes('config')
                            && !call.args.includes('--no-interpolate'))).toBe(true);
                    } else {
                        expect(effects).toEqual(['definition', 'bindings', 'metadata']);
                        expect((await docker.readInvocations()).length).toBe(before);
                    }
                }
                return;
            }
            if (storedPreparation || selection.startsWith('machine Use')) {
                if (teamReceiptHistory) {
                    environment.environment.capabilities = { role: 'deployer', read: true, deploy: true,
                        manage: false, manageBindings: false, manageTargets: false, delete: false };
                }
                const document = JSON.stringify({ services: { app: { image: image.registryReference,
                    ...(selection === 'stored preparation removed required binding'
                        ? { environment: { PASSWORD: '${DB_PASSWORD:?private-runtime-required-sentinel}',
                            PASSWORD_COPY: '${DB_PASSWORD}' } } : {}),
                } } });
                environment.content.definition = { kind: 'stored', contentRevision: 1, document,
                    composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['app'] };
                const stored = documents.get(environment.environment.contentArtifactId)!;
                documents.set(environment.environment.contentArtifactId, { ...stored,
                    body: encodePlainArtifactStoredContent({ body: JSON.stringify(environment.content) }) });
                const nativeBefore = (await docker.readInvocations()).length;
                phase('stored-cost-preparation');
                const input = { serverId: 'home', environmentId: environment.environment.id, targetLinkId: currentTargetLinkId,
                    ...(selection === 'machine Use pending stored definition' ? { requestKey: 'use-pending', whenBusy: 'supersede' as const } : {}) };
                if (selection === 'machine Use pending stored definition') pendingEnvelope = DeploymentPendingDeployV1Schema.parse({ t: 'plain', v: {
                    sourceIntent: environment.content.definition, requestKey: 'use-pending', targetLinkId: currentTargetLinkId,
                    actionOperationId: 'use-pending-operation',
                } });
                let context: Parameters<typeof deps.prepareDeploymentAction>[0]['context'] = nativeReviewContext;
                if (selection.startsWith('machine Use')) {
                    const target = { kind: 'machine' as const, machineId: 'machine-a' };
                    const envelope = { v: 1 as const, requestId: 'machine-use-stored', target, input };
                    const accountId = teamReceiptHistory ? 'member' : 'owner';
                    const rootAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'machine-use-stored-root', binding: {
                        serverIdentityId: 'home', accountId, authentication: { kind: 'account', tokenEpoch: 1 },
                        actionId: 'deployments.deploy', requestId: envelope.requestId, target,
                        machineId: 'machine-a', installationId: 'installation-a', custodianAccountId: 'owner', accountEncryptionMode: 'plain',
                        admittedMachineRole: 'use', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                        deploymentCandidatePublication: createDeploymentCandidatePublicationV1({
                            serverIdentityId: 'home', accountId, actionId: 'deployments.deploy', requestId: envelope.requestId,
                            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), environmentId: input.environmentId,
                            source: { id: environment.environment.projectSourceId, revision: 1 } }),
                    } });
                    const authorization = teamReceiptHistory ? sealExternalActionRequesterAccountContextV1({
                        authorization: rootAuthorization, purpose: { kind: 'external_action' },
                        credentials: { token: memberToken, secret: null, encryption: null },
                        installationPublicKey: keys.publicKey, randomBytes: length => new Uint8Array(randomBytes(length)),
                    }) : rootAuthorization;
                    requesterPreparation = await prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
                        machineId: 'machine-a', installationId: 'installation-a', installationPrivateKey: keys.secretKey,
                        serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test', ownCredentials: credentials,
                        isCurrent: async () => requesterCurrent, createExecutor: () => executor });
                    if (!requesterPreparation) throw new Error('Expected admitted stored deployment custody');
                    context = { externalActionExecutionAuthorization: requesterPreparation.authorization, originalActionEnvelope: envelope };
                    await expect(deps.prepareDeployCandidate({ environmentId: environment.environment.id,
                        sourceIntent: environment.content.definition, context }))
                        .resolves.toMatchObject({ ok: false, errorCode: 'action_forbidden' });
                }
                if (selection === 'stored preparation missing tool') {
                    const emptyPath = join(root, 'missing-tools');
                    await mkdir(emptyPath);
                    vi.stubEnv('PATH', emptyPath);
                }
                const preparedCost = await deps.prepareDeploymentAction({ actionId: 'deployments.deploy', input, context });
                if (selection === 'stored preparation missing tool') {
                    expect(preparedCost).toMatchObject({ ok: false, errorCode: 'plugin_exec_system_tool_unavailable',
                        details: { kind: 'systemToolUnavailable', toolId: 'docker', remedy: 'install_on_machine_and_add_to_daemon_path' } });
                    expect(JSON.stringify(preparedCost)).not.toContain(root);
                    expect((await docker.readInvocations()).some(call => call.args.includes('up'))).toBe(false);
                    return;
                }

                if (selection === 'stored preparation removed required binding') {
                    expect(preparedCost).toMatchObject({ ok: false,
                        errorCode: 'secret_missing', details: { deployable: false, missingRequiredSecretNames: ['DB_PASSWORD'] } });
                    expect(JSON.stringify(preparedCost)).not.toContain('private-runtime-required-sentinel');
                    expect((await docker.readInvocations()).some(call => call.args.includes('up'))).toBe(false);
                    return;
                }
                if (selection === 'stored preparation failure reason') {
                    expect(preparedCost).toMatchObject({ ok: false, errorCode: 'native_runtime_configuration_failed' });
                    expect(JSON.stringify(preparedCost)).not.toContain('private-runtime-config-sentinel');
                    expect((await docker.readInvocations()).some(call => call.args.includes('up'))).toBe(false);
                    return;
                }
                await nativePhase('stored-owner-returned');
                phase('stored-cost-prepared');
                expect(preparedCost).not.toHaveProperty('errorCode');
                if (!('input' in preparedCost)) throw new Error('native_preparation_failed');
                const native = (await docker.readInvocations()).slice(nativeBefore);
                const modelQueries = native.filter(call => call.args.includes('config') && !call.args.includes('--no-interpolate')
                    && !call.args.includes('--environment') && !call.args.includes('--variables'));
                if (selection === 'stored preparation cost') expect({
                    // Native runtime projection has a separate stdin lookup-
                    // name inventory with placeholder values. Only its final
                    // include normalization supplies the reviewed runtime model.
                    renders: {
                        build: modelQueries.filter(call => call.args[call.args.indexOf('--file') + 1]?.endsWith('candidate.compose.json')).length,
                        runtime: modelQueries.filter(call => call.args.includes('--no-consistency')
                            && call.args[call.args.indexOf('--file') + 1] !== '-').length,
                    },
                    secretPosts: preparationReads.secretPhases.length,
                    environmentReads: preparationReads.environments,
                }).toEqual({ renders: { build: 1, runtime: 1 }, secretPosts: 2, environmentReads: 1 });
                expect(preparedCost.preview).toMatchObject({ environment: { id: environment.environment.id },
                    runtimeMachines: [{ machineId: 'machine-a' }] });
                if (selection === 'stored preparation stale held') {
                    // #75: approve the retained exact candidate after the Environment moved 3 → 4.
                    expect(preparedCost.input.expectedRevision).toBe(3);
                    const nativeBeforeReplay = await docker.readInvocations();
                    const writesBeforeReplay = posts.mock.calls.length;
                    environment.environment.revision = 4;
                    const outcome = await deps.prepareDeploymentAction({ actionId: 'deployments.deploy', input: preparedCost.input,
                        context: { ...context, approvedActionReplay: { artifactId: 'stale-held-approval' } } });
                    const expectedCause = { phase: 'deployment.failure', errorClass: 'Error', errorCode: null, httpStatus: null };
                    const expectedDetails = { serverId: 'home', environmentId: environment.environment.id,
                        targetLinkId: preparedCost.input.targetLinkId, requiredFact: 'currentEnvironmentRevision',
                        currentEnvironmentRevision: 4, remedy: expect.any(String) };
                    expect(outcome).toMatchObject({ ok: false, errorCode: 'deployment_conflict', effectAttempted: false,
                        failureCause: expectedCause, details: expectedDetails });
                    expect(await docker.readInvocations()).toEqual(nativeBeforeReplay);
                    expect(posts.mock.calls).toHaveLength(writesBeforeReplay);
                    if (!('errorCode' in outcome)) throw new Error('Expected stale held deployment refusal');
                    const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'executing', createdAtMs: 1, updatedAtMs: 2,
                        createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'deployments.deploy',
                        actionArgs: preparedCost.input, summary: 'Deploy held native candidate',
                        executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
                            serverId: 'home', serverIdentityId: 'home', accountId: 'owner', machineId: 'machine-a',
                            target: { kind: 'machine', machineId: 'machine-a' }, actionId: 'deployments.deploy', requestId: 'stale-held' },
                        decision: { kind: 'approve', decidedAtMs: 2 } });
                    const settled = projectSettledApprovalExecution({ request: approval, actionId: approval.actionId,
                        exec: outcome, dispatchEffectAttempted: true, executedAtMs: 3 });
                    const artifactId = 'stale-held-approval';
                    put(artifactId, 'approval_request.v1', settled.request);
                    documents.get(artifactId)!.header = encode(buildApprovalRequestArtifactHeaderV1(settled.request));
                    const reader = createActionExecutor({ ...createUnavailableActionTransportDeps(),
                        ...createCliApprovalsArtifactStore({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://home.test' }) });
                    const observed = await runWithServerHttpBaseUrl('https://home.test', () => reader.execute('approval.request.get',
                        { artifactId }, { ...nativeReviewContext, surface: 'cli', authority: 'present_user', serverId: 'home' }));
                    expect(observed).toMatchObject({ ok: true, result: { request: { status: 'failed', execution: {
                        ok: false, errorCode: 'deployment_conflict', effectAttempted: false, failureCause: expectedCause,
                        details: expectedDetails } } } });
                }
                if (teamReceiptHistory) {
                    expect(memberHistoryReads).toBeGreaterThan(0);
                    expect(environment.environment.capabilities.manage).toBe(false);
                    expect(documents.get(historical.deployment.contentArtifactId)?.ownerAccountId).toBe('owner');
                    expect(documents.get(preparedCost.input.contentArtifactId)?.ownerAccountId).toBe('member');
                    expect(artifactGrants.get(preparedCost.input.contentArtifactId)).toMatchObject([
                        { principal: { kind: 'account', accountId: 'owner' }, accessLevel: 'admin' },
                        { principal: { kind: 'team', teamId: 'deployment-team' }, accessLevel: 'view' },
                    ]);
                }
                return;
            }
            if (selection === 'configured ref') {
                const environmentReads = () => vi.mocked(axios.get).mock.calls.filter(([url]) =>
                    new URL(url).pathname === `/v1/artifacts/${environment.environment.contentArtifactId}`).length;
                const beforeCandidate = environmentReads();
                const createBeforeEdit = posts.getMockImplementation()!;
                posts.mockImplementation(async (url, value, config) => {
                    const result = await createBeforeEdit(url, value, config);
                    if (url.endsWith('/v1/artifacts')) environment.environment.revision++;
                    return result;
                });
                expect(await deps.prepareDeployCandidate({ environmentId: environment.environment.id,
                    targetLinkId: currentTargetLinkId, context: nativeReviewContext })).toMatchObject({ ok: true });
                expect(environmentReads() - beforeCandidate,
                    'candidate preparation opens one Environment body; Team sharing reads only current owner metadata').toBe(1);
                posts.mockImplementation(createBeforeEdit);
            }
            if (triggerConsentSelection) {
                pendingPhase = 'trigger-save';
                const automationId = 'automation-1';
                const triggerId = 'deployment-trigger';
                const runId = '00000000-0000-4000-8000-000000000001';
                environment.content = DeploymentEnvironmentContentV1Schema.parse({ ...environment.content,
                    bindings: [createDeploymentVariableBindingV1({ name: 'LOG_LEVEL', phase: 'runtime', source: { kind: 'value', value: 'info' } })] });
                put(environment.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, environment.content);
                const starterResult = await executor.execute('workflow.starters.resolve', { key: 'deploy-on-push' },
                    { ...nativeReviewContext, surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' } });
                expect(starterResult).toMatchObject({ ok: true, result: { status: 'ready', example: { key: 'deploy-on-push' } } });
                if (!starterResult.ok) throw new Error('missing_deployment_starter');
                const starter = z.object({ status: z.literal('ready'), example: z.object({ definition: WorkflowDefinitionV1Schema }) })
                    .parse(starterResult.result);
                const definition = starter.example.definition;
                let stored: ReturnType<typeof AutomationDefinitionDetailSchema.parse> | undefined;
                const unused = async (): Promise<never> => { throw new Error('unexpected_automation_write'); };
                let nextTriggerId = 0;
                const triggerOwner = createAccountWorkflowTriggerActions({
                    nativeAccount: { accountId: 'owner', serverId: 'home', isCurrent: async () => true },
                    resolveEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
                    deploymentAction: deps.deploymentAction,
                    resolveWorkflow: async () => ({ definition }), newId: () => ++nextTriggerId === 1 ? triggerId : automationId,
                    randomBytes: length => new Uint8Array(length),
                    automations: {
                        get: async id => id === automationId ? stored ?? null : null,
                        list: async () => ({ automations: stored ? [stored] : [], nextCursor: null }),
                        listDetails: async () => ({ automations: stored ? [stored] : [], nextCursor: null }),
                        create: async input => {
                            stored = AutomationDefinitionDetailSchema.parse({ id: input.automationId, name: input.name, description: null,
                                enabled: input.enabled, targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null,
                                createdAt: 1, updatedAt: 1, workflowDefinitionId: null, scopeSessionId: null, executionRecipe: input.executionRecipe,
                                assignments: input.assignments?.map(row => ({ ...row, enabled: row.enabled ?? true, priority: row.priority ?? 0, updatedAt: 1 })),
                                triggers: input.triggers.map(row => {
                                    if (row.trigger.kind !== 'pluginEvent') throw new Error('expected_event');
                                    const sourceSelectorId = 'sourceSelectorId' in row.trigger ? row.trigger.sourceSelectorId : AutomationSourceSelectorIdV1Schema.parse('00000000-0000-4000-8000-000000000002');
                                    const triggerDefinitionEnvelope = 'triggerDefinitionEnvelope' in row.trigger ? row.trigger.triggerDefinitionEnvelope
                                        : sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding: { v: 1, automationId: input.automationId,
                                            triggerId: AutomationTriggerIdSchema.parse(row.triggerId), triggerRevision: 0, triggerKind: 'pluginEvent',
                                            eventRef: row.trigger.eventRef, sourceSelectorId }, definition: {
                                            v: 1, sourceInstanceId: row.trigger.sourceInstanceId, sourceConfig: row.trigger.sourceConfig,
                                            displayLabel: row.trigger.displayLabel, filter: row.trigger.filter,
                                            maximumObservationAgeMs: row.trigger.maximumObservationAgeMs } });
                                    return { id: row.triggerId, revision: 0, enabled: row.trigger.enabled, createdAt: 1, updatedAt: 1,
                                        kind: 'pluginEvent', eventRef: row.trigger.eventRef, sourceSelectorId,
                                        sourceContractVersion: row.trigger.sourceContractVersion, observation: { kind: 'checkpointedPull', watcher: null },
                                        sourceStatus: null, sourceCatalogStatus: null, triggerDefinitionEnvelope: JSON.stringify(triggerDefinitionEnvelope) };
                                }),
                            });
                            return stored;
                        }, reconcile: unused, delete: unused,
                    },
                });
                const saveInput = { target: { kind: 'inline', definition },
                    project: { machineId: 'machine-a', directory: repository }, deployment: {},
                    inputs: { serverId: 'home', environmentId: environment.environment.id, targetLinkId: currentTargetLinkId },
                    trigger: { kind: 'pluginEvent', enabled: true,
                        eventRef: { pluginId: 'happier.scm.forge.github', localId: selection === 'trigger claim consent merge'
                            ? 'automation/pull-request-merged-v1' : 'automation/repository-pushed-v1' },
                        sourceInstanceId: 'github:repository:77', sourceContractVersion: 1, sourceConfig: {}, displayLabel: 'Repository',
                        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
                            machineId: 'machine-a', materializationId: 'github-install', pluginId: 'happier.scm.forge.github' } },
                        filter: null, maximumObservationAgeMs: null },
                } satisfies Parameters<typeof triggerOwner.add>[0];
                const personContext = { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
                    runtimeAccountId: 'owner', serverId: 'home', actionRequestId: 'person-save' } satisfies NonNullable<Parameters<typeof triggerOwner.add>[1]>;
                environment.environment.protection = 'nonProduction';
                const saved = await triggerOwner.add(saveInput, personContext);
                const operation = saved.set.context?.actionApprovals?.[0]?.operation;
                if (!operation || !stored || !saved.set.context) throw new Error('missing_saved_consent');
                pendingPhase = 'trigger-claim';
                const parent = operation.parent;
                // Automatic approval covers the authored deploy operands. A
                // subsequent unrelated Environment edit must not hold a push.
                environment.content.name = 'Renamed after Automatic was saved';
                environment.content = DeploymentEnvironmentContentV1Schema.parse({ ...environment.content,
                    bindings: [createDeploymentVariableBindingV1({ name: 'LOG_LEVEL', phase: 'runtime', source: { kind: 'value', value: 'debug' } })] });
                environment.environment.revision += 1;
                environment.environment.protection = 'production';
                environment.environment.contentBodyVersion += 1;
                put(environment.environment.contentArtifactId, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, environment.content);
                documents.get(environment.environment.contentArtifactId)!.bodyVersion = environment.environment.contentBodyVersion;
                const triggerBindings = await prepareEnvironmentSecretBindings({
                    environmentId: environment.environment.id,
                    bindings: environment.content.bindings,
                    previousBindings: [],
                    runtimeInstallations: [{ machineId: 'machine-a', installationId: 'installation-a', publicKey: keys.publicKey }],
                    existingGrants: [],
                    assertCurrent: async () => {},
                });
                const triggerTransport = vi.mocked(axios.request).getMockImplementation()!;
                vi.spyOn(axios, 'request').mockImplementation(async request => {
                    const response = await triggerTransport(request);
                    if (!new URL(request.url!).pathname.endsWith('/secret-launch-admission')) return response;
                    if (!isRecord(response)) throw new Error('Expected the fixture HTTP response');
                    return { ...response, data: { ok: true, grants: triggerBindings.grants } };
                });
                const pushedSha = git('rev-parse', 'HEAD');
                const priorSourceIntent = receipt.content.sourceIntent;
                if (priorSourceIntent.kind !== 'repository') throw new Error('Expected a repository receipt source');
                expect(pushedSha).not.toBe(priorSourceIntent.sha);
                const normalizeCommit = (sha: string, providerDeliveryId: string) => {
                    const merged = selection === 'trigger claim consent merge';
                    const repositoryPayload = { id: 77, full_name: 'owner/source' };
                    const payload = merged ? { action: 'closed', repository: repositoryPayload, pull_request: {
                        id: 456, number: 34, merged: true, merged_at: '2026-08-10T12:05:06Z', merge_commit_sha: sha,
                        user: { id: 99, login: 'octocat', type: 'User' },
                        head: { sha: 'd'.repeat(40), ref: 'feature', repo: repositoryPayload },
                        base: { ref: 'main', repo: repositoryPayload },
                    } } : { repository: repositoryPayload, ref: 'refs/heads/main', before: priorSourceIntent.sha, after: sha };
                    const event = normalizeGithubWebhookDelivery({ eventType: merged ? 'pull_request' : 'push', providerDeliveryId,
                        receivedAtMs: 1000, rawBody: new TextEncoder().encode(JSON.stringify(payload)) }).automationEvent;
                    if (!event) throw new Error('Expected normalized deployment event');
                    return event;
                };
                const normalized = normalizeCommit(pushedSha, 'delivery-1');
                const base = { v: 1 as const, kind: 'pluginEvent' as const,
                    eventRef: normalized.eventRef,
                    sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse('00000000-0000-4000-8000-000000000002'), occurrenceId: normalized.occurrenceId,
                    occurredAt: normalized.occurredAtMs, payload: PluginJsonValueV2Schema.parse(normalized.payload) };
                const evidence = AutomationRunPluginEventTriggerEvidenceV1Schema.parse({ ...base, sourceInstanceId: 'github:repository:77', sourceContractVersion: 1,
                    observationReceivedAt: 1000, filter: { version: null, result: 'matched' } });
                const cause = AutomationRunCauseSchema.parse({ kind: 'trigger', triggerKind: 'pluginEvent', triggerId, triggerRevision: 1,
                    occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence: base }), occurredAt: base.occurredAt,
                    evidence: { eventRef: base.eventRef, sourceSelectorId: base.sourceSelectorId } });
                const captured = new Error('accepted_snapshot_captured');
                const nativePreparation = vi.spyOn(deps, 'prepareDeploymentAction');
                let accepted: ReturnType<typeof openWorkflowAcceptedSnapshotStoredEnvelopeV1> | undefined;
                let acceptedEnvelope = '';
                const coordinatorDeps = { token, accountId: 'owner', machineId: 'machine-a',
                    resolveControllerContext: async () => ({ ...nativeReviewContext, surface: 'cli', authority: 'account_automation', callerPermissionMode: 'yolo' }),
                    resolveAccountEncryption: async () => ({ kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }),
                    isAcceptedAuthorizationCurrent: async () => true,
                    prepareAcceptedWorkspaceTarget: async () => ({ ok: true, workspaceTarget: { project: { machineId: 'machine-a', directory: repository, checkoutRootPath: repository } } }),
                    resolveMaterializationHost: async ({ runId: admittedRunId }) => ({ effects: { resolveTargetAvailability: async () => true,
                        readActionContract: async id => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(id)))) },
                        admitLeaf: async (leaf, facts) => admitAgentStartV1(DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1, { kind: 'workflow_run_leaf', leaf }, {
                            caller: { kind: 'originless', runId: admittedRunId, runDepth: 0 }, baseline: { machineId: 'machine-a', directory: repository },
                            ledSubtreeSessionIds: [], roles: {}, workDepthLimit: 4, callerPermissionCeiling: facts.permissionCeiling,
                        }) }),
                    execution: { credentials, serverId: 'home', serverIdentityId: 'home',
                        machineAdmissionTransport: async () => { throw new Error('deployment_starter_must_not_create_agent'); },
                        resolveExistingSessionConversation: async () => null,
                        detachedRun: { actionExecutor: executor, buildActionContext: () => ({ ...nativeReviewContext, surface: 'cli', authority: 'account_automation' }) } },
                    onCommittedTransition: async () => {}, onReviewEntered: async () => {},
                } satisfies Parameters<typeof createProductionWorkflowRunCoordinator>[0];
                const coordinate = createProductionWorkflowRunCoordinator({ ...coordinatorDeps,
                    storage: { observeChanges: () => ({ dispose: async () => {} }), execute: async operation => {
                        expect(operation.operation).toBe('accepted-snapshot.resolve');
                        acceptedEnvelope = String(operation.acceptedEnvelope);
                        accepted = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'owner', runId },
                            envelope: parseWorkflowStoredContentEnvelopeV1(operation.acceptedEnvelope) });
                        throw captured;
                    } },
                });
                const createsBefore = posts.mock.calls.filter(([url]) => url.endsWith('/v1/artifacts')).length;
                const invoke = async (approvedOperation = operation, selectedTriggerId = triggerId): Promise<ReturnType<typeof openWorkflowAcceptedSnapshotStoredEnvelopeV1> | undefined> => {
                    accepted = undefined;
                    await expect(coordinate({ runId, automationId, attempt: 0, expectedRevision: 0, causeWorkDepth: 0,
                    automationCause: cause, accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
                    automationEvidenceEnvelope: JSON.stringify({ t: 'plain', v: evidence }),
                    definitionEnvelope: JSON.stringify({ t: 'plain', v: { ...saved.set.context,
                        actionApprovals: [{ triggerId: selectedTriggerId, operation: approvedOperation }] } }),
                    })).rejects.toBe(captured);
                    return accepted;
                };
                accepted = await invoke();
                expect(nativePreparation).not.toHaveBeenCalled();
                expect(accepted).toMatchObject({ kind: 'available', content: { approvedOperation: { approvedBy: { accountId: 'owner' },
                    parent, steps: operation.steps } } });
                if (accepted?.kind !== 'available') throw new Error('missing_accepted_snapshot');
                expect(accepted.content.origin).toMatchObject({ kind: 'direct',
                    actionPolicy: { authority: 'account_automation', approvalProfileId: null } });
                expect(accepted.content.materializedLeaves[0]?.actionInput).toEqual({ serverId: 'home', environmentId: environment.environment.id,
                    targetLinkId: currentTargetLinkId, sha: pushedSha,
                    requestKey: cause.kind === 'trigger' ? cause.occurrenceKey : '', whenBusy: 'supersede' });
                expect(posts.mock.calls.filter(([url]) => url.endsWith('/v1/artifacts'))).toHaveLength(createsBefore);
                expect(await docker.readInvocations()).not.toEqual(expect.arrayContaining([expect.objectContaining({ args: expect.arrayContaining(['up']) })]));
                // The accepted Run's real Workflow context reaches ordinary native
                // preparation before the receiving approval reader binds exact bytes.
                const originalInput = DeploymentDeployIntentInputV1Schema.parse(accepted.content.materializedLeaves[0]!.actionInput);
                const invocationId = 'deploy-invocation';
                const actionRequestId = `${runId}/${invocationId}/0`;
                // Home admission is the network boundary. Keep requester sealing,
                // installation custody, signed HTTP projections and native execution real.
                const admitWorkflowContext = async (input: unknown, context: ActionExecutorContext): Promise<ActionExecutorContext> => {
                    const caller = context.actionCaller;
                    if (caller?.kind !== 'workflowRun' || !context.actionRequestId) throw new Error('expected_workflow_invocation');
                    const target = { kind: 'machine' as const, machineId: 'machine-a' };
                    const envelope = { v: 1 as const, requestId: context.actionRequestId, target,
                        input: DeploymentDeployIntentInputV1Schema.parse(input) };
                    const digest = computeExternalActionRequestEnvelopeDigestV1(envelope);
                    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-workflow', binding: {
                        serverIdentityId: 'home', accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
                        admittedMachineRole: 'manage', actionId: 'deployments.deploy', requestId: envelope.requestId, target,
                        machineId: 'machine-a', installationId: 'installation-a', custodianAccountId: 'owner', accountEncryptionMode: 'plain',
                        requestEnvelopeDigest: digest, workflowActionOrigin: { runId: caller.runId, requestId: envelope.requestId },
                        deploymentCandidatePublication: createDeploymentCandidatePublicationV1({ serverIdentityId: 'home', accountId: 'owner',
                            actionId: 'deployments.deploy', requestId: envelope.requestId, requestEnvelopeDigest: digest,
                            environmentId: environment.environment.id, source: { id: environment.environment.projectSourceId, revision: 1 } }),
                    } });
                    const authorization = sealExternalActionRequesterAccountContextV1({ authorization: root,
                        purpose: { kind: 'external_action' }, credentials: { token, secret: null, encryption: null },
                        installationPublicKey: keys.publicKey, randomBytes: length => new Uint8Array(randomBytes(length)) });
                    const prepared = await prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
                        machineId: 'machine-a', installationId: 'installation-a', installationPrivateKey: keys.secretKey,
                        serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test',
                        isCurrent: async () => requesterCurrent, createExecutor: () => executor });
                    if (!prepared) throw new Error('workflow_requester_admission_failed');
                    onTestFinished(() => prepared.dispose());
                    return { ...context, serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'owner', externalActionTarget: target,
                        externalActionExecutionAuthorization: prepared.authorization, originalActionEnvelope: envelope };
                };
                const workflowContext = await admitWorkflowContext(originalInput,
                    { ...nativeReviewContext, ...buildWorkflowActionContext({ runId, authorization: accepted.content.authorization,
                        workspace: accepted.content.workspaceTarget.project }), actionRequestId });
                const runStorage = createWorkflowRunStorageTestkit({ runId, machineId: 'machine-a', accountId: 'owner', state: 'running',
                    origin: { kind: 'automation', automationId, cause }, acceptedEnvelope });
                const binding = { v: 1 as const, purpose: 'invocation_progress' as const, accountId: 'owner', runId,
                    recordId: invocationId, sequence: '1', parentRecordId: 'root', memberOrdinal: '0', attempt: '0' };
                const progress = { kind: 'happier.workflow-progress.v1' as const, blockKind: 'action' as const,
                    invocationPath: { blockId: 'deploy', scope: [] }, logicalInvocationRecordId: invocationId, attempt: '0' };
                await runStorage.execute({ operation: 'invocations.admit', runId, parentAttempt: 0, expectedRevision: 0, checkpointEnvelope: '{}',
                    invocations: [{ id: invocationId, sequence: '1', parentRecordId: 'root', memberOrdinal: '0',
                        contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding, progress })) }] });
                const reader = createWorkflowApprovedOperationReader({ storage: runStorage, resolveEncryption: async () => ({ witness: { mode: 'plain' } }),
                    readSavedTriggerConsent: input => triggerOwner.readSavedConsent(input, input.context) });
                const admissions: { phase: 'prepare' | 'dispatch'; input: unknown; semanticInput: unknown }[] = [];
                const triggerOperations = createHostActionOperationRuntime({ machineId: 'machine-a',
                    resolveAccountId: async () => 'owner', generateOperationId: () => `trigger-native-${randomBytes(8).toString('hex')}` });
                const triggerExecutor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...sourceDeps, ...deps,
                    runActionOperation: triggerOperations.runActionOperation,
                    // Plugin interception is the extension boundary; native preparation and custody stay real.
                    interceptActionExecution: async () => ({ status: 'continue', input: originalInput }),
                    readApprovedOperation: async request => {
                        admissions.push({ phase: request.phase, input: request.input, semanticInput: request.semanticInput });
                        return request.runId ? reader({ ...request, runId: request.runId }) : null;
                    } });
                pendingPhase = 'trigger-outermost-prepare';
                const preparedInvocation = await triggerExecutor.prepare('deployments.deploy',
                    DeploymentDeployIntentInputV1Schema.parse(originalInput), workflowContext);
                expect(nativePreparation).toHaveBeenCalledOnce();
                expect(preparedInvocation.kind, JSON.stringify(preparedInvocation)).toBe('ready');
                const nativePrepared = { input: DeploymentDeployInputV1Schema.parse(admissions[0]?.input) };
                expect(admissions).toEqual([{ phase: 'prepare', input: nativePrepared.input, semanticInput: originalInput }]);
                const preparedContent = await deps.readPreparedDeploymentContent({ input: nativePrepared.input, context: workflowContext });
                expect(preparedContent, 'errorCode' in preparedContent ? preparedContent.errorCode : undefined)
                    .toMatchObject({ ok: true, content: { sourceIntent: { sha: pushedSha }, ownServer: { approvedInputBasis: {
                        bindings: [{ purpose: 'variable', name: 'LOG_LEVEL', phase: 'runtime', source: { kind: 'value', value: 'debug' } }],
                    } } } });
                const request = { runId, actionId: 'deployments.deploy' as const, input: nativePrepared.input,
                    semanticInput: originalInput, context: workflowContext, phase: 'prepare' as const };
                const bound = await reader(request);
                expect(bound).toMatchObject({ parent, approvedBy: { accountId: 'owner' },
                    steps: [{ actionId: 'deployments.deploy', input: nativePrepared.input }] });
                const policy = { actionId: 'deployments.deploy' as const, spec: getActionSpec('deployments.deploy'),
                    input: nativePrepared.input, context: workflowContext, approvedOperation: bound,
                    approvalScope: { kind: 'environment' as const, environmentId: environment.environment.id } };
                expect(resolveActionApprovalRouting(policy).required).toBe(false);
                expect(resolveActionApprovalRouting({ ...policy, settings: ActionsSettingsV1Schema.parse({ v: 1,
                    actions: { 'deployments.deploy': { approvalRequiredSurfaces: ['agent'] } } }) }).required).toBe(true);
                await runStorage.execute({ operation: 'invocations.fact', runId, invocationId, invocationAttempt: '0', expectedLifecycle: 'pending', expectedContentRevision: '0',
                    lifecycle: 'admitting', contentEnvelope: serializeWorkflowStoredContentEnvelopeV1(sealWorkflowProgressStoredEnvelopeV1({ mode: 'plain', binding,
                        progress: { ...progress, execution: { kind: 'action', actionId: 'deployments.deploy', actionRequestId, localInputId: 'deploy-input', input: originalInput } } })) });
                expect(await reader({ ...request, phase: 'dispatch' })).toMatchObject({ steps: [{ input: nativePrepared.input }] });
                pendingPhase = 'trigger-dispatch';
                if (preparedInvocation.kind === 'ready') {
                    const result = await preparedInvocation.invocation.run();
                    expect(result, 'errorCode' in result ? String(result.errorCode) : undefined).toMatchObject({ ok: true });
                }
                // Dispatch consumes the exact private proof retained by its admission.
                expect(admissions).toEqual([{ phase: 'prepare', input: nativePrepared.input, semanticInput: originalInput }]);
                expect(triggerDeployRequests).toEqual([expect.objectContaining({
                    requestKey: originalInput.requestKey, contentArtifactId: nativePrepared.input.contentArtifactId,
                })]);
                pendingPhase = 'trigger-controls';
                stored.triggers[0]!.enabled = false;
                expect(await reader({ ...request, phase: 'dispatch' })).toBeNull();
                const createsAfterNative = posts.mock.calls.filter(([url]) => url.endsWith('/v1/artifacts')).length;
                for (const [invalid, selectedTrigger] of [[{ ...operation, approvedBy: { accountId: 'other-owner' } }, triggerId],
                    [operation, 'other-trigger']] as const) {
                    const ordinary = await invoke(invalid, selectedTrigger);
                    expect(ordinary).toMatchObject({ kind: 'available' });
                    if (ordinary?.kind !== 'available') throw new Error('missing_ordinary_snapshot');
                    expect(ordinary.content.approvedOperation).toBeUndefined();
                }
                stored.triggers[0]!.enabled = true;
                expect(await reader({ ...request, semanticInput: { ...originalInput, whenBusy: 'refuse' }, phase: 'dispatch' })).toBeNull();
                expect(nativePreparation).toHaveBeenCalledOnce();
                expect(posts.mock.calls.filter(([url]) => url.endsWith('/v1/artifacts'))).toHaveLength(createsAfterNative);
                // Withdrawal applies to a fresh admission, whose context has no retained proof.
                stored.triggers[0]!.enabled = false;
                const admissionsBeforeWithdrawal = admissions.length;
                const deployRequestsBeforeWithdrawal = triggerDeployRequests.length;
                const activationsBeforeWithdrawal = (await docker.readInvocations())
                    .filter(call => call.args.includes('up')).length;
                const withdrawn = await triggerExecutor.prepare('deployments.deploy',
                    DeploymentDeployIntentInputV1Schema.parse(originalInput), workflowContext);
                expect(withdrawn).toMatchObject({ kind: 'settled', result: { ok: false, errorCode: 'approvals_not_supported' } });
                expect(admissions).toHaveLength(admissionsBeforeWithdrawal + 1);
                expect(admissions.at(-1)).toMatchObject({ phase: 'prepare', semanticInput: originalInput });
                expect(triggerDeployRequests).toHaveLength(deployRequestsBeforeWithdrawal);
                expect((await docker.readInvocations()).filter(call => call.args.includes('up')))
                    .toHaveLength(activationsBeforeWithdrawal);
                // Run the registered starter through production executeActionBlock,
                // with real saved consent/native preparation and opaque Run storage.
                // The HTTP boundary settles each admitted deployment receipt.
                stored.triggers[0]!.enabled = true;
                const completedInputs: unknown[] = [];
                for (const [ordinal, sha] of [receipt.content.sourceIntent.sha, pushedSha].entries()) {
                    const journeyRunId = `00000000-0000-4000-8000-${String(ordinal + 10).padStart(12, '0')}`;
                    const normalizedJourney = normalizeCommit(sha, `journey-${ordinal}`);
                    const occurrence = { ...base, occurrenceId: normalizedJourney.occurrenceId,
                        occurredAt: normalizedJourney.occurredAtMs, payload: PluginJsonValueV2Schema.parse(normalizedJourney.payload) };
                    const journeyEvidence = AutomationRunPluginEventTriggerEvidenceV1Schema.parse({ ...evidence, ...occurrence });
                    const journeyCause = AutomationRunCauseSchema.parse({ ...cause,
                        occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId, evidence: occurrence }) });
                    const storage = createWorkflowRunStorageTestkit({ runId: journeyRunId, machineId: 'machine-a', accountId: 'owner',
                        state: 'claimed', origin: { kind: 'automation', automationId, cause: journeyCause } });
                    const readApprovedOperation = createWorkflowApprovedOperationReader({ storage,
                        resolveEncryption: async () => ({ witness: { mode: 'plain' } }),
                        readSavedTriggerConsent: input => triggerOwner.readSavedConsent(input, input.context) });
                    let nativeContext: ActionExecutorContext | undefined;
                    const journeyExecutor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...sourceDeps, ...deps,
                        runActionOperation: triggerOperations.runActionOperation,
                        readApprovedOperation: input => input.runId ? readApprovedOperation({ ...input, runId: input.runId }) : Promise.resolve(null),
                        observeActionExecution: async observation => {
                            if (observation.actionId === 'deployments.deploy') completedInputs.push(observation.result);
                        } });
                    const run = createProductionWorkflowRunCoordinator({ ...coordinatorDeps, storage,
                        execution: { ...coordinatorDeps.execution, action: { executor: { ...journeyExecutor,
                            // Installed requester ingress after the Home transport boundary.
                            prepare: async (id, input, context) => {
                                if (id !== 'deployments.deploy') return journeyExecutor.prepare(id, input, context);
                                nativeContext = await admitWorkflowContext(input, context ?? {});
                                return journeyExecutor.prepare(id, input, nativeContext);
                            } },
                            buildContext: async execution => ({ ...nativeReviewContext, ...buildWorkflowActionContext(execution) }),
                            observeRun: async () => { throw new Error('deployment_starter_must_not_create_agent'); } } } });
                    const result = await run({ runId: journeyRunId, automationId, attempt: 0, expectedRevision: 0, causeWorkDepth: 0,
                        automationCause: journeyCause, accountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
                        automationEvidenceEnvelope: JSON.stringify({ t: 'plain', v: journeyEvidence }),
                        definitionEnvelope: JSON.stringify({ t: 'plain', v: saved.set.context }) });
                    expect(result, JSON.stringify(result)).toMatchObject({ state: 'succeeded' });
                    expect(storage.run()).toMatchObject({ state: 'succeeded' });
                    const prepared = await nativePreparation.mock.results.at(-1)?.value;
                    expect(prepared).toMatchObject({ input: {
                        requestKey: journeyCause.kind === 'trigger' ? journeyCause.occurrenceKey : '', whenBusy: 'supersede' } });
                    if (!prepared || !('input' in prepared) || !nativeContext) throw new Error('missing_native_starter_candidate');
                    const candidateInput = DeploymentDeployInputV1Schema.parse(prepared.input);
                    expect(await deps.readPreparedDeploymentContent({ input: candidateInput, context: nativeContext }))
                        .toMatchObject({ ok: true, content: { sourceIntent: { sha } } });
                    expect(triggerDeployRequests.at(-1)).toMatchObject({ contentArtifactId: candidateInput.contentArtifactId,
                        requestKey: candidateInput.requestKey });
                    const snapshot = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
                        binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'owner', runId: journeyRunId },
                        envelope: parseWorkflowStoredContentEnvelopeV1(storage.acceptedEnvelope()!) });
                    expect(snapshot).toMatchObject({ kind: 'available', content: { approvedOperation: { parent, approvedBy: { accountId: 'owner' } },
                        materializedLeaves: [{ actionInput: { sha, requestKey: journeyCause.kind === 'trigger' ? journeyCause.occurrenceKey : '', whenBusy: 'supersede' } }] } });
                }
                expect(completedInputs).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
                expect(triggerDeployRequests).toHaveLength(deployRequestsBeforeWithdrawal + 2);
                // The same template has no default person consent on Production.
                const productionSaved = await triggerOwner.add(saveInput, personContext);
                expect(productionSaved.set.context?.actionApprovals).toBeUndefined();
                return;
            }
            expect(deps).toHaveProperty('prepareDeployCandidate', expect.any(Function));
            if (selection === 'missing native builder') {
                delete environment.environment.buildMachineId;
                expect(await deps.prepareDeployCandidate({ environmentId: environment.environment.id,
                    targetLinkId: currentTargetLinkId, context: nativeReviewContext })).toMatchObject({
                    ok: false, errorCode: 'required_fact_unavailable', details: { requiredFact: 'buildMachineId' } });
                return;
            }
            const input = { serverId: homeServerIdentityId, environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
                targetLinkId: currentTargetLinkId, expectedTargetLinkRevision: 1, requestKey: 'prepare',
                contentArtifactId: receipt.deployment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 };
            expect(git('rev-parse', 'HEAD')).not.toBe(receipt.content.sourceIntent.sha);
            expect(await readFile(join(repository, 'compose.yaml'), 'utf8')).toBe('uncommitted bytes must not enter the candidate');
            await expect(deps.prepareDeploymentAction({ actionId: 'deployments.deploy', input,
                context: { ...nativeReviewContext, approvedActionReplay: { artifactId: 'approved-action' } } }))
                .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
            const minimal = { serverId: homeServerIdentityId, environmentId: environment.environment.id,
                targetLinkId: currentTargetLinkId, ...(selection === 'configured ref' ? { onFailure: 'keepPartial' as const } : {}) };
            await expect(deps.prepareDeploymentAction({ actionId: 'deployments.deploy', input: minimal,
                context: { ...nativeReviewContext, approvedActionReplay: { artifactId: 'approved-action' } } }))
                .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
            const candidateRequest = { environmentId: environment.environment.id, targetLinkId: currentTargetLinkId,
                ...(selection === 'compact exact SHA' ? { sha: receipt.content.sourceIntent.sha } : { sourceIntent: receipt.content.sourceIntent }),
                requestKey: 'approved-event', whenBusy: 'supersede' as const, context: nativeReviewContext };
            const compactInput = { serverId: homeServerIdentityId, environmentId: environment.environment.id,
                sha: receipt.content.sourceIntent.sha, requestKey: 'approved-event', whenBusy: 'supersede' as const,
                onFailure: 'keepPartial' as const };
            const compactRollbackInput = { serverId: homeServerIdentityId, environmentId: environment.environment.id,
                deploymentId: historical.deployment.id };
            let preparationContext: Parameters<typeof deps.prepareDeploymentAction>[0]['context'] = nativeReviewContext;
            if (selection === 'compact exact SHA' || selection === 'pending exact SHA' || selection.startsWith('retained rollback intent')) {
                // Home admission is the HTTP boundary. The real requester
                // preparer opens Account custody and produces signed read ports.
                const target = { kind: 'machine' as const, machineId: 'machine-a' };
                const actionId = rollbackSelection ? 'deployments.rollback' as const : 'deployments.deploy' as const;
                const rootBinding = { serverIdentityId: homeServerIdentityId, accountId: 'owner',
                    authentication: { kind: 'account' as const, tokenEpoch: 1 }, actionId,
                    requestId: 'compact-native-review', target };
                const rootInput = rollbackSelection ? compactRollbackInput : compactInput;
                // The receipt-page UI seals its unchanged compact root before native preparation.
                const envelope = mode === 'e2ee' ? sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: rootBinding, input: rootInput,
                    material: { type: 'dataKey', machineKey }, randomBytes: length => new Uint8Array(randomBytes(length)) })
                    : { v: 1 as const, requestId: rootBinding.requestId, target, input: rootInput };
                const preparationAdmission = projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({ actionId, envelope });
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'compact-native-root', binding: {
                    serverIdentityId: rootBinding.serverIdentityId, accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 },
                    admittedMachineRole: 'manage',
                    actionId, deploymentChildRoot: true, requestId: envelope.requestId, target,
                    machineId: 'machine-a', installationId: 'installation-a', custodianAccountId: 'owner', accountEncryptionMode: mode,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                    ...(preparationAdmission ? { deploymentPreparationAdmission: preparationAdmission } : {}),
                    deploymentCandidatePublication: createDeploymentCandidatePublicationV1({
                        serverIdentityId: rootBinding.serverIdentityId, accountId: 'owner', actionId, requestId: envelope.requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), environmentId: compactInput.environmentId,
                        source: { id: environment.environment.projectSourceId, revision: 1 },
                    }),
                } });
                requesterPreparation = await prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
                    machineId: 'machine-a', installationId: 'installation-a', installationPrivateKey: keys.secretKey,
                    serverId: 'home', serverIdentityId: rootBinding.serverIdentityId, serverHttpBaseUrl: 'https://home.test', ownCredentials: credentials,
                    isCurrent: async () => requesterCurrent, createExecutor: () => executor });
                expect(requesterPreparation).not.toBeNull();
                if (!requesterPreparation) throw new Error('Expected admitted compact review custody');
                preparationContext = { ...nativeReviewContext, serverIdentityId: rootBinding.serverIdentityId,
                    externalActionTarget: target,
                    externalActionExecutionAuthorization: requesterPreparation.authorization,
                    originalActionEnvelope: envelope };
            }
            phase('before-candidate');
            const candidate = selection === 'approved exact SHA' || selection === 'native tool version changes'
                ? await deps.prepareDeployCandidate(candidateRequest) : undefined;
            phase('candidate-ready');
            if (candidate) {
                expect(candidate).not.toHaveProperty('errorCode');
                if (!candidate.ok) throw new Error(candidate.errorCode);
                expect(candidate.content.sourceIntent).toEqual(receipt.content.sourceIntent);
                expect(candidate.input).toMatchObject({ requestKey: 'approved-event', whenBusy: 'supersede' });
                expect(candidate.content.machineResults).toMatchObject([{ currentDeploymentId: historical.deployment.id }]);
                expect(historicalReads).toEqual({ headers: 0, bodies: 1 });
            }
            const retainedBeforePreparation = structuredClone(documents.get(historical.deployment.contentArtifactId));
            const preparation = selection.startsWith('retained rollback intent')
                ? { actionId: 'deployments.rollback' as const, input: compactRollbackInput }
                : selection === 'retained rollback'
                ? { actionId: 'deployments.rollback' as const,
                    input: DeploymentActionInputSchemasV1['deployments.rollback'].parse({ ...input,
                        deploymentId: historical.deployment.id, requestKey: 'approved-event',
                        contentArtifactId: historical.deployment.contentArtifactId,
                        contentHeaderVersion: historical.deployment.contentHeaderVersion,
                        contentBodyVersion: historical.deployment.contentBodyVersion }) }
                : { actionId: 'deployments.deploy' as const,
                    input: selection === 'compact exact SHA' || selection === 'pending exact SHA' ? compactInput : candidate?.input ?? minimal };
            pendingPhase = 'initial-native-preparation';
            if (rollbackSelection) await expect(resolveOwnServerDeploymentIdentityForHost({
                happierHomeDir: root, serverId: 'home', environmentId: environment.environment.id,
            })).resolves.toMatchObject({ homeServerIdentityId: 'srv_preparation_home' });
            if (mode === 'e2ee') {
                // Enter the real Action executor with only the compact intent;
                // native preparation, candidate encryption and review stay real.
                const invocation = await executor.prepare('deployments.rollback', compactRollbackInput, {
                    ...preparationContext, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                    serverId: 'home', runtimeAccountId: 'owner',
                }, { reviewOnly: true });
                if (invocation.kind === 'settled') throw new Error(`Rollback preparation settled: ${JSON.stringify(invocation.result)}`);
                expect(invocation).toMatchObject({ kind: 'ready', operation: { actionId: 'deployments.rollback' } });
                if (invocation.kind !== 'ready' || !invocation.operation) throw new Error('Expected reviewed rollback Action');
                preparation.input = DeploymentActionInputSchemasV1['deployments.rollback'].parse(invocation.operation.normalizedInput);
            }
            const prepared = await deps.prepareDeploymentAction({ ...preparation, context: preparationContext });
            await nativePhase('review-ready');
            expect(boundaryFailures).toEqual([]);
            expect(prepared, JSON.stringify(prepared)).not.toHaveProperty('errorCode');
            if (!('input' in prepared)) throw new Error('Expected prepared deployment');
            if (selection.startsWith('retained rollback intent')) {
                const child = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'member', actionId: 'deployments.rollback',
                    input: prepared.input, machineId: 'machine-a', installationId: 'installation-a',
                    deploymentId: 'rollback-receipt', actionOperationId: 'rollback-operation', phase: 'activate',
                    selectedDeploymentId: historical.deployment.id });
                expect(await isReviewedDeploymentChild({ authorization: preparationContext.externalActionExecutionAuthorization!,
                    envelope: preparationContext.originalActionEnvelope, actionId: 'deployments.rollback',
                    machineId: 'machine-a', params: child })).toBe(true);
                const rpc = { credentials, machineId: 'machine-a', method: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD,
                    request: child, requireCurrentMachine: true, externalAction: {
                        context: preparationContext, effectActionId: 'deployments.rollback',
                        installationId: 'installation-a', privateKey: keys.secretKey } };
                // Real requester custody and derivation run before HTTP/socket effects.
                requesterCurrent = false;
                const staleRequester = await callExactMachineRpc(rpc).catch((error: unknown) => error);
                expect(staleRequester).toMatchObject({ code: 'machine_target_not_current', reason: 'requester_not_current' });
                expect(readMachineRpcRequestDisposition(staleRequester)).toBe('notSent');
                requesterCurrent = true;
                const foreignChild = await callExactMachineRpc({ ...rpc, request: {
                    ...child, input: { ...child.input, deploymentId: 'foreign-release' } } }).catch((error: unknown) => error);
                expect(foreignChild).toMatchObject({ code: 'machine_target_not_current', reason: 'child_not_derived',
                    derivationReason: 'child_input_mismatch' });
                expect(readMachineRpcRequestDisposition(foreignChild)).toBe('notSent');
                const foreignRoot = await callExactMachineRpc({ ...rpc, externalAction: { ...rpc.externalAction,
                    context: { ...preparationContext, originalActionEnvelope: {
                        ...preparationContext.originalActionEnvelope!, requestId: 'foreign-original-root' } } } })
                    .catch((error: unknown) => error);
                expect(foreignRoot).toMatchObject({ code: 'machine_target_not_current', reason: 'child_not_derived',
                    derivationReason: 'root_binding_mismatch' });
                expect(readMachineRpcRequestDisposition(foreignRoot)).toBe('notSent');
            }
            if (selection === 'compact exact SHA') {
                const authorization = preparationContext.externalActionExecutionAuthorization!;
                const target = { kind: 'machine' as const, machineId: 'machine-a' };
                const origin = buildApprovalExecutionOriginV1({ actionId: 'deployments.deploy', input: prepared.input, targetSessionId: null,
                    admittedInput: prepared.input, context: { ...preparationContext, surface: 'mcp', authority: 'account_automation',
                        actionCaller: { kind: 'host' }, serverId: 'home', serverIdentityId: 'home', runtimeAccountId: 'owner',
                        actionRequestId: authorization.binding.requestId, externalActionTarget: target,
                        signExternalActionApprovalInput: ({ actionId, input, target, authorization: signedAuthorization }) =>
                            signExternalActionApprovalInputV1({ authorizationToken: signedAuthorization.token,
                                actionId, input, target, privateKey: keys.secretKey }),
                    } });
                const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'approved', createdAtMs: 1, updatedAtMs: 2,
                    createdBy: { surface: 'system' }, actionId: 'deployments.deploy', actionArgs: prepared.input,
                    summary: 'Review native deployment', executionOriginV1: origin,
                    decision: { kind: 'approve', decidedAtMs: 2 } });
                expect(resolveApprovalExecutor(request)).toEqual({ kind: 'daemon', machineId: 'machine-a' });
                const reasons: string[] = [];
                const currentness = createDaemonApprovalExecutionOriginCurrentness({ accountId: 'owner', machineId: 'machine-a', serverId: 'home',
                    resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'home', machineId: 'machine-a' }),
                    resolveTarget: async () => target, isAccountCurrent: async () => true,
                    listAccountApiTokens: async () => { throw new Error('Ordinary Account approval does not use PAT lookup'); },
                    externalActionMachinePublicKey: keys.publicKey,
                    // Home verification is the network boundary; native preparation and the exact signed carrier stay real.
                    verifyExternalExecutionAuthorization: async () => true,
                });
                expect(await currentness({ origin: request.executionOriginV1, request,
                    reportStale: reason => reasons.push(reason) })).toBe(true);
                expect(reasons).toEqual([]);
                expect(await currentness({ origin: request.executionOriginV1,
                    request: { ...request, actionArgs: compactInput } })).toBe(false);
            }
            if (preparationContext.externalActionExecutionAuthorization) expect(prepared.input.contentArtifactId).toBe(
                preparationContext.externalActionExecutionAuthorization.binding.deploymentCandidatePublication?.contentArtifactId);
            if (rollbackSelection) expect(prepared.input).toMatchObject({
                requestKey: selection.startsWith('retained rollback intent') ? expect.any(String) : 'approved-event',
                deploymentId: historical.deployment.id,
                expectedRevision: environment.environment.revision, targetLinkId: currentTargetLinkId,
                expectedTargetLinkRevision: environment.targetLinks[0].targetLink.revision });
            else if (!configuredRef) expect(prepared.input).toMatchObject({ requestKey: 'approved-event', whenBusy: 'supersede' });
            expect(prepared.preview).toMatchObject({ machineId: 'machine-a',
                environment: { id: environment.environment.id, name: environment.content.name },
                revision: { kind: 'repository', sha: receipt.content.sourceIntent.sha }, replaces: null,
                runtimeMachines: [{ machineId: 'machine-a', review: { revision: { kind: 'repository', sha: receipt.content.sourceIntent.sha } } }],
            });
            expect(prepared.input.contentArtifactId).not.toBe(input.contentArtifactId);
            const candidateDocument = documents.get(prepared.input.contentArtifactId)!;
            expect(candidateDocument.encryptionMode).toBe(mode);
            const reviewedContent = await deps.readPreparedDeploymentContent({ input: prepared.input, context: preparationContext });
            expect(reviewedContent).toMatchObject({ ok: true, content: { sourceIntent: receipt.content.sourceIntent,
                ownServer: { approvedInputBasis: { sourceIntent: receipt.content.sourceIntent } } } });
            if (!reviewedContent.ok) throw new Error(reviewedContent.errorCode);
            if (selection === 'configured ref' || selection === 'compact exact SHA' || selection === 'pending exact SHA') {
                expect(prepared.input).toMatchObject({ onFailure: 'keepPartial' });
                expect(prepared.preview).toMatchObject({ onFailure: 'keepPartial' });
                expect(reviewedContent.content).toMatchObject({ onFailure: 'keepPartial' });
            }
            if (mode === 'e2ee') {
                expect(candidateDocument.dataEncryptionKey).not.toBe(ARTIFACT_PLAIN_DATA_KEY_MARKER);
                expect(String(candidateDocument.body)).not.toContain('approvedInputBasis');
                expect(decodePlainArtifactStoredContent(String(candidateDocument.body))).toBeNull();
            }
            const retained = mode === 'plain' ? decodePlainArtifactStoredContent(String(candidateDocument.body))
                : { body: JSON.stringify(reviewedContent.content) };
            expect(retained).toMatchObject({ body: expect.stringContaining('approvedInputBasis') });
            if (!retained || typeof retained !== 'object' || !('body' in retained) || typeof retained.body !== 'string') throw new Error('Reviewed candidate is required');
            const reviewedCandidate = DeploymentContentV1Schema.parse(JSON.parse(retained.body));
            expect(reviewedCandidate).toMatchObject({ sourceIntent: receipt.content.sourceIntent, images: [image] });
            if (selection.startsWith('retained rollback intent')) {
                expect(prepared.input.contentArtifactId).not.toBe(historical.deployment.contentArtifactId);
                expect(reviewedCandidate).toMatchObject({ machineResults: [], steps: [], ownServer: { approvedInputBasis: {
                    environmentRevision: environment.environment.revision, targetLinkId: currentTargetLinkId,
                    targetLinkRevision: environment.targetLinks[0].targetLink.revision } } });
                expect(documents.get(historical.deployment.contentArtifactId)).toEqual(retainedBeforePreparation);
            }
            const cancelled = new AbortController(); cancelled.abort();
            await expect(deps.readPreparedDeploymentContent({ input: prepared.input, context: { signal: cancelled.signal } }))
                .resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
            const creates = posts.mock.calls.filter(([url]) => url.endsWith('/v1/artifacts')).length;
            if (selection !== 'stale Team grant') expect(grantedCandidates.size).toBe(selection === 'configured ref' ? creates : 0);
            if (selection === 'configured ref') expect(grantedCandidates.has(prepared.input.contentArtifactId)).toBe(true);
            pendingPhase = 'review-replay';
            if (selection === 'native tool version changes') {
                const executable = await readFile(docker.executablePath, 'utf8');
                expect(executable).toContain('2.39.4');
                // Docker is the OS boundary; retain the real native review and
                // change only the installed tool's reported version.
                await writeFile(docker.executablePath, executable.replace('2.39.4', '2.40.1'));
            }
            const replay = await deps.prepareDeploymentAction({ actionId: preparation.actionId, input: prepared.input, context: nativeReviewContext });
            await nativePhase('replay-ready');
            expect(replay).toMatchObject({ input: prepared.input });
            if (selection === 'native tool version changes') {
                expect(replay).toHaveProperty('preview.environment.id', environment.environment.id);
                expect(reviewedContent.content).toHaveProperty('ownServer.approvedInputBasis.toolVersion', '2.39.4');
                expect(documents.get(prepared.input.contentArtifactId)).toEqual(candidateDocument);
                environment.environment.revision++;
                await expect(deps.prepareDeploymentAction({ actionId: preparation.actionId, input: prepared.input, context: nativeReviewContext }))
                    .resolves.toMatchObject({ ok: false, errorCode: 'deployment_conflict', effectAttempted: false,
                        details: { requiredFact: 'currentEnvironmentRevision' } });
                environment.environment.revision--;
                environment.targetLinks[0].targetLink.revision++;
                await expect(deps.prepareDeploymentAction({ actionId: preparation.actionId, input: prepared.input, context: nativeReviewContext }))
                    .resolves.toMatchObject({ ok: false, errorCode: 'deployment_conflict', effectAttempted: false,
                        details: { requiredFact: 'currentEnvironmentRevision' } });
                environment.targetLinks[0].targetLink.revision--;
            }
            expect(posts.mock.calls.filter(([url]) => url.endsWith('/v1/artifacts'))).toHaveLength(creates);
            if (mode === 'e2ee') {
                // A valid ciphertext for another resource cannot open under the
                // candidate's key. Keep the real Account Artifact decoder here.
                documents.set(prepared.input.contentArtifactId, { ...candidateDocument,
                    body: documents.get(environment.environment.contentArtifactId)!.body });
                const substitutedCiphertext = await deps.readPreparedDeploymentContent({ input: prepared.input, context: preparationContext });
                expect(substitutedCiphertext, JSON.stringify(substitutedCiphertext))
                    .toMatchObject({ ok: false, errorCode: 'artifact_encryption_material_unavailable' });
                documents.set(prepared.input.contentArtifactId, candidateDocument);
                requesterCurrent = false;
                await expect(deps.readPreparedDeploymentContent({ input: prepared.input, context: preparationContext }))
                    .resolves.toMatchObject({ ok: false });
                expect(posts.mock.calls.filter(([url]) => url.endsWith('/v1/artifacts'))).toHaveLength(creates);
            }
            await expect(docker.readInvocations()).resolves.not.toEqual(expect.arrayContaining([expect.objectContaining({ args: expect.arrayContaining(['up']) })]));
            expect(boundaryFailures).toEqual([]);
            if (selection === 'approved exact SHA') {
                const orchestrationRuntime = createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'home',
                    resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
                    serverHttpBaseUrl: 'https://home.test', machineId: 'orchestration-host',
                    async acquirePluginRuntimeRegistryLease() { return mounted.lease; },
                    readEnvironmentSecretLaunchAdmission: readEnvironmentSecretLaunchAdmissionForHost });
                const orchestrationDeps = createDaemonDeploymentActionDeps({
                    resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
                    credentials, serverId: 'home',
                    serverHttpBaseUrl: 'https://home.test', machineId: 'orchestration-host', runtime: orchestrationRuntime });
                // A distinct deployment host may coordinate review.
                // This direct call has no signed root for the receiving member;
                // refusal belongs to child dispatch, before any native effect.
                const nativeCallsBeforeIndependentReview = await docker.readInvocations();
                expect(await orchestrationDeps.prepareDeploymentAction({ actionId: 'deployments.deploy',
                    input: prepared.input, context: ownerContextFor('orchestration-host') }))
                    .toMatchObject({ ok: false, errorCode: 'action_forbidden',
                        error: 'action_forbidden (child_dispatch_context_missing)' });
                expect(await docker.readInvocations()).toEqual(nativeCallsBeforeIndependentReview);
                expect(documents.get(prepared.input.contentArtifactId)).toEqual(candidateDocument);
            }
            if (selection === 'stale Team grant') {
                const { ownServer: _reviewed, ...unreviewedContent } = DeploymentContentV1Schema.parse(JSON.parse(retained.body));
                const staleCandidateId = 'candidate-before-owner-change';
                put(staleCandidateId, DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, unreviewedContent);
                const createBeforeOwnerChange = posts.getMockImplementation()!;
                posts.mockImplementation(async (url, value, config) => {
                    const result = await createBeforeOwnerChange(url, value, config);
                    // The receipt and its audience were admitted atomically.
                    // Withdrawal takes effect at the next admission.
                    if (url.endsWith('/v1/artifacts')) {
                        environment.environment.owner = { kind: 'team', teamId: 'replacement-team' };
                        environment.environment.revision += 1;
                    }
                    return result;
                });
                const grantsBeforeOwnerChange = grantedCandidates.size;
                await expect(deps.prepareDeploymentAction({ actionId: 'deployments.deploy', input: {
                    ...prepared.input, contentArtifactId: staleCandidateId, contentHeaderVersion: 1, contentBodyVersion: 1,
                }, context: nativeReviewContext })).resolves.not.toHaveProperty('errorCode');
                await nativePhase('admitted-owner-audience-retained');
                expect(grantedCandidates.size).toBe(grantsBeforeOwnerChange + 1);
                environment.environment.owner = { kind: 'team', teamId: 'deployment-team' };
                // Fresh candidate admission captures its audience before native
                // preparation. Withdrawal during that admitted work does not
                // trigger another ownership decision before publication.
                await expect(deps.prepareDeployCandidate({ environmentId: environment.environment.id,
                    targetLinkId: currentTargetLinkId, context: nativeReviewContext }))
                    .resolves.toMatchObject({ ok: true });
                expect(grantedCandidates.size).toBe(grantsBeforeOwnerChange + 2);
                // Home refuses the next admission after Team access is withdrawn.
                // Only its real HTTP boundary is substituted here.
                const readBeforeWithdrawal = vi.mocked(axios.request).getMockImplementation()!;
                vi.mocked(axios.request).mockImplementation(async request => {
                    if (new URL(request.url!).pathname.endsWith(`/environments/${environment.environment.id}`)) {
                        return { status: 200, data: DeploymentEnvironmentGetResultV1Schema.parse({
                            ok: false, error: 'deployment_access_denied',
                        }) };
                    }
                    return readBeforeWithdrawal(request);
                });
                const nativeCallsBeforeWithdrawal = await docker.readInvocations();
                const createsBeforeWithdrawal = posts.mock.calls.filter(([url]) => url.endsWith('/v1/artifacts')).length;
                await expect(deps.prepareDeployCandidate({ environmentId: environment.environment.id,
                    targetLinkId: currentTargetLinkId, context: nativeReviewContext }))
                    .resolves.toMatchObject({ ok: false, errorCode: 'deployment_access_denied' });
                expect(grantedCandidates.size).toBe(grantsBeforeOwnerChange + 2);
                expect(posts.mock.calls.filter(([url]) => url.endsWith('/v1/artifacts'))).toHaveLength(createsBeforeWithdrawal);
                expect(await docker.readInvocations()).toEqual(nativeCallsBeforeWithdrawal);
            }
            if (selection === 'pending exact SHA') {
                const scope = { accountId: 'owner', machineId: 'machine-a' };
                const store = createActionOperationStore();
                const runner = createActionOperationRunner({ store, generateOperationId: () => 'pending-native',
                    resolveAction: actionId => ({ actionId, title: 'Deploy', operation: getActionSpec('deployments.deploy').operation }) });
                try {
                    pendingPhase = 'pending-acceptance';
                    const accepted = await runner.observe({ actionId: 'deployments.deploy', scope, input: prepared.input,
                        execute: async context => {
                            const result = await deps.deploymentAction('deployments.deploy', prepared.input, {
                                ...preparationContext,
                                signal: context.signal, operationAcceptance: context.operationAcceptance,
                                operationOwnerUpdate: { update: context.publishOwnerUpdate },
                            });
                            return 'errorCode' in result ? result : { ok: true as const, result };
                        } });
                    phase('pending-accepted');
                    expect(accepted).toMatchObject({ ok: true, result: { kind: 'pending', actionOperationId: 'pending-native' } });
                    expect(store.get(scope, 'pending-native')).toMatchObject({ state: 'running' });
                    expect(resumed).toBe(0);
                    // The builder's mutable HEAD/ref/editor all differ from A;
                    // only the retained sourceIntent may enter fresh preparation.
                    busy = false;
                    environment.environment.revision += 1;
                    environment.targetLinks[0].targetLink.revision += 1;
                    const change = buildDeploymentAccountChangeV1({ environmentId: environment.environment.id, revision: environment.environment.revision });
                    pendingPhase = 'settlement-wake-and-fresh-preparation';
                    pendingSocket.emit('update', { id: 'settled', seq: 1, createdAt: 1,
                        body: { t: 'account-change', entityIds: [change.entityId], changeKinds: [change.kind] } });
                    const terminal = await runner.waitForTerminal(scope, 'pending-native', undefined, { includeSetupReview: true });
                    pendingPhase = 'terminal-refusal-and-cleanup';
                    await nativePhase('pending-terminal');
                    const terminalErrorCode = terminal && 'failure' in terminal ? terminal.failure?.errorCode : undefined;
                    expect(resumed, terminalErrorCode).toBe(1);
                    expect(terminal).toMatchObject({ state: 'failed' });
                    expect(terminalErrorCode).not.toBe('deployment_content_unavailable');
                    expect(terminalErrorCode).not.toBe('outcome_unknown');
                    expect(pendingEnvelope).toBeDefined();
                    await requesterPreparation?.dispose();
                    requesterPreparation = null;
                    expect([...pendingSocket.listeners.values()].reduce((sum, group) => sum + group.size, 0)).toBe(0);
                    expect((await docker.readInvocations()).some(call => call.args.includes('up'))).toBe(false);
                } finally {
                    runner.cancel(scope, 'pending-native');
                    await runner.waitForTerminal(scope, 'pending-native', undefined, { includeSetupReview: true });
                }
            }
            // Native settlement requires original-Account signed child admission.
            // The ONE deploymentComposeJourney exercises that real Action boundary;
            // this fixture owns candidate/ref/review preparation only.
        } finally {
            phase('cleanup-start');
            await requesterPreparation?.dispose();
            await mounted.dispose();
            phase('plugin-disposed');
            await rm(root, { recursive: true, force: true });
            phase('cleanup-complete');
        }
    // Native composition uses the CLI integration lane's existing test budget.
    }, 60_000);
    it('refuses a substituted candidate Artifact revision before acquiring native custody or admitting a receipt', async () => {
        const environment = createDeploymentEnvironmentDetailV1();
        const receipt = createDeploymentReceiptDetailV1();
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
            if (url.includes('/v1/artifacts/')) return { status: 200, data: {
                id: receipt.deployment.contentArtifactId, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                header: encodePlainArtifactStoredContent({ kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: 'Candidate' }),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(receipt.content) }),
                encryptionMode: 'plain', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 2,
                seq: 1, createdAt: 1, updatedAt: 1,
            } };
            throw new Error(`Unexpected HTTP read: ${url}`);
        });
        const writes = vi.spyOn(axios, 'post');
        let acquisitions = 0;
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const deps = createDaemonDeploymentActionDeps({
            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' } as const),
            credentials: { token, encryption: null },
            serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
            runtime: { async acquire() { acquisitions++; throw new Error('A stale candidate must not reach native custody'); } } });
        await expect(deps.prepareDeploymentAction({ actionId: 'deployments.deploy', input: {
            serverId: 'home', environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
            targetLinkId: receipt.deployment.targetLinkId, expectedTargetLinkRevision: 1, requestKey: 'request',
            contentArtifactId: receipt.deployment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1,
        }, context: ownerContext })).resolves.toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
        expect(acquisitions).toBe(0);
        expect(writes).not.toHaveBeenCalled();
    });
});
