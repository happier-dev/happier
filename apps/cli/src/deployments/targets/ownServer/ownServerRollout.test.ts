import axios from 'axios';
import nacl from 'tweetnacl';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { DeploymentOwnServerContentV1Schema, EnvironmentVariableBindingV1Schema, OwnServerEnvironmentConfigurationV1Schema, OwnServerDeploymentInputBasisV1Schema } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1, createDeploymentReceiptHeaderV1, createDeploymentSecretVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { configuration } from '@/configuration';
import { projectDeploymentTransitionOutcomeUnknownForHost } from '@/deployments/deploymentTransitionResult';
import * as persistence from '@/persistence';
import type { ServerProfile } from '@/server/serverProfiles';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { resolveOwnServerDeploymentIdentityForHost } from './paths';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import { readAccountNoticeArtifactV1, projectAccountNoticeInboxItemV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { projectSettledApprovalExecution } from '@happier-dev/protocol/actions/executor/approvalResults';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import * as installationStore from '@/daemon/identity/store';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createOwnServerDockerBoundary } from './ownServerDeployment.testkit';
import { createOwnServerDeploymentRuntimeForHost } from './ownServerDeploymentHostRuntime';
import { buildOwnServerDeploymentReceipt } from './buildReceipt';
import { executeOwnServerRollout } from './ownServerRollout';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionOperationSnapshotV1Schema } from '@happier-dev/protocol/actions/operations/v1';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import { readDeploymentChildResult } from '../../deploymentChild';
import { prepareRollbackForHost } from '../../prepareRollbackForHost';
import { createOwnServerDeploymentTargetForHost, type OwnServerDeploymentTargetForHost,
    type OwnServerDeploymentTargetHostInput, type OwnServerDeploymentRequest, type OwnServerDeploymentReceipt,
    type OwnServerDeploymentMemberRouteEnrollmentForHost } from './ownServerDeploymentTarget';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each([
    { autoRestore: false, members: 2, baseline: true, expectedDown: true, failure: 'machine_unavailable', restores: 2, state: 'failed' },
    { autoRestore: false, members: 1, baseline: true, rollback: true, thrownFailure: 'rpc', failure: 'RPC_FORBIDDEN', restores: 0, state: 'failed' },
    { autoRestore: false, members: 1, baseline: true, rollback: true, thrownFailure: 'rpc-carrier', failure: 'RPC_FORBIDDEN', restores: 0, state: 'failed' },
    { autoRestore: false, members: 1, baseline: true, rollback: true, thrownFailure: 'untyped', failure: 'deployment_failed', restores: 0, state: 'failed' },
    { autoRestore: false, members: 1, baseline: true, failure: 'machine_unavailable', restores: 0, state: 'failed' },
    { autoRestore: true, members: 1, baseline: true, failure: 'machine_unavailable', restores: 1, state: 'failed' },
    { autoRestore: false, members: 2, baseline: true, failure: 'machine_unavailable', restores: 2, state: 'failed' },
    { autoRestore: true, members: 1, baseline: true, failure: 'outcome_unknown', restores: 0, state: 'outcome_unknown' },
    { autoRestore: true, members: 1, baseline: true, failure: 'cancelled', restores: 0, state: 'cancelled' },
    { autoRestore: true, members: 1, baseline: true, serverCancellation: 'initial', failure: 'outcome_unknown', restores: 0, state: 'outcome_unknown' },
    { autoRestore: true, members: 1, baseline: true, serverCancellation: 'observe', failure: 'action_forbidden', restores: 0, state: 'cancelled' },
    { autoRestore: true, members: 1, baseline: true, serverCancellation: 'build', failure: 'action_forbidden', restores: 0, state: 'cancelled' },
    { autoRestore: true, members: 2, baseline: true, serverCancellation: 'activate', failure: 'action_forbidden', restores: 0, state: 'cancelled' },
    { autoRestore: true, members: 1, baseline: true, serverCancellation: 'activate', failure: 'outcome_unknown', restores: 0, state: 'outcome_unknown' },
    { autoRestore: true, members: 1, baseline: true, serverCancellation: 'activate', childUnknownAck: true, failure: 'outcome_unknown', restores: 0, state: 'outcome_unknown' },
    { autoRestore: false, members: 1, baseline: false, failure: 'machine_unavailable', restores: 0, state: 'failed' },
    { autoRestore: false, members: 1, baseline: false, failure: 'quota_exceeded', restores: 0, state: 'failed' },
    { autoRestore: false, members: 1, baseline: false, failure: 'deployment_image_unavailable', cleanupFailure: 'deployment_generation_required', restores: 0, state: 'failed' },
    { autoRestore: false, members: 1, baseline: false, failure: 'deployment_image_unavailable', cleanupFailure: 'native_service_control_unconfirmed', cleanupAuthored: true, restores: 0, state: 'failed' },
    { autoRestore: true, members: 1, baseline: true, advancePlacement: true, failure: 'machine_unavailable', restores: 1, state: 'failed' },
    { autoRestore: true, members: 2, baseline: true, editBindings: true, failure: 'machine_unavailable', restores: 2, state: 'failed' },
    { autoRestore: true, members: 1, baseline: true, retryAfterEnvironmentEdit: true, failure: 'machine_unavailable', restores: 1, state: 'failed' },
    { autoRestore: false, members: 1, baseline: true, migrationPolicy: 'rollbackCodeOnly', failure: 'machine_unavailable', restores: 1, state: 'failed' },
    { autoRestore: true, members: 2, baseline: true, migrationPolicy: 'ask', failure: 'machine_unavailable', restores: 0, state: 'failed' },
    { autoRestore: true, members: 2, baseline: true, restoreBackupId: 'recorded-backup', failure: 'backup_required', restores: 0, state: 'failed' },
] as const)('honors automatic restore=$autoRestore for $members member(s) after $failure (baseline=$baseline, server=$serverCancellation, unknownAck=$childUnknownAck, placement=$advancePlacement, bindings=$editBindings, retry=$retryAfterEnvironmentEdit, migration=$migrationPolicy, expected=$expectedDown)', async scenario => {
    const { autoRestore, members, baseline, failure, restores, state } = scenario;
    const expectedDown = 'expectedDown' in scenario;
    const operationScope = { accountId: 'account-expected', machineId: 'controller' };
    const operationStore = createActionOperationStore();
    const blocked: Array<{ machineId: string; resume(): void }> = [];
    if (expectedDown) {
        const settings = await persistence.readSettings();
        const profile: ServerProfile = { id: 'home', name: 'Home', serverUrl: 'https://rollout-home.test',
            webappUrl: 'https://rollout-home.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1,
            homeConnectionDescriptorAuthority: 'exact', homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1,
                homeServerIdentityId: 'srv_rollout_home', canonicalServerUrl: 'https://rollout-home.test', revision: 1,
                endpoints: [{ kind: 'https', url: 'https://rollout-home.test' }] }) };
        vi.spyOn(persistence, 'readSettings').mockResolvedValue({ ...settings, servers: { home: profile } });
    }
    const advancePlacement = 'advancePlacement' in scenario && scenario.advancePlacement;
    const editBindings = 'editBindings' in scenario && scenario.editBindings;
    const retryAfterEnvironmentEdit = 'retryAfterEnvironmentEdit' in scenario && scenario.retryAfterEnvironmentEdit;
    const migrationPolicy = 'migrationPolicy' in scenario ? scenario.migrationPolicy : undefined;
    const environment = createDeploymentEnvironmentDetailV1();
    environment.content.ownServer = OwnServerEnvironmentConfigurationV1Schema.parse({ ...environment.content.ownServer,
        autoRestorePreviousRelease: autoRestore,
        ...(migrationPolicy ? { migrationFailurePolicy: migrationPolicy, backupBeforeMigration: false,
            migration: { service: 'app', argv: ['migrate'] } } : {}) });
    const link = environment.targetLinks[0].targetLink;
    link.machines = ['machine-a', 'machine-b'].slice(0, members);
    link.members = link.machines.map(machineId => ({ machineId, installationId: `installation-${machineId}`, state: 'active' }));
    link.activeDeploymentId = 'uniform';
    if (!baseline) delete link.activeDeploymentId;
    const receipt = createDeploymentReceiptDetailV1();
    receipt.deployment = { ...receipt.deployment, id: 'candidate', state: 'queued', targetLinkId: link.id,
        ...('serverCancellation' in scenario ? { revision: 4 } : {}),
        acceptedExecution: { v: 1,
            controller: { machineId: environment.environment.controllerMachineId, installationId: link.members[0].installationId },
            builder: { machineId: link.machines[0], installationId: link.members[0].installationId } } };
    receipt.content = { ...receipt.content, machines: link.machines, buildMachineId: link.machines[0], onFailure: 'rollbackAll',
        machineResults: [], ownServer: { approvedInputBasis: OwnServerDeploymentInputBasisV1Schema.parse({ v: 1,
            environmentId: environment.environment.id, environmentRevision: environment.environment.revision,
            targetLinkId: link.id, targetLinkRevision: link.revision, sourceIntent: receipt.content.sourceIntent,
            manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'project',
            toolVersion: '2.40.1', services: ['app'], profiles: [], bindings: [], images: receipt.content.images, ownServer: environment.content.ownServer,
            ...('serverCancellation' in scenario && scenario.serverCancellation === 'build' ? { buildServices: ['app'] } : {}),
            members: link.members.map(({ machineId, installationId }) => ({ machineId, installationId })) }) } };
    const uniform = structuredClone(receipt);
    uniform.deployment = { ...uniform.deployment, id: 'uniform', state: 'succeeded' };
    if ('serverCancellation' in scenario && scenario.serverCancellation === 'initial') {
        receipt.deployment = { ...receipt.deployment, state: 'outcome_unknown', revision: 6, cancelRequestedAtMs: 1794181907621 };
    }
    const controller = new AbortController();
    const phases: string[] = [];
    const runningVersions = new Map(link.machines.map(machineId => [machineId, 'uniform']));
    const cancelledChild = () => {
        // K7's cancel route accepts running revision 5 and returns revision 6
        // while the finite child is active. Its later read can be refused.
        expect(receipt.deployment.revision).toBe(5);
        receipt.deployment = { ...receipt.deployment, state: 'outcome_unknown',
            revision: 6, cancelRequestedAtMs: 1794181907621 };
        if ('childUnknownAck' in scenario) return readDeploymentChildResult({ ok: true,
            environmentId: environment.environment.id, revision: environment.environment.revision,
            deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: 'outcome_unknown' });
        return { ok: false as const, errorCode: failure, error: failure };
    };
    let environmentReads = 0;
    const host: OwnServerDeploymentTargetHostInput = {
        credentials: { token: 'home-boundary', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
        async readEnvironment() {
            if (advancePlacement && ++environmentReads === 2) {
                environment.environment.buildMachineId = 'future-builder';
                environment.environment.revision++;
            }
            return structuredClone(environment);
        },
        async readReceipt({ deploymentId }) { return structuredClone(deploymentId === 'uniform' ? uniform : receipt); },
        async writeTransition(input) {
            expect(input.expectedRevision).toBe(receipt.deployment.revision);
            receipt.content = DeploymentOwnServerContentV1Schema.parse(input.content);
            receipt.deployment = { ...receipt.deployment, revision: receipt.deployment.revision + 1, state: input.state };
            return { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: input.state };
        },
        runtime: { async acquire() { throw new Error('Controller must not acquire remote native custody'); } },
        async dispatchBuild() { return cancelledChild(); },
        async readExpectedDownDomains() { return [{ environmentId: environment.environment.id, targetLinkId: link.id,
            domainId: 'domain', machineId: 'edge-c', installationId: 'edge-installation' }]; },
        // Only Home storage and the remote native response are substituted.
        async dispatchMember({ machineId, installationId, phase, selectedDeploymentId }) {
            phases.push(phase);
            if (expectedDown && (phase === 'activate' || phase === 'restore')) {
                await new Promise<void>(resume => blocked.push({ machineId, resume }));
            }
            if ('serverCancellation' in scenario && phase === scenario.serverCancellation) {
                return cancelledChild();
            }
            if (phase === 'observe' && 'thrownFailure' in scenario) {
                if (scenario.thrownFailure === 'rpc') throw new RpcError('private-native-error-sentinel', scenario.failure);
                if (scenario.thrownFailure === 'rpc-carrier') throw { rpcErrorCode: scenario.failure };
                throw new Error('private-native-error-sentinel');
            }
            if (phase === 'activate') {
                if (migrationPolicy) {
                    receipt.content.steps.push({ id: 'own-server-migration', label: 'Run candidate migration', state: 'succeeded' });
                    receipt.deployment.revision++;
                }
                if (failure === 'cancelled') controller.abort();
                if (editBindings && machineId === link.machines[0]) {
                    runningVersions.set(machineId, selectedDeploymentId);
                    // The receiving machine authors its successful native row.
                    receipt.content.machineResults.push({ machineId, installationId, activation: 'succeeded', health: 'healthy',
                        currentDeploymentId: selectedDeploymentId, actionOperationId: receipt.deployment.actionOperationId, steps: [] });
                    receipt.deployment.revision++;
                } else {
                    if (editBindings) {
                        // A manager edits bindings after A has cut over, just
                        // before B reports a known failure. U is still serving.
                        environment.content.bindings = [createDeploymentSecretVariableBindingV1({ name: 'DATABASE_PASSWORD',
                            phase: 'runtime', resourceId: 'edited-password', resourceRevision: 1 })];
                        environment.environment.revision++;
                    }
                    return failure === 'quota_exceeded'
                        ? readDeploymentChildResult({ ok: false, error: failure, budget: 'document', limitBytes: 1, usedBytes: 2 })
                        : { ok: false, errorCode: failure, error: failure };
                }
            }
            if (phase === 'cleanup' && 'cleanupFailure' in scenario) {
                if ('cleanupAuthored' in scenario) {
                    receipt.content.machineResults[0].steps.push({ id: 'own-server-candidate-cleanup', label: 'Remove first-deploy candidate', state: 'failed' });
                    receipt.deployment.revision++;
                }
                return { ok: false, errorCode: scenario.cleanupFailure, error: 'private-native-error-sentinel' };
            }
            if (phase === 'restore') runningVersions.set(machineId, selectedDeploymentId);
            return { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: 'running' };
        },
    };
    const request: OwnServerDeploymentRequest = { actionId: 'restoreBackupId' in scenario || 'rollback' in scenario ? 'deployments.rollback' : 'deployments.deploy', input: {
        serverId: 'home', environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
        targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: receipt.deployment.requestKey,
        contentArtifactId: receipt.deployment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1,
        ...('rollback' in scenario ? { deploymentId: uniform.deployment.id } : {}),
        ...('restoreBackupId' in scenario ? { deploymentId: uniform.deployment.id, restoreBackupId: scenario.restoreBackupId } : {}) },
        receipt: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
            deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: 'queued' },
        context: { operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
    let executionRequest = request;
    if (retryAfterEnvironmentEdit) {
        // The first admission committed, but its dispatch response was lost.
        // Home's same-requestKey branch returns that receipt with the current
        // Environment revision (deploymentService.createDeploymentInTx).
        const acceptedRequest = structuredClone(request.input);
        environment.content.name = `${environment.content.name} renamed`;
        environment.environment.revision++;
        executionRequest = { ...request, receipt: { ...request.receipt, revision: environment.environment.revision } };
        expect(request.input).toEqual(acceptedRequest);
        expect(request.receipt.revision).not.toBe(executionRequest.receipt.revision);
    }
    let completed = false;
    const runRollout = (selected: OwnServerDeploymentRequest) => executeOwnServerRollout(host, selected,
        { ...structuredClone({ environment, link, receipt }), signal: controller.signal });
    const executed = (async () => {
        if (!expectedDown) return retryAfterEnvironmentEdit
            ? createOwnServerDeploymentTargetForHost(host).execute(executionRequest) : runRollout(request);
        const spec = getActionSpec('deployments.deploy');
        const runner = createActionOperationRunner({ store: operationStore,
            generateOperationId: () => receipt.deployment.actionOperationId,
            resolveAction: () => ({ actionId: spec.id, title: spec.title, operation: spec.operation }) });
        let outcome: Awaited<ReturnType<typeof runRollout>> | undefined;
        await runner.observe({ actionId: spec.id, scope: operationScope, input: request.input,
            execute: async ({ publishOwnerUpdate, operationAcceptance }) => {
                outcome = await runRollout({ ...request, context: { ...request.context, operationAcceptance,
                    operationOwnerUpdate: { update: publishOwnerUpdate } } });
                return outcome.ok ? { ok: true, result: outcome } : outcome;
            } });
        if (!outcome) throw new Error('Expected the real rollout to settle');
        return outcome;
    })().finally(() => { completed = true; });
    if (expectedDown) {
        while (!completed) {
            await vi.waitFor(() => expect(completed || blocked.length > 0).toBe(true));
            const child = blocked.shift();
            if (!child) continue;
            try {
                const snapshot = ActionOperationSnapshotV1Schema.parse(operationStore.get(operationScope, receipt.deployment.actionOperationId));
                expect(snapshot).toMatchObject({ state: 'running', domainRef: { kind: 'deployment', expectedDown: {
                    operation: 'deploy', machineId: child.machineId, installationId: `installation-${child.machineId}`,
                    serviceIds: [`${createHash('sha256').update('srv_rollout_home').digest('hex')}--${environment.environment.id}/app`],
                    domains: [{ domainId: 'domain', machineId: 'edge-c', installationId: 'edge-installation' }],
                } } });
            } finally { child.resume(); }
        }
        expect(operationStore.get(operationScope, receipt.deployment.actionOperationId)?.state).not.toBe('running');
    }
    const outcome = await executed;
    expect(outcome).toMatchObject('cleanupFailure' in scenario
        ? { ok: false, errorCode: scenario.cleanupFailure, error: expect.stringContaining(scenario.cleanupFailure) }
        : 'restoreBackupId' in scenario || retryAfterEnvironmentEdit
        ? { ok: false, errorCode: failure } : { ok: true, state });
    expect(JSON.stringify(outcome)).not.toContain('private-native-error-sentinel');
    if ('serverCancellation' in scenario) {
        expect(receipt.deployment.state).toBe(state);
        expect(phases.filter(phase => phase === 'activate')).toHaveLength(scenario.serverCancellation === 'activate' ? 1 : 0);
        expect(receipt.content.machineResults).toEqual([]);
        expect(link.activeDeploymentId).toBe('uniform');
        if (scenario.serverCancellation === 'initial') {
            expect(phases).toEqual([]);
            expect(receipt.deployment.revision).toBe(6);
        }
    }
    expect(phases.filter(phase => phase === 'restore')).toHaveLength(restores);
    expect(phases.filter(phase => phase === 'cleanup')).toHaveLength(baseline ? 0 : 1);
    expect(link.activeDeploymentId).toBe(baseline ? 'uniform' : undefined);
    expect(receipt.deployment.state).toBe(state);
    if ('serverCancellation' in scenario) expect(receipt.content.failure).toBeUndefined();
    else {
        expect(receipt.content.failure).toMatchObject({ code: failure });
        expect(JSON.stringify(receipt.content.failure)).not.toContain('private-native-error-sentinel');
    }
    expect(receipt.content.ownServer?.rollbackTarget).toEqual('serverCancellation' in scenario && scenario.serverCancellation === 'initial' ? undefined : baseline
        ? { deploymentId: uniform.deployment.id, revision: { kind: 'repository', sha: 'a'.repeat(40) } } : null);
    if (editBindings) expect([...runningVersions.values()]).toEqual(link.machines.map(() => 'uniform'));
});

