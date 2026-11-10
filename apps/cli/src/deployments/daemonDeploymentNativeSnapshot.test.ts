import axios, { AxiosHeaders } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploymentChildRpcV1Schema } from '@happier-dev/protocol';
import { managedMachineActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { RpcHandler } from '@/api/rpc/types';
import { resolveAdmittedRequesterAccountReadRuntime } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createDeploymentChildRequesterHarness } from '@/testkit/backends/deploymentChildRequesterHarness';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createNativeCredentialComposerFixture } from '@/machines/managed/nativeCredentialComposer.testkit';
import { createManagedMachineAcquisitionDriver } from '@/machines/managed/acquire';
import { registerDaemonDeploymentChildRpcHandler } from './daemonDeploymentChildRpc';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('installed restore snapshot child', () => {
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
                return { status: 200, data: machine };
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
