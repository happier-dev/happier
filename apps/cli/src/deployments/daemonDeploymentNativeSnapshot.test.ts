import axios, { AxiosHeaders } from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploymentChildRpcV1Schema } from '@happier-dev/protocol';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { projectManagedMachinePresetForRecipientV1, replaceManagedMachinePresetLaunchNameV1,
    sealManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { SavedSecretResourceEnvelopeCensusRecipientV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler } from '@/api/rpc/types';
import { resolveAdmittedRequesterAccountReadRuntime } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createDeploymentChildRequesterHarness } from '@/testkit/backends/deploymentChildRequesterHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createNativeCredentialComposerFixture } from '@/machines/managed/nativeCredentialComposer.testkit';
import { createManagedMachineAcquisitionDriver } from '@/machines/managed/acquire';
import { registerDaemonDeploymentChildRpcHandler } from './daemonDeploymentChildRpc';
import { createDaemonDeploymentNativeSnapshot } from './daemonDeploymentNativeSnapshot';
import { ManagedMachineControllerError } from '@/machines/managed/controllerErrors';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { logger } from '@/ui/logger';
import { PluginError } from '@happier-dev/plugin-sdk/errors';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function opaqueSnapshotRead(machine: ReturnType<typeof ManagedMachineV1Schema.parse>, mode: 'plain' | 'e2ee',
    accountId: string, accountKey: Uint8Array) {
    const { launch, resource, observation: _observation, reviewedFacts: _reviewedFacts, ...structural } = machine;
    if (!resource) throw new Error('snapshot_fixture_requires_resource');
    const presetId = 'snapshot-preset';
    const randomBytes = (length: number) => new Uint8Array(length).fill(41);
    const content = { v: 1 as const, name: launch.name, launch };
    const stored = mode === 'plain'
        ? sealManagedMachinePresetContentV1({ presetId, mode, content })
        : sealManagedMachinePresetContentV1({ presetId, mode, content, recipientCensus: [
            SavedSecretResourceEnvelopeCensusRecipientV1Schema.parse({
                account: { kind: 'account', accountId, firstName: 'Requester', lastName: null, username: accountId, avatarUrl: null },
                readiness: { status: 'available', contentPublicKey: encodeBase64(nacl.box.keyPair.fromSecretKey(accountKey).publicKey, 'base64'),
                    contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(nacl.box.keyPair.fromSecretKey(accountKey).publicKey) },
                envelopeStatus: 'missing',
            }),
        ], randomBytes });
    const reviewedFacts = {
        launch,
        ...(machine.controller ? { controller: machine.controller } : {}),
        optionStatus: 'current' as const,
        billing: { location: 'unknown' as const, stoppedBilling: 'unknown' as const },
        prerequisites: [], retentionCapabilities: { supportedIntents: ['start', 'stop'] as const },
        retention: machine.retention, wakeOnAcceptedMessage: machine.wakeOnAcceptedMessage,
        preset: { id: presetId, revision: 1, name: launch.name },
    };
    const snapshot = mode === 'plain'
        ? replaceManagedMachinePresetLaunchNameV1({ presetId, mode, content: stored.content, launchName: launch.name,
            reviewedFacts, nativeResult: { kind: 'bound', resource } })
        : replaceManagedMachinePresetLaunchNameV1({ presetId, mode, content: stored.content, recipients: stored.recipients,
            accountId, accountKey, launchName: launch.name, reviewedFacts, nativeResult: { kind: 'bound', resource }, randomBytes });
    if (!snapshot) throw new Error('snapshot_fixture_seal_failed');
    return {
        machine: { ...structural, preset: { id: presetId, revision: 1, contentEncryptionMode: mode } },
        presetContent: projectManagedMachinePresetForRecipientV1({ content: snapshot, recipients: stored.recipients,
            recipientAccountId: accountId }),
    };
}

