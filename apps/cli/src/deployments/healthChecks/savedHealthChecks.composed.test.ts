import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { Resolver } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import type { HealthCheckSourceConfigV1 } from '@happier-dev/plugin-sdk';
import { MachineServicesDetailResultV1Schema, sealAutomationTriggerDefinitionStoredEnvelopeV1,
    createActionExecutor, type AutomationEventStoredDefinitionProjectionV1 } from '@happier-dev/protocol';
import { createAutomationEventAdoptedDefinitionSetHostV1 } from '@/plugins/runtime/automations/automationEventAdoptedDefinitionSetHost';
import type { PluginInvocationServicesSeed } from '@/plugins/runtime/invocation/services/types';
import { createSavedHealthChecksHost } from './savedHealthChecks';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createPluginHttpService } from '@/plugins/runtime/fetch/service';
import { createGlobalFetchRuntime } from '@/plugins/runtime/fetch/globalFetchRuntime';
import { createPluginInvocationActionsService } from '@/plugins/runtime/invocation/services/actions';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createDeploymentSocketHome } from '../../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';
import { db } from '../../../../server/sources/storage/db';
import { inTx } from '../../../../server/sources/storage/inTx';
import { auth } from '../../../../server/sources/app/auth/auth';
import { createProjectSourceInTx } from '../../../../server/sources/app/projects/sources/projectSourceService';
import { makeShareEligibleForTest } from '../../../../server/sources/testkit/shareEligibility.testkit';

