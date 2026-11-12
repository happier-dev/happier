import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, sealSessionDataKeyBundleV0,
    sealEncryptedDataKeyEnvelopeV1, DeploymentDomainMutationResultV1Schema, DeploymentDomainListResultV1Schema,
    deploymentDomainObservationProofPayloadV1, nativeCaddyDomainRouteIdsV1, nativeCaddyRemovalSigningBytes,
    type DeploymentDomainObservationBodyV1, type DeploymentDomainPlacementV1 } from '@happier-dev/protocol';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import type { ExternalActionExecutionAuthorizationBindingV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { projectDeploymentDomainHeader, projectDeploymentDomainMachineReferences, prepareDeploymentTeardownDomainsInTx,
    readAcceptedDeploymentTeardownDomainContentInTx, readMemberDeploymentDomainContentInTx } from './deploymentDomainService';
import { loadDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import { DeploymentDomainCapturedPlacementsV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { deploymentDomainProviderObservationProofPayloadV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';

describe('public Domain storage and native custody', () => {
    const serverId = `srv_${'d'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-domain-', initEncrypt: true, initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: serverId } });
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function fixture(mode: 'plain' | 'e2ee' = 'plain') {
        const contentKeys = nacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(contentKeys.publicKey) : {}) } });
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        const key = nacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: crypto.randomUUID(), installationPublicKey: key.publicKey } });
        const source = await db.projectSource.create({ data: { createdByAccountId: owner.id,
            owner: { kind: 'account', accountId: owner.id }, name: 'Domain owner', audience: [], attachments: [] } });
        const content = async (kind: string) => {
            const dataKey = nacl.randomBytes(32);
            const seal = async (value: unknown) => mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value))
                : new Uint8Array(await sealSessionDataKeyBundleV0(value, dataKey));
            const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                kind: `v1:other:${kind}`, header: await seal({ kind, title: 'Private domain' }),
                body: await seal({ body: JSON.stringify(kind === 'deployment-domain.v1' ? { hostname: 'qa-domain-1101-ingress.localhost',
                    target: { service: 'web', containerPort: 80 }, healthCheck: { path: '/', expectStatus: 200 } } : { hostname: 'private.example.test' }) }),
                dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)
                    : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: contentKeys.publicKey, randomBytes: nacl.randomBytes })) });
            if (!artifact.ok) throw new Error(artifact.error);
            return { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.id,
            createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: machine.id, ...await content('deployment-environment.v1'), referencedSavedSecretRevisions: [] } });
        const target = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured',
            createdByAccountId: owner.id, ...await content('deployment-target-link.v1'),
            machines: { create: { machineId: machine.id, installationId: machine.installationId!, position: 0, state: 'active' } } } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: target.id } });
        return { owner, foreign, machine, key, environment, target, content };
    }

    it.each(['plain', 'e2ee'] as const)('admits a provider Domain without fabricating native placements in %s', async mode => {
        const f = await fixture(mode);
        await db.deploymentTargetLink.update({ where: { id: f.target.id }, data: {
            sourceKind: 'plugin', hostTargetId: null, pluginId: 'happier.deploy.vercel', contributionLocalId: 'runtime', targetKind: 'vercel' } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const input = { serverId, domainId: crypto.randomUUID(), environmentId: f.environment.id, expectedRevision: 1,
                targetLinkId: f.target.id, expectedTargetLinkRevision: 1, requestKey: crypto.randomUUID(),
                actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID(), provider: true, placements: [],
                ...await f.content('deployment-domain.v1') };
            const added = await app.inject({ method: 'POST', url: `/v1/deployments/environments/${f.environment.id}/domains`,
                headers: { 'x-test-user-id': f.owner.id }, payload: input });
            expect(added.statusCode).toBe(200);
            expect(added.json()).toMatchObject({ ok: true, domain: { id: input.domainId, provider: true, state: 'pending', placements: [] } });
            expect(JSON.stringify(added.json())).not.toContain('qa-domain-1101-ingress.localhost');
            const stored = await db.deploymentDomain.findUniqueOrThrow({ where: { id: input.domainId } });
            expect(stored.capturedPlacements).toMatchObject({ kind: 'provider', placement: { controller: {
                machineId: f.machine.id, installationId: f.machine.installationId } } });
            const result = DeploymentDomainMutationResultV1Schema.parse(added.json());
            if (!result.ok || !result.domain.providerPlacement) throw new Error('provider capture missing');
            expect(result.domain).not.toHaveProperty('routedReplicas');
            const url = `/v1/deployments/environments/${f.environment.id}/domains/${input.domainId}`;
            const headers = { 'x-test-user-id': f.owner.id };
            const settle = (domain: typeof result.domain, state: 'active' | 'removed', tamper = false) => {
                const observation = { placement: domain.providerPlacement!, state };
                return app.inject({ method: 'POST', url: `${url}/transitions`, headers, payload: {
                    serverId, environmentId: f.environment.id, domainId: input.domainId, expectedDomainRevision: domain.revision,
                    observations: [], providerObservation: { ...observation, ...(tamper ? { state: 'warning' } : {}),
                        proof: signMachineInstallationProof({ privateKey: f.key.secretKey,
                            payload: deploymentDomainProviderObservationProofPayloadV1({ expectedDomainRevision: domain.revision, observation }) }) },
                } });
            };
            expect((await settle(result.domain, 'active', true)).statusCode).toBe(403);
            const active = DeploymentDomainMutationResultV1Schema.parse((await settle(result.domain, 'active')).json());
            if (!active.ok) throw new Error(active.error);
            expect(active.domain).toMatchObject({ state: 'active', revision: 2 });
            expect((await app.inject({ method: 'GET', url: `${url}?serverId=${serverId}`, headers })).json()).toEqual(active);
            expect((await settle(active.domain, 'active')).json()).toEqual(active);
            const removal = DeploymentDomainMutationResultV1Schema.parse((await app.inject({ method: 'POST', url: `${url}/remove`, headers,
                payload: { serverId, environmentId: f.environment.id, domainId: input.domainId, expectedRevision: active.revision,
                    expectedDomainRevision: active.domain.revision, actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID(),
                    requestKey: crypto.randomUUID() } })).json());
            if (!removal.ok) throw new Error(removal.error);
            expect(removal.domain).toMatchObject({ state: 'removing' });
            expect((await settle(removal.domain, 'removed')).json()).toMatchObject({ ok: true, domain: { deletedAtMs: expect.any(Number) } });
        });
    });

    it.each(['plain', 'e2ee'] as const)('captures retained provider Domains under the existing teardown admission in %s', async mode => {
        const f = await fixture(mode);
        await db.deploymentTargetLink.update({ where: { id: f.target.id }, data: {
            sourceKind: 'plugin', hostTargetId: null, pluginId: 'happier.deploy.vercel', contributionLocalId: 'runtime', targetKind: 'vercel' } });
        const reference = await f.content('deployment-domain.v1');
        const domainId = crypto.randomUUID();
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const added = await app.inject({ method: 'POST', url: `/v1/deployments/environments/${f.environment.id}/domains`,
                headers: { 'x-test-user-id': f.owner.id }, payload: { serverId, domainId, environmentId: f.environment.id,
                    expectedRevision: 1, targetLinkId: f.target.id, expectedTargetLinkRevision: 1,
                    requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID(),
                    provider: true, placements: [], ...reference } });
            expect(added.statusCode).toBe(200);
        });
        const actionOperationId = crypto.randomUUID();
        const binding = { serverIdentityId: serverId, accountId: f.owner.id,
            authentication: { kind: 'account', tokenEpoch: f.owner.tokenEpoch }, actionId: 'deployments.teardown',
            target: { kind: 'machine', machineId: f.machine.id }, machineId: f.machine.id,
            custodianAccountId: f.owner.id, installationId: f.machine.installationId!, environmentId: f.environment.id,
            requestId: crypto.randomUUID(), requestEnvelopeDigest: 'd'.repeat(43) } satisfies ExternalActionExecutionAuthorizationBindingV1;
        const result = await inTx(async tx => {
            const loaded = await loadDeploymentEnvironmentInTx(tx, f.owner.id, serverId, f.environment.id);
            if (!loaded.ok) throw new Error(loaded.error);
            return prepareDeploymentTeardownDomainsInTx(tx, f.owner.id, actionOperationId, loaded, binding);
        });
        expect(result).toEqual({ ok: true });
        const removing = await db.deploymentDomain.findUniqueOrThrow({ where: { id: domainId } });
        expect(removing).toMatchObject({ state: 'removing', capturedPlacements: { kind: 'provider',
            requestEnvelopeDigest: binding.requestEnvelopeDigest, placement: { actionOperationId, requestId: binding.requestId } } });
        expect(await inTx(tx => readAcceptedDeploymentTeardownDomainContentInTx(tx, binding, reference.contentArtifactId))).toEqual(reference);
        expect(await inTx(tx => readAcceptedDeploymentTeardownDomainContentInTx(tx,
            { ...binding, requestEnvelopeDigest: 'x'.repeat(43) }, reference.contentArtifactId))).toBeNull();
        const otherMachineId = crypto.randomUUID();
        for (const changed of [
            { ...binding, machineId: otherMachineId, target: { kind: 'machine' as const, machineId: otherMachineId } },
            { ...binding, installationId: crypto.randomUUID() },
            { ...binding, requestId: crypto.randomUUID() },
            { ...binding, accountId: f.foreign.id },
        ]) {
            expect(await inTx(tx => readAcceptedDeploymentTeardownDomainContentInTx(tx,
                changed, reference.contentArtifactId))).toBeNull();
        }
        expect(projectDeploymentDomainMachineReferences(removing, f.machine.id)).toEqual([]);
        expect(await inTx(tx => readMemberDeploymentDomainContentInTx(tx, {
            environmentId: f.environment.id, targetLinkId: f.target.id, machineId: f.machine.id,
            installationId: f.machine.installationId!, artifactId: reference.contentArtifactId,
        }))).toBeNull();
    });

    it.each(['plain', 'e2ee'] as const)('keeps native-only Domain success unhealthy until public DNS is observed in %s', async mode => {
        const f = await fixture(mode);
        const domainId = crypto.randomUUID();
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const url = `/v1/deployments/environments/${f.environment.id}/domains`;
            const headers = { 'x-test-user-id': f.owner.id };
            const added = DeploymentDomainMutationResultV1Schema.parse((await app.inject({ method: 'POST', url, headers,
                payload: { serverId, domainId, environmentId: f.environment.id, expectedRevision: 1,
                    targetLinkId: f.target.id, expectedTargetLinkRevision: 1, requestKey: crypto.randomUUID(),
                    actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID(),
                    placements: [{ machineId: f.machine.id, installationId: f.machine.installationId!,
                        nativeServer: 'private', listener: 'privateOrigin', dockerEngineId: 'domain-engine' }],
                    ...await f.content('deployment-domain.v1') } })).json());
            if (!added.ok) throw new Error(added.error);
            const settle = async (revision: number, dnsHealth?: DeploymentDomainObservationBodyV1['dnsHealth'], tamper = false) => {
                const observation = { capture: added.domain.placements![0]!, state: 'active' as const,
                    ...(dnsHealth ? { dnsHealth } : {}) };
                return app.inject({ method: 'POST',
                url: `${url}/${domainId}/transitions`, headers, payload: { serverId, environmentId: f.environment.id,
                    domainId, expectedDomainRevision: revision, observations: [{ ...observation,
                        ...(tamper ? { dnsHealth: { ...dnsHealth, status: 'up' } } : {}),
                        proof: signMachineInstallationProof({ privateKey: f.key.secretKey,
                            payload: deploymentDomainObservationProofPayloadV1({ expectedDomainRevision: revision, observation }) }) }] } });
            };
            expect((await settle(1)).json()).toMatchObject({ ok: true, domain: { state: 'warning', revision: 2 } });
            const missing: NonNullable<DeploymentDomainObservationBodyV1['dnsHealth']> = { status: 'down', evidence: {
                v: 1, items: [{ source: { kind: 'alert', label: 'dns' }, author: { kind: 'process' },
                    text: JSON.stringify({ reason: 'dns_missing', remedy: 'Configure public DNS, then verify the Domain again.' }) }] } };
            expect((await settle(2, missing, true)).statusCode).toBe(403);
            const unhealthy = DeploymentDomainMutationResultV1Schema.parse((await settle(2, missing)).json());
            expect(unhealthy).toMatchObject({ ok: true, domain: { state: 'warning', revision: 3, dnsHealth: missing } });
            expect((await app.inject({ method: 'GET', url: `${url}/${domainId}?serverId=${serverId}`, headers })).json()).toEqual(unhealthy);
            expect((await app.inject({ method: 'GET', url: `${url}?serverId=${serverId}`, headers })).json())
                .toMatchObject({ ok: true, domains: [{ state: 'warning', dnsHealth: missing }] });
            const changes: string[] = [];
            const stop = observeSqliteRequests({ before: event => {
                if (event.model === 'DeploymentDomain' && event.action === 'update') changes.push(event.action);
            } });
            try { expect((await settle(3, missing)).json()).toEqual(unhealthy); } finally { stop(); }
            expect(changes).toEqual([]);
            const resolved = { ...missing, status: 'up' as const, evidence: { ...missing.evidence,
                items: [{ ...missing.evidence.items[0]!, text: JSON.stringify({ reason: 'dns_matched' }) }] } };
            expect((await settle(3, resolved)).json()).toMatchObject({ ok: true, domain: { state: 'active', revision: 4, dnsHealth: resolved } });
            const unavailable = { ...missing, status: 'unknown' as const };
            expect((await settle(4, unavailable)).json()).toMatchObject({ ok: true, domain: { state: 'warning', revision: 5, dnsHealth: unavailable } });
        });
    });

    it.each(['plain', 'e2ee'] as const)('creates and lists a multi-Machine local-hostname Domain in %s through the public route, records native facts and tombstones only signed complete removal', async mode => {
        const f = await fixture(mode);
        const secondMachine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.owner.id,
            metadata: '{}', installationId: crypto.randomUUID(), installationPublicKey: f.key.publicKey } });
        await db.deploymentTargetLink.update({ where: { id: f.target.id }, data: { machines: { create: {
            machineId: secondMachine.id, installationId: secondMachine.installationId!, position: 1, state: 'active',
        } } } });
        const input = { serverId, domainId: crypto.randomUUID(), environmentId: f.environment.id, expectedRevision: 1,
            targetLinkId: f.target.id, expectedTargetLinkRevision: 1, requestKey: crypto.randomUUID(),
            actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID(),
            placements: [{ machineId: f.machine.id, installationId: f.machine.installationId!, nativeServer: 'private', listener: 'privateOrigin', dockerEngineId: 'domain-engine' },
                { machineId: f.machine.id, installationId: f.machine.installationId!, nativeServer: 'public', listener: 'public', dockerEngineId: 'domain-engine' },
                { machineId: secondMachine.id, installationId: secondMachine.installationId!, nativeServer: 'private', listener: 'privateOrigin', dockerEngineId: 'second-domain-engine' }],
            ...await f.content('deployment-domain.v1') };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const request = (user: string, body: Record<string, unknown> = input) => app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${f.environment.id}/domains`, headers: { 'x-test-user-id': user }, payload: body });
            const created = await request(f.owner.id);
            expect(created.statusCode).toBe(200);
            expect((await request(f.foreign.id)).statusCode).toBe(404);
            const result = DeploymentDomainMutationResultV1Schema.parse(created.json());
            if (!result.ok) throw new Error(result.error);
            expect(result).toMatchObject({ ok: true, environmentId: f.environment.id, revision: 2,
                domain: { state: 'pending', revision: 1, targetLinkId: f.target.id } });
            expect(JSON.stringify(result)).not.toContain('qa-domain-1101-ingress.localhost');
            expect((await request(f.owner.id)).json()).toEqual(result);
            expect(await db.deploymentDomain.count({ where: { environmentId: f.environment.id } })).toBe(1);
            const stored = await db.deploymentDomain.findUniqueOrThrow({ where: { id: result.domain.id } });
            // The native target is not the operation controller. All retained legs belong to the
            // current admitted root, so project its exact address without disclosing execution custody.
            const captures = DeploymentDomainCapturedPlacementsV1Schema.parse(stored.capturedPlacements);
            expect(result.domain).not.toHaveProperty('routedReplicas');
            const emptyTopology = captures.map(capture => ({ ...capture, routedReplicas: [] }));
            expect(projectDeploymentDomainHeader({ ...stored, capturedPlacements: emptyTopology }))
                .toMatchObject({ routedReplicas: { source: 'recordedTopology', count: 0, replicas: [] } });
            expect(projectDeploymentDomainHeader({ ...stored, capturedPlacements: [emptyTopology[0], ...captures.slice(1)] }))
                .not.toHaveProperty('routedReplicas');
            expect(projectDeploymentDomainHeader({ ...stored, capturedPlacements: [
                ...emptyTopology, { ...captures[0]!, desired: false, routedReplicas: [{ containerName: 'retired-web' }] },
            ] })).toMatchObject({ routedReplicas: { source: 'recordedTopology', count: 0, replicas: [] } });
            expect(projectDeploymentDomainHeader({ ...stored,
                capturedPlacements: captures.map(capture => ({ ...capture, desired: false, routedReplicas: [{ containerName: 'retired-web' }] })),
            })).not.toHaveProperty('routedReplicas');
            expect(projectDeploymentDomainHeader({ ...stored, deletedAt: new Date(), capturedPlacements: emptyTopology }))
                .not.toHaveProperty('routedReplicas');
            const executed = captures.map(capture => ({ ...capture, execution: {
                controller: { machineId: 'controller-machine', installationId: 'controller-installation' },
                requestEnvelopeDigest: 'admitted-envelope', actionId: 'deployments.domains.add' as const,
            } }));
            const projected = projectDeploymentDomainHeader({ ...stored, capturedPlacements: executed });
            expect(projected).toMatchObject({ operationAddress: {
                serverId, machineId: 'controller-machine', operationId: input.actionOperationId,
            } });
            expect(projected.placements?.[0]?.placement.machineId).toBe(f.machine.id);
            expect(JSON.stringify(projected)).not.toContain('admitted-envelope');
            expect(JSON.stringify(projected)).not.toContain('controller-installation');
            expect(projectDeploymentDomainHeader(stored)).not.toHaveProperty('operationAddress');
            expect(projectDeploymentDomainHeader({ ...stored, capturedPlacements: [executed[0], captures[1]] }))
                .not.toHaveProperty('operationAddress');
            expect(projectDeploymentDomainHeader({ ...stored, capturedPlacements: [executed[0], {
                ...executed[1], placement: { ...executed[1]!.placement, actionOperationId: 'different-root' },
            }] })).not.toHaveProperty('operationAddress');
            expect(stored.capturedPlacements).toEqual(expect.arrayContaining([expect.objectContaining({ placement: expect.objectContaining({ machineId: f.machine.id,
                installationId: f.machine.installationId, nativeServer: 'private', requestId: input.requestId,
                actionOperationId: input.actionOperationId }) })]));
            expect((await request(f.owner.id, { ...input, contentBodyVersion: 2 })).statusCode).toBe(409);
            const url = `/v1/deployments/environments/${f.environment.id}/domains/${result.domain.id}`;
            const headers = { 'x-test-user-id': f.owner.id };
            expect((await app.inject({ method: 'GET', url: `${url}?serverId=${serverId}`, headers })).json()).toEqual(result);
            const list = DeploymentDomainListResultV1Schema.parse((await app.inject({ method: 'GET',
                url: `/v1/deployments/environments/${f.environment.id}/domains?serverId=${serverId}`, headers })).json());
            expect(list).toMatchObject({ ok: true, domains: [result.domain], nextCursor: null });
            const unavailableCaptures = captures.map((capture, index) => ({ ...capture, networkExposure: index === 0
                ? { kind: 'unavailable' as const, reason: 'required_fact_unavailable' }
                : { kind: 'unavailable' as const, reason: 'required_fact_unavailable', requiredFact: 'caddyAdminSocket' as const,
                    remedy: 'Restore the captured Caddy admin socket.' } }));
            await db.deploymentDomain.update({ where: { id: input.domainId }, data: { capturedPlacements: unavailableCaptures } });
            const unavailable = DeploymentDomainMutationResultV1Schema.parse((await app.inject({ method: 'GET',
                url: `${url}?serverId=${serverId}`, headers })).json());
            expect(unavailable).toMatchObject({ ok: true, domain: { networkExposure: unavailableCaptures.map((capture, index) => ({
                observation: index === 0
                    ? { kind: 'unavailable', reason: 'required_fact_unavailable', requiredFact: 'networkExposure', remedy: expect.any(String) }
                    : capture.networkExposure,
            })) } });
            if (!unavailable.ok) throw new Error(unavailable.error);
            expect((await app.inject({ method: 'GET',
                url: `/v1/deployments/environments/${f.environment.id}/domains?serverId=${serverId}`, headers })).json())
                .toMatchObject({ ok: true, domains: [unavailable.domain] });
            expect((await db.deploymentDomain.findUniqueOrThrow({ where: { id: input.domainId } })).capturedPlacements)
                .toEqual(unavailableCaptures);
            await db.deploymentDomain.update({ where: { id: input.domainId }, data: { capturedPlacements: captures } });
            const captured = result.domain.placements![0]!;
            expect(captured).toMatchObject({ dockerEngineId: 'domain-engine',
                environmentContent: { contentArtifactId: f.environment.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 },
                targetLinkContent: { contentArtifactId: f.target.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1 } });
            const signed = (capture: DeploymentDomainPlacementV1, revision: number, state: DeploymentDomainObservationBodyV1['state'], recordReplicas = false) => {
                const ids = nativeCaddyDomainRouteIdsV1(input.domainId, capture.listener);
                const removal = state === 'removed' ? { kind: 'removed' as const, placement: capture.placement, routeIds: ids.removalIds,
                    proof: { version: 1 as const, algorithm: 'ed25519' as const, signature: encodeBase64(nacl.sign.detached(
                        nativeCaddyRemovalSigningBytes(capture.placement, ids.removalIds), f.key.secretKey), 'base64url') } } : undefined;
                const networkExposure = state === 'removed' ? { kind: 'unavailable' as const, reason: 'route_absent' }
                    : { kind: 'ready' as const, listener: capture.listener, listeners: [{ tls: false,
                        automaticHttpsDisabled: true, endpoints: [{ audience: 'privateNetwork' as const, hostPort: 8080,
                            containerPort: 8080, protocol: 'tcp' as const }] }], localOrigin: true, fallback: false };
                const observation = { capture, state, networkExposure,
                    ...(recordReplicas ? { routedReplicas: [{ containerName: 'web-1' },
                        ...(capture.listener === 'public' ? [{ containerName: 'web-2' }] : [])] } : {}),
                    ...(removal ? { removal } : { dnsHealth: {
                    status: 'up' as const, evidence: { v: 1 as const, items: [{ source: { kind: 'alert' as const, label: 'dns' },
                        author: { kind: 'process' as const }, text: JSON.stringify({ reason: 'dns_matched' }) }] },
                } }) };
                return { ...observation, proof: signMachineInstallationProof({ privateKey: f.key.secretKey,
                    payload: deploymentDomainObservationProofPayloadV1({ expectedDomainRevision: revision, observation }) }) };
            };
            const transition = (revision: number, observations: ReturnType<typeof signed>[]) => app.inject({ method: 'POST',
                url: `${url}/transitions`, headers, payload: { serverId, environmentId: f.environment.id,
                    domainId: input.domainId, expectedDomainRevision: revision, observations } });
            const valid = result.domain.placements!.map(capture => signed(capture, 1, 'active', true));
            expect((await transition(1, valid.map(value => ({ ...value,
                routedReplicas: [{ containerName: 'web-1', hostAddress: '100.98.0.2', networkNames: ['private'] }],
            })))).statusCode).toBe(400);
            const privateAddressPayload = valid.map(value => ({ ...value, networkExposure: { ...value.networkExposure,
                listeners: [{ listen: ['[fd00::2]:8080'], tls: false, automaticHttpsDisabled: true,
                    endpoints: [{ audience: 'privateNetwork' as const, hostAddress: '100.98.0.2', hostPort: 8080,
                        containerPort: 8080, protocol: 'tcp' as const }] }],
            } }));
            expect((await transition(1, privateAddressPayload)).statusCode).toBe(400);
            expect(result.domain.networkExposure).toEqual(result.domain.placements!.map(capture => ({
                machineId: capture.placement.machineId, installationId: capture.placement.installationId,
                nativeServer: capture.placement.nativeServer, listener: capture.listener,
                observation: { kind: 'unavailable', reason: 'required_fact_unavailable',
                    requiredFact: 'networkExposure', remedy: expect.any(String) },
            })));
            expect((await transition(1, valid.map(value => ({ ...value, networkExposure: {
                ...value.networkExposure, fallback: true,
            } })))).statusCode).toBe(403);
            expect((await transition(1, valid.map(value => ({ ...value,
                routedReplicas: [{ containerName: 'unsigned-web' }],
            })))).statusCode).toBe(403);
            expect((await transition(1, valid.map((value, index) => index ? value : { ...value,
                proof: { ...value.proof, signature: encodeBase64(nacl.randomBytes(64), 'base64url') } }))).statusCode).toBe(403);
            const active = DeploymentDomainMutationResultV1Schema.parse((await transition(1, valid)).json());
            expect(active).toMatchObject({ ok: true, domain: { state: 'active', revision: 2, observedAtMs: expect.any(Number) } });
            if (!active.ok) throw new Error(active.error);
            expect(active.domain.routedReplicas).toEqual({ source: 'recordedTopology', count: 3, replicas: [
                { machineId: f.machine.id, installationId: f.machine.installationId, containerName: 'web-1' },
                { machineId: f.machine.id, installationId: f.machine.installationId, containerName: 'web-2' },
                { machineId: secondMachine.id, installationId: secondMachine.installationId, containerName: 'web-1' },
            ] });
            expect(active.domain.placements).toEqual(result.domain.placements);
            expect(JSON.stringify(active.domain.routedReplicas)).not.toMatch(/network|address|endpoint|listen|hostPort|containerPort/i);
            expect(active.domain).toMatchObject({ networkExposure: result.domain.placements!.map(capture => ({
                machineId: capture.placement.machineId, installationId: capture.placement.installationId,
                nativeServer: capture.placement.nativeServer, listener: capture.listener,
                observation: { kind: 'ready', localOrigin: true, fallback: false },
            })) });
            expect(JSON.stringify(active.domain.networkExposure)).not.toMatch(/hostAddress|"listen"|100\.98\.0\.2/);
            expect(active.domain.networkExposure?.[0]?.observation).toMatchObject({ kind: 'ready', listeners: [{
                endpoints: [{ audience: 'privateNetwork', hostPort: 8080 }],
            }] });
            expect((await app.inject({ method: 'GET', url: `${url}?serverId=${serverId}`, headers })).json())
                .toMatchObject({ ok: true, domain: active.domain });
            expect((await app.inject({ method: 'GET',
                url: `/v1/deployments/environments/${f.environment.id}/domains?serverId=${serverId}`, headers })).json())
                .toMatchObject({ ok: true, domains: [active.domain] });
            expect((await app.inject({ method: 'GET', url: `${url}?serverId=${serverId}`,
                headers: { 'x-test-user-id': f.foreign.id } })).statusCode).toBe(404);
            const changes: string[] = [];
            const stop = observeSqliteRequests({ before: event => { if (event.model === 'DeploymentDomain' && event.action === 'update') changes.push(event.action); } });
            try {
                for (let i = 0; i < 3; i++) expect((await transition(2, result.domain.placements!.map(capture => signed(capture, 2, 'active')))).json()).toEqual(active);
            } finally { stop(); }
            expect(changes).toEqual([]);
            expect((await db.deploymentDomain.findUniqueOrThrow({ where: { id: input.domainId } })).capturedPlacements)
                .toEqual(expect.arrayContaining(valid.map(({ capture, routedReplicas }) => expect.objectContaining({
                    placement: capture.placement, routedReplicas,
                }))));
            expect((await request(f.owner.id, { ...input, expectedRevision: 2, expectedDomainRevision: 2,
                requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID() })).json()).toEqual(active);
            const remove = { serverId, environmentId: f.environment.id, domainId: input.domainId, expectedRevision: 2,
                expectedDomainRevision: 2, requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID() };
            const removing = DeploymentDomainMutationResultV1Schema.parse((await app.inject({ method: 'POST', url: `${url}/remove`, headers, payload: remove })).json());
            expect(removing).toMatchObject({ ok: true, domain: { state: 'removing', revision: 3 } });
            if (!removing.ok) throw new Error(removing.error);
            expect(removing.domain).not.toHaveProperty('routedReplicas');
            expect((await db.deploymentDomain.findUniqueOrThrow({ where: { id: input.domainId } })).deletedAt).toBeNull();
            const teardownInput = { serverId, environmentId: f.environment.id, expectedRevision: removing.revision,
                targetLinkId: f.target.id, expectedTargetLinkRevision: 1, requestKey: crypto.randomUUID(),
                actionOperationId: crypto.randomUUID(), reason: 'manual', ...await f.content('deployment-receipt.v1') };
            const teardown = () => app.inject({ method: 'POST', url: `/v1/deployments/environments/${f.environment.id}/teardown`,
                headers, payload: teardownInput });
            expect((await teardown()).json()).toMatchObject({ ok: false, error: 'unsupported_action' });
            expect((await transition(3, [signed(removing.domain.placements![0]!, 3, 'removed')])).statusCode).toBe(409);
            expect((await transition(3, result.domain.placements!.map(capture => signed(capture, 3, 'removed')))).statusCode).toBe(403);
            const removed = DeploymentDomainMutationResultV1Schema.parse((await transition(3,
                removing.domain.placements!.map(capture => signed(capture, 3, 'removed')))).json());
            expect(removed).toMatchObject({ ok: true, domain: { state: 'removing', deletedAtMs: expect.any(Number), revision: 4 } });
            if (!removed.ok) throw new Error(removed.error);
            expect(removed.domain).not.toHaveProperty('routedReplicas');
            expect(DeploymentDomainCapturedPlacementsV1Schema.parse((await db.deploymentDomain.findUniqueOrThrow({
                where: { id: input.domainId },
            })).capturedPlacements).every(capture => capture.routedReplicas === undefined)).toBe(true);
            expect(removed).toMatchObject({ ok: true, domain: { networkExposure: removing.domain.placements!.map(capture => ({
                machineId: capture.placement.machineId, installationId: capture.placement.installationId,
                nativeServer: capture.placement.nativeServer, listener: capture.listener,
                observation: { kind: 'unavailable', reason: 'route_absent',
                    requiredFact: 'networkExposure', remedy: expect.any(String) },
            })) } });
            expect((await app.inject({ method: 'GET', url: `/v1/deployments/environments/${f.environment.id}/domains?serverId=${serverId}`, headers })).json())
                .toMatchObject({ ok: true, domains: [] });
            expect((await teardown()).json()).toMatchObject({ ok: true, state: 'queued' });
        });
    });

    it.each([false, true])('captures shared tunnel retirement once at removal admission, retained sibling=%s', async retainedSibling => {
        const f = await fixture();
        const input = { serverId, domainId: crypto.randomUUID(), environmentId: f.environment.id, expectedRevision: 1,
            targetLinkId: f.target.id, expectedTargetLinkRevision: 1, requestKey: crypto.randomUUID(),
            actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID(),
            placements: [{ machineId: f.machine.id, installationId: f.machine.installationId!, nativeServer: 'private',
                listener: 'privateOrigin', dockerEngineId: 'domain-engine' }], ...await f.content('deployment-domain.v1') };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const headers = { 'x-test-user-id': f.owner.id };
            const url = `/v1/deployments/environments/${f.environment.id}/domains`;
            expect((await app.inject({ method: 'POST', url, headers, payload: input })).statusCode).toBe(200);
            // The shared tunnel belongs to this Environment; no private hostname,
            // provider identity or credential is needed to decide its last consumer.
            const sibling = await db.deploymentDomain.create({ data: { environmentId: f.environment.id, state: 'active',
                targetLinkId: f.target.id, createdByAccountId: f.owner.id, ...await f.content('deployment-domain.v1'),
                ...(retainedSibling ? {} : { deletedAt: new Date() }) } });
            const remove = { serverId, environmentId: f.environment.id, domainId: input.domainId, expectedRevision: 2,
                expectedDomainRevision: 1, requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID() };
            const response = await app.inject({ method: 'POST', url: `${url}/${input.domainId}/remove`, headers, payload: remove });
            expect(response.statusCode).toBe(200);
            const removing = DeploymentDomainMutationResultV1Schema.parse(response.json());
            expect(removing).toMatchObject({ ok: true, domain: { state: 'removing', placements: [
                { desired: false, retireSharedTunnel: !retainedSibling },
            ] } });
            const stored = await db.deploymentDomain.findUniqueOrThrow({ where: { id: input.domainId } });
            expect(stored.capturedPlacements).toMatchObject([{ retireSharedTunnel: !retainedSibling }]);
            // Replaying the admitted request must retain its decision after another
            // Domain disappears; the native consumer does not recount the rows.
            await db.deploymentDomain.update({ where: { id: sibling.id }, data: { deletedAt: new Date() } });
            expect((await app.inject({ method: 'POST', url: `${url}/${input.domainId}/remove`, headers, payload: remove })).json()).toEqual(removing);
        });
    });

    it('retains old content and placements when desired content changes, and refuses unknown legacy custody', async () => {
        const f = await fixture();
        const input = { serverId, domainId: crypto.randomUUID(), environmentId: f.environment.id, expectedRevision: 1,
            targetLinkId: f.target.id, expectedTargetLinkRevision: 1, requestKey: crypto.randomUUID(),
            actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID(),
            placements: [{ machineId: f.machine.id, installationId: f.machine.installationId!, nativeServer: 'private', listener: 'privateOrigin', dockerEngineId: 'domain-engine' }],
            ...await f.content('deployment-domain.v1') };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const headers = { 'x-test-user-id': f.owner.id };
            const url = `/v1/deployments/environments/${f.environment.id}/domains`;
            expect((await app.inject({ method: 'POST', url, headers, payload: input })).statusCode).toBe(200);
            const updated = DeploymentDomainMutationResultV1Schema.parse((await app.inject({ method: 'POST', url, headers, payload: {
                ...input, expectedRevision: 2, expectedDomainRevision: 1, ...await f.content('deployment-domain.v1'),
                requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID(),
            } })).json());
            expect(updated).toMatchObject({ ok: true, domain: { revision: 2, placements: [
                { content: { contentArtifactId: input.contentArtifactId }, desired: false }, { desired: true },
            ] } });
            await db.$executeRawUnsafe('UPDATE "DeploymentDomain" SET "capturedPlacements" = NULL WHERE "id" = ?', input.domainId);
            const remove = await app.inject({ method: 'POST', url: `${url}/${input.domainId}/remove`, headers, payload: {
                serverId, environmentId: input.environmentId, domainId: input.domainId, expectedRevision: 3, expectedDomainRevision: 2,
                requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID(),
            } });
            expect(remove.statusCode).toBe(409);
            expect((await db.deploymentDomain.findUniqueOrThrow({ where: { id: input.domainId } })).deletedAt).toBeNull();
        });
    });
});