function createSettlementNoticeHttpBoundary(serverHttpBaseUrl: string) {
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-owner' })).toString('base64url')}.signature`, encryption: null };
    // Home persistence is the boundary; receipt admission, C1 encoding/writes
    // and Inbox projection stay real in this producer-to-consumer journey.
    const notices = new Map<string, Record<string, unknown>>();
    const writeJournal: Array<{ id: string; header: unknown }> = [];
    let writes = 0;
    const boundary: { beforeArtifactRead?: () => void } = {};
    vi.spyOn(axios, 'get').mockImplementation(async url => {
        if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
        if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
        if (new URL(url).pathname === '/v1/artifacts') return { status: 200, data: artifactListResponse(url, [...notices.values()]) };
        const before = boundary.beforeArtifactRead;
        delete boundary.beforeArtifactRead;
        before?.();
        const id = new URL(url).pathname.split('/').at(-1)!;
        return { status: notices.has(id) ? 200 : 404, data: notices.get(id) ?? {} };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, wire) => {
        const mutation = readCarrierMutation(wire);
        const id = typeof mutation.id === 'string' ? mutation.id : new URL(url).pathname.split('/').at(-1)!;
        const previous = notices.get(id);
        // Match artifactMutationHttpResponse: owner create is idempotent;
        // update conflicts return the existing bytes at HTTP 200. Each content
        // field advances only when present, retaining its provenance pairing.
        if (typeof mutation.id === 'string') {
            if (previous) return { status: 200, data: previous };
        } else {
            if (!previous) return { status: 404, data: { error: 'Artifact not found' } };
            if (mutation.header !== undefined && mutation.expectedHeaderVersion === undefined
                || mutation.body !== undefined && mutation.expectedBodyVersion === undefined) return { status: 400, data: { error: 'Invalid parameters' } };
            if (mutation.expectedHeaderVersion !== undefined && mutation.expectedHeaderVersion !== previous.headerVersion
                || mutation.body !== undefined && mutation.expectedBodyVersion !== previous.bodyVersion) {
                return { status: 200, data: { success: false, error: 'version-mismatch',
                    ...(mutation.header !== undefined || mutation.kind !== undefined
                        ? { currentHeaderVersion: previous.headerVersion, currentHeader: previous.header } : {}),
                    ...(mutation.body !== undefined ? { currentBodyVersion: previous.bodyVersion, currentBody: previous.body } : {}) } };
            }
        }
        const headerVersion = previous ? Number(previous.headerVersion) + Number(mutation.header !== undefined) : 1;
        const bodyVersion = previous ? Number(previous.bodyVersion) + Number(mutation.body !== undefined) : 1;
        notices.set(id, { ...previous, ...mutation, id, ownerAccountId: 'account-owner', access: 'owner', publicAudience: 'none',
            encryptionMode: 'plain', headerVersion, bodyVersion, seq: 1, createdAt: 1, updatedAt: headerVersion });
        writes++;
        writeJournal.push({ id, header: typeof mutation.header === 'string' ? decodePlainArtifactStoredContent(mutation.header) : null });
        return { status: 200, data: typeof mutation.id === 'string' ? notices.get(id)! : { success: true,
            ...(mutation.header !== undefined ? { headerVersion } : {}), ...(mutation.body !== undefined ? { bodyVersion } : {}) } };
    });
    const store = createCredentialedAccountArtifactStore(credentials);
    const readArtifacts = () => runWithServerHttpBaseUrl(serverHttpBaseUrl, async () => Promise.all([...notices.keys()].map(async id => {
            const artifact = await store.read(id);
            return { artifact, notice: artifact ? readAccountNoticeArtifactV1(artifact) : null };
        })));
    return { credentials, notices, boundary, readArtifacts, writeJournal, writes: () => writes, async read(environmentId: string, targetLinkId: string) {
        const observed = await readArtifacts();
        // Native service health and Environment settlement are distinct C1
        // identities. Count the exact settlement condition, not every Artifact
        // captured by the shared Home persistence boundary.
        const settlements = observed.filter(({ notice }) => notice?.source.kind === 'host' && notice.source.topic === 'service_health'
            && notice.source.subject.kind === 'environment' && notice.source.subject.environmentId === environmentId
            && notice.source.subject.targetLinkId === targetLinkId && notice.source.subject.condition === 'deployment_failed');
        expect(settlements).toHaveLength(1);
        const { artifact, notice } = settlements[0];
        if (!artifact) throw new Error('The settled deployment must publish its C1 notice');
        if (!notice) throw new Error('The canonical C1 reader must accept the producer notice');
        return { artifact, notice, item: projectAccountNoticeInboxItemV1({ artifactId: artifact.artifactId, header: notice,
            serverId: 'home', createdAt: artifact.createdAt, pageRoute: `/inbox/${artifact.artifactId}` }) };
    } };
}