async function adopted(sourceConfig: HealthCheckSourceConfigV1, observerMachineId = 'subject') {
    const caller = { pluginId: 'happier.machine.services', machineId: observerMachineId, materializationId: 'installed' };
    const abort = new AbortController();
    const eventRef = { pluginId: caller.pluginId, localId: 'health-status' };
    const binding = { v: 1 as const, automationId: 'automation', triggerId: 'trigger', triggerRevision: 1,
        triggerKind: 'pluginEvent' as const, eventRef, sourceSelectorId: '11111111-1111-4111-8111-111111111111' };
    const stored: AutomationEventStoredDefinitionProjectionV1 = {
        automationId: binding.automationId, triggerId: binding.triggerId, triggerRevision: 1, eventRef,
        sourceSelectorId: binding.sourceSelectorId, sourceContractVersion: 1,
        observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: caller }, payloadSchema: { type: 'object' },
        storedDefinitionEnvelope: sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding,
            definition: { v: 1, sourceInstanceId: 'health:subject', sourceConfig, displayLabel: 'Service checks',
                filter: null, maximumObservationAgeMs: null } }),
    };
    const sourceCustody = { kind: 'managed' as const, immutableGenerationId: 'generation', installSource: 'archive' as const };
    const readStoredDefinitions = vi.fn(async () => ({ kind: 'page', revision: '1', definitions: [stored], nextCursor: null,
        eventDeclarationRelease: { release: { pluginId: caller.pluginId, version: '0.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}` } }));
    const owner = createAutomationEventAdoptedDefinitionSetHostV1({
        credentials: { token: 'fixture-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
        caller, occurrenceId: 'occurrence', sourceCustody, transport: { kind: 'checkpointedPull' }, occurrenceSignal: abort.signal,
        isOccurrenceCurrent: () => true, revalidateCallerMaterialization: async () => true, revalidateCallerOccurrence: async () => true,
        resolveAccountEncryptionCurrentness: async () => ({ mode: 'plain', version: 1, signingKeyFingerprint: 'aemk1_signing',
            contentKeyFingerprint: null, updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } }),
        resolveAccountEncryptionMaterial: async () => null,
        readStoredDefinitions,
    });
    expect(await owner.refresh()).toEqual({ kind: 'adopted', revision: '1' });
    const seed: PluginInvocationServicesSeed = { plugin: { id: caller.pluginId, version: '0.0.0' },
        contribution: { id: 'health-observer', qualifiedId: `${caller.pluginId}/backgroundServices/health-observer` },
        occurrenceId: 'occurrence', sourceCustody, correlationId: 'correlation', surface: 'background', signal: abort.signal,
        resolveCurrentPluginMaterializationRef: () => caller, isOccurrenceCurrent: () => true };
    return { seed, owner, readStoredDefinitions, observer: { machineId: observerMachineId, installationId: 'installation' } };
}

const definition = (kind: string, config: HealthCheckSourceConfigV1['checks'][number]['config']) => ({
    checkId: kind, kind: { pluginId: 'happier.machine.services', localId: kind }, binding: { kind: 'healthCheck' as const },
    config, periodMs: 1000, consecutiveFailuresBeforeAlerting: 1,
});

describe('saved source finite native producer binding', () => {
    it('reads an Environment heartbeat at its controller through the same saved source and exact receipt owner', async () => {
        const environment = createDeploymentEnvironmentHeaderV1({ id: 'environment', serverId: 'server', controllerMachineId: 'observer' });
        const sourceConfig: HealthCheckSourceConfigV1 = { v: 1, subject: { kind: 'environment', environmentId: environment.id },
            checks: [definition('heartbeat', { webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA', graceMs: 200 })] };
        const f = await adopted(sourceConfig, 'observer');
        let lastAcceptedAt: number | null = null;
        let time = 2200;
        const receipts = vi.fn(async () => ({ kind: 'ready' as const, lastAcceptedAt }));
        const execute = vi.fn(async () => ({ ok: true as const, environment, targetLinks: [] }));
        const host = createSavedHealthChecksHost({ serverId: 'server', resolveAdoptedDefinitionSet: () => f.owner,
            readObserver: () => f.observer, now: () => time, readHeartbeatReceipt: receipts,
            openDomainArtifact: async () => { throw new Error('Heartbeat has no Domain content'); } });
        const service = host.bind(f.seed, { actions: { execute } as unknown as ActionsService,
            http: { request: () => { throw new Error('Heartbeat does not probe'); } } as unknown as HttpService });
        expect(await service!.read({ sourceInstanceId: 'health:subject', checkIds: ['heartbeat'] }))
            .toMatchObject([{ checkId: 'heartbeat', result: { status: 'unknown' }, nextEligibleAt: null }]);
        lastAcceptedAt = 1000;
        expect(await service!.read({ sourceInstanceId: 'health:subject', checkIds: ['heartbeat'] }))
            .toMatchObject([{ result: { status: 'up' }, nextEligibleAt: 2201 }]);
        time = 2201;
        expect(await service!.read({ sourceInstanceId: 'health:subject', checkIds: ['heartbeat'] }))
            .toMatchObject([{ result: { status: 'down' } }]);
        expect(receipts).toHaveBeenLastCalledWith({ caller: f.seed.resolveCurrentPluginMaterializationRef!(),
            sourceInstanceId: 'health:subject', checkId: 'heartbeat', webhookEndpointId: 'wh_ep_AAAAAAAAAAAAAAAAAAAAAA' }, expect.any(AbortSignal));
        const other = await adopted(sourceConfig, 'other-controller');
        const retired = createSavedHealthChecksHost({ serverId: 'server', resolveAdoptedDefinitionSet: () => other.owner,
            readObserver: () => other.observer, readHeartbeatReceipt: receipts, openDomainArtifact: async () => null })
            .bind(other.seed, { actions: { execute } as unknown as ActionsService, http: {} as HttpService });
        await expect(retired!.read({ sourceInstanceId: 'health:subject', checkIds: ['heartbeat'] }))
            .rejects.toMatchObject({ code: 'health_check_subject_mismatch' });
        expect(receipts).toHaveBeenCalledTimes(3);
    });

    it.each(['http', 'certificate'] as const)('binds a finite saved %s Action to the current Domain and refuses another person before the network', async kind => {
        const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
        await withTempDir('happier-saved-health-home-', async homeDir => {
            env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: undefined,
                HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
            reloadConfiguration();
            const home = await createDeploymentSocketHome();
            try {
                const profile = await addServerProfile({ name: 'saved-health', serverUrl: home.baseUrl, webappUrl: home.baseUrl });
                await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact',
                    descriptor: { v: 1, homeServerIdentityId: home.serverId, canonicalServerUrl: home.baseUrl,
                        revision: 1, endpoints: [{ kind: 'https', url: home.baseUrl }] } });
                const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
                const requesterToken = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user',
                    authenticationEvidence: [{ kind: 'home_method', methodId: 'key_challenge' }] });
                await makeShareEligibleForTest(home.accountId, requester.id);
                const source = await inTx(tx => createProjectSourceInTx(tx, home.accountId, { serverId: home.serverId,
                    requestKey: randomUUID(), name: 'Saved Domain authority', audience: [
                        { principal: { kind: 'account', accountId: requester.id }, level: 'view' },
                    ] }));
                if (!source.ok) throw new Error(source.error);
                const environmentContent = await home.createContentArtifact({}, 'deployment-environment.v1');
                const targetContent = await home.createContentArtifact({}, 'deployment-target-link.v1');
                const ownerCredentials = { token: home.token, encryption: null };
                const artifacts = createCredentialedAccountArtifactStore(ownerCredentials);
                const domainArtifact = await runWithServerHttpBaseUrl(home.baseUrl, () => artifacts.create({
                    header: { kind: 'deployment-domain.v1', title: 'Saved Domain authority' },
                    body: JSON.stringify({ hostname: 'app.example.test', target: { service: 'web', containerPort: 3000 },
                        healthCheck: { path: '/ready', expectStatus: 204 } }),
                }));
                const domainContent = { contentArtifactId: domainArtifact.artifactId,
                    contentHeaderVersion: domainArtifact.revision.headerVersion,
                    contentBodyVersion: domainArtifact.revision.bodyVersion };
                await db.artifactAccountGrant.createMany({ data: [environmentContent.contentArtifactId,
                    targetContent.contentArtifactId, domainContent.contentArtifactId].map(artifactId => ({ artifactId,
                    accountId: requester.id, accessLevel: 'view', createdByAccountId: home.accountId })) });
                const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
                    createdByAccountId: home.accountId, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                    controllerMachineId: home.machineId, ...environmentContent } });
                const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
                    createdByAccountId: home.accountId, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
                    targetKind: 'ownServer', state: 'configured', ...targetContent,
                    machines: { create: { machineId: home.machineId, installationId: home.installationId,
                        position: 0, state: 'active' } } } });
                const domain = await db.deploymentDomain.create({ data: { environmentId: environment.id, targetLinkId: link.id,
                    createdByAccountId: home.accountId, state: 'active', ...domainContent } });
                const sourceConfig: HealthCheckSourceConfigV1 = { v: 1,
                    subject: { kind: 'environment', environmentId: environment.id },
                    checks: [{ ...definition(kind, {}), binding: { kind: 'domain', domainId: domain.id,
                        targetLinkId: link.id, condition: 'domain_probe_failed' } }] };
                const f = await adopted(sourceConfig, home.machineId);
                const actionSeed: PluginInvocationServicesSeed = { ...f.seed, surface: 'cli',
                    contribution: { id: `health/${kind}`, qualifiedId: `happier.machine.services/actions/health/${kind}` } };
                const requests: string[] = [];
                let expectedStatus = 204;
                const http = { request: vi.fn(async ({ url }: { url: string }) => {
                    requests.push(url);
                    return { status: expectedStatus, body: new Uint8Array(), finalUrl: url,
                        tlsPeer: { url, fingerprint256: 'AA:BB', notBefore: Date.now() - 60_000, notAfter: Date.now() + 60_000 } };
                }) } as unknown as HttpService;
                const openDomainArtifact = vi.fn(async (artifactId: string, signal: AbortSignal) =>
                    await runWithServerHttpBaseUrl(home.baseUrl, () => artifacts.read(artifactId, {
                        signal, prepareRecipients: false, includeSharedAudience: false })));
                const onDomainResult = vi.fn();
                const host = createSavedHealthChecksHost({ serverId: profile.id,
                    resolveAdoptedDefinitionSet: () => f.owner, readObserver: () => f.observer, openDomainArtifact, onDomainResult });
                const actionsFor = (token: string) => createPluginInvocationActionsService({ seed: actionSeed,
                    actionExecutor: createActionExecutor({ ...createUnavailableActionTransportDeps(),
                        ...createDaemonDeploymentActionDeps({ credentials: { token, encryption: null },
                            serverId: profile.id, serverHttpBaseUrl: home.baseUrl, machineId: home.machineId,
                            resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
                            runtime: { async acquire() { throw new Error('No native role in saved health admission'); } },
                        }),
                    }), invokeContributedAction: async () => { throw new Error('No contributed Action in saved health admission'); } });
                const ownerService = host.bind(actionSeed, { actions: actionsFor(home.token), http });
                if (!ownerService) throw new Error('Owner service must bind');
                await expect(ownerService.setup({ sourceInstanceId: 'health:subject', sourceConfig: {
                    ...sourceConfig, checks: [{ ...sourceConfig.checks[0]!, binding: { kind: 'domain',
                        domainId: 'not-deployed-domain', targetLinkId: link.id, condition: 'domain_probe_failed' } }],
                }, heartbeatContributionId: 'health-heartbeat' })).rejects.toMatchObject({
                    code: 'deployment_unavailable', details: { requiredFact: 'domainServingAddress',
                        remedy: expect.stringMatching(/deploy/i) },
                    data: { name: 'PluginError', code: 'deployment_unavailable',
                        details: { requiredFact: 'domainServingAddress', remedy: expect.stringMatching(/deploy/i) } },
                });
                expect(requests).toEqual([]);
                expect(await ownerService.setup({ sourceInstanceId: 'health:subject', sourceConfig,
                    heartbeatContributionId: 'health-heartbeat' })).toEqual(sourceConfig);
                await expect(ownerService.setup({ sourceInstanceId: 'health:subject', sourceConfig: {
                    ...sourceConfig, checks: [{ ...sourceConfig.checks[0]!, config: { endpoint: 'https://attacker.example', expectStatus: 200 } }],
                }, heartbeatContributionId: 'health-heartbeat' })).rejects.toMatchObject({ code: 'source_config_invalid' });
                expect((await ownerService.read({ sourceInstanceId: 'health:subject', checkIds: [kind] }))[0]?.result.status).toBe('up');
                expect(requests).toEqual(['https://app.example.test/ready']);
                const changedArtifact = await runWithServerHttpBaseUrl(home.baseUrl, () => artifacts.create({
                    header: { kind: 'deployment-domain.v1', title: 'Saved Domain authority' },
                    body: JSON.stringify({ hostname: 'app.example.test', target: { service: 'web', containerPort: 3000 },
                        healthCheck: { path: '/changed', expectStatus: 205 } }),
                }));
                await db.deploymentDomain.update({ where: { id: domain.id }, data: { revision: { increment: 1 },
                    contentArtifactId: changedArtifact.artifactId, contentHeaderVersion: changedArtifact.revision.headerVersion,
                    contentBodyVersion: changedArtifact.revision.bodyVersion } });
                expectedStatus = 205;
                expect((await ownerService.read({ sourceInstanceId: 'health:subject', checkIds: [kind] }))[0]?.result.status).toBe('up');
                expect(requests).toEqual(['https://app.example.test/ready', 'https://app.example.test/changed']);
                expect(onDomainResult).toHaveBeenCalledTimes(2);
                expect(onDomainResult).toHaveBeenLastCalledWith(expect.objectContaining({ kind,
                    sourceRevision: '1', environment: expect.objectContaining({ id: environment.id }),
                    targetLink: expect.objectContaining({ id: link.id }), domain: expect.objectContaining({ id: domain.id }),
                    result: expect.objectContaining({ status: 'up' }) }));
                const requesterService = host.bind(actionSeed, { actions: actionsFor(requesterToken), http });
                if (!requesterService) throw new Error('Requester service must bind');
                await expect(requesterService.setup({ sourceInstanceId: 'health:subject', sourceConfig,
                    heartbeatContributionId: 'health-heartbeat' })).rejects.toMatchObject({ code: 'deployment_access_denied' });
                await expect(requesterService.read({ sourceInstanceId: 'health:subject', checkIds: [kind] }))
                    .rejects.toMatchObject({ code: 'deployment_access_denied' });
                expect(requests).toHaveLength(2);
                expect(openDomainArtifact).toHaveBeenCalledTimes(3);
                expect(onDomainResult).toHaveBeenCalledTimes(2);
                const otherLink = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
                    createdByAccountId: home.accountId, role: 'data', sourceKind: 'plugin', pluginId: 'example.data',
                    contributionLocalId: 'database', targetKind: 'database', state: 'configured', ...targetContent } });
                await db.deploymentDomain.update({ where: { id: domain.id }, data: { targetLinkId: otherLink.id,
                    revision: { increment: 1 } } });
                await expect(ownerService.read({ sourceInstanceId: 'health:subject', checkIds: [kind] }))
                    .rejects.toMatchObject({ code: 'health_check_subject_mismatch' });
                expect(requests).toHaveLength(2);
                expect(openDomainArtifact).toHaveBeenCalledTimes(3);
            } finally {
                await home.close();
                env.restore();
                reloadConfiguration();
            }
        });
    }, 180_000);
    it('runs saved TCP/DNS/heartbeat selectors under one adopted source without another scan or Environment', async () => {
        let connections = 0;
        const server = createServer(socket => { connections += 1; socket.end(); });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('TCP listener required');
        const dns = vi.spyOn(Resolver.prototype, 'resolve').mockResolvedValue(['192.0.2.1']);
        try {
            const sourceConfig: HealthCheckSourceConfigV1 = { v: 1, subject: { kind: 'machineService', machineId: 'subject', serviceId: 'service' },
                checks: [definition('tcp', { host: '127.0.0.1', port: address.port }),
                    definition('dns', { hostname: 'private.example.test', recordType: 'A', expectedAnswer: '192.0.2.1' }),
                    definition('heartbeat', { webhookEndpointId: 'endpoint', graceMs: 200 })] };
            const f = await adopted(sourceConfig);
            // Machine detail and heartbeat receipt are remote host boundaries;
            // source adoption/config admission and native producers remain real.
            const detail = MachineServicesDetailResultV1Schema.parse({ kind: 'service', service: {
                serviceId: 'service', name: 'Watched service', authority: 'machine', lifecyclePurpose: 'deployment',
                generation: 'generation', state: 'running', watchId: 'service', watchRevision: '1',
                native: { phase: 'running', readiness: 'not_reported' },
                nativeInstance: { adapter: { pluginId: 'happier.machine.services', localId: 'systemd' }, nativeResourceId: 'example.service' },
                capabilities: { start: true, stop: true, restart: true, logs: true, accounting: false },
            } });
            const execute = vi.fn(async () => detail);
            const actions = { execute } as unknown as ActionsService;
            const http = createPluginHttpService({ adapter: createGlobalFetchRuntime() });
            const receipts = vi.fn(async () => ({ kind: 'ready' as const, lastAcceptedAt: 1000 }));
            const host = createSavedHealthChecksHost({ serverId: 'server', resolveAdoptedDefinitionSet: () => f.owner,
                readObserver: () => f.observer, now: () => 2200, readHeartbeatReceipt: receipts,
                openDomainArtifact: async () => null });
            const service = host.bind(f.seed, { actions, http });
            expect(service).not.toBeNull();
            const results = await service!.read({ sourceInstanceId: 'health:subject', checkIds: ['tcp', 'dns', 'heartbeat'] });
            expect(results.map(value => value.result.status)).toEqual(['up', 'up', 'up']);
            expect(results[2]?.nextEligibleAt).toBe(2201);
            expect(f.readStoredDefinitions).toHaveBeenCalledTimes(1);
            expect(execute).toHaveBeenCalledTimes(1);
            expect(execute).toHaveBeenCalledWith('machines.services.detail', { serverId: 'server', machineId: 'subject', serviceId: 'service' },
                expect.objectContaining({ signal: expect.any(AbortSignal) }));
            expect(dns).toHaveBeenCalledWith('private.example.test', 'A');
            expect(JSON.stringify(results)).not.toContain('private.example.test');
            const remote = await adopted(sourceConfig, 'outside-observer');
            const remoteHost = createSavedHealthChecksHost({ serverId: 'server', resolveAdoptedDefinitionSet: () => remote.owner,
                readObserver: () => remote.observer, now: () => 2200, readHeartbeatReceipt: receipts,
                openDomainArtifact: async () => null }).bind(remote.seed, { actions, http });
            await expect(remoteHost!.read({ sourceInstanceId: 'health:subject', checkIds: ['tcp', 'dns', 'heartbeat'] }))
                .rejects.toMatchObject({ code: 'health_check_subject_mismatch' });
            expect(connections).toBe(1);
            expect(dns).toHaveBeenCalledTimes(1);
            expect(receipts).toHaveBeenCalledTimes(1);
        } finally {
            dns.mockRestore();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });
});
