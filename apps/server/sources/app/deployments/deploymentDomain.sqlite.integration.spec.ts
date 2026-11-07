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
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { projectDeploymentDomainHeader } from './deploymentDomainService';
import { DeploymentDomainCapturedPlacementsV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';

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

    it.each(['plain', 'e2ee'] as const)('creates and lists a single-Machine local-hostname Domain in %s through the public route, records native facts and tombstones only signed complete removal', async mode => {
        const f = await fixture(mode);
        const input = { serverId, domainId: crypto.randomUUID(), environmentId: f.environment.id, expectedRevision: 1,
            targetLinkId: f.target.id, expectedTargetLinkRevision: 1, requestKey: crypto.randomUUID(),
            actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID(),
            placements: [{ machineId: f.machine.id, installationId: f.machine.installationId!, nativeServer: 'private', listener: 'privateOrigin', dockerEngineId: 'domain-engine' },
                { machineId: f.machine.id, installationId: f.machine.installationId!, nativeServer: 'public', listener: 'public', dockerEngineId: 'domain-engine' }],
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
            expect(unavailable).toMatchObject({ ok: true, domain: { networkExposure: [
                { observation: { kind: 'unavailable', reason: 'required_fact_unavailable', requiredFact: 'networkExposure', remedy: expect.any(String) } },
                { observation: unavailableCaptures[1]!.networkExposure },
            ] } });
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
            const signed = (capture: DeploymentDomainPlacementV1, revision: number, state: DeploymentDomainObservationBodyV1['state']) => {
                const ids = nativeCaddyDomainRouteIdsV1(input.domainId, capture.listener);
                const removal = state === 'removed' ? { kind: 'removed' as const, placement: capture.placement, routeIds: ids.removalIds,
                    proof: { version: 1 as const, algorithm: 'ed25519' as const, signature: encodeBase64(nacl.sign.detached(
                        nativeCaddyRemovalSigningBytes(capture.placement, ids.removalIds), f.key.secretKey), 'base64url') } } : undefined;
                const networkExposure = state === 'removed' ? { kind: 'unavailable' as const, reason: 'route_absent' }
                    : { kind: 'ready' as const, listener: capture.listener, listeners: [{ tls: false,
                        automaticHttpsDisabled: true, endpoints: [{ audience: 'privateNetwork' as const, hostPort: 8080,
                            containerPort: 8080, protocol: 'tcp' as const }] }], localOrigin: true, fallback: false };
                const observation = { capture, state, networkExposure, ...(removal ? { removal } : { dnsHealth: {
                    status: 'up' as const, evidence: { v: 1 as const, items: [{ source: { kind: 'alert' as const, label: 'dns' },
                        author: { kind: 'process' as const }, text: JSON.stringify({ reason: 'dns_matched' }) }] },
                } }) };
                return { ...observation, proof: signMachineInstallationProof({ privateKey: f.key.secretKey,
                    payload: deploymentDomainObservationProofPayloadV1({ expectedDomainRevision: revision, observation }) }) };
            };
            const transition = (revision: number, observations: ReturnType<typeof signed>[]) => app.inject({ method: 'POST',
                url: `${url}/transitions`, headers, payload: { serverId, environmentId: f.environment.id,
                    domainId: input.domainId, expectedDomainRevision: revision, observations } });
            const valid = result.domain.placements!.map(capture => signed(capture, 1, 'active'));
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
            expect((await transition(1, valid.map((value, index) => index ? value : { ...value,
                proof: { ...value.proof, signature: encodeBase64(nacl.randomBytes(64), 'base64url') } }))).statusCode).toBe(403);
            const active = DeploymentDomainMutationResultV1Schema.parse((await transition(1, valid)).json());
            expect(active).toMatchObject({ ok: true, domain: { state: 'active', revision: 2, observedAtMs: expect.any(Number) } });
            if (!active.ok) throw new Error(active.error);
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
            expect((await request(f.owner.id, { ...input, expectedRevision: 2, expectedDomainRevision: 2,
                requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID() })).json()).toEqual(active);
            const remove = { serverId, environmentId: f.environment.id, domainId: input.domainId, expectedRevision: 2,
                expectedDomainRevision: 2, requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID() };
            const removing = DeploymentDomainMutationResultV1Schema.parse((await app.inject({ method: 'POST', url: `${url}/remove`, headers, payload: remove })).json());
            expect(removing).toMatchObject({ ok: true, domain: { state: 'removing', revision: 3 } });
            if (!removing.ok) throw new Error(removing.error);
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