it.for(['ordered mixed-fleet compensation', 'mid-rollout bindings edit', 'retained rollback without build',
    'activation failure diagnostic', 'activation failure diagnostic with cleanup'] as const)(
    'restores native members to U after %s', { timeout: 300_000 }, async (scenario, testContext) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-own-server-rollout-'));
    const mounted = await createAdmittedPluginRuntimeFixture({ happyHomeDir: configuration.happyHomeDir,
        controller: pluginReloadController, runtimeOptions: { pluginIds: ['happier.scm.backend.git'] } });
    const originalHome = Object.getOwnPropertyDescriptor(configuration, 'happyHomeDir')!;
    const activationFailure = scenario.startsWith('activation failure diagnostic');
    const machineIds = scenario === 'retained rollback without build' || activationFailure
        ? ['machine-a'] : ['machine-a', 'machine-b', 'machine-c'];
    let selectedMachine = machineIds[0];
    const tools = new Map<string, Awaited<ReturnType<typeof createOwnServerDockerBoundary>>>();
    const identities = new Map(machineIds.map(machineId => {
        const keys = nacl.sign.keyPair();
        return [machineId, { version: 1 as const, installationId: `installation-${machineId.at(-1)}`, createdAt: 1,
            publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') }];
    }));
    const environment = createDeploymentEnvironmentDetailV1();
    environment.content.retainPreviousDeployments = scenario === 'retained rollback without build' ? 2 : 0;
    environment.environment.protection = 'production';
    environment.environment.owner = { kind: 'team', teamId: 'shared-source-team' };
    const link = environment.targetLinks[0].targetLink;
    link.machines = [...machineIds];
    link.members = machineIds.map(machineId => ({ machineId, installationId: identities.get(machineId)!.installationId, state: 'active' }));
    delete link.activeDeploymentId;
    const receipts = new Map<string, { deployment: OwnServerDeploymentReceipt['deployment']; content: OwnServerDeploymentReceipt['content'] }>();
    const stages: string[] = [];
    const dispatchErrors: string[] = [];
    const activationFailures: unknown[] = [];
    const targets = new Map<string, OwnServerDeploymentTargetForHost>();
    const hosts = new Map<string, OwnServerDeploymentTargetHostInput>();
    const saveCountsBeforeBuild = new Map<string, number>();
    const buildRequests: string[] = [];
    const noticeBoundary = createSettlementNoticeHttpBoundary('https://rollout-home.test');
    const { credentials, read: readSettlementNotice } = noticeBoundary;
    const onMachine = async <T>(machineId: string, run: () => Promise<T>) => {
        selectedMachine = machineId;
        vi.stubEnv('PATH', `${join(root, machineId, 'tools')}${delimiter}${process.env.PATH ?? ''}`);
        return await run();
    };
    // Each machine is a separate OS in production. Substitute its filesystem,
    // identity and Home HTTP boundaries, retaining installed runtime acquisition,
    // source custody, P42, native lifecycle and the actual managed-service owner.
    Object.defineProperty(configuration, 'happyHomeDir', { configurable: true, get: () => join(root, selectedMachine) });
    const settings = await persistence.readSettings();
    const profile: ServerProfile = { id: 'home', name: 'Home', serverUrl: 'https://rollout-home.test',
        webappUrl: 'https://rollout-home.test', createdAt: 1, updatedAt: 1, lastUsedAt: 1,
        homeConnectionDescriptorAuthority: 'exact',
        homeConnectionDescriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: 'srv_rollout_home',
            canonicalServerUrl: 'https://rollout-home.test', revision: 1,
            endpoints: [{ kind: 'https', url: 'https://rollout-home.test' }] }) };
    vi.spyOn(persistence, 'readSettings').mockResolvedValue({ ...settings, servers: { home: profile } });
    const environmentRoot = async (machineId: string) => {
        const identity = await resolveOwnServerDeploymentIdentityForHost({ happierHomeDir: join(root, machineId),
            serverId: 'home', environmentId: environment.environment.id });
        return join(identity.deploymentRoot, identity.environmentInstanceId);
    };
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockImplementation(() => identities.get(selectedMachine) ?? null);
    vi.spyOn(axios, 'request').mockImplementation(async request => {
        if (request.url?.endsWith('/secret-launch-admission')) return { status: 200, data: { ok: true, grants: [] } };
        throw new Error(`Unexpected Home request: ${request.url}`);
    });
    try {
        for (const machineId of machineIds) {
            tools.set(machineId, await createOwnServerDockerBoundary(join(root, machineId, 'tools'), {
                engineId: `engine-${machineId}`, activationCommandFailure: scenario === 'activation failure diagnostic with cleanup'
                    ? 'afterCreate' : activationFailure,
            }));
            const host: OwnServerDeploymentTargetHostInput = {
                credentials, serverId: 'home', serverHttpBaseUrl: 'https://rollout-home.test', machineId,
                async readEnvironment() { return structuredClone(environment); },
                async readRetentionHeaders({ deploymentId }) {
                    return structuredClone({ environment: environment.environment, deployment: receipts.get(deploymentId)!.deployment, link });
                },
                async readReceipt({ deploymentId }) {
                    const receipt = receipts.get(deploymentId);
                    if (!receipt) throw Object.assign(new Error('deployment_unavailable'), { code: 'deployment_unavailable' });
                    return structuredClone(receipt);
                },
                // Persistence/transport boundaries alone are substituted. This
                // test does not claim P40's server pointer/CAS integration proof.
                async writeTransition(input) {
                    const current = receipts.get(input.deploymentId)!;
                    if (current.deployment.revision !== input.expectedRevision) return { ok: false, errorCode: 'deployment_conflict', error: 'deployment_conflict' };
                    if (input.content.ownServer?.sources?.some(source => source.role === 'build')
                        && !current.content.ownServer?.sources?.some(source => source.role === 'build')) {
                        // Native archive production may only start after the
                        // admitted build tree's manifest custody is published.
                        expect((await tools.get(machineId)!.readInvocations()).filter(command => command.args[0] === 'save')).toHaveLength(
                            saveCountsBeforeBuild.get(input.deploymentId)!);
                    }
                    current.content = DeploymentOwnServerContentV1Schema.parse(input.content);
                    current.deployment = { ...current.deployment, revision: current.deployment.revision + 1, state: input.state };
                    // The real signed settlement transaction advances this
                    // pointer before acknowledging authoritative success.
                    if (input.state === 'succeeded' || input.state === 'running_unverified') {
                        link.activeDeploymentId = current.deployment.id;
                        link.revision++;
                    }
                    return { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                        deploymentId: current.deployment.id, deploymentRevision: current.deployment.revision, state: input.state };
                },
                runtime: createOwnServerDeploymentRuntimeForHost({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://rollout-home.test', machineId,
                    resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                    async acquirePluginRuntimeRegistryLease() { return mounted.controller.tryAcquireRuntimeRegistry()!; } }),
                async *readBuildHistory() { for (const value of [...receipts.values()].reverse()) yield structuredClone(value); },
                async dispatchBuild(request) {
                    buildRequests.push(request.receipt.deploymentId);
                    const buildMachineId = environment.environment.buildMachineId;
                    if (!buildMachineId) throw new Error('Expected a build Machine in the rollout fixture');
                    saveCountsBeforeBuild.set(request.receipt.deploymentId, (await tools.get(buildMachineId)!.readInvocations())
                        .filter(command => command.args[0] === 'save').length);
                    const built = await onMachine(buildMachineId,
                        () => buildOwnServerDeploymentReceipt(hosts.get(buildMachineId)!, request));
                    if (!built.ok) dispatchErrors.push(`build:${built.errorCode}`);
                    return built;
                },
                async reviewMember(input) { return onMachine(input.machineId, () => targets.get(input.machineId)!.reviewMember(input)); },
                async dispatchRetention(input) {
                    const result = await onMachine(input.machineId, () => targets.get(input.machineId)!.retain(input));
                    if (!result.ok) dispatchErrors.push(`retention:${input.machineId}:${result.errorCode}`);
                    return result;
                },
                async dispatchMember(input) {
                    stages.push(`${input.phase}:${input.machineId}:start`);
                    const result = await onMachine(input.machineId, () => targets.get(input.machineId)!.executeMember(input));
                    if (activationFailure && input.phase === 'activate' && !result.ok) activationFailures.push(result);
                    if (input.request.receipt.deploymentId === 'bindings-edited' && input.phase === 'activate'
                        && input.machineId === 'machine-b' && !result.ok && result.errorCode === 'native_failed') {
                        // An independent manager edits the Environment after
                        // A has cut over and B has failed. Compensation still
                        // has to reach the real receiving member and restore U.
                        environment.content.bindings = [EnvironmentVariableBindingV1Schema.parse({ purpose: 'variable',
                            name: 'UNRELATED_EDIT', phase: 'runtime', source: { kind: 'value', value: 'changed' } })];
                        environment.environment.revision++;
                    }
                    if (input.phase === 'activate' && input.request.receipt.deploymentId === 'v3' && input.machineId === 'machine-a') {
                        // A's local success is not Environment settlement. B
                        // can still fail and need the last uniform source.
                        expect(await readFile(join(await environmentRoot('machine-a'),
                            'releases', 'v1', 'compose.yaml'), 'utf8')).toContain('v1');
                    }
                    if (!result.ok) dispatchErrors.push(`${input.phase}:${input.machineId}:${result.errorCode}`);
                    stages.push(`${input.phase}:${input.machineId}:end`);
                    return result;
                },
            };
            hosts.set(machineId, host);
            targets.set(machineId, createOwnServerDeploymentTargetForHost(host));
        }
        let sourceRevision = 0;
        const candidate = async (version: string, onFailure: 'rollbackAll' | 'keepPartial', previous?: OwnServerDeploymentReceipt) => {
            const images = await Promise.all(machineIds.map(machineId => tools.get(machineId)!.registerImage('app', version)));
            const document = JSON.stringify({ services: { app: { image: images[0].registryReference, environment: { VERSION: version } } } });
            const sourceIntent = { kind: 'stored' as const, document, contentRevision: ++sourceRevision,
                composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, services: ['app'], profiles: [] };
            environment.content.definition = sourceIntent;
            const receipt = createDeploymentReceiptDetailV1();
            receipt.deployment = createDeploymentReceiptHeaderV1({ ...receipt.deployment, id: version, requestKey: version, state: 'queued', actionOperationId: `operation-${version}`,
                acceptedExecution: { v: 1, controller: { machineId: 'machine-a', installationId: identities.get('machine-a')!.installationId },
                    builder: { machineId: 'machine-a', installationId: identities.get('machine-a')!.installationId } } });
            receipt.content = { sourceIntent, machines: [...link.machines], buildMachineId: 'machine-a', onFailure,
                images: [images[0]], machineResults: previous?.content.machineResults ?? [], steps: [] };
            receipts.set(version, receipt);
            const request: OwnServerDeploymentRequest = { actionId: 'deployments.deploy',
                input: { serverId: 'home', environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
                    targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: version,
                    contentArtifactId: receipt.deployment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 },
                receipt: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                    deploymentId: version, deploymentRevision: receipt.deployment.revision, state: 'queued' },
                context: { signal: testContext.signal,
                    operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
            const review = await onMachine('machine-a', () => targets.get('machine-a')!.review({ ...request, content: receipt.content }));
            expect(review.inputBasis.servicePlatforms).toEqual([{ service: 'app', platform: 'linux/amd64' }]);
            expect(review.inputBasis.runtimeProjections?.map(projection => projection.servicePlatforms)).toEqual(
                machineIds.map(() => [{ service: 'app', platform: 'linux/amd64' }]));
            receipt.content.ownServer = { approvedInputBasis: review.inputBasis };
            return { receipt, request, image: images[0] };
        };
        if (activationFailure) {
            const failed = await candidate('missing-entrypoint', 'rollbackAll');
            const outcome = await onMachine('machine-a', () => targets.get('machine-a')!.execute(failed.request));
            const failureCause = { phase: 'deployment.native.compose.native_compose_command_failed',
                errorClass: 'Error', errorCode: null, httpStatus: null };
            // The real native child crosses the Machine transport with its cause;
            // aggregate settlement must retain it after reading the authored receipt.
            expect.soft(activationFailures).toEqual([expect.objectContaining({ ok: false, effectAttempted: true,
                errorCode: 'native_failed', failureCause })]);
            expect((await tools.get('machine-a')!.readInvocations()).some(command => command.args.includes('up'))).toBe(true);
            if (scenario === 'activation failure diagnostic with cleanup') {
                expect((await tools.get('machine-a')!.readInvocations()).some(command => command.args.includes('rm'))).toBe(true);
                expect(failed.receipt.content.machineResults[0]?.steps).toContainEqual(expect.objectContaining({
                    id: 'own-server-candidate-cleanup', state: 'succeeded',
                }));
            }
            expect(failed.receipt.deployment.state).toBe('failed');
            expect.soft(failed.receipt.content.failure).toMatchObject({ effectAttempted: true, remedy: expect.any(String) });
            expect(outcome).toMatchObject({ ok: false, errorCode: 'native_failed' });
            if (outcome.ok) throw new Error('Expected the failed native activation to settle as a failure');
            const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'executing', createdAtMs: 1, updatedAtMs: 2,
                createdBy: { surface: 'cli' }, requestedSurface: 'cli', actionId: 'deployments.deploy',
                actionArgs: failed.request.input, summary: 'Deploy reviewed native source',
                executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
                    serverId: 'home', serverIdentityId: 'home', accountId: 'account-owner', machineId: 'machine-a',
                    target: { kind: 'machine', machineId: 'machine-a' }, actionId: 'deployments.deploy', requestId: 'native-request' },
                decision: { kind: 'approve', decidedAtMs: 2 } });
            const settled = projectSettledApprovalExecution({ request: approval, actionId: approval.actionId,
                exec: outcome, dispatchEffectAttempted: true, executedAtMs: 3 });
            const artifactId = 'native-diagnostic-approval';
            await runWithServerHttpBaseUrl('https://rollout-home.test', () => createCredentialedAccountArtifactStore(credentials).create({
                artifactId, header: buildApprovalRequestArtifactHeaderV1(settled.request), body: JSON.stringify(settled.request),
            }));
            const reader = createActionExecutor({ ...createUnavailableActionTransportDeps(),
                ...createCliApprovalsArtifactStore({ credentials, serverId: 'home', serverHttpBaseUrl: 'https://rollout-home.test' }) });
            const observed = await runWithServerHttpBaseUrl('https://rollout-home.test', () => reader.execute('approval.request.get',
                { artifactId }, { surface: 'cli', authority: 'present_user', serverId: 'home' }));
            expect.soft(outcome).toMatchObject({ ok: false, effectAttempted: true, errorCode: 'native_failed', failureCause,
                details: { failure: { code: 'native_failed', phase: 'activate', remedy: expect.any(String) } } });
            expect(observed).toMatchObject({ ok: true, result: { request: { status: 'failed', execution: {
                ok: false, effectAttempted: true, errorCode: 'native_failed', failureCause,
                details: { failure: { code: 'native_failed', phase: 'activate', remedy: expect.any(String) } } } } } });
            expect(JSON.stringify(observed)).not.toContain('private-missing-entrypoint-sentinel');
            return;
        }
        if (scenario === 'retained rollback without build') {
            const first = await candidate('v1', 'rollbackAll');
            expect(await onMachine('machine-a', () => targets.get('machine-a')!.execute(first.request))).toMatchObject({ ok: true, state: 'succeeded' });
            const second = await candidate('v2', 'rollbackAll', first.receipt);
            expect(await onMachine('machine-a', () => targets.get('machine-a')!.execute(second.request))).toMatchObject({ ok: true, state: 'succeeded' });
            expect(link.activeDeploymentId).toBe('v2');
            expect(buildRequests).toEqual(['v1', 'v2']);

            for (const mode of ['joining', 'retained'] as const) {
                const recovery = createDeploymentReceiptDetailV1();
                recovery.deployment = createDeploymentReceiptHeaderV1({ ...second.receipt.deployment,
                    id: `rollback-${mode}`, operation: 'rollback', rollbackOfDeploymentId: 'v1',
                    requestKey: `rollback-${mode}`, actionOperationId: `operation-rollback-${mode}`, revision: 1, state: 'queued' });
                const prepared = await prepareRollbackForHost({ input: { serverId: 'home', environmentId: environment.environment.id,
                    deploymentId: first.receipt.deployment.id, requestKey: recovery.deployment.requestKey }, context: {} }, {
                    ...hosts.get('machine-a')!, async createCandidate(_environment, content) {
                        recovery.content = DeploymentOwnServerContentV1Schema.parse(content);
                        return { contentArtifactId: recovery.deployment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 };
                    },
                });
                receipts.set(recovery.deployment.id, recovery);
                const request: OwnServerDeploymentRequest = { actionId: 'deployments.rollback', input: prepared.input,
                    receipt: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                        deploymentId: recovery.deployment.id, deploymentRevision: 1, state: 'queued' },
                    context: { signal: testContext.signal, operationAcceptance: { operationId: recovery.deployment.actionOperationId, accept() {} } } };
                const review = await onMachine('machine-a', () => targets.get('machine-a')!.review({ ...request, content: recovery.content }));
                recovery.content.ownServer = { approvedInputBasis: review.inputBasis };
                expect(recovery.content.ownServer.buildSecretRevisions).toBeUndefined();
                const beforeCommands = (await tools.get('machine-a')!.readInvocations()).length;
                const beforeStages = stages.length;
                if (mode === 'joining') link.members[0].state = 'joining';
                const result = await onMachine('machine-a', () => targets.get('machine-a')!.execute(request));
                link.members[0].state = 'active';
                if (mode === 'joining') {
                    expect(result).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
                    expect(stages).toHaveLength(beforeStages);
                    expect(await tools.get('machine-a')!.readInvocations()).toHaveLength(beforeCommands);
                    expect(recovery.content.failure).toEqual({ code: 'unsupported_action', phase: 'admission' });
                    continue;
                }
                expect(result, JSON.stringify({ failure: recovery.content.failure, dispatchErrors })).toMatchObject({ ok: true, state: 'succeeded' });
                expect(buildRequests).toEqual(['v1', 'v2']);
                expect(link.activeDeploymentId).toBe(recovery.deployment.id);
                expect(recovery.content.images).toEqual(first.receipt.content.images);
                expect(recovery.content.machineResults).toContainEqual(expect.objectContaining({ activation: 'succeeded',
                    currentDeploymentId: recovery.deployment.id, health: 'healthy' }));
                expect(await tools.get('machine-a')!.readRunningImageConfig('app')).toBe(first.image.configDigest);
            }
            return;
        }
        if (scenario === 'mid-rollout bindings edit') {
            // This regression needs only U and its failed successor. Keep the
            // separate mixed-fleet/first-deploy journey below independently runnable.
            const first = await candidate('v1', 'rollbackAll');
            expect(await onMachine('machine-a', () => targets.get('machine-a')!.execute(first.request)), JSON.stringify({ dispatchErrors, stages }))
                .toMatchObject({ ok: true, state: 'succeeded' });
            const edited = await candidate('bindings-edited', 'rollbackAll', first.receipt);
            await tools.get('machine-b')!.failImageHealth(edited.image.configDigest);
            expect(await onMachine('machine-a', () => targets.get('machine-a')!.execute(edited.request)))
                .toMatchObject({ ok: false, errorCode: 'native_failed', details: { deploymentId: edited.receipt.deployment.id,
                    failure: { code: 'native_failed', phase: 'activate' } } });
            expect(environment.content.bindings).toContainEqual(expect.objectContaining({ name: 'UNRELATED_EDIT' }));
            expect(link.activeDeploymentId).toBe('v1');
            for (const machineId of machineIds) {
                expect(await tools.get(machineId)!.readRunningImageConfig('app'), JSON.stringify(dispatchErrors))
                    .toBe(first.image.configDigest);
                expect(edited.receipt.content.machineResults).toContainEqual(expect.objectContaining({ machineId,
                    actionOperationId: edited.receipt.deployment.actionOperationId,
                    currentDeploymentId: 'v1', restoration: 'succeeded' }));
            }
            return;
        }
        const introduced = await candidate('first-failed', 'rollbackAll');
        await tools.get('machine-b')!.failImageHealth(introduced.image.configDigest);
        expect(await onMachine('machine-a', () => targets.get('machine-a')!.execute(introduced.request)))
            .toMatchObject({ ok: false, errorCode: 'native_failed', details: { deploymentId: introduced.receipt.deployment.id,
                failure: { code: 'native_failed', phase: 'activate' } } });
        // The known native failure, rather than any failed receipt, establishes
        // that this control exercised activation and candidate compensation.
        expect(dispatchErrors, JSON.stringify(stages)).toEqual(['activate:machine-b:native_failed']);
        const opened = await readSettlementNotice(environment.environment.id, link.id);
        expect(opened.notice).toMatchObject({ type: 'blocked', healthPhase: 'open', source: { kind: 'host', topic: 'service_health',
            subject: { kind: 'environment', environmentId: environment.environment.id, targetLinkId: link.id, condition: 'deployment_failed' } } });
        expect(opened.item?.view).toBe('needs_you');
        const settlementWritesBeforeRetry = noticeBoundary.writeJournal.filter(row => row.id === opened.artifact.artifactId);
        await onMachine('machine-a', () => targets.get('machine-a')!.execute(introduced.request));
        // Runtime health has its own notice identity and can settle on retry.
        // The failed deployment's settlement itself must remain idempotent.
        expect(noticeBoundary.writeJournal.filter(row => row.id === opened.artifact.artifactId))
            .toEqual(settlementWritesBeforeRetry);
        for (const machineId of machineIds) expect(await tools.get(machineId)!.readRunningImageConfig('app')).toBeNull();
        expect(introduced.receipt.content.machineResults, JSON.stringify({ dispatchErrors, stages })).toEqual(expect.arrayContaining(['machine-a', 'machine-b'].map(machineId => expect.objectContaining({
            machineId, steps: expect.arrayContaining([expect.objectContaining({ id: 'own-server-candidate-cleanup', state: 'succeeded' })]),
        }))));
        dispatchErrors.length = 0;
        const first = await candidate('v1', 'rollbackAll');
        expect(await onMachine('machine-a', () => targets.get('machine-a')!.execute(first.request))).toMatchObject({ ok: true, state: 'succeeded' });
        const recovered = await readSettlementNotice(environment.environment.id, link.id);
        expect(recovered.artifact.artifactId).toBe(opened.artifact.artifactId);
        expect(recovered.notice).toMatchObject({ type: 'update', healthPhase: 'recovered', resolved: false });
        expect(recovered.item?.view).toBe('updates');
        // The canonical P40 server advances this pointer only after its own
        // all-member proof. Its integration is covered at that storage owner.
        link.activeDeploymentId = 'v1';
        link.machines = ['machine-a', 'machine-c', 'machine-b'];
        link.members = link.machines.map(machineId => link.members.find(member => member.machineId === machineId)!);
        link.revision++;
        const partial = await candidate('v2', 'keepPartial', first.receipt);
        await tools.get('machine-b')!.failImageHealth(partial.image.configDigest);
        expect(await onMachine('machine-a', () => targets.get('machine-a')!.execute(partial.request)))
            .toMatchObject({ ok: false, errorCode: 'native_failed', details: { deploymentId: partial.receipt.deployment.id,
                failure: { code: 'native_failed', phase: 'activate' } } });
        expect(dispatchErrors).toEqual(['activate:machine-b:native_failed']);
        expect(partial.receipt.content.machineResults.find(row => row.machineId === 'machine-a')).toMatchObject({
            currentDeploymentId: 'v2', activation: 'succeeded', health: 'healthy' });
        expect(await tools.get('machine-a')!.readRunningImageConfig('app')).toBe(partial.image.configDigest);
        expect(await tools.get('machine-c')!.readRunningImageConfig('app')).toBe(partial.image.configDigest);
        expect(link.activeDeploymentId).toBe('v1');
        link.machines = [...machineIds];
        link.members = link.machines.map(machineId => link.members.find(member => member.machineId === machineId)!);
        link.revision++;
        const failed = await candidate('v3', 'rollbackAll', partial.receipt);
        await tools.get('machine-b')!.failImageHealth(failed.image.configDigest);
        stages.length = 0;
        expect(await onMachine('machine-a', () => targets.get('machine-a')!.execute(failed.request)))
            .toMatchObject({ ok: false, errorCode: 'native_failed', details: { deploymentId: failed.receipt.deployment.id,
                failure: { code: 'native_failed', phase: 'activate' } } });
        const restoredNotice = await readSettlementNotice(environment.environment.id, link.id);
        expect(restoredNotice.artifact.artifactId).toBe(opened.artifact.artifactId);
        expect(restoredNotice.notice).toMatchObject({ type: 'update', healthPhase: 'open', resolved: false });
        expect(restoredNotice.item?.view).toBe('updates');
        expect(stages.filter(stage => stage.startsWith('activate:'))).toEqual([
            'activate:machine-a:start', 'activate:machine-a:end', 'activate:machine-b:start', 'activate:machine-b:end',
        ]);
        for (const machineId of machineIds) {
            expect(await tools.get(machineId)!.readRunningImageConfig('app')).toBe(first.image.configDigest);
            expect(failed.receipt.content.machineResults).toContainEqual(expect.objectContaining({ machineId,
                currentDeploymentId: 'v1', restoration: 'succeeded' }));
            const commands = await tools.get(machineId)!.readInvocations();
            expect(commands.some(command => command.args.includes('build'))).toBe(false);
            // Restored aggregate settlement may expire only the abandoned
            // candidate's source. The uniform rollback baseline stays owned.
            await expect(readFile(join(await environmentRoot(machineId),
                'releases', 'v2', 'compose.yaml'), 'utf8'), JSON.stringify(dispatchErrors)).rejects.toMatchObject({ code: 'ENOENT' });
            expect(await readFile(join(await environmentRoot(machineId),
                'releases', 'v1', 'compose.yaml'), 'utf8')).toContain('v1');
        }
        await expect(readFile(join(await environmentRoot('machine-a'),
            'builds', 'v2', 'compose.yaml'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
        Object.defineProperty(configuration, 'happyHomeDir', originalHome);
        await mounted.dispose();
        await rm(root, { recursive: true, force: true });
    }
});