describe('installed restore snapshot child', () => {
    it.each(['native', 'transport', 'uncoded'] as const)('retains %s snapshot failures through the child output', async stage => {
        const native = await createNativeCredentialComposerFixture({ nativeOptions: { snapshot: true } });
        const log = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
        try {
            const machine = native.input.machine;
            if (!machine.controller || !machine.resource) throw new Error('Expected managed native fixture');
            const offer = { managedId: machine.id, intentRevision: machine.intentRevision, controller: machine.controller,
                resource: machine.resource, contribution: machine.launch.provider,
                coverage: { rootDisk: true, attachedVolumes: false }, consistency: 'running',
                cost: { kind: 'billed', source: 'Native snapshot pricing' } };
            const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'snapshot', actionId: 'deployments.backups.restore',
                ...machine.controller, actionOperationId: 'restore-operation',
                input: { serverId: machine.homeId, environmentId: 'environment', targetLinkId: 'target', deploymentId: 'deployment',
                    source: { kind: 'repository', snapshotId: 'backup' }, expectedRevision: 1, machineId: 'guest',
                    installationId: 'guest-installation', mode: 'confirm', prepareOperationId: 'prepared', snapshotReview: offer },
                offer, label: 'Before restore', reason: 'Restore' });
            if (job.kind !== 'snapshot') throw new Error('Expected snapshot job');
            const nativeCause = { localCause: 'native_route_unavailable' as const };
            const failureCause = projectActionFailureCauseV1({ code: 'native_route_unavailable' }, 'machines.snapshot');
            const error = stage === 'uncoded' ? new TypeError('snapshot token=PRIVATE_SNAPSHOT_TOKEN')
                : stage === 'native' ? new PluginError({ code: 'native_failed', details: { nativeCause, token: 'PRIVATE_SNAPSHOT_TOKEN' }, failureCause })
                : new ManagedMachineControllerError('native_failed', undefined, { kind: 'managedNative', nativeCause }, failureCause);
            const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200,
                data: opaqueSnapshotRead(machine, 'plain', machine.custodianAccountId, new Uint8Array(32)) });
            const context = { surface: 'cli' as const, operationAcceptance: {
                actionId: 'deployments.backups.restore' as const, operationId: job.actionOperationId, accept() {} } };
            const adapter = createDaemonDeploymentNativeSnapshot({ serverHttpBaseUrl: 'http://home',
                executeManagedSnapshot: async () => { throw error; } }, {
                headers: async () => ({}), openManagedRead: async () => machine,
                // Transport is a real process boundary; the child owner remains loaded below it.
                sendChild: async (child, childContext) => {
                    if (stage === 'transport') throw error;
                    if (child.kind !== 'snapshot') throw new Error('Unexpected child');
                    return adapter.executeChild(child, childContext);
                },
            });
            const result = await adapter.execute({ input: job.input, offer: job.offer, label: job.label, reason: job.reason, context });
            expect(result).toMatchObject(stage === 'uncoded' ? { ok: false, errorCode: 'action_failed',
                failureCause: { errorClass: 'TypeError', errorCode: null } }
                : { ok: false, errorCode: 'native_failed', details: { kind: 'managedNative', nativeCause }, failureCause });
            expect(post).toHaveBeenCalledTimes(stage === 'transport' ? 0 : 1);
            expect(JSON.stringify(result)).not.toContain('PRIVATE_SNAPSHOT_TOKEN');
            expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE_SNAPSHOT_TOKEN');
            if (stage === 'uncoded') expect(log).toHaveBeenCalled();
        } finally { await native.cleanup(); }
    });
    it.each(['plain', 'e2ee'] as const)('spends the admitted restore through retained controller custody (%s)', async encryptionMode => {
        const native = await createNativeCredentialComposerFixture({ nativeOptions: { snapshot: true } });
        const channel = await createRequesterCurrentnessSocketHarness();
        let prepared: Awaited<ReturnType<Awaited<ReturnType<typeof createDeploymentChildRequesterHarness>>['prepare']>> | undefined;
        try {
            const machine = native.input.machine;
            if (!machine.controller || !machine.resource) throw new Error('Expected managed native fixture');
            const offer = { managedId: machine.id, intentRevision: machine.intentRevision, controller: machine.controller,
                resource: machine.resource, contribution: machine.launch.provider,
                coverage: { rootDisk: true, attachedVolumes: false }, consistency: 'running',
                cost: { kind: 'billed', source: 'Native snapshot pricing' } };
            const input = { serverId: machine.homeId, environmentId: 'environment', targetLinkId: 'target',
                deploymentId: 'deployment', source: { kind: 'repository', snapshotId: 'backup' }, expectedRevision: 1,
                machineId: 'guest', installationId: 'guest-installation', mode: 'confirm',
                prepareOperationId: 'prepared', snapshotReview: offer };
            const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'snapshot', actionId: 'deployments.backups.restore',
                ...machine.controller, actionOperationId: 'restore-operation', input, offer,
                label: 'Before restore', reason: 'Database restore' });
            const fixture = await createDeploymentChildRequesterHarness({ encryptionMode, job,
                receivingIdentity: { ...machine.controller, homeIdentityId: machine.homeId } });
            const opaque = opaqueSnapshotRead(machine, encryptionMode, fixture.root.binding.accountId, fixture.machineKey);
            expect(opaque.machine.custodianAccountId).not.toBe(fixture.root.binding.accountId);
            vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
                if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: fixture.root.binding.accountId } };
                if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: fixture.settingsContent, version: 1 } };
                if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: fixture.currentness };
                throw new Error('Unexpected snapshot requester read');
            });
            let managedReads = 0;
            const managedRequests: Array<{ url: string; body: unknown; headers: AxiosHeaders }> = [];
            vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
                managedRequests.push({ url: String(url), body, headers: new AxiosHeaders(config?.headers) });
                managedReads++;
                return { status: 200, data: opaque };
            });
            prepared = await fixture.prepare();
            const handlers = new Map<string, RpcHandler>();
            const driver = createManagedMachineAcquisitionDriver(native.driverInput);
            registerDaemonDeploymentChildRpcHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
                machineId: job.machineId,
                resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                resolveRequesterRuntime: ingress => resolveAdmittedRequesterAccountReadRuntime({ ingress,
                    serverId: fixture.profileId, machineId: job.machineId,
                    installationId: job.installationId, isInstalledCurrent: () => true }),
                resolveInstalledRuntime: async () => ({ serverId: fixture.profileId, machineId: job.machineId,
                    accountId: machine.custodianAccountId, credentials: native.driverInput.credentials,
                    serverHttpBaseUrl: fixture.serverHttpBaseUrl, isCurrent: async () => true }),
                acquirePluginRuntimeRegistryLease: async () => ({ registry: native.native.runtimeRegistry, release() {} }),
                executeManagedSnapshot: request => driver.snapshotAdmitted(request),
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_DEPLOYMENT_CHILD);
            if (!handler) throw new Error('Missing installed child handler');
            let admissionReads = 0;
            const result = await handler(job, { signal: new AbortController().signal,
                callerInputAuthorization: prepared.authorization, originalActionEnvelope: fixture.envelope,
                workspaceSyncSourceExecution: fixture.packet,
                machineAdmission: { actorAccountId: fixture.root.binding.accountId, custodianAccountId: machine.custodianAccountId,
                    ...machine.controller, role: 'use', encryptionMode },
                verifyMachineAdmissionCurrent: async () => { admissionReads++; return true; } });
            expect(managedReads).toBe(1);
            expect(managedRequests[0]?.url).toBe(`${fixture.serverHttpBaseUrl}${managedMachineActionEndpointPathV1('machines.managed.get')}`);
            expect(managedRequests[0]?.body).toEqual({ homeId: machine.homeId, managedId: machine.id });
            expect(managedRequests[0]?.headers.get(EXTERNAL_ACTION_EFFECT_ACTION_HEADER)).toBe('deployments.backups.restore');
            expect(managedRequests[0]?.headers.get(EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER)).toEqual(expect.any(String));
            expect(result, JSON.stringify(result)).toMatchObject({ kind: 'confirmed', snapshotId: 'snapshot-1' });
            expect(admissionReads).toBe(1);
            expect(native.native.effects()).toBe(1);
        } finally { await prepared?.dispose(); await channel.close(); await native.cleanup(); }
    });
});
