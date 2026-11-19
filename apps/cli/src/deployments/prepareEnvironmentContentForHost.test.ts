import axios from 'axios';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createPrepareEnvironmentContentForHost } from './prepareEnvironmentContentForHost';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { createOwnServerEnvironmentConfigurationV1, DeploymentEnvironmentContentV1Schema, type DeploymentEnvironmentContentV1 } from '@happier-dev/deployments/contracts/v1';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey, libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { createCliDeploymentActionDeps } from './createCliDeploymentActionDeps';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { ArtifactJsonCreateHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactMutationHttpV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { normalizeStoredComposeDefinitionInput } from '@/workspaces/projectSetup/nativeComposeSource';
import { ExternalActionExecutionAuthorizationV1Schema, createDeploymentEnvironmentContentArtifactIdV1,
    projectDeploymentNativeAdmissionV1, isDeploymentEnvironmentUpdateNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';

afterEach(() => { vi.restoreAllMocks(); });

const authoredPreviewTemplate = { v: 1, enabled: true, forkPreviews: 'off',
    repository: { kind: 'github', deployment: 'https://github.com', repository: 'owner/app' },
    runtimeTargetLinkId: 'runtime', domain: null, bindingBlueprints: [], data: [] } satisfies NonNullable<DeploymentEnvironmentContentV1['previewTemplate']>;

describe('opened Environment content preparation', () => {
    it.each(['plain', 'e2ee'] as const)('saves release settings, private exports and explicit source through the %s Environment update', async mode => {
        const detail = createDeploymentEnvironmentDetailV1();
        const originalDefinitionInput = { from: 'compose' as const,
            document: 'services: {app: {image: "example/app:1"}}', profiles: [], services: ['app'] };
        detail.content.definition = { ...await normalizeStoredComposeDefinitionInput(originalDefinitionInput), contentRevision: 4 };
        detail.content.ownServer = { rollout: 'recreate', autoRestorePreviousRelease: true,
            migration: { service: 'app', argv: ['migrate'], pendingCheck: { argv: ['pending'] } },
            migrationFailurePolicy: 'rollbackCodeOnly' };
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const machineKey = new Uint8Array(32).fill(7);
        const credentials = { token, encryption: mode === 'plain' ? null : {
            type: 'dataKey' as const, machineKey, publicKey: libsodiumPublicKeyFromSecretKey(machineKey),
        } };
        const resource = await createResourceDataKey({ credentials, mode });
        const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : encodeBase64(encryptWithDataKey(value, resource.dataKey));
        const created = new Map<string, ReturnType<typeof ArtifactJsonCreateHttpInputV1Schema.parse>>();
        // Only Home HTTP is replaced; Account codecs, Artifact publication and Action preparation stay real.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
            if (path.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 0 } };
            const id = path.split('/').at(-1)!;
            return { status: 200, data: { ...(created.get(id) ?? { id,
                header: encode({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: detail.content.name }),
                body: encode({ body: JSON.stringify(detail.content) }),
                dataEncryptionKey: resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey }),
                ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: mode,
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
        });
        vi.spyOn(axios, 'post').mockImplementation(async (_url, raw) => {
            const parsed = ArtifactJsonCreateHttpInputV1Schema.parse(raw);
            created.set(parsed.id, parsed);
            return { status: 200, data: { id: parsed.id, headerVersion: 1, bodyVersion: 1 } };
        });
        const updates: unknown[] = [];
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (request.method?.toUpperCase() === 'GET') return { status: 200, data: { ok: true,
                environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink) } };
            updates.push(request.data);
            return { status: 200, data: { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1 } };
        });
        const artifacts = createCredentialedAccountArtifactStore(credentials);
        const host = { credentials, accountArtifacts: artifacts, serverHttpBaseUrl: 'https://home.test',
            resolveRequestHeaders: () => ({ Authorization: `Bearer ${token}` }) };
        const deps = createCliDeploymentActionDeps({ ...host, admitAccount: () => null,
            prepareEnvironment: createPrepareEnvironmentContentForHost(host),
            dispatchReceipt: async () => { throw new Error('Release settings cannot dispatch native work'); } });
        const patch = { ownServer: { rollout: 'startFirst' as const, autoRestorePreviousRelease: false }, retainPreviousDeployments: 7 };
        const input = { serverId: 'home', environmentId: detail.environment.id, expectedRevision: detail.environment.revision,
            contentArtifactId: detail.environment.contentArtifactId, contentHeaderVersion: detail.environment.contentHeaderVersion,
            contentBodyVersion: detail.environment.contentBodyVersion, patch };
        expect(await deps.deploymentAction!('deployments.environments.update', input, {})).toMatchObject({ ok: true });
        expect(created.size).toBe(1);
        expect(updates).toEqual([expect.objectContaining({ patch, contentArtifactId: [...created.keys()][0] })]);
        const opened = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => artifacts.read([...created.keys()][0]!, {
            prepareRecipients: false, includeSharedAudience: false,
        }));
        expect(JSON.parse(opened!.body!)).toEqual({ ...detail.content, retainPreviousDeployments: 7,
            ownServer: { ...detail.content.ownServer, ...patch.ownServer } });
        expect(await deps.deploymentAction!('deployments.environments.update', { ...input,
            patch: { ownServer: { autoRestorePreviousRelease: false } } }, {})).toMatchObject({ ok: true });
        const partial = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => artifacts.read([...created.keys()].at(-1)!, {
            prepareRecipients: false, includeSharedAudience: false,
        }));
        expect(JSON.parse(partial!.body!)).toEqual({ ...detail.content,
            ownServer: { ...detail.content.ownServer, autoRestorePreviousRelease: false } });
        expect(created.size).toBe(2);
        const serviceExports = [{ key: 'database', service: 'app', containerPort: 5432, scheme: 'postgres',
            exposure: 'privateNetwork' as const, privateNetwork: 'network-a' },
            { key: 'cache', service: 'app', containerPort: 6379, scheme: 'redis',
                exposure: 'loopback' as const, transport: { kind: 'iroh' as const } }];
        const definition = { from: 'compose' as const,
            document: 'services: {app: {image: "example/app:1", ports: ["10.0.0.8:5432:5432"]}}',
            profiles: [], services: ['app'] };
        expect(await deps.deploymentAction!('deployments.environments.update', { ...input,
            patch: { ownServer: { serviceExports }, definition } }, {})).toMatchObject({ ok: true });
        const configured = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => artifacts.read([...created.keys()].at(-1)!, {
            prepareRecipients: false, includeSharedAudience: false,
        }));
        expect(JSON.parse(configured!.body!)).toEqual({ ...detail.content,
            definition: { ...await normalizeStoredComposeDefinitionInput(definition), contentRevision: 5 },
            ownServer: { ...detail.content.ownServer, serviceExports } });
        expect(updates.at(-1)).toMatchObject({ patch: {} });
        expect(JSON.stringify(updates.at(-1))).not.toContain('10.0.0.8');
        expect(JSON.stringify(updates.at(-1))).not.toContain('network-a');
        expect(await deps.deploymentAction!('deployments.environments.update', { ...input,
            patch: { ownServer: { serviceExports: [] } } }, {})).toMatchObject({ ok: true });
        const cleared = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => artifacts.read([...created.keys()].at(-1)!, {
            prepareRecipients: false, includeSharedAudience: false,
        }));
        expect(JSON.parse(cleared!.body!).ownServer).toEqual({ ...detail.content.ownServer, serviceExports: [] });
        expect(created.size).toBe(4);
        expect(await deps.deploymentAction!('deployments.environments.update', { ...input,
            patch: { definition: originalDefinitionInput } }, {})).toMatchObject({ ok: true });
        expect(created.size).toBe(4);
        expect(updates.at(-1)).toMatchObject({ patch: {} });
        const updatesBeforeRefusal = updates.length;
        expect(await deps.deploymentAction!('deployments.environments.update', { ...input,
            patch: { definition: { ...originalDefinitionInput,
                document: 'services: {app: {image: "example/app:1", env_file: secrets.env}}' } } }, {}))
            .toMatchObject({ ok: false, errorCode: 'needs_repository' });
        expect(updates).toHaveLength(updatesBeforeRefusal);
        expect(created.size).toBe(4);
        // An unchanged selected setting does not create another private Artifact.
        expect(await deps.deploymentAction!('deployments.environments.update', { ...input,
            patch: { ownServer: { rollout: 'recreate' }, retainPreviousDeployments: detail.content.retainPreviousDeployments } }, {}))
            .toMatchObject({ ok: true });
        expect(created.size).toBe(4);
        delete detail.content.ownServer;
        expect(await deps.deploymentAction!('deployments.environments.update', { ...input,
            patch: { ownServer: { autoRestorePreviousRelease: false }, retainPreviousDeployments: 0 } }, {}))
            .toMatchObject({ ok: true });
        const initialized = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => artifacts.read([...created.keys()].at(-1)!, {
            prepareRecipients: false, includeSharedAudience: false,
        }));
        expect(JSON.parse(initialized!.body!)).toEqual({ ...detail.content, retainPreviousDeployments: 0,
            ownServer: createOwnServerEnvironmentConfigurationV1({ autoRestorePreviousRelease: false }) });
        expect(created.size).toBe(5);
        const updatesBeforeInvalidCandidate = updates.length;
        expect(await deps.deploymentAction!('deployments.environments.update', { ...input, contentArtifactId: 'unprepared-candidate',
            patch: { ownServer: { rollout: 'startFirst' } } }, {})).toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
        expect(created.size).toBe(5);
        expect(updates).toHaveLength(updatesBeforeInvalidCandidate);
        detail.content.ownServer = createOwnServerEnvironmentConfigurationV1({ serviceExports: [] });
        for (const [index, privatePatch] of [
            { definition: originalDefinitionInput }, { ownServer: { serviceExports: [] } },
            { ownServer: { serviceExports, rollout: 'startFirst' as const } },
            { previewTemplate: authoredPreviewTemplate },
        ].entries()) {
            const authored = { ...input, patch: privatePatch };
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-private-update', binding: {
                accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home',
                machineId: 'controller', installationId: 'installed-controller', actionId: 'deployments.environments.update',
                environmentId: input.environmentId,
                requestId: `private-update-${index}`, requestEnvelopeDigest: 'A'.repeat(43),
                target: { kind: 'machine', machineId: 'controller' }, accountEncryptionMode: mode,
                deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.environments.update', authored),
            } });
            const prepared = await createPrepareEnvironmentContentForHost(host)({ actionId: 'deployments.environments.update',
                input: authored, context: { externalActionExecutionAuthorization: authorization } });
            const id = createDeploymentEnvironmentContentArtifactIdV1({ ...authorization.binding, environmentId: input.environmentId });
            expect(prepared).toMatchObject({ input: { patch: index === 2 ? { ownServer: { rollout: 'startFirst' } } : {}, contentArtifactId: id },
                authoredInputDigest: expect.any(String) });
            expect(created.has(id)).toBe(true);
            if (index === 2) {
                const authoredExports = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => artifacts.read(id, {
                    prepareRecipients: false, includeSharedAudience: false,
                }));
                expect(JSON.parse(authoredExports!.body!).ownServer)
                    .toEqual({ ...detail.content.ownServer, serviceExports, rollout: 'startFirst' });
            }
            if (index === 3) {
                const authoredPreview = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => artifacts.read(id, {
                    prepareRecipients: false, includeSharedAudience: false,
                }));
                expect(JSON.parse(authoredPreview!.body!).previewTemplate).toEqual(authoredPreviewTemplate);
            }
        }
        detail.content.definition = { ...await normalizeStoredComposeDefinitionInput({ ...originalDefinitionInput,
            document: 'services: {app: {image: "example/app:1"}, database: {image: "postgres:17"}, cache: {image: "redis:7"}}',
            services: ['app', 'database', 'cache'] }), contentRevision: 4 };
        detail.content.template = { templateRef: { sourceId: 'apps', itemId: 'postgres', version: '17',
            ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
            definition: { kind: 'stored', contentRevision: 4, composeDigest: detail.content.definition.composeDigest },
            services: ['database', 'cache'], health: [{ service: 'database', participates: true }, { service: 'cache', participates: true }],
            data: [{ engine: 'postgres', service: 'database' }, { engine: 'redis', service: 'cache' }],
            exports: { database: { service: 'database', port: 5432, scheme: 'postgres', defaultExposure: 'internal' },
                cache: { service: 'cache', port: 6379, scheme: 'redis', defaultExposure: 'internal' } } };
        detail.content.ownServer = createOwnServerEnvironmentConfigurationV1({ serviceExports: [
            { key: 'database', service: 'database', containerPort: 5432, scheme: 'postgres', exposure: 'loopback' },
            { key: 'cache', service: 'cache', containerPort: 6379, scheme: 'redis', exposure: 'loopback' },
        ] });
        detail.content.backup = { configRevision: 1, destinationRef: { pluginId: 'happier.backup.destinations', localId: 'open' },
            occurrenceId: 'backup', config: {}, credentialBindings: [], ownership: { environmentId: detail.environment.id, prefix: 'backup/' },
            sources: [{ kind: 'dump', sourceId: 'database', service: 'database', consistency: 'logical' },
                { kind: 'volume', sourceId: 'cache', service: 'cache', volume: 'cache-data', consistency: 'stopDuringCopy' }],
            retention: { kind: 'keepEverything' } };
        DeploymentEnvironmentContentV1Schema.parse(detail.content);
        const removed = { ...originalDefinitionInput,
            document: 'services: {app: {image: "example/app:1"}, cache: {image: "redis:7"}}\nvolumes: {data: {}, cache-data: {}}',
            services: ['app', 'cache'] };
        const removalResult = await deps.deploymentAction!('deployments.environments.update', { ...input, patch: { definition: removed } }, {});
        expect(removalResult, JSON.stringify(removalResult)).toMatchObject({ ok: true });
        const reconciled = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => artifacts.read([...created.keys()].at(-1)!, {
            prepareRecipients: false, includeSharedAudience: false,
        }));
        const reconciledContent = JSON.parse(reconciled!.body!);
        expect(reconciledContent.template.data).toEqual([{ engine: 'redis', service: 'cache' }]);
        expect(reconciledContent.template.services).toEqual(['cache']);
        expect(reconciledContent.template.health).toEqual([{ service: 'cache', participates: true }]);
        expect(Object.keys(reconciledContent.template.exports)).toEqual(['cache']);
        expect(reconciledContent.ownServer.serviceExports).toHaveLength(1);
        expect(reconciledContent.backup.sources).toEqual([detail.content.backup.sources[1]]);
        expect(reconciledContent.backup.configRevision).toBe(2);
        expect(reconciledContent.definition.document).toContain('data: {}');
        detail.content.backup.sources = [detail.content.backup.sources[0]!];
        expect(await deps.deploymentAction!('deployments.environments.update', { ...input, patch: { definition: removed } }, {}))
            .toMatchObject({ ok: true });
        const retiredBackup = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => artifacts.read([...created.keys()].at(-1)!, {
            prepareRecipients: false, includeSharedAudience: false,
        }));
        expect(JSON.parse(retiredBackup!.body!).backup).toBeUndefined();
        detail.content.backup = { notNeeded: true };
        expect(await deps.deploymentAction!('deployments.environments.update', { ...input, patch: { definition: removed } }, {}))
            .toMatchObject({ ok: true });
        const noBackupNeeded = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => artifacts.read([...created.keys()].at(-1)!, {
            prepareRecipients: false, includeSharedAudience: false,
        }));
        expect(JSON.parse(noBackupNeeded!.body!).backup).toEqual({ notNeeded: true });
    });

    it.each(['plain', 'e2ee'] as const)('admits only the current definition sub-revision before %s storage through requester custody', async mode => {
        const detail = createDeploymentEnvironmentDetailV1();
        const definition = (tag: string, contentRevision: number) => {
            const document = JSON.stringify({ services: { app: { image: `example/app:${tag}` }, worker: { image: 'example/worker:1' } } });
            return { kind: 'stored' as const, document, contentRevision,
                composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, profiles: [], services: ['app'] };
        };
        detail.content.definition = definition('one', 4);
        let candidate: DeploymentEnvironmentContentV1 = { ...detail.content, definition: definition('two', 4) };
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const machineKey = new Uint8Array(32).fill(7);
        const credentials = { token, encryption: mode === 'plain' ? null : {
            type: 'dataKey' as const, machineKey, publicKey: libsodiumPublicKeyFromSecretKey(machineKey),
        } };
        const resource = await createResourceDataKey({ credentials, mode });
        const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : encodeBase64(encryptWithDataKey(value, resource.dataKey));
        // Only Home HTTP is mocked; real Artifact opening, Account mode and P41
        // source admission run beneath the installed CLI Action composition.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
            if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 0 } };
            const id = new URL(url).pathname.split('/').at(-1)!;
            return { status: 200, data: { id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: mode,
                dataEncryptionKey: resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey,
                header: encode({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Stored' }),
                body: encode({ body: JSON.stringify(id === 'candidate' ? candidate : detail.content) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
        });
        const writes: unknown[] = [];
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            if (request.method?.toUpperCase() === 'GET') return { status: 200, data: { ok: true,
                environment: detail.environment, targetLinks: detail.targetLinks.map(item => item.targetLink) } };
            writes.push(request.data);
            return { status: 200, data: { ok: true, environmentId: detail.environment.id, revision: 2 } };
        });
        const resolveRequestHeaders = () => ({ Authorization: `Bearer ${token}` });
        const custodianKey = new Uint8Array(32).fill(89);
        const custodianCredentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'custodian' })).toString('base64url')}.signature`,
            encryption: mode === 'plain' ? null : { type: 'dataKey' as const, machineKey: custodianKey,
                publicKey: libsodiumPublicKeyFromSecretKey(custodianKey) } };
        const contentHost = { credentials: custodianCredentials, accountArtifacts: createCredentialedAccountArtifactStore(credentials),
            serverHttpBaseUrl: 'https://home.test', resolveRequestHeaders };
        const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: () => null, resolveRequestHeaders,
            prepareEnvironment: createPrepareEnvironmentContentForHost(contentHost),
            dispatchReceipt: async () => { throw new Error('Definition writes cannot dispatch native effects'); } });
        const input = { serverId: 'home', environmentId: detail.environment.id, expectedRevision: 1,
            contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
        const update = () => deps.deploymentAction!('deployments.environments.update', input, {});
        await expect(update()).resolves.toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
        expect(writes).toHaveLength(0);
        candidate = { ...detail.content, definition: { ...definition('one', 4), services: ['worker'] } };
        await expect(update()).resolves.toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
        candidate = { ...detail.content, name: 'Renamed', definition: definition('one', 5) };
        await expect(update()).resolves.toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
        expect(writes).toHaveLength(0);
        candidate = { ...detail.content, name: 'Renamed', definition: definition('one', 4) };
        await expect(update()).resolves.toMatchObject({ ok: true });
        candidate = { ...detail.content, definition: definition('two', 5) };
        await expect(update()).resolves.toMatchObject({ ok: true });
        candidate = { ...detail.content, definition: { ...definition('one', 5), services: ['worker'] } };
        await expect(update()).resolves.toMatchObject({ ok: true });
        expect(writes).toHaveLength(3);
        const ingress = { kind: 'edgeCaddy' as const, edgeMachineId: 'edge' };
        candidate = { ...detail.content, ingress };
        await expect(deps.deploymentAction!('deployments.environments.update', { ...input, patch: { ingress } }, {}))
            .resolves.toMatchObject({ ok: true });
        expect(writes).toHaveLength(4);
        // Content and non-content placement must agree in both Account modes.
        await expect(deps.deploymentAction!('deployments.environments.update', {
            ...input, patch: { ingress: { kind: 'edgeCaddy', edgeMachineId: 'another-edge' } },
        }, {})).resolves.toMatchObject({ ok: false, errorCode: 'deployment_invalid',
            error: 'deployment_invalid (deployment.environment.ingress_content_mismatch)',
            details: { requiredFact: 'preparedEnvironmentIngress' } });
        candidate = { ...detail.content, ingress: { kind: 'cloudflareTunnel' } };
        await expect(update()).resolves.toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
        expect(writes).toHaveLength(4);
        detail.content.definition = { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: ['app'] } };
        candidate = { ...detail.content, definition: definition('one', 1) };
        await expect(update()).resolves.toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
        expect(writes).toHaveLength(4);
        detail.content.definition = definition('one', 4);
        candidate = { ...detail.content, backup: { notNeeded: true } };
        await expect(update()).resolves.toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
        expect(writes).toHaveLength(4);
        detail.content.backup = { notNeeded: true };
        candidate = { ...detail.content, name: 'Preserves backup policy' };
        await expect(update()).resolves.toMatchObject({ ok: true });
        candidate = { ...detail.content, backup: undefined };
        await expect(update()).resolves.toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
        expect(writes).toHaveLength(5);
        detail.content.ownServer = createOwnServerEnvironmentConfigurationV1({ serviceExports: [
            { key: 'database', service: 'app', containerPort: 5432, scheme: 'postgres', exposure: 'loopback' },
        ] });
        for (const privateCandidate of [
            { ownServer: { ...detail.content.ownServer, serviceExports: [] } },
            { ownServer: { ...detail.content.ownServer, rollout: 'startFirst' as const } },
            { previewTemplate: authoredPreviewTemplate },
        ]) {
            candidate = { ...detail.content, ...privateCandidate };
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-prepared-update', binding: {
                accountId: 'owner', custodianAccountId: 'owner', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'home',
                machineId: 'controller', installationId: 'installed-controller', actionId: 'deployments.environments.update',
                environmentId: input.environmentId, requestId: 'prepared-update', requestEnvelopeDigest: 'A'.repeat(43),
                target: { kind: 'machine', machineId: 'controller' }, accountEncryptionMode: mode,
                deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.environments.update', input),
            } });
            await expect(deps.deploymentAction!('deployments.environments.update', input,
                { externalActionExecutionAuthorization: authorization }))
                .resolves.toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
            await expect(update()).resolves.toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
            expect(writes).toHaveLength(5);
        }
        const prepare = createPrepareEnvironmentContentForHost(contentHost);
        const createRequest = { actionId: 'deployments.environments.create' as const, context: {}, input: {
            serverId: 'home', projectSourceId: 'source', requestKey: 'create-without-backup',
            protection: 'nonProduction' as const, purpose: 'standard' as const, deployerMode: 'managers' as const,
            controllerMachineId: 'machine-a', contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1,
        } };
        candidate = { ...detail.content, definition: definition('one', 1), backup: undefined };
        expect(await prepare(createRequest)).toBeNull();
        candidate = { ...candidate, backup: { notNeeded: true } };
        expect(await prepare(createRequest)).toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
        // A failed Home read must retain the existing structured transport
        // cause rather than collapsing to an unnamed preparation refusal.
        vi.mocked(axios.get).mockRejectedValueOnce(Object.assign(new Error('Home unavailable'), {
            code: 'ERR_BAD_RESPONSE', response: { status: 503 },
        }));
        expect(await prepare(createRequest)).toMatchObject({ ok: false, errorCode: 'ERR_BAD_RESPONSE',
            failureCause: { httpStatus: 503, errorClass: 'Error', errorCode: 'ERR_BAD_RESPONSE' } });
    });
    it.each(['plain', 'e2ee'] as const)('preserves preview provenance across a normal %s edit and refuses replacement or removal before storage', async mode => {
        const environment = createDeploymentEnvironmentDetailV1();
        environment.environment.purpose = 'preview';
        environment.environment.previewTemplateEnvironmentId = 'template';
        environment.environment.previewRepositoryId = 'repository-identity';
        environment.environment.previewPullRequestId = 'opaque-pr-17';
        environment.environment.previewTargetLinkId = 'template-runtime';
        const repository = { kind: 'github', deployment: 'https://github.example/enterprise', repository: 'owner/app' };
        const previewProvenance = { v: 1, templateEnvironmentId: 'template', runtimeTargetLinkId: 'template-runtime', repository,
            pullRequestId: 'opaque-pr-17', pullRequestNumber: 17, author: { id: 'author', login: 'contributor' }, headRepository: repository };
        const original = { ...environment.content, previewProvenance };
        let candidate: Record<string, unknown> = { ...original, name: 'Edited preview' };
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const machineKey = new Uint8Array(32).fill(7);
        const credentials = { token, encryption: mode === 'plain' ? null : {
            type: 'dataKey' as const, machineKey, publicKey: libsodiumPublicKeyFromSecretKey(machineKey),
        } };
        const resource = await createResourceDataKey({ credentials, mode });
        const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : encodeBase64(encryptWithDataKey(value, resource.dataKey));
        const reads: string[] = [];
        // HTTP is the genuine Account/Artifact system boundary; codecs, CAS,
        // domain parsing and update admission below remain production owners.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            reads.push(path);
            if (path.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
            if (path.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 0 } };
            const artifactId = path.split('/').at(-1);
            if (artifactId !== 'preview-candidate' && artifactId !== environment.environment.contentArtifactId)
                throw new Error('Only selected Environment content may be read');
            return { status: 200, data: { id: artifactId, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
                header: encode({ kind: 'deployment-environment.v1', title: 'Preview' }),
                body: encode({ body: JSON.stringify(artifactId === 'preview-candidate' ? candidate : original) }),
                encryptionMode: mode, dataEncryptionKey: resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey,
                headerVersion: 1, bodyVersion: 1,
                seq: 1, createdAt: 1, updatedAt: 1 } };
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            expect(request.method).toBe('GET');
            expect(new URL(String(request.url)).pathname).toBe(`/v1/deployments/environments/${environment.environment.id}`);
            return { status: 200, data: { ok: true, environment: environment.environment,
                targetLinks: environment.targetLinks.map(item => item.targetLink) } };
        });
        const prepare = createPrepareEnvironmentContentForHost({ credentials,
            serverHttpBaseUrl: 'https://home.test', resolveRequestHeaders: () => ({ Authorization: `Bearer ${token}` }) });
        const input = { serverId: 'home', environmentId: environment.environment.id, expectedRevision: environment.environment.revision,
            contentArtifactId: 'preview-candidate', contentHeaderVersion: 1, contentBodyVersion: 1 };
        const request = { actionId: 'deployments.environments.update' as const, input, context: {} };
        expect(await prepare(request)).toBeNull();
        for (const provenance of [undefined, { ...previewProvenance, templateEnvironmentId: 'another-template' },
            { ...previewProvenance, headRepository: { ...repository, repository: 'another/app' } }]) {
            candidate = { ...original, name: 'Edited preview' };
            if (provenance === undefined) delete candidate.previewProvenance;
            else candidate.previewProvenance = provenance;
            expect(await prepare(request)).toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
        }
        expect(reads.filter(path => path.includes('/v1/artifacts/')))
            .toEqual(Array.from({ length: 4 }, () => [
                '/v1/artifacts/preview-candidate', `/v1/artifacts/${environment.environment.contentArtifactId}`]).flat());
    });
});