it.each(['action_forbidden', 'outcome_unknown'] as const)(
    'settles the r30 native result after a refused final transition (%s)', async errorCode => {
    const environment = createDeploymentEnvironmentDetailV1();
    const link = environment.targetLinks[0].targetLink;
    link.machines = ['machine-a'];
    link.members = [{ machineId: 'machine-a', installationId: 'installation-a', state: 'active' }];
    link.activeDeploymentId = 'uniform';
    const receipt = createDeploymentReceiptDetailV1();
    receipt.deployment = createDeploymentReceiptHeaderV1({ ...receipt.deployment, id: 'rollback', operation: 'rollback',
        state: 'queued', acceptedExecution: { v: 1, controller: { machineId: 'machine-a', installationId: 'installation-a' }, builder: { machineId: 'machine-a', installationId: 'installation-a' } } });
    receipt.content = { ...receipt.content, machines: link.machines, machineResults: [],
        ownServer: { approvedInputBasis: OwnServerDeploymentInputBasisV1Schema.parse({ v: 1,
            environmentId: environment.environment.id, environmentRevision: environment.environment.revision,
            targetLinkId: link.id, targetLinkRevision: link.revision, sourceIntent: receipt.content.sourceIntent,
            manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'rollback',
            toolVersion: '2.40.1', services: ['app'], profiles: [], bindings: [], images: receipt.content.images,
            ownServer: environment.content.ownServer, members: link.members.map(({ machineId, installationId }) => ({ machineId, installationId })) }) } };
    const uniform = structuredClone(receipt);
    uniform.deployment = { ...uniform.deployment, id: 'uniform', state: 'succeeded' };
    const refusal = { ok: false as const, errorCode, error: errorCode === 'action_forbidden'
        ? 'action_forbidden (home_request_headers_refused)' : 'outcome_unknown' };
    const host: OwnServerDeploymentTargetHostInput = {
        credentials: { token: 'storage-boundary', encryption: null }, serverId: 'home', serverHttpBaseUrl: 'https://home.test', machineId: 'machine-a',
        readEnvironment: async () => structuredClone(environment),
        readReceipt: async ({ deploymentId }) => structuredClone(deploymentId === 'uniform' ? uniform : receipt),
        async writeTransition(input) {
            expect(input.expectedRevision).toBe(receipt.deployment.revision);
            if (input.state === 'succeeded') return refusal;
            receipt.content = DeploymentOwnServerContentV1Schema.parse(input.content);
            receipt.deployment = { ...receipt.deployment, revision: receipt.deployment.revision + 1, state: input.state };
            return { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: input.state };
        },
        runtime: { async acquire() { throw new Error('Controller must not acquire native custody'); } },
        async dispatchMember({ phase, selectedDeploymentId }) {
            if (phase === 'activate') {
                // r30: the native Machine has already authored success before Home settlement.
                receipt.content.machineResults = [{ machineId: 'machine-a', installationId: 'installation-a', activation: 'succeeded', health: 'healthy',
                    currentDeploymentId: selectedDeploymentId, actionOperationId: receipt.deployment.actionOperationId, steps: [] }];
                receipt.deployment.revision = 7;
            }
            return { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: 'running' };
        },
    };
    const request: OwnServerDeploymentRequest = { actionId: 'deployments.rollback',
        input: { serverId: 'home', environmentId: environment.environment.id, deploymentId: uniform.deployment.id,
            expectedRevision: environment.environment.revision, targetLinkId: link.id, expectedTargetLinkRevision: link.revision,
            requestKey: 'r30-rollback', contentArtifactId: receipt.deployment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 },
        receipt: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
            deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: 'queued' },
        context: { surface: 'ui',
            operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
    const result = await executeOwnServerRollout(host, request,
        { environment: structuredClone(environment), link: structuredClone(link), receipt: structuredClone(receipt), signal: new AbortController().signal });
    expect(result).toEqual(refusal);
    if (errorCode === 'action_forbidden') {
        expect(receipt.deployment.state).toBe('failed');
        expect(receipt.content.failure).toMatchObject({ code: 'action_forbidden', phase: 'activate' });
    } else {
        // A lost final acknowledgement does not prove that Home refused the commit.
        expect(receipt.deployment.state).toBe('running');
        expect(receipt.content.failure).toBeUndefined();
    }
    // A global settlement failure must not falsify the Machine's signed physical result.
    expect(receipt.content.machineResults[0]).toMatchObject({ activation: 'succeeded', currentDeploymentId: receipt.deployment.id });
});

it.each(['offline', 'unknown', 'staleSettlement', 'revokedSettlement', 'missingBaseline', 'missingPlatform', 'missingVariant', 'lostAck', 'buildLostAck', 'incompleteBuild', 'baselineObserve', 'keepPartialBaselineObserve', 'joiningNoRoute', 'joiningWriteRejected', 'joiningHealthy', 'joiningMultiple', 'joiningUnhealthy', 'joiningRouteRefused'] as const)('keeps %s transport settlement truthful without early aggregate success or uncertain replay', async mode => {
    const enrollJoining = mode === 'joiningHealthy' || mode === 'joiningMultiple' || mode === 'joiningUnhealthy' || mode === 'joiningRouteRefused';
    const environment = createDeploymentEnvironmentDetailV1();
    const noticeBoundary = ['offline', 'unknown', 'staleSettlement', 'revokedSettlement'].includes(mode) ? createSettlementNoticeHttpBoundary('https://home.test') : null;
    if (mode === 'unknown' || mode === 'staleSettlement') environment.environment.protection = 'production';
    // Current Source access is already admitted by the Environment read owner.
    if (mode === 'unknown') environment.environment.owner = { kind: 'team', teamId: 'shared-source-team' };
    if (mode === 'staleSettlement') noticeBoundary!.boundary.beforeArtifactRead = () => { environment.environment.revision++; };
    if (mode === 'revokedSettlement') noticeBoundary!.boundary.beforeArtifactRead = () => { environment.environment.capabilities.read = false; };
    const link = environment.targetLinks[0].targetLink;
    link.machines = ['machine-a', 'machine-b', 'machine-c'];
    if (mode === 'joiningMultiple') link.machines.push('machine-d');
    link.members = link.machines.map(machineId => ({ machineId, installationId: `installation-${machineId.at(-1)}`, state: 'active' }));
    link.activeDeploymentId = 'uniform-v1';
    if (mode === 'joiningNoRoute' || mode === 'joiningWriteRejected' || enrollJoining) link.members[2].state = 'joining';
    if (mode === 'joiningMultiple') link.members[3].state = 'joining';
    if (mode === 'missingBaseline') delete link.activeDeploymentId;
    const receipt = createDeploymentReceiptDetailV1();
    receipt.deployment = { ...receipt.deployment, id: 'candidate-v3', state: 'queued' };
    receipt.content = { ...receipt.content, machines: [...link.machines], onFailure: 'rollbackAll',
        machineResults: link.members.map(({ machineId, installationId }) => ({ machineId, installationId,
            steps: [], activation: 'pending', health: 'unknown', currentDeploymentId: 'partial-v2' })) };
    const nativeBasis = { manifestFingerprint: 'native-manifest', configInputDigests: [], physicalProjectName: 'native-project',
        toolVersion: '2.39.4', services: ['app'], profiles: [] };
    receipt.content.ownServer = { approvedInputBasis: OwnServerDeploymentInputBasisV1Schema.parse({ v: 1,
        environmentId: environment.environment.id, environmentRevision: environment.environment.revision,
        targetLinkId: link.id, targetLinkRevision: link.revision, sourceIntent: receipt.content.sourceIntent, ...nativeBasis,
        members: link.members.map(({ machineId, installationId }) => ({ machineId, installationId })), bindings: [],
        ownServer: environment.content.ownServer, images: receipt.content.images,
        runtimeProjections: link.members.map(({ machineId, installationId }) => ({ machineId, installationId, ...nativeBasis, platform: 'linux/amd64' })) }) };
    const uniform = structuredClone(receipt);
    uniform.deployment = { ...uniform.deployment, id: 'uniform-v1', state: 'succeeded' };
    if (mode === 'baselineObserve' || mode === 'keepPartialBaselineObserve' || enrollJoining) {
        // C joined after U. Only its actual read-only U render can establish
        // U's effective platform; A's host-default projection is not C's proof.
        uniform.content.machines = ['machine-a', 'machine-b'];
        uniform.content.machineResults = uniform.content.machineResults.filter(row => uniform.content.machines.includes(row.machineId));
        uniform.content.ownServer!.approvedInputBasis.members = uniform.content.ownServer!.approvedInputBasis.members.slice(0, 2);
        uniform.content.ownServer!.approvedInputBasis.runtimeProjections = uniform.content.ownServer!.approvedInputBasis.runtimeProjections!.slice(0, 2);
        uniform.content = DeploymentOwnServerContentV1Schema.parse(uniform.content);
        if (mode === 'keepPartialBaselineObserve') receipt.content.onFailure = 'keepPartial';
    }
    if (mode === 'missingVariant') {
        uniform.content.images = uniform.content.images.map(image => ({ ...image, platform: 'linux/arm64/v9' }));
        receipt.content.ownServer.approvedInputBasis.runtimeProjections!.forEach(projection => { projection.platform = 'linux/arm64'; });
    }
    const builtImages = structuredClone(receipt.content.images);
    const immutableUniform = structuredClone(uniform);
    if (mode === 'buildLostAck' || mode === 'incompleteBuild' || mode === 'baselineObserve' || mode === 'keepPartialBaselineObserve'
        || mode === 'joiningHealthy') {
        environment.environment.buildMachineId = 'builder-c';
        receipt.content.buildMachineId = 'builder-c';
        receipt.content.images = [];
        receipt.content.ownServer.approvedInputBasis.images = [];
        receipt.content.ownServer.approvedInputBasis.buildServices = ['app'];
    }
    receipt.deployment = createDeploymentReceiptHeaderV1({ ...receipt.deployment, requestKey: 'transport-rollout',
        acceptedExecution: { v: 1, controller: { machineId: 'machine-a', installationId: 'installation-a' },
            builder: { machineId: receipt.content.buildMachineId,
                installationId: receipt.content.buildMachineId === 'builder-c' ? 'installation-c' : 'installation-a' } } });
    if (mode === 'missingPlatform') receipt.content.ownServer.approvedInputBasis.runtimeProjections![2].platform = 'linux/arm64';
    let beginActivation!: () => void;
    const activationBegan = new Promise<void>(resolve => { beginActivation = resolve; });
    let continueActivation!: () => void;
    const activationGate = new Promise<void>(resolve => { continueActivation = resolve; });
    const dispatched: string[] = [];
    let buildDispatches = 0;
    const request: OwnServerDeploymentRequest = { actionId: 'deployments.deploy', input: {
        serverId: 'home', environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
        targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: 'transport-rollout',
        contentArtifactId: receipt.deployment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 },
        receipt: { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
            deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: 'queued' },
        context: { operationAcceptance: { operationId: receipt.deployment.actionOperationId, accept() {} } } };
    const target = createOwnServerDeploymentTargetForHost({ credentials: noticeBoundary?.credentials ?? { token: 'transport-boundary', encryption: null },
        machineId: 'machine-a', serverId: 'home', serverHttpBaseUrl: 'https://home.test',
        async readEnvironment() { return structuredClone(environment); },
        async readReceipt({ deploymentId }) { return structuredClone(deploymentId === 'uniform-v1' ? uniform : receipt); },
        async writeTransition(input) {
            expect(input.expectedRevision).toBe(receipt.deployment.revision);
            if (mode === 'joiningWriteRejected') return { ok: false, errorCode: 'operation_unavailable', error: 'operation_unavailable' };
            receipt.content = DeploymentOwnServerContentV1Schema.parse(input.content);
            receipt.deployment = { ...receipt.deployment, revision: receipt.deployment.revision + 1, state: input.state };
            return { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: input.state };
        },
        runtime: { async acquire() { throw new Error('Remote members must not acquire controller native custody'); } },
        ...(enrollJoining ? { async enrollMemberRoutes(_request: OwnServerDeploymentRequest, input: OwnServerDeploymentMemberRouteEnrollmentForHost) {
            expect(input.link.id).toBe(link.id);
            for (const joining of input.link.members.filter(member => member.state === 'joining')) {
                expect(receipt.content.machineResults.find(row => row.machineId === joining.machineId
                    && row.installationId === joining.installationId)).toMatchObject({
                    currentDeploymentId: 'uniform-v1', restoration: 'succeeded', health: 'healthy' });
            }
            expect(buildDispatches).toBe(0);
            expect(link.members[2].state).toBe('joining');
            dispatched.push('enroll');
            return mode === 'joiningRouteRefused' ? { ok: false as const, errorCode: 'native_route_unavailable', error: 'native_route_unavailable' }
                : { ok: true as const, environmentId: environment.environment.id, revision: environment.environment.revision,
                    deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: 'running' as const };
        } } : {}),
        async dispatchBuild() {
            buildDispatches += 1;
            expect(receipt.deployment.state).toBe('running');
            expect(dispatched.filter(phase => !phase.startsWith('observe:'))).toEqual(enrollJoining
                ? mode === 'joiningMultiple' ? ['restore:machine-c', 'restore:machine-d', 'enroll']
                    : ['restore:machine-c', 'enroll'] : []);
            receipt.content.images = builtImages;
            const builderId = receipt.content.buildMachineId;
            const builderInstallationId = builderId === 'builder-c' ? 'installation-c' : 'installation-a';
            receipt.content.ownServer!.buildSecretRevisions = receipt.content.ownServer!.approvedInputBasis.buildServices?.length
                ? [{ service: 'app', machineId: builderId, installationId: builderInstallationId, bindings: [] }] : [];
            if (mode !== 'incompleteBuild') receipt.content.ownServer!.imageArchives = builtImages.map(image => ({ image,
                holder: { serverId: 'home', machineId: builderId, installationId: builderInstallationId, rootPath: '/owned/archives', path: '/owned/archives/app.tar' },
                sizeBytes: 1, sha256: 'a'.repeat(64) }));
            receipt.deployment.revision++;
            return mode === 'buildLostAck' ? { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' }
                : { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                    deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: 'running' };
        },
        // Network/persistence boundary: remote signed rows are received here;
        // the actual ordered controller and receipt admission remain real.
        async dispatchMember(input) {
            dispatched.push(`${input.phase}:${input.machineId}`);
            if ((mode === 'baselineObserve' || mode === 'keepPartialBaselineObserve') && input.phase === 'observe' && input.machineId === 'machine-c') {
                return { ok: false, errorCode: 'rollback_image_unavailable', error: 'rollback_image_unavailable' };
            }
            if (mode === 'missingBaseline' || mode === 'missingPlatform' || mode === 'missingVariant' || mode === 'incompleteBuild') return { ok: false, errorCode: 'machine_unavailable', error: 'machine_unavailable' };
            if (input.phase === 'activate' && input.machineId === 'machine-a' && mode !== 'joiningNoRoute' && !enrollJoining) { beginActivation(); await activationGate; }
            if (input.phase !== 'observe' && input.machineId === 'machine-b' && mode !== 'joiningNoRoute'
                && mode !== 'baselineObserve' && mode !== 'keepPartialBaselineObserve' && !enrollJoining) {
                const errorCode = mode === 'unknown' || mode === 'staleSettlement' || mode === 'revokedSettlement' ? 'outcome_unknown' : 'machine_unavailable';
                if (mode === 'unknown') return projectDeploymentTransitionOutcomeUnknownForHost({ response: {
                    status: 503, data: { error: 'database_transaction_conflict_exhausted' },
                } });
                return { ok: false, errorCode, error: errorCode };
            }
            if (input.phase !== 'observe') {
                receipt.content.machineResults = receipt.content.machineResults.map(row => row.machineId === input.machineId ? {
                    ...row, actionOperationId: receipt.deployment.actionOperationId,
                    health: mode === 'joiningUnhealthy' && input.phase === 'restore' ? 'unhealthy' : 'healthy',
                    currentDeploymentId: input.selectedDeploymentId,
                    ...(input.phase === 'restore' ? { restoration: 'succeeded' } : { activation: 'succeeded' }),
                } : row);
                receipt.deployment.revision++;
            }
            if (mode === 'lostAck' && input.phase === 'activate' && input.machineId === 'machine-a') return {
                ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
            return { ok: true, environmentId: environment.environment.id, revision: environment.environment.revision,
                deploymentId: receipt.deployment.id, deploymentRevision: receipt.deployment.revision, state: 'running' };
        },
    });
    if (enrollJoining) {
        const successful = mode === 'joiningHealthy' || mode === 'joiningMultiple';
        const outcome = await target.execute(request);
        expect(outcome, JSON.stringify({ outcome, dispatched, failure: receipt.content.failure })).toMatchObject({ ok: successful,
            ...(successful ? { state: 'succeeded' } : { errorCode: mode === 'joiningUnhealthy'
                ? 'deployment_health_failed' : 'native_route_unavailable' }) });
        expect(dispatched[0]).toBe('restore:machine-c');
        expect(dispatched).toContainEqual(mode === 'joiningUnhealthy' ? 'restore:machine-c' : 'enroll');
        if (mode === 'joiningMultiple') expect(dispatched.slice(0, 3)).toEqual(['restore:machine-c', 'restore:machine-d', 'enroll']);
        expect(dispatched.filter(phase => phase === 'enroll')).toHaveLength(mode === 'joiningUnhealthy' ? 0 : 1);
        expect(dispatched.filter(phase => phase.startsWith('activate:'))).toHaveLength(successful ? link.members.length : 0);
        expect(buildDispatches).toBe(successful ? 1 : 0);
        expect(receipt.deployment.state).toBe(successful ? 'succeeded' : 'failed');
        expect(uniform).toEqual(immutableUniform);
        // The server transition owner alone commits membership after final route proofs.
        expect(link.members[2].state).toBe('joining');
        return;
    }
    if (mode === 'baselineObserve' || mode === 'keepPartialBaselineObserve') {
        continueActivation();
        await target.execute(request);
        expect(receipt.deployment.state).toBe(mode === 'baselineObserve' ? 'failed' : 'succeeded');
        expect(buildDispatches).toBe(mode === 'baselineObserve' ? 0 : 1);
        expect(dispatched.filter(phase => phase.startsWith('activate:'))).toHaveLength(mode === 'baselineObserve' ? 0 : 3);
        return;
    }
    if (mode === 'missingBaseline' || mode === 'missingPlatform' || mode === 'missingVariant') {
        expect(await target.execute(request)).toMatchObject({ ok: false, errorCode: 'rollback_image_unavailable' });
        expect(dispatched).toEqual([]);
        expect(buildDispatches).toBe(0);
        expect(receipt.deployment.state).toBe('failed');
        return;
    }
    if (mode === 'joiningWriteRejected') {
        expect(await target.execute(request)).toMatchObject({ ok: false, errorCode: 'operation_unavailable' });
        expect(dispatched).toEqual([]);
        expect(receipt.deployment.state).toBe('queued');
        expect(link.activeDeploymentId).toBe('uniform-v1');
        return;
    }
    if (mode === 'joiningNoRoute') {
        expect(await target.execute(request)).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
        expect(dispatched).toEqual([]);
        expect(link.members[2].state).toBe('joining');
        expect(link.activeDeploymentId).toBe('uniform-v1');
        expect(receipt.deployment.state).toBe('failed');
        return;
    }
    if (mode === 'incompleteBuild') {
        expect(await target.execute(request)).toMatchObject({ ok: false, errorCode: 'deployment_image_unavailable',
            details: { deploymentId: receipt.deployment.id, failure: { code: 'deployment_image_unavailable', phase: 'build' } } });
        expect(dispatched.filter(phase => !phase.startsWith('observe:'))).toEqual([]);
        return;
    }
    let settled = false;
    const execution = target.execute(request).finally(() => { settled = true; });
    await Promise.race([activationBegan, execution]);
    expect(settled).toBe(false);
    expect(receipt.deployment.state).toBe('running');
    expect(dispatched).not.toContain('activate:machine-b');
    continueActivation();
    expect(await execution).toMatchObject(mode === 'unknown' || mode === 'staleSettlement' || mode === 'revokedSettlement'
        ? { ok: true, state: 'outcome_unknown' }
        : { ok: false, errorCode: 'machine_unavailable', details: { deploymentId: receipt.deployment.id,
            failure: { code: 'machine_unavailable', phase: 'activate' } } });
    if (mode === 'offline' || mode === 'unknown') {
        expect(receipt.content.failure).toMatchObject({ requiredFact: 'deploymentActionResult', remedy: expect.stringMatching(/\S/) });
    }
    if (mode === 'unknown') expect(receipt.content.failure).toMatchObject({ code: 'outcome_unknown', failureCause: {
        phase: 'deployment.transition', errorCode: 'database_transaction_conflict_exhausted', httpStatus: 503,
    } });
    expect(link.activeDeploymentId).toBe('uniform-v1');
    expect(dispatched).not.toContain('activate:machine-c');
    if (mode === 'staleSettlement' || mode === 'revokedSettlement') {
        // Source access was admitted before notice storage awaited. A later
        // revision/access change does not retract this Account's private notice.
        const { artifact, notice } = await noticeBoundary!.read(environment.environment.id, link.id);
        expect(artifact).toMatchObject({ ownerAccountId: 'account-owner', access: 'owner', publicAudience: 'none' });
        expect(notice).toMatchObject({ type: mode === 'staleSettlement' ? 'blocked' : 'update', healthPhase: 'open' });
        expect(noticeBoundary!.writes()).toBe(1);
        expect(receipt.deployment.state).toBe('outcome_unknown');
        return;
    }
    if (noticeBoundary) {
        const { artifact, notice, item } = await noticeBoundary.read(environment.environment.id, link.id);
        expect(artifact).toMatchObject({ ownerAccountId: 'account-owner', access: 'owner', publicAudience: 'none' });
        expect(notice).toMatchObject({ type: mode === 'unknown' ? 'blocked' : 'update', healthPhase: 'open', resolved: false });
        expect(item?.view).toBe(mode === 'unknown' ? 'needs_you' : 'updates');
        if (mode === 'unknown') expect(notice.body).toContain('outcome_unknown');
    }
    if (mode === 'offline' || mode === 'lostAck' || mode === 'buildLostAck') {
        expect(receipt.content.machineResults.find(row => row.machineId === 'machine-b')).toMatchObject({ restoration: 'unreachable' });
        expect(receipt.content.machineResults.find(row => row.machineId === 'machine-c')).toMatchObject({ currentDeploymentId: 'uniform-v1', restoration: 'succeeded' });
    } else {
        expect(dispatched.some(call => call.startsWith('restore:'))).toBe(false);
        const beforeReplay = [...dispatched];
        const writesBeforeReplay = noticeBoundary?.writes();
        expect(await target.execute(request)).toMatchObject({ ok: true, state: 'outcome_unknown' });
        expect(dispatched).toEqual(beforeReplay);
        if (noticeBoundary) expect(noticeBoundary.writes()).toBe(writesBeforeReplay);
    }
});
