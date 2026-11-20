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
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { teamResourceGrantFixture } from '@/testkit/resourceGrant.testkit';
import { projectDeploymentDomainHeader, projectDeploymentDomainMachineReferences, prepareDeploymentTeardownDomainsInTx,
    readAcceptedDeploymentTeardownDomainContentInTx, readMemberDeploymentDomainContentInTx, createDeploymentDomainInTx } from './deploymentDomainService';
import { loadDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import { haveDeploymentMembershipRoutesInTx } from './deploymentMembershipService';
import { DeploymentDomainCapturedPlacementsV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { deploymentDomainProviderObservationProofPayloadV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import { DeploymentDomainProviderResultV1Schema } from '@happier-dev/protocol/deployments/deploymentDomainProviderResultV1';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import * as vercelDomainPlugin from '../../../../../packages/plugins/deploy-vercel/src/index';
import { DeploymentChildRoutingV1Schema } from '@happier-dev/protocol';
import { readDeploymentChildAdmissionInTx } from './deploymentChildAuthorization';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';

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
            metadata: '{}', installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(key.publicKey) } });
        const source = await db.projectSource.create({ data: { createdByAccountId: owner.id,
            owner: { kind: 'account', accountId: owner.id }, name: 'Domain owner', audience: [], attachments: [] } });
        const content = async (kind: string, domainTarget = { service: 'web', containerPort: 80 } as
            { service: string; containerPort: number } | { kind: 'telemetry' }) => {
            const dataKey = nacl.randomBytes(32);
            const seal = async (value: unknown) => mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value))
                : new Uint8Array(await sealSessionDataKeyBundleV0(value, dataKey));
            const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                kind: `v1:other:${kind}`, header: await seal({ kind, title: 'Private domain' }),
                body: await seal({ body: JSON.stringify(kind === 'deployment-domain.v1' ? { hostname: 'qa-domain-1101-ingress.localhost',
                    target: domainTarget, healthCheck: { path: '/', expectStatus: 200 } } : { hostname: 'private.example.test' }) }),
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

    it.each(['machine', 'deployed App'] as const)('admits a collector Domain only on the Environment selected collector, independently of workload membership (%s)', async kind => {
        const f = await fixture();
        await db.machine.update({ where: { id: f.machine.id }, data: {
            metadata: encodePlainMachineStoredContent({ host: 'workload-host', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/workload', happyHomeDir: '/home/workload/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        const collector = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'collector-host', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/collector', happyHomeDir: '/home/collector/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(f.key.publicKey) } });
        let selected = collector;
        if (kind === 'deployed App') {
            const receipt = await db.deployment.create({ data: { environmentId: f.environment.id, targetLinkId: f.target.id,
                operation: 'deploy', state: 'succeeded', requestKey: crypto.randomUUID(), requestedByAccountId: f.owner.id,
                actionOperationId: crypto.randomUUID(), acceptedControllerMachineId: collector.id,
                acceptedControllerInstallationId: collector.installationId!, ...await f.content('deployment-receipt.v1') } });
            selected = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.owner.id,
                metadata: '{}', installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(f.key.publicKey),
                deploymentAppDeploymentId: receipt.id } });
        }
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { telemetryMachineId: selected.id } });
        const content = await f.content('deployment-domain.v1', { kind: 'telemetry' });
        const input = { serverId, domainId: crypto.randomUUID(), environmentId: f.environment.id, expectedRevision: 1,
            targetLinkId: f.target.id, expectedTargetLinkRevision: 1, requestKey: crypto.randomUUID(),
            actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID(), telemetryMachineId: selected.id,
            placements: [{ machineId: collector.id, installationId: collector.installationId!, dockerEngineId: 'native',
                nativeServer: 'private', listener: 'privateOrigin' as const }], ...content };
        const binding = { accountId: f.owner.id, custodianAccountId: f.owner.id,
            authentication: { kind: 'account' as const, tokenEpoch: 1 }, accountEncryptionMode: 'plain' as const,
            serverIdentityId: serverId, machineId: f.machine.id, installationId: f.machine.installationId!,
            target: { kind: 'machine' as const, machineId: f.machine.id }, actionId: 'deployments.domains.add',
            requestId: input.requestId, environmentId: f.environment.id } satisfies ExternalActionExecutionAuthorizationBindingV1;
        const { placements: _placements, actionOperationId: _operation, requestId: _request, ...discoveryInput } = input;
        const routing = DeploymentChildRoutingV1Schema.parse({ v: 1, kind: 'domainDiscover', actionId: 'deployments.domains.add',
            machineId: collector.id, installationId: collector.installationId!, input: discoveryInput });
        expect(await inTx(tx => readDeploymentChildAdmissionInTx(tx, binding, routing))).not.toBeNull();
        const { telemetryMachineId: _selected, ...nativeServiceInput } = discoveryInput;
        expect(await inTx(tx => readDeploymentChildAdmissionInTx(tx, binding, DeploymentChildRoutingV1Schema.parse({
            ...routing, input: nativeServiceInput, machineId: f.machine.id, installationId: f.machine.installationId! })))).not.toBeNull();
        expect(await inTx(tx => readDeploymentChildAdmissionInTx(tx, binding, DeploymentChildRoutingV1Schema.parse({
            ...routing, machineId: f.machine.id, installationId: f.machine.installationId! })))).toBeNull();
        const result = await inTx(tx => createDeploymentDomainInTx(tx, f.owner.id, input));
        expect(DeploymentDomainMutationResultV1Schema.parse(result)).toMatchObject({ ok: true,
            domain: { placements: [{ placement: { machineId: collector.id } }] } });
        const other = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.owner.id,
            metadata: '{}', installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(f.key.publicKey) } });
        const rejected = await inTx(tx => createDeploymentDomainInTx(tx, f.owner.id, { ...input,
            domainId: crypto.randomUUID(), requestKey: crypto.randomUUID(), expectedRevision: 2,
            telemetryMachineId: other.id, placements: [{ ...input.placements[0]!, machineId: other.id, installationId: other.installationId! }] }));
        expect(rejected).toMatchObject({ ok: false, error: 'deployment_conflict' });
    });

    it('returns the structured controller failure when a provider Domain cannot acquire its controller key', async () => {
        const f = await fixture();
        await db.deploymentTargetLink.update({ where: { id: f.target.id }, data: {
            sourceKind: 'plugin', hostTargetId: null, pluginId: 'happier.deploy.vercel', contributionLocalId: 'runtime', targetKind: 'vercel' } });
        await db.machine.update({ where: { id: f.machine.id }, data: { installationPublicKey: null } });
        const content = await f.content('deployment-domain.v1');
        const result = await inTx(tx => createDeploymentDomainInTx(tx, f.owner.id, {
            serverId, domainId: crypto.randomUUID(), environmentId: f.environment.id, expectedRevision: 1,
            targetLinkId: f.target.id, expectedTargetLinkRevision: 1, requestKey: crypto.randomUUID(),
            actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID(), provider: true, placements: [],
            ...content,
        }));
        expect(DeploymentDomainMutationResultV1Schema.parse(result)).toEqual({ ok: false, error: 'machine_unavailable',
            role: 'controller', machineIds: [f.machine.id], nextActions: ['start', 'chooseAnother'] });
        expect(await db.deploymentDomain.count({ where: { environmentId: f.environment.id } })).toBe(0);
    });

    it('keeps an S4 topology read within its accepted deployment and exact Domain capture after G1', async () => {
        const f = await fixture();
        const collector = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.owner.id,
            metadata: '{}', installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(f.key.publicKey) } });
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { telemetryMachineId: collector.id } });
        const input = { serverId, domainId: crypto.randomUUID(), environmentId: f.environment.id, expectedRevision: 1,
            targetLinkId: f.target.id, expectedTargetLinkRevision: 1, requestKey: crypto.randomUUID(),
            actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID(), telemetryMachineId: collector.id,
            placements: [{ machineId: collector.id, installationId: collector.installationId!, dockerEngineId: 'native',
                nativeServer: 'private', listener: 'privateOrigin' as const }], ...await f.content('deployment-domain.v1', { kind: 'telemetry' }) };
        const added = DeploymentDomainMutationResultV1Schema.parse(await inTx(tx => createDeploymentDomainInTx(tx, f.owner.id, input)));
        if (!added.ok || !added.domain.placements?.[0]) throw new Error('Domain capture unavailable');
        const rootOperationId = crypto.randomUUID();
        const deployment = await db.deployment.create({ data: { environmentId: f.environment.id, targetLinkId: f.target.id,
            operation: 'deploy', state: 'running', requestKey: crypto.randomUUID(), requestedByAccountId: f.owner.id,
            actionOperationId: rootOperationId, acceptedControllerMachineId: f.machine.id,
            acceptedControllerInstallationId: f.machine.installationId!, acceptedBuildMachineId: f.machine.id,
            acceptedBuildInstallationId: f.machine.installationId!, acceptedRequestEnvelopeDigest: 'a'.repeat(43),
            ...await f.content('deployment-receipt.v1') } });
        const binding = { accountId: f.owner.id, custodianAccountId: f.owner.id,
            authentication: { kind: 'account' as const, tokenEpoch: 1 }, accountEncryptionMode: 'plain' as const,
            serverIdentityId: serverId, machineId: f.machine.id, installationId: f.machine.installationId!,
            target: { kind: 'machine' as const, machineId: f.machine.id }, actionId: 'deployments.deploy',
            requestId: crypto.randomUUID(), requestEnvelopeDigest: 'a'.repeat(43), environmentId: f.environment.id,
            deploymentChildRoot: true as const } satisfies ExternalActionExecutionAuthorizationBindingV1;
        const routing = DeploymentChildRoutingV1Schema.parse({ v: 1, kind: 'domain', actionId: 'deployments.domains.verify',
            machineId: collector.id, installationId: collector.installationId!,
            input: { serverId, environmentId: f.environment.id, domainId: input.domainId },
            expectedDomainRevision: added.domain.revision, capture: added.domain.placements[0],
            observeTopology: { environmentId: f.environment.id, deploymentId: deployment.id, actionOperationId: rootOperationId } });
        await db.projectSource.update({ where: { id: f.environment.projectSourceId }, data: { owner: { kind: 'account', accountId: f.foreign.id } } });
        const read = (root = binding, child = routing) => inTx(tx => readDeploymentChildAdmissionInTx(tx, root, child));
        expect(await read()).toMatchObject({ acceptedReceipt: { id: deployment.id } });
        expect(await read({ ...binding, accountId: f.foreign.id })).toBeNull();
        if (routing.kind !== 'domain') throw new Error('Wrong child kind');
        expect(await read(binding, { ...routing, capture: { ...routing.capture,
            content: { ...routing.capture.content, contentArtifactId: crypto.randomUUID() } } })).toBeNull();
        const otherEnvironmentId = crypto.randomUUID();
        expect(await read(binding, { ...routing, input: { ...routing.input, environmentId: otherEnvironmentId },
            capture: { ...routing.capture, placement: { ...routing.capture.placement, environmentId: otherEnvironmentId } } })).toBeNull();
        const otherMachineId = crypto.randomUUID();
        expect(await read(binding, { ...routing, machineId: otherMachineId,
            capture: { ...routing.capture, placement: { ...routing.capture.placement, machineId: otherMachineId } } })).toBeNull();
        const otherInstallationId = crypto.randomUUID();
        expect(await read(binding, { ...routing, installationId: otherInstallationId,
            capture: { ...routing.capture, placement: { ...routing.capture.placement, installationId: otherInstallationId } } })).toBeNull();
        expect(await read(binding, { ...routing, expectedDomainRevision: added.domain.revision + 1 })).toBeNull();
        await db.deployment.update({ where: { id: deployment.id }, data: { state: 'succeeded' } });
        expect(await read()).toBeNull();
    });

    it('returns the structured controller failure when a provider Domain controller was revoked', async () => {
        const f = await fixture();
        await db.deploymentTargetLink.update({ where: { id: f.target.id }, data: {
            sourceKind: 'plugin', hostTargetId: null, pluginId: 'happier.deploy.vercel', contributionLocalId: 'runtime', targetKind: 'vercel' } });
        await db.machine.update({ where: { id: f.machine.id }, data: { revokedAt: new Date() } });
        const content = await f.content('deployment-domain.v1');
        const result = await inTx(tx => createDeploymentDomainInTx(tx, f.owner.id, {
            serverId, domainId: crypto.randomUUID(), environmentId: f.environment.id, expectedRevision: 1,
            targetLinkId: f.target.id, expectedTargetLinkRevision: 1, requestKey: crypto.randomUUID(),
            actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID(), provider: true, placements: [],
            ...content,
        }));
        expect(DeploymentDomainMutationResultV1Schema.parse(result)).toEqual({ ok: false, error: 'machine_unavailable',
            role: 'controller', machineIds: [f.machine.id], nextActions: ['start', 'chooseAnother'] });
        expect(await db.deploymentDomain.count({ where: { environmentId: f.environment.id } })).toBe(0);
    });

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

    it('settles a verified Vercel Add with its private provider observation through the Home transition', async () => {
        const f = await fixture();
        await db.deploymentTargetLink.update({ where: { id: f.target.id }, data: {
            sourceKind: 'plugin', hostTargetId: null, pluginId: 'happier.deploy.vercel', contributionLocalId: 'runtime', targetKind: 'vercel' } });
        const hostname = 'app.example.test';
        const account = { service: { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }, accountId: 'fixture' };
        const kit = await createPluginTestkit({ manifest: vercelDomainPlugin.manifest, module: vercelDomainPlugin,
            services: { http: createPluginHttpFixture({ async request(request) {
                const body = new URL(request.url).pathname.endsWith('/config') ? { misconfigured: false }
                    : { name: hostname, apexName: 'example.test', projectId: 'prj_exact',
                        gitBranch: null, customEnvironmentId: null, verified: true };
                return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
            } }) } });
        try {
            await withAuthenticatedTestApp(app => { registerDeploymentRoutes(app); artifactsRoutes(app); }, async app => {
                const input = { serverId, domainId: crypto.randomUUID(), environmentId: f.environment.id, expectedRevision: 1,
                    targetLinkId: f.target.id, expectedTargetLinkRevision: 1, requestKey: crypto.randomUUID(),
                    actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID(), provider: true, placements: [],
                    ...await f.content('deployment-domain.v1') };
                const headers = { 'x-test-user-id': f.owner.id };
                const url = `/v1/deployments/environments/${f.environment.id}/domains`;
                const added = await app.inject({ method: 'POST', url, headers, payload: input });
                expect(added.statusCode, added.body).toBe(200);
                const accepted = DeploymentDomainMutationResultV1Schema.parse(added.json());
                if (!accepted.ok || !accepted.domain.providerPlacement) throw new Error('provider capture missing');
                const providerObservation = DeploymentDomainProviderResultV1Schema.parse(await kit.invokeAction('domains-add', {
                    v: 1, serverId, environmentId: f.environment.id, expectedRevision: accepted.revision,
                    targetLinkId: f.target.id, expectedTargetLinkRevision: 1, credentialRef: account,
                    credentialPrincipal: { kind: 'account', accountId: f.owner.id, purpose: {
                        consumer: { pluginId: vercelDomainPlugin.manifest.id, localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' },
                        target: { kind: 'account', account } },
                    providerIdentity: { providerAccountId: 'team_exact', providerResourceId: 'prj_exact', providerEnvironment: 'production' },
                    providerEnvironment: { kind: 'production' }, domainId: input.domainId, domain: { hostname },
                }));
                expect(providerObservation.state).toBe('active');
                // Use the actual host Artifact preparation against the Home routes, not invented mutation bytes.
                const cliStorePath = '../../../../cli/src/api/artifacts/accountArtifactStore';
                const cliServerUrlPath = '../../../../cli/src/api/client/serverHttpBaseUrl';
                const { createAccountArtifactStore } = await import(cliStorePath);
                const { runWithServerHttpBaseUrl } = await import(cliServerUrlPath);
                const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
                const prepared = await runWithServerHttpBaseUrl(baseUrl, async () => {
                    const store = createAccountArtifactStore({ accountContent: { accountId: f.owner.id, encryption: null },
                        getAccountEncryptionMode: async () => 'plain' });
                    const resource = await store.readForUpdate(input.contentArtifactId, { prepareRecipients: false,
                        includeSharedAudience: false, authorizationHeaders: async () => headers });
                    if (!resource) throw new Error('Domain Artifact missing');
                    return resource.prepareJsonUpdate({ header: resource.artifact.header,
                        body: JSON.stringify({ hostname, target: { kind: 'provider' }, providerObservation }) });
                });
                if (!prepared.ok) throw new Error(prepared.errorCode);
                const observation = { placement: accepted.domain.providerPlacement, state: 'active' as const,
                    contentUpdate: { body: prepared.mutation.body,
                        expectedBodyVersion: prepared.mutation.expectedBodyVersion, expectedHeaderVersion: prepared.mutation.expectedHeaderVersion,
                        ...(prepared.mutation.kind === undefined ? {} : { kind: prepared.mutation.kind }),
                        ...(prepared.mutation.provenance === undefined ? {} : { provenance: prepared.mutation.provenance }),
                        ...(prepared.mutation.provenanceDataEncryptionKey === undefined ? {} : { provenanceDataEncryptionKey: prepared.mutation.provenanceDataEncryptionKey }) } };
                const settled = await app.inject({ method: 'POST', url: `${url}/${input.domainId}/transitions`, headers,
                    payload: { serverId, environmentId: f.environment.id, domainId: input.domainId, expectedDomainRevision: 1,
                        observations: [], providerObservation: { ...observation, proof: signMachineInstallationProof({
                            privateKey: f.key.secretKey, payload: deploymentDomainProviderObservationProofPayloadV1({
                                expectedDomainRevision: 1, observation }) }) } } });
                expect(settled.statusCode, settled.body).toBe(200);
                expect(DeploymentDomainMutationResultV1Schema.parse(settled.json())).toMatchObject({ ok: true,
                    domain: { state: 'active', revision: 2, contentBodyVersion: 2 } });
            });
        } finally { await kit.dispose(); }
    });

    it('scopes teardown replay to an admitted Environment before returning its receipt', async () => {
        const original = await fixture();
        const other = await fixture();
        const reference = await original.content('deployment-receipt.v1');
        const team = await db.team.create({ data: { name: 'Teardown replay' } });
        const teammate = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: original.owner.id, role: 'owner' },
            { teamId: team.id, accountId: teammate.id, role: 'admin' },
        ] });
        await db.projectSource.update({ where: { id: original.environment.projectSourceId },
            data: { owner: { kind: 'team', teamId: team.id } } });
        await db.artifactGrant.create({ data: { artifactId: reference.contentArtifactId, ...teamResourceGrantFixture({
            teamId: team.id, accessLevel: 'admin', createdByAccountId: original.owner.id,
        }) } });
        await db.machineGrant.create({ data: { machineId: original.machine.id, ...teamResourceGrantFixture({
            teamId: team.id, accessLevel: 'view', createdByAccountId: original.owner.id,
        }) } });
        const input = { serverId, environmentId: original.environment.id, targetLinkId: original.target.id,
            expectedRevision: 1, expectedTargetLinkRevision: 1, requestKey: crypto.randomUUID(),
            actionOperationId: crypto.randomUUID(), reason: 'manual', ...reference };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const request = (accountId: string, payload: typeof input) => app.inject({ method: 'POST',
                url: `/v1/deployments/environments/${payload.environmentId}/teardown`,
                headers: { 'x-test-user-id': accountId }, payload });
            const first = await request(original.owner.id, input);
            expect(first.statusCode, first.body).toBe(200);
            expect(first.json()).toMatchObject({ ok: true, state: 'queued', deploymentId: expect.any(String) });
            const replay = { ...input, actionOperationId: crypto.randomUUID() };
            expect((await request(original.owner.id, replay)).json()).toEqual(first.json());
            // An authorized teammate resolves the same receipt. Home still owns
            // Environment admission and reevaluates it on a new replay request.
            expect((await request(teammate.id, replay)).json()).toEqual(first.json());
            const read = (accountId: string, environmentId = input.environmentId) => {
                const query = new URLSearchParams({ serverId, teardownRequestKey: input.requestKey });
                return app.inject({ method: 'GET', url: `/v1/deployments/environments/${environmentId}/deployments?${query}`,
                    headers: { 'x-test-user-id': accountId } });
            };
            const receiptReads: string[] = [];
            const stop = observeSqliteRequests({ before: query => {
                if (query.model === 'Deployment') receiptReads.push(query.action);
            } });
            const selected = await read(teammate.id).finally(stop);
            expect(selected.statusCode, selected.body).toBe(200);
            expect(selected.json()).toEqual({ ok: true, items: [expect.objectContaining({
                environmentId: input.environmentId, targetLinkId: input.targetLinkId, requestKey: input.requestKey,
            })], nextCursor: null });
            expect(receiptReads).toEqual(['findUnique']);
            expect((await read(other.owner.id, other.environment.id)).json()).toEqual({ ok: true, items: [], nextCursor: null });
            await db.teamMembership.delete({ where: { teamId_accountId: { teamId: team.id, accountId: teammate.id } } });
            expect((await read(teammate.id)).statusCode).toBe(404);
            expect((await read(original.foreign.id)).statusCode).toBe(404);
            const withdrawn = await request(teammate.id, replay);
            expect(withdrawn.statusCode).toBe(404);
            expect(withdrawn.json()).toMatchObject({ ok: false, error: 'deployment_unavailable' });

            const foreign = await request(original.foreign.id, replay);
            expect(foreign.statusCode).toBe(404);
            expect(foreign.json()).toMatchObject({ ok: false, error: 'deployment_unavailable' });

            const unrelated = await request(other.owner.id, { ...replay, environmentId: other.environment.id,
                targetLinkId: other.target.id });
            expect(unrelated.json()).toMatchObject({ ok: false, error: 'deployment_content_unavailable' });
            expect(await db.deployment.findMany({ where: { requestKey: input.requestKey }, select: {
                environmentId: true, requestedByAccountId: true, actionOperationId: true,
            } })).toEqual([{ environmentId: input.environmentId, requestedByAccountId: original.owner.id,
                actionOperationId: input.actionOperationId }]);
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

    it.each(['plain', 'e2ee'] as const)('persists the signed native Domain state and DNS evidence without redeciding health in %s', async mode => {
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
                        nativeServer: 'private', listener: 'privateOrigin', dockerEngineId: 'domain-engine' },
                        { machineId: f.machine.id, installationId: f.machine.installationId!,
                            nativeServer: 'public', listener: 'public', dockerEngineId: 'domain-engine' }],
                    ...await f.content('deployment-domain.v1') } })).json());
            if (!added.ok) throw new Error(added.error);
            const settle = async (revision: number, state: 'active' | 'warning', dnsHealth?: DeploymentDomainObservationBodyV1['dnsHealth'], tamper = false) => {
                const observation = { capture: added.domain.placements![1]!, state,
                    ...(dnsHealth ? { dnsHealth } : {}) };
                const privateObservation = { capture: added.domain.placements![0]!, state: 'active' as const };
                return app.inject({ method: 'POST',
                url: `${url}/${domainId}/transitions`, headers, payload: { serverId, environmentId: f.environment.id,
                    domainId, expectedDomainRevision: revision, observations: [{ ...privateObservation,
                        proof: signMachineInstallationProof({ privateKey: f.key.secretKey,
                            payload: deploymentDomainObservationProofPayloadV1({ expectedDomainRevision: revision, observation: privateObservation }) }) }, { ...observation,
                        ...(tamper ? { dnsHealth: { ...dnsHealth, status: 'up' } } : {}),
                        proof: signMachineInstallationProof({ privateKey: f.key.secretKey,
                            payload: deploymentDomainObservationProofPayloadV1({ expectedDomainRevision: revision, observation }) }) }] } });
            };
            expect.soft((await settle(1, 'active')).json()).toMatchObject({ ok: true, domain: { state: 'active', revision: 2 } });
            const membershipRoutes = () => inTx(tx => haveDeploymentMembershipRoutesInTx(tx, {
                environmentId: f.environment.id, targetLinkId: f.target.id, mode: 'join',
                members: [{ machineId: f.machine.id, installationId: f.machine.installationId! }],
            }));
            expect.soft(await membershipRoutes()).toBe(true);
            const missing: NonNullable<DeploymentDomainObservationBodyV1['dnsHealth']> = { status: 'down',
                cause: { kind: 'dns', vantage: 'sameMachine', observerMachineId: f.machine.id,
                    reason: 'dns_missing', remedy: 'Configure public DNS, then verify the Domain again.' }, evidence: {
                v: 1, items: [{ source: { kind: 'alert', label: 'dns' }, author: { kind: 'process' },
                    text: 'dns health check: down (dns_missing).' }] } };
            expect((await settle(2, 'warning', missing, true)).statusCode).toBe(403);
            const unhealthy = DeploymentDomainMutationResultV1Schema.parse((await settle(2, 'warning', missing)).json());
            expect(unhealthy).toMatchObject({ ok: true, domain: { state: 'warning', revision: 3, dnsHealth: missing } });
            expect(await membershipRoutes()).toBe(false);
            expect((await app.inject({ method: 'GET', url: `${url}/${domainId}?serverId=${serverId}`, headers })).json()).toEqual(unhealthy);
            expect((await app.inject({ method: 'GET', url: `${url}?serverId=${serverId}`, headers })).json())
                .toMatchObject({ ok: true, domains: [{ state: 'warning', dnsHealth: missing }] });
            const changes: string[] = [];
            const stop = observeSqliteRequests({ before: event => {
                if (event.model === 'DeploymentDomain' && event.action === 'update') changes.push(event.action);
            } });
            try { expect((await settle(3, 'warning', missing)).json()).toEqual(unhealthy); } finally { stop(); }
            expect(changes).toEqual([]);
            const resolved = { ...missing, status: 'up' as const,
                cause: { ...missing.cause!, reason: 'dns_ready' }, evidence: { ...missing.evidence,
                    items: [{ ...missing.evidence.items[0]!, text: 'dns health check: up (dns_ready).' }] } };
            expect((await settle(3, 'active', resolved)).json()).toMatchObject({ ok: true, domain: { state: 'active', revision: 4, dnsHealth: resolved } });
            const unavailable = { ...missing, status: 'unknown' as const,
                cause: { ...missing.cause!, reason: 'resolver_unavailable' } };
            expect((await settle(4, 'warning', unavailable)).json()).toMatchObject({ ok: true, domain: { state: 'warning', revision: 5, dnsHealth: unavailable } });
            const recovered = (await settle(5, 'active')).json();
            expect(recovered).toMatchObject({ ok: true, domain: { state: 'active', revision: 6 } });
            expect(recovered.domain).not.toHaveProperty('dnsHealth');
        });
    });

    it.each(['plain', 'e2ee'] as const)('creates and lists a multi-Machine local-hostname Domain in %s through the public route, records native facts and tombstones only signed complete removal', async mode => {
        const f = await fixture(mode);
        const secondMachine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.owner.id,
            metadata: '{}', installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(f.key.publicKey) } });
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
            // Accepts deliberately malformed observations too: the route schema is what is under test.
            const transition = (revision: number, observations: readonly unknown[]) => app.inject({ method: 'POST',
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
