import axios from 'axios';
import { createHash } from 'node:crypto';
import { ed25519, x25519 } from '@noble/curves/ed25519';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { DeploymentEnvironmentCreateIntentInputV1Schema, DeploymentEnvironmentCreateInputV1Schema,
    DeploymentEnvironmentGetResultV1Schema, signAccountContentKeyBindingV1, computeContentPublicKeyFingerprint,
    type ActionExecutorContext } from '@happier-dev/protocol';
import { ArtifactAccessGrantSetInputV1Schema, ArtifactAccessGrantMutationResponseV1Schema,
    ArtifactAccessRecipientCensusResponseV1Schema, ArtifactRecipientKeyEnvelopeCommitInputV1Schema,
    ArtifactRecipientKeyEnvelopeCommitResponseV1Schema,
    type ArtifactRecipientKeyEnvelopeCommitInputV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { readDeploymentEnvironmentArtifactV1, readDeploymentTargetLinkArtifactV1 } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1, createDeploymentSecretVariableBindingV1,
    createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey, libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { createPrepareEnvironmentCreateForHost, resolveEnvironmentCreateCopyForHost } from './prepareEnvironmentCreateForHost';
import { createPrepareEnvironmentContentForHost } from './prepareEnvironmentContentForHost';
import { createCliDeploymentActionDeps } from './createCliDeploymentActionDeps';
import { admitRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';

afterEach(() => vi.restoreAllMocks());

describe('authored Environment creation through protected preparation and the existing storage carrier', () => {
    it.each(['plain', 'e2ee'] as const)('captures explicit %s copy choices through requester custody and creates independent configuration without inherited placement or authority', async mode => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const machineKey = new Uint8Array(32).fill(47);
        const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null : {
            type: 'dataKey', machineKey, publicKey: x25519.getPublicKey(machineKey) } };
        const currentness = { ...createAccountEncryptionCurrentnessFixture({ mode }), contentKeyFingerprint: mode === 'plain' ? null
            : computeAccountEncryptionMigrateKeyFingerprintV1(x25519.getPublicKey(machineKey)) };
        const channel = await createRequesterCurrentnessSocketHarness();
        onTestFinished(() => channel.close());
        const source = createDeploymentEnvironmentDetailV1();
        source.environment.revision = 7;
        const document = 'services:\n  app:\n    image: example/source:7\n';
        source.content.definition = { kind: 'stored', document, contentRevision: 9,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`,
            profiles: ['web'], services: ['app'], primaryService: 'app' };
        source.content.retainPreviousDeployments = 7;
        source.content.ownServer = { rollout: 'startFirst', autoRestorePreviousRelease: false,
            migration: { service: 'app', argv: ['migrate'] } };
        source.content.backup = {
            configRevision: 1, destinationRef: { pluginId: 'example.storage', localId: 'storage' },
            occurrenceId: 'source-storage', config: { bucket: 'source-recovery' },
            credentialBindings: [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword' }],
            sources: [{ kind: 'dump', sourceId: 'database', service: 'db', consistency: 'logical' }],
            ownership: { environmentId: source.environment.id, prefix: 'source-only' },
            retention: { kind: 'keepEverything' },
        };
        const repository = { kind: 'github' as const, deployment: 'https://github.example', repository: 'base/app' };
        source.environment.purpose = 'preview';
        source.environment.previewTemplateEnvironmentId = 'original-template';
        source.environment.previewRepositoryId = 'original-repository';
        source.environment.previewPullRequestId = 'original-pr';
        source.environment.previewTargetLinkId = 'original-runtime';
        source.content.previewProvenance = { v: 1, templateEnvironmentId: 'original-template', runtimeTargetLinkId: 'original-runtime',
            repository, pullRequestId: 'original-pr', pullRequestNumber: 17, author: { id: 'contributor', login: 'contributor' },
            headRepository: { ...repository, repository: 'fork/app' } };
        const secret = createDeploymentSecretVariableBindingV1({ name: 'DATABASE_PASSWORD', phase: 'runtime',
            resourceId: 'private-copy-secret', resourceRevision: 3 });
        source.content.bindings = [secret,
            { purpose: 'variable', name: 'PUBLIC_VALUE', phase: 'runtime', source: { kind: 'value', value: 'review-redacted-value' } },
            { purpose: 'variable', name: 'REMOTE', phase: 'runtime', source: { kind: 'reference', environmentId: 'private-reference', export: 'api', via: 'auto' } },
            { purpose: 'variable', name: 'URL', phase: 'runtime', source: { kind: 'deploymentFact', fact: 'primaryUrl' } }];
        const dataLink = createDeploymentTargetLinkHeaderV1({ id: 'source-data', environmentId: source.environment.id, role: 'data',
            source: { kind: 'plugin', contribution: { pluginId: 'data-plugin', localId: 'database' } },
            targetKind: 'database', machines: [], members: [] });
        const resource = await createResourceDataKey({ credentials, mode });
        const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : encodeBase64(encryptWithDataKey(value, resource.dataKey));
        const artifacts = new Map<string, Record<string, unknown>>();
        const sourceReads: string[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: currentness };
            if (path === '/v1/account/profile') return { status: 200, data: { id: 'owner' } };
            if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: mode === 'plain'
                ? { t: 'plain', v: {} } : { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
                    material: { type: 'dataKey', machineKey }, payload: {}, randomBytes: length => crypto.getRandomValues(new Uint8Array(length)) }) } } };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 0 } };
            const id = decodeURIComponent(path.slice('/v1/artifacts/'.length));
            if (id === source.environment.contentArtifactId) {
                sourceReads.push(path);
                return { status: 200, data: { id, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: mode,
                    dataEncryptionKey: resource.mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER : resource.dataEncryptionKey,
                    header: encode({ kind: 'deployment-environment.v1', title: 'Source' }),
                    body: encode({ body: JSON.stringify(source.content) }), headerVersion: 1, bodyVersion: 1,
                    seq: 1, createdAt: 1, updatedAt: 1 } };
            }
            const created = artifacts.get(id);
            if (!created) throw new Error('Only exact selected source or destination Artifact may be opened');
            return { status: 200, data: created };
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            expect(request.method).toBe('GET');
            expect(new URL(String(request.url)).pathname).toBe(`/v1/deployments/environments/${source.environment.id}`);
            sourceReads.push(new URL(String(request.url)).pathname);
            return { status: 200, data: { ok: true, environment: source.environment,
                targetLinks: [...source.targetLinks.map(item => item.targetLink), dataLink] } };
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
            expect(url).toBe('https://home.test/v1/artifacts');
            if (!body || typeof body !== 'object' || !('id' in body) || typeof body.id !== 'string') throw new Error('Expected protected Artifact');
            artifacts.set(body.id, { ...body, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: mode,
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
        });
        const resolveRequestHeaders = () => ({ Authorization: `Bearer ${token}` });
        const carrier = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://home.test', admitAccount: () => null,
            resolveRequestHeaders, async dispatchReceipt() { throw new Error('Copy preparation cannot execute a deployment'); } });
        const custodianKey = new Uint8Array(32).fill(91);
        const custodianCredentials: StoredCredentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'custodian' })).toString('base64url')}.signature`,
            encryption: mode === 'plain' ? null : { type: 'dataKey', machineKey: custodianKey,
                publicKey: libsodiumPublicKeyFromSecretKey(custodianKey) } };
        const host = { credentials: custodianCredentials, accountArtifacts: createCredentialedAccountArtifactStore(credentials),
            serverHttpBaseUrl: 'https://home.test', async assertCurrent() {}, resolveRequestHeaders,
            async readMetadata({ environmentId, context }: Readonly<{ environmentId: string; context: ActionExecutorContext }>) {
                const loaded = await carrier.deploymentAction!('deployments.environments.get', { serverId: 'home', environmentId }, context);
                if ('errorCode' in loaded) throw Object.assign(new Error(loaded.errorCode), { code: loaded.errorCode });
                const detail = DeploymentEnvironmentGetResultV1Schema.parse(loaded);
                if (!detail.ok) throw Object.assign(new Error(detail.error), { code: detail.error });
                return detail;
            } };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-copy', binding: {
            accountId: 'owner', custodianAccountId: 'custodian', authentication: { kind: 'account', tokenEpoch: 1 },
            serverIdentityId: 'copy-home', machineId: 'controller', installationId: 'installed-controller',
            actionId: 'deployments.environments.create', requestId: 'copy-create', requestEnvelopeDigest: 'A'.repeat(43),
            target: { kind: 'machine', machineId: 'controller' }, accountEncryptionMode: mode,
        } });
        const requester = await admitRequesterAccountActionContext({ authorization, credentials,
            serverId: 'home', serverIdentityId: 'copy-home', serverHttpBaseUrl: host.serverHttpBaseUrl, isCurrent: async () => true });
        if (!requester) throw new Error('Expected canonical admitted requester custody');
        onTestFinished(() => requester.dispose());
        const requesterContext: ActionExecutorContext = { runtimeAccountId: 'owner', externalActionExecutionAuthorization: requester.authorization };
        const variable = (name: string) => ({ purpose: 'variable' as const, name, phase: 'runtime' as const });
        const input = DeploymentEnvironmentCreateIntentInputV1Schema.parse({ serverId: 'home', projectSourceId: 'destination-source',
            requestKey: 'copy-create', name: 'Independent copy', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            copyFrom: { environmentId: source.environment.id, expectedRevision: 7, choices: {
                secrets: [{ binding: variable('DATABASE_PASSWORD'), kind: 'useSameReference' }],
                values: [{ binding: variable('PUBLIC_VALUE'), kind: 'include' },
                    { binding: variable('REMOTE'), kind: 'remap', source: { kind: 'value', value: 'remapped-value' } },
                    { binding: variable('URL'), kind: 'omit' }],
                data: [{ targetLinkId: dataLink.id, kind: 'omit' }], retainPreviousDeployments: 'copy' } } });
        const captured = await resolveEnvironmentCreateCopyForHost({ input, context: {} }, host);
        if ('errorCode' in captured) throw new Error(captured.errorCode);
        expect(captured.input).toMatchObject({ retainPreviousDeployments: 7, definition: { from: 'compose', document } });
        for (const key of ['controllerMachineId', 'buildMachineId', 'firstTargetLink', 'preview', 'deployerPrincipals'])
            expect(captured.input).not.toHaveProperty(key);
        expect(captured.copyPlan?.bindings).toEqual([secret, source.content.bindings[1],
            { ...source.content.bindings[2], source: { kind: 'value', value: 'remapped-value' } }]);
        const review = JSON.stringify(captured.review);
        for (const privateText of ['review-redacted-value', 'private-copy-secret', 'private-reference', 'remapped-value', document])
            expect(review).not.toContain(privateText);
        expect(captured.review).toMatchObject({ sourceEnvironmentId: source.environment.id, sourceRevision: 7 });
        expect(artifacts.size).toBe(0);
        const prepared = await createPrepareEnvironmentCreateForHost(host)({ input: { ...captured.input,
            controllerMachineId: 'new-controller' }, context: requesterContext, projectOwner: { kind: 'account', accountId: 'owner' }, copy: captured });
        if ('errorCode' in prepared) throw new Error(prepared.errorCode);
        expect(prepared.copyIntentCommitment).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        const store = createCredentialedAccountArtifactStore(credentials);
        const artifact = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => store.read(prepared.contentArtifactId,
            { prepareRecipients: false, includeSharedAudience: false }));
        expect(prepared.contentArtifactId).not.toBe(source.environment.contentArtifactId);
        const opened = readDeploymentEnvironmentArtifactV1(prepared, artifact);
        expect(opened).toMatchObject({ ok: true, content: {
            name: 'Independent copy', definition: { kind: 'stored', contentRevision: 1, document }, bindings: [], ownServer: source.content.ownServer } });
        if (!opened.ok) throw new Error(opened.error);
        expect(artifact?.provenance?.savedBy).toEqual({ kind: 'person', accountId: 'owner' });
        expect(opened.content).not.toHaveProperty('previewProvenance');
        expect(opened.content).not.toHaveProperty('backup');
        for (const key of ['activeDeploymentId', 'runtimeTargetLinkId', 'preview', 'grants']) expect(prepared).not.toHaveProperty(key);
        expect(sourceReads).toEqual([`/v1/deployments/environments/${source.environment.id}`,
            `/v1/artifacts/${source.environment.contentArtifactId}`]);
        for (const badChoices of [{ ...input.copyFrom!.choices, secrets: [] },
            { ...input.copyFrom!.choices, values: input.copyFrom!.choices.values.slice(1) },
            { ...input.copyFrom!.choices, data: [] },
            { ...input.copyFrom!.choices, secrets: [...input.copyFrom!.choices.secrets, ...input.copyFrom!.choices.secrets] },
            { ...input.copyFrom!.choices, values: [...input.copyFrom!.choices.values, { binding: variable('FOREIGN'), kind: 'omit' as const }] }]) {
            await expect(resolveEnvironmentCreateCopyForHost({ input: { ...input,
                copyFrom: { ...input.copyFrom!, choices: badChoices } }, context: {} }, host))
                .resolves.toMatchObject({ ok: false, errorCode: 'deployment_invalid' });
        }
        const beforeStale = sourceReads.length;
        await expect(resolveEnvironmentCreateCopyForHost({ input: { ...input,
            copyFrom: { ...input.copyFrom!, expectedRevision: 6 } }, context: {} }, host))
            .resolves.toMatchObject({ ok: false, errorCode: 'deployment_conflict' });
        expect(sourceReads.slice(beforeStale)).toEqual([`/v1/deployments/environments/${source.environment.id}`]);
        const explicitRetention = await resolveEnvironmentCreateCopyForHost({ input: { ...input, retainPreviousDeployments: 0 }, context: {} }, host);
        expect(explicitRetention).toMatchObject({ input: { retainPreviousDeployments: 0 } });
        const defaultRetention = await resolveEnvironmentCreateCopyForHost({ input: { ...input, copyFrom: { ...input.copyFrom!,
            choices: { ...input.copyFrom!.choices, retainPreviousDeployments: 'default' } } }, context: {} }, host);
        if ('errorCode' in defaultRetention) throw new Error(defaultRetention.errorCode);
        expect(defaultRetention.input.retainPreviousDeployments).toBeUndefined();
        const reboundSecret = createDeploymentSecretVariableBindingV1({ name: 'DATABASE_PASSWORD', phase: 'runtime',
            resourceId: 'explicit-replacement', resourceRevision: 4 });
        const rebound = await resolveEnvironmentCreateCopyForHost({ input: { ...input, copyFrom: { ...input.copyFrom!,
            choices: { ...input.copyFrom!.choices, secrets: [{ binding: variable('DATABASE_PASSWORD'), kind: 'rebind', source: reboundSecret.source }] } } },
            context: {} }, host);
        if ('errorCode' in rebound) throw new Error(rebound.errorCode);
        expect(rebound.copyPlan?.bindings[0]).toEqual(reboundSecret);
        const materializeCopy = async (copy = captured, name = captured.input.name) => {
            const result = await createPrepareEnvironmentCreateForHost(host)({ input: { ...copy.input, name,
                controllerMachineId: 'new-controller' }, context: requesterContext,
                projectOwner: { kind: 'account', accountId: 'owner' }, copy });
            if ('errorCode' in result) throw new Error(result.errorCode);
            return result;
        };
        const retried = await materializeCopy();
        expect(retried.contentArtifactId).not.toBe(prepared.contentArtifactId);
        expect(retried.copyIntentCommitment).toBe(prepared.copyIntentCommitment);
        expect((await materializeCopy(captured, 'Changed copy')).copyIntentCommitment).not.toBe(prepared.copyIntentCommitment);
        expect((await materializeCopy(rebound)).copyIntentCommitment).not.toBe(prepared.copyIntentCommitment);
        await expect(resolveEnvironmentCreateCopyForHost({ input: { ...input, copyFrom: { ...input.copyFrom!,
            choices: { ...input.copyFrom!.choices, data: [{ targetLinkId: dataLink.id, kind: 'restoreBackup' }] } } }, context: {} }, host))
            .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
        if (mode === 'e2ee') await expect(createPrepareEnvironmentCreateForHost({ ...host,
            credentials: { ...credentials, encryption: null },
            accountArtifacts: createCredentialedAccountArtifactStore({ ...credentials, encryption: null }) })({
                input: { ...captured.input, controllerMachineId: 'new-controller' }, context: {},
                projectOwner: { kind: 'account', accountId: 'owner' }, copy: captured }))
            .resolves.toMatchObject({ ok: false, errorCode: 'client_required' });
        if (mode === 'e2ee') await expect(createPrepareEnvironmentCreateForHost({ ...host,
            credentials: { ...credentials, encryption: { type: 'dataKey', machineKey, publicKey: new Uint8Array(32) } } })({
                input: { ...captured.input, controllerMachineId: 'new-controller' }, context: {},
                projectOwner: { kind: 'account', accountId: 'owner' }, copy: captured }))
            .resolves.toMatchObject({ ok: false, errorCode: 'client_required' });
        await expect(createPrepareEnvironmentCreateForHost({ ...host, credentials })({
            input: { ...captured.input, controllerMachineId: 'new-controller' },
            context: { externalActionExecutionAuthorization: authorization },
            projectOwner: { kind: 'account', accountId: 'owner' }, copy: captured }))
            .resolves.toMatchObject({ ok: false, errorCode: 'client_required' });
        if (mode === 'e2ee') await expect(resolveEnvironmentCreateCopyForHost({ input, context: {} }, { ...host,
            credentials: { ...credentials, encryption: null },
            accountArtifacts: createCredentialedAccountArtifactStore({ ...credentials, encryption: null }) }))
            .resolves.toMatchObject({ ok: false, errorCode: 'client_required' });
        expect(artifacts.size).toBe(4);
    });
    it.each((['plain', 'e2ee'] as const).flatMap(mode => [false, true].map(adopted => ({ mode, adopted }))))(
        'preserves $mode definition owners and protected origin (adopted=$adopted) on storage retry', async ({ mode, adopted }) => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null
            : { type: 'legacy', secret: new Uint8Array(32).fill(23) } };
        const artifacts = new Map<string, Record<string, unknown>>();
        const artifactWrites: unknown[] = [];
        const environmentWrites: unknown[] = [];
        // HTTP is the genuine external boundary. Source normalization, private
        // codecs, Artifact admission, and the prepared storage carrier stay real.
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/encryption/currentness') return { status: 200,
                data: createAccountEncryptionCurrentnessFixture({ mode }) };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 0 } };
            if (!path.startsWith('/v1/artifacts/')) throw new Error('Prepared execution must not read defaults or Source again');
            const id = decodeURIComponent(path.slice('/v1/artifacts/'.length));
            const value = artifacts.get(id);
            if (!value) throw new Error('Only prepared Artifacts may be opened');
            return { status: 200, data: value };
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
            expect(url).toBe('https://home.test/v1/artifacts');
            if (!body || typeof body !== 'object' || !('id' in body) || typeof body.id !== 'string') throw new Error('Expected Artifact create wire');
            artifactWrites.push(body);
            artifacts.set(body.id, { ...body, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: mode,
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
        });
        vi.spyOn(axios, 'request').mockImplementation(async request => {
            expect(request.method).toBe('POST');
            expect(request.url).toBe('https://home.test/v1/deployments/environments');
            environmentWrites.push(DeploymentEnvironmentCreateInputV1Schema.parse(request.data));
            return { status: 200, data: { ok: true, environmentId: 'created', revision: 2 } };
        });
        const host = { credentials, serverHttpBaseUrl: 'https://home.test', async assertCurrent() {},
            resolveRequestHeaders: () => ({ Authorization: `Bearer ${token}` }) };
        const projectOwner = { kind: 'account' as const, accountId: 'owner' };
        const materialize = createPrepareEnvironmentCreateForHost(host);
        const carrier = createCliDeploymentActionDeps({ ...host, admitAccount: () => null,
            prepareEnvironment: createPrepareEnvironmentContentForHost(host),
            async dispatchReceipt() { throw new Error('Create cannot execute a deployment'); } });
        const input = DeploymentEnvironmentCreateIntentInputV1Schema.parse({ serverId: 'home', projectSourceId: 'source',
            requestKey: 'image-create', name: 'Image app', protection: 'nonProduction', purpose: 'standard', deployerMode: 'chosen',
            deployerPrincipals: [{ principalKind: 'account', principalId: 'teammate' }],
            controllerMachineId: 'controller', buildMachineId: 'builder', retainPreviousDeployments: 0, managedRetention: 'keep',
            firstTargetLink: { machines: [{ machineId: 'runtime', installationId: 'runtime-installation' }] },
            definition: adopted ? { from: 'compose', document: JSON.stringify({ services: { app: { image: 'example/app:1', expose: ['8080'] } } }),
                profiles: [], services: ['app'], primaryService: 'app' }
                : { from: 'image', image: 'example/app:1', port: 8080 } });
        await expect(carrier.deploymentAction!('deployments.environments.create', input, {}))
            .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: {
                issues: expect.arrayContaining([expect.objectContaining({ path: ['contentArtifactId'] })]),
            } });
        expect(artifactWrites).toHaveLength(0);
        expect(environmentWrites).toHaveLength(0);
        const nativeOrigin = adopted ? { projectName: 'existing-app', dockerEndpoint: 'unix:///var/run/docker.sock',
            workingDirectory: '/srv/existing-app' } : undefined;
        const prepared = await materialize({ input, context: {}, projectOwner, nativeOrigin });
        if ('errorCode' in prepared) throw new Error(prepared.errorCode);
        expect(prepared.managedRetention).toBe('keep');
        expect(artifactWrites).toHaveLength(2);
        const store = createCredentialedAccountArtifactStore(credentials);
        const linkArtifact = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => store.read(prepared.firstTargetLink!.contentArtifactId,
            { prepareRecipients: false, includeSharedAudience: false }));
        expect(readDeploymentTargetLinkArtifactV1(prepared.firstTargetLink!, linkArtifact)).toEqual({ ok: true,
            content: adopted ? { nativeOrigin } : {}, title: input.name });
        expect(JSON.stringify(prepared)).not.toContain('nativeOrigin');
        expect(JSON.stringify(prepared)).not.toContain('/srv/existing-app');
        if (adopted && mode === 'e2ee') expect(JSON.stringify(artifactWrites)).not.toContain('/srv/existing-app');
        const artifact = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => store.read(prepared.contentArtifactId,
            { prepareRecipients: false, includeSharedAudience: false }));
        const opened = readDeploymentEnvironmentArtifactV1(prepared, artifact);
        if (!opened.ok || opened.content.definition.kind !== 'stored') throw new Error('Expected opened stored definition');
        const definition = opened.content.definition;
        expect(opened.content).toMatchObject({ name: input.name, retainPreviousDeployments: 0, bindings: [] });
        expect(opened.content.ownServer).toEqual({ rollout: 'recreate', autoRestorePreviousRelease: true,
            backupBeforeMigration: true, migrationFailurePolicy: 'ask', serviceExports: [] });
        expect(JSON.parse(definition.document)).toEqual({ services: { app: { image: 'example/app:1', expose: ['8080'] } } });
        expect(definition).toMatchObject({ contentRevision: 1, profiles: [], services: ['app'], primaryService: 'app',
            composeDigest: `sha256:${createHash('sha256').update(definition.document).digest('hex')}` });
        expect(prepared).toMatchObject({ deployerPrincipals: input.deployerPrincipals, controllerMachineId: 'controller', buildMachineId: 'builder',
            firstTargetLink: { machines: input.firstTargetLink!.machines } });
        for (let retry = 0; retry < 2; retry += 1) {
            await expect(carrier.deploymentAction!('deployments.environments.create', prepared, {}))
                .resolves.toEqual({ ok: true, environmentId: 'created', revision: 2 });
        }
        expect(environmentWrites).toEqual([prepared, prepared]);
        expect(artifactWrites, 'prepared retry must not generate new content refs or reread defaults').toHaveLength(2);

        const document = 'services:\n  app:\n    image: example/app:2\nconfigs:\n  settings:\n    content: inline\n';
        const compose = await materialize({ input: { ...input, requestKey: 'compose-create',
            definition: { from: 'compose', document, profiles: ['web'], services: ['app'], primaryService: 'app' } }, context: {}, projectOwner });
        if ('errorCode' in compose) throw new Error(compose.errorCode);
        const composeArtifact = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => store.read(compose.contentArtifactId,
            { prepareRecipients: false, includeSharedAudience: false }));
        expect(readDeploymentEnvironmentArtifactV1(compose, composeArtifact)).toMatchObject({ ok: true,
            content: { definition: { kind: 'stored', document, contentRevision: 1, profiles: ['web'], services: ['app'], primaryService: 'app' } } });
        const repositoryInput = DeploymentEnvironmentCreateIntentInputV1Schema.parse({ ...input, requestKey: 'repository-create',
            definition: { from: 'repository', ref: 'release/one', compose: {
                path: 'deploy/compose.yaml', profiles: ['web'], services: ['app'], primaryService: 'app' } } });
        const repository = await materialize({ input: repositoryInput, context: {}, projectOwner });
        if ('errorCode' in repository) throw new Error(repository.errorCode);
        const repositoryArtifact = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => store.read(repository.contentArtifactId,
            { prepareRecipients: false, includeSharedAudience: false }));
        const openedRepository = readDeploymentEnvironmentArtifactV1(repository, repositoryArtifact);
        if (!openedRepository.ok) throw new Error(openedRepository.error);
        expect(openedRepository.content.definition).toEqual({ kind: 'repository', ref: 'release/one', compose: {
            path: 'deploy/compose.yaml', profiles: ['web'], services: ['app'], primaryService: 'app' } });
        expect(openedRepository.content.definition).not.toHaveProperty('document');
        expect(openedRepository.content.definition).not.toHaveProperty('contentRevision');
        await expect(carrier.deploymentAction!('deployments.environments.create', repository, {}))
            .resolves.toEqual({ ok: true, environmentId: 'created', revision: 2 });
        // Plan 43 Git integration builds at the provider; no native definition or target is fabricated.
        const platformInput = DeploymentEnvironmentCreateIntentInputV1Schema.parse({ ...input,
            requestKey: 'platform-create', firstTargetLink: undefined, buildMachineId: undefined,
            definition: { from: 'repository', ref: 'release/static-site' } });
        const platform = await materialize({ input: platformInput, context: {}, projectOwner });
        if ('errorCode' in platform) throw new Error(platform.errorCode);
        expect(platform.firstTargetLink).toBeUndefined();
        expect(platform.buildMachineId).toBeUndefined();
        const platformArtifact = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => store.read(platform.contentArtifactId,
            { prepareRecipients: false, includeSharedAudience: false }));
        const openedPlatform = readDeploymentEnvironmentArtifactV1(platform, platformArtifact);
        expect(openedPlatform).toMatchObject({ ok: true, content: {
            definition: { kind: 'repository', ref: 'release/static-site' }, bindings: [] } });
        if (!openedPlatform.ok) throw new Error(openedPlatform.error);
        expect(openedPlatform.content.definition).not.toHaveProperty('compose');
        await expect(carrier.deploymentAction!('deployments.environments.create', platform, {}))
            .resolves.toEqual({ ok: true, environmentId: 'created', revision: 2 });
        const beforeRefusal = artifactWrites.length;
        await expect(materialize({ input: { ...input,
            definition: DeploymentEnvironmentCreateIntentInputV1Schema.shape.definition.parse({ from: 'catalogApp',
                templateRef: { sourceId: 'registry', itemId: 'app', version: '1', ref: { kind: 'version', version: '1' } } }) }, context: {}, projectOwner }))
            .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
        await expect(materialize({ input: { ...input, definition: { from: 'compose', profiles: [], services: ['app'],
            document: 'services:\n  app:\n    image: example/app:1\n    env_file: .env\n' } }, context: {}, projectOwner }))
            .resolves.toMatchObject({ ok: false, errorCode: 'needs_repository' });
        expect(artifactWrites, 'sidecar refusal occurs before protecting or storing any create bytes').toHaveLength(beforeRefusal);
        const cancelled = new AbortController();
        cancelled.abort();
        await expect(materialize({ input, context: { signal: cancelled.signal }, projectOwner }))
            .resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
        await expect(materialize({ input: { ...input, retainPreviousDeployments: undefined }, context: {}, projectOwner }))
            .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: {
                issues: expect.arrayContaining([expect.objectContaining({ path: ['retainPreviousDeployments'] })]),
            } });
        await expect(materialize({ input: { ...input, controllerMachineId: undefined }, context: {}, projectOwner }))
            .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: {
                issues: expect.arrayContaining([expect.objectContaining({ path: ['controllerMachineId'] })]),
            } });
        await expect(materialize({ input: { ...input, copyFrom: { environmentId: 'source-environment', expectedRevision: 3,
            choices: { secrets: [], values: [], data: [] } } }, context: {}, projectOwner }))
            .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters', details: {
                issues: expect.arrayContaining([expect.objectContaining({ path: ['copyFrom'] })]),
            } });
        expect(artifactWrites, 'cancellation and unresolved defaults cannot author private content').toHaveLength(beforeRefusal);
    });

    it.each(['plain', 'e2ee'] as const)('protects %s Environment and first-link content for the admitted Team before returning prepared refs', async mode => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature`;
        const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null
            : { type: 'legacy', secret: new Uint8Array(32).fill(31) } };
        const artifacts = new Map<string, Record<string, unknown>>();
        const grants = new Map<string, unknown>();
        const keyCommits = new Map<string, ArtifactRecipientKeyEnvelopeCommitInputV1>();
        const projectOwner = { kind: 'team' as const, teamId: 'source-team' };
        const peerToken = `header.${Buffer.from(JSON.stringify({ sub: 'peer' })).toString('base64url')}.signature`;
        const peerMachineKey = new Uint8Array(32).fill(37);
        const peerPublicKey = x25519.getPublicKey(peerMachineKey);
        const peerSigningSeed = new Uint8Array(32).fill(41);
        const peerSigningPublicKey = ed25519.getPublicKey(peerSigningSeed);
        const peerFingerprint = computeContentPublicKeyFingerprint(peerPublicKey);
        const peerContentKey = { status: 'available' as const,
            accountSigningPublicKey: Buffer.from(peerSigningPublicKey).toString('hex'),
            contentPublicKey: Buffer.from(peerPublicKey).toString('base64'),
            contentPublicKeySignature: Buffer.from(signAccountContentKeyBindingV1({
                accountSigningSecretKey: new Uint8Array([...peerSigningSeed, ...peerSigningPublicKey]),
                contentPublicKey: peerPublicKey,
            })).toString('base64') };
        vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
            const path = new URL(url).pathname;
            if (path === '/v1/account/encryption/currentness') return { status: 200,
                data: createAccountEncryptionCurrentnessFixture({ mode }) };
            if (path === '/v1/account/encryption') return { status: 200, data: { mode, updatedAt: 0 } };
            const id = decodeURIComponent(path.split('/')[3]!);
            const artifact = artifacts.get(id);
            if (!artifact) throw new Error('Only newly prepared Team Artifacts may be opened');
            if (path.endsWith('/access/recipients')) {
                expect(grants.get(id)).toEqual({ principal: projectOwner, accessLevel: 'admin' });
                const peerEnvelope = keyCommits.get(id)?.recipientKeyEnvelopes[0];
                return { status: 200, data: ArtifactAccessRecipientCensusResponseV1Schema.parse({ artifactId: id,
                    ownerAccountId: 'owner', access: 'owner', encryptionMode: mode,
                    dataEncryptionKey: artifact.dataEncryptionKey, callerDataEncryptionKey: artifact.dataEncryptionKey,
                    provenanceDataEncryptionKey: artifact.provenanceDataEncryptionKey ?? null,
                    callerProvenanceDataEncryptionKey: artifact.provenanceDataEncryptionKey ?? null,
                    recipients: [{ recipientAccountId: 'peer', contentKey: peerContentKey,
                        contentPublicKeyFingerprint: peerFingerprint,
                        encryptedDataKey: peerEnvelope?.encryptedDataKey ?? null,
                        encryptedProvenanceDataKey: peerEnvelope?.encryptedProvenanceDataKey ?? null,
                        recipientContentPublicKeyFingerprint: peerEnvelope?.recipientContentPublicKeyFingerprint ?? null }] }) };
            }
            expect(path).toBe(`/v1/artifacts/${id}`);
            if (config?.headers?.Authorization === `Bearer ${peerToken}`) {
                const envelope = keyCommits.get(id)?.recipientKeyEnvelopes[0];
                if (!envelope?.encryptedProvenanceDataKey) throw new Error('Peer content and provenance keys must be committed before disclosure');
                return { status: 200, data: { ...artifact, access: 'admin', dataEncryptionKey: envelope.encryptedDataKey,
                    provenanceDataEncryptionKey: envelope.encryptedProvenanceDataKey } };
            }
            return { status: 200, data: artifact };
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
            if (new URL(url).pathname.endsWith('/access/key-envelopes')) {
                const input = ArtifactRecipientKeyEnvelopeCommitInputV1Schema.parse(body);
                expect(url).toBe(`https://home.test/v1/artifacts/${input.artifactId}/access/key-envelopes`);
                expect(mode).toBe('e2ee');
                expect(grants.get(input.artifactId)).toEqual({ principal: projectOwner, accessLevel: 'admin' });
                const artifact = artifacts.get(input.artifactId);
                expect(input.expectedDataEncryptionKey).toBe(artifact?.dataEncryptionKey);
                expect(input.expectedProvenanceDataEncryptionKey).toBe(artifact?.provenanceDataEncryptionKey);
                expect(input.recipientKeyEnvelopes).toEqual([{ recipientAccountId: 'peer',
                    recipientContentPublicKeyFingerprint: peerFingerprint,
                    encryptedDataKey: expect.any(String), encryptedProvenanceDataKey: expect.any(String) }]);
                keyCommits.set(input.artifactId, input);
                return { status: 200, data: ArtifactRecipientKeyEnvelopeCommitResponseV1Schema.parse({
                    appliedRecipientAccountIds: ['peer'], skippedRecipientAccountIds: [],
                }) };
            }
            expect(url).toBe('https://home.test/v1/artifacts');
            if (!body || typeof body !== 'object' || !('id' in body) || typeof body.id !== 'string') throw new Error('Expected Artifact create wire');
            artifacts.set(body.id, { ...body, ownerAccountId: 'owner', access: 'owner', publicAudience: 'none', encryptionMode: mode,
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
            return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
        });
        vi.spyOn(axios, 'put').mockImplementation(async (url, body: unknown) => {
            const input = ArtifactAccessGrantSetInputV1Schema.parse(body);
            expect(url).toBe(`https://home.test/v1/artifacts/${input.artifactId}/access/grants`);
            expect(input.principal).toEqual(projectOwner);
            grants.set(input.artifactId, { principal: input.principal, accessLevel: input.accessLevel });
            return { status: 200, data: ArtifactAccessGrantMutationResponseV1Schema.parse({
                artifactId: input.artifactId, ownerAccountId: 'owner', access: 'owner', changed: true,
                grants: [{ principal: input.principal, accessLevel: input.accessLevel,
                    createdByAccountId: 'owner', createdAt: 1, display: { name: null } }],
            }) };
        });
        const host = { credentials, serverHttpBaseUrl: 'https://home.test', async assertCurrent() {},
            resolveRequestHeaders: () => ({ Authorization: `Bearer ${token}` }) };
        const materialize = createPrepareEnvironmentCreateForHost(host);
        const input = DeploymentEnvironmentCreateIntentInputV1Schema.parse({ serverId: 'home', projectSourceId: 'team-source',
            requestKey: 'team-create', name: 'Team app', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: 'controller', buildMachineId: 'builder', retainPreviousDeployments: 0,
            firstTargetLink: { machines: [{ machineId: 'runtime', installationId: 'runtime-installation' }] },
            definition: { from: 'image', image: 'example/app:1', port: 8080 } });
        const prepared = await materialize({ input, context: {}, projectOwner });
        if ('errorCode' in prepared) throw new Error(prepared.errorCode);
        expect(prepared.firstTargetLink).toBeDefined();
        expect(grants).toEqual(new Map([prepared.contentArtifactId, prepared.firstTargetLink!.contentArtifactId]
            .map(id => [id, { principal: projectOwner, accessLevel: 'admin' }])));
        const store = createCredentialedAccountArtifactStore(credentials);
        const artifact = await runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => store.read(prepared.contentArtifactId,
            { prepareRecipients: false, includeSharedAudience: false }));
        expect(readDeploymentEnvironmentArtifactV1(prepared, artifact)).toMatchObject({ ok: true,
            content: { name: input.name, retainPreviousDeployments: 0, definition: { kind: 'stored' } } });
        if (mode === 'plain') expect(keyCommits.size).toBe(0);
        else {
            expect(new Set(keyCommits.keys())).toEqual(new Set([prepared.contentArtifactId, prepared.firstTargetLink!.contentArtifactId]));
            const peerCredentials: StoredCredentials = { token: peerToken,
                encryption: { type: 'dataKey', machineKey: peerMachineKey, publicKey: peerPublicKey } };
            const peerStore = createCredentialedAccountArtifactStore(peerCredentials);
            const readPeer = (id: string) => runWithServerHttpBaseUrl(host.serverHttpBaseUrl, () => peerStore.read(id,
                { prepareRecipients: false, includeSharedAudience: false }));
            const peerEnvironment = await readPeer(prepared.contentArtifactId);
            expect(readDeploymentEnvironmentArtifactV1(prepared, peerEnvironment)).toMatchObject({ ok: true,
                content: { name: input.name, retainPreviousDeployments: 0, definition: { kind: 'stored' } } });
            const peerLink = await readPeer(prepared.firstTargetLink!.contentArtifactId);
            expect(readDeploymentTargetLinkArtifactV1(prepared.firstTargetLink!, peerLink)).toEqual({ ok: true, content: {}, title: input.name });
            expect(peerEnvironment?.provenance?.savedBy).toEqual({ kind: 'person', accountId: 'owner' });
            expect(peerLink?.provenance?.savedBy).toEqual({ kind: 'person', accountId: 'owner' });
        }
    });

    it.each(['plain', 'e2ee'] as const)('refuses %s captured authority retirement during content preparation before any Artifact write', async mode => {
        const token = `header.${Buffer.from(JSON.stringify({ sub: `retiring-${mode}` })).toString('base64url')}.signature`;
        const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null
            : { type: 'legacy', secret: new Uint8Array(32).fill(29) } };
        let current = true;
        let retireDuringPreparation = false;
        const writes: unknown[] = [];
        vi.spyOn(axios, 'get').mockImplementation(async url => {
            const path = new URL(url).pathname;
            if (path === '/captured-authority') return { status: 200, data: { current } };
            if (path === '/v1/account/encryption/currentness') {
                retireDuringPreparation = true;
                current = false;
                return { status: 200, data: createAccountEncryptionCurrentnessFixture({ mode }) };
            }
            if (path === '/v1/account/encryption') {
                retireDuringPreparation = true;
                current = false;
                return { status: 200, data: { mode, updatedAt: 0 } };
            }
            throw new Error('Unexpected content preparation read');
        });
        vi.spyOn(axios, 'post').mockImplementation(async (_url, body: unknown) => {
            writes.push(body);
            return { status: 500, data: {} };
        });
        const materialize = createPrepareEnvironmentCreateForHost({ credentials, serverHttpBaseUrl: 'https://home.test',
            async assertCurrent() {
                const captured = await axios.get<{ current: boolean }>('https://home.test/captured-authority');
                if (!captured.data.current) throw Object.assign(new Error('action_forbidden'), { code: 'action_forbidden' });
            },
            resolveRequestHeaders: () => ({ Authorization: `Bearer ${token}` }),
        });
        const input = DeploymentEnvironmentCreateIntentInputV1Schema.parse({ serverId: 'home', projectSourceId: 'source', requestKey: 'retired',
            name: 'Retired', protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: 'controller', retainPreviousDeployments: 1,
            definition: { from: 'compose', document: 'services: {app: {image: nginx:1}}', profiles: [], services: ['app'] } });
        await expect(materialize({ input, context: {}, projectOwner: { kind: 'account', accountId: `retiring-${mode}` } }))
            .resolves.toMatchObject({ ok: false, errorCode: 'action_forbidden' });
        expect(retireDuringPreparation, 'the initially admitted caller retires while real private-content preparation is underway').toBe(true);
        expect(writes).toHaveLength(0);
    });
});
