import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { db } from '@/storage/db';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { inTx } from '@/storage/inTx';
import { createProjectSourceInTx, readProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER,
    encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { DeploymentEnvironmentContentV1Schema, readDeploymentReceiptArtifactV1, type MachineSecretGrantV1 } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { ArtifactHeaderMetadataV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { ArtifactBodyEnvelopeV1StoredSchema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { createSavedSecretResourceInTx, deleteSavedSecretResourceInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { createArtifact, updateArtifact } from '@/app/artifacts/artifactWriteService';
import { readArtifactForCallerInTx } from '@/app/artifacts/artifactAccessService';
import { ArtifactJsonUpdateHttpInputV1Schema, DeploymentEnvironmentCreateResultV1Schema, computeDeploymentTransitionRequestDigestV1, readDeploymentAccountChangeV1, type DeploymentTransitionInputV1 } from '@happier-dev/protocol';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import nacl from 'tweetnacl';
import { createDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import * as environmentService from './deploymentEnvironmentService';
import { linkDeploymentTargetInTx, readDeploymentTargetInTx, readDeploymentTargetsInTx } from './deploymentTargetLinkService';
import { readPlainDeploymentEnvironmentContentInTx } from './deploymentStoredContent';
import { createActionExecutor, createDeploymentApprovalScopeResolverV1,
    DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1, sealEncryptedDataKeyEnvelopeV1,
    sealSessionDataKeyBundleV0, type ActionExecutorDeps } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { auth } from '@/app/auth/auth';
import { computeExternalActionRequestEnvelopeDigestV1, encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER } from '@happier-dev/protocol/actions/externalActionApi';

const plainMachineContent = {
    metadata: encodePlainMachineStoredContent({ host: 'Persistence', platform: 'linux', happyCliVersion: 'test',
        homeDir: '/home/deployment', happyHomeDir: '/home/deployment/.happier' }),
    dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
};

describe('deployment storage real SQLite boundary', () => {
    const serverId = `srv_${'a'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-deployment-storage-', initEncrypt: true, initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: serverId, AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it.each((['plain', 'e2ee'] as const).flatMap(mode => [false, true].map(existing => ({ mode, existing }))))(
        'retains incomplete template bindings until the binding writer completes ($mode; existing=$existing)', async ({ mode, existing }) => {
        const { sealSavedSecretResourceStoredContentV1 } = await import('@happier-dev/protocol/account/settings/savedSecretResourceContentV1');
        const { computeContentPublicKeyFingerprint } = await import('@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint');
        const keys = nacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(keys.publicKey) : {}) } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId,
            requestKey: crypto.randomUUID(), name: 'Template binding preparation', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const machineId = crypto.randomUUID(), installationId = crypto.randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: owner.id,
            ...(mode === 'plain' ? plainMachineContent : { metadata: '{}' }),
            installationId, installationPublicKey: new Uint8Array(nacl.sign.keyPair().publicKey) } });
        const key = nacl.randomBytes(32);
        const artifact = async (kind: string, body: unknown) => {
            const seal = async (value: unknown) => mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value))
                : new Uint8Array(await sealSessionDataKeyBundleV0(value, key));
            const created = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(), kind: `v1:other:${kind}`,
                header: await seal({ kind, title: 'Template binding preparation' }), body: await seal({ body: JSON.stringify(body) }),
                dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)
                    : sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: keys.publicKey, randomBytes: nacl.randomBytes }) });
            if (!created.ok) throw new Error(created.error);
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const content = DeploymentEnvironmentContentV1Schema.parse({ name: 'Template binding preparation', retainPreviousDeployments: 1,
            definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } }, bindings: [] });
        const resourceId = crypto.randomUUID();
        const secret = { v: 1 as const, name: 'Template password', kind: 'password' as const, value: 'private-boundary-value' };
        const resource = await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
            displayName: secret.name, kind: secret.kind, encryptionMode: mode,
            storedContent: sealSavedSecretResourceStoredContentV1(mode === 'plain' ? { resourceId, mode, content: secret }
                : { resourceId, mode, content: secret, resourceDataKey: key, randomBytes: nacl.randomBytes }),
            ...(mode === 'e2ee' ? { keyEnvelopes: [{ recipientAccountId: owner.id,
                encryptedDataKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: key,
                    recipientPublicKey: keys.publicKey, randomBytes: nacl.randomBytes }),
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(keys.publicKey) }] } : {}) }));
        if (!resource.ok) throw new Error(resource.error);
        const unrelated = await db.account.create({ data: { encryptionMode: 'plain' } });
        const unrelatedResourceId = crypto.randomUUID();
        expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: unrelated.id, resourceId: unrelatedResourceId,
            displayName: 'Unrelated key', kind: 'token', encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'Unrelated key', kind: 'token', value: 'private-test-boundary' } } })))
            .toMatchObject({ ok: true });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id };
            const createBody = {
                serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(),
                controllerMachineId: machineId, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                ...await artifact('deployment-environment.v1', content),
                ...(!existing ? { referencedSavedSecretRevisions: [{ resourceId, revision: 1 }] } : {}),
                firstTargetLink: { ...await artifact('deployment-target-link.v1', {}), machines: [{ machineId, installationId }] },
            };
            // Public storage cannot turn a forged foreign ID into a Used-by reference.
            const forged = await app.inject({ method: 'POST', url: '/v1/deployments/environments', headers,
                payload: { ...createBody, requestKey: crypto.randomUUID(),
                    referencedSavedSecretRevisions: [{ resourceId: unrelatedResourceId, revision: 1 }] } });
            expect(forged.statusCode, forged.body).toBe(409);
            expect(forged.json()).toMatchObject({ ok: false, error: 'deployment_conflict' });
            const created = await app.inject({ method: 'POST', url: '/v1/deployments/environments', headers, payload: createBody });
            expect(created.statusCode, created.body).toBe(200);
            const { environmentId } = created.json() as { environmentId: string };
            let revision = (created.json() as { revision: number }).revision;
            const base = `/v1/deployments/environments/${environmentId}`;
            const read = async () => (await app.inject({ method: 'GET', url: `${base}?serverId=${serverId}`, headers })).json();
            const binding = { purpose: 'variable' as const, phase: 'runtime' as const, name: 'PASSWORD',
                source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 } };
            const grant: MachineSecretGrantV1 = { v: 1, kind: 'secret', environmentId, machineId, installationId,
                resourceId, resourceRevision: 1, sealedContent: 'installation-boundary-ciphertext' };
            const bind = async (bindings: typeof binding[]) => {
                const response = await app.inject({ method: 'POST', url: `${base}/bindings`, headers, payload: {
                    serverId, environmentId, expectedRevision: revision, ...await artifact('deployment-environment.v1', { ...content, bindings }),
                    referencedSavedSecretRevisions: [{ resourceId, revision: 1, requiredBindings: [{ purpose: 'variable', phase: 'runtime' }] }],
                    grants: [grant],
                } });
                expect(response.statusCode, response.body).toBe(200);
                revision = (response.json() as { revision: number }).revision;
            };
            let retainedSharedResourceId: string | undefined;
            if (existing) {
                // Ordinary binding-free Compose is ready, then the first app binds this resource.
                expect(await read()).toMatchObject({ secretScope: { status: 'ready' } });
                await bind([binding]);
                expect(await read()).toMatchObject({ secretScope: { status: 'ready', requiredGrantCount: 1 } });
                if (mode === 'plain') {
                    await makeShareEligibleForTest(unrelated.id, owner.id);
                    const sharedResourceId = crypto.randomUUID();
                    expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: unrelated.id, resourceId: sharedResourceId,
                        displayName: 'Retained shared key', kind: 'token', encryptionMode: 'plain', accountGrants: [owner.id],
                        storedContent: { t: 'plain', v: { v: 1, name: 'Retained shared key', kind: 'token', value: 'private-test-boundary' } } })))
                        .toMatchObject({ ok: true });
                    // Retained unplaced metadata is a real persistence boundary: no Machine grant holds this reference.
                    await db.deploymentEnvironment.update({ where: { id: environmentId }, data: { referencedSavedSecretRevisions: [
                        { resourceId, revision: 1, requiredBindings: [{ purpose: 'variable', phase: 'runtime' }] },
                        { resourceId: sharedResourceId, revision: 1 },
                    ] } });
                    expect(await db.machineSecretGrant.count({ where: { environmentId, resourceId: sharedResourceId } })).toBe(0);
                    retainedSharedResourceId = sharedResourceId;
                }
                const forgedUpdate = await app.inject({ method: 'PATCH', url: base, headers, payload: {
                    serverId, environmentId, expectedRevision: revision, ...await artifact('deployment-environment.v1', { ...content, bindings: [binding] }),
                    referencedSavedSecretRevisions: [{ resourceId: unrelatedResourceId, revision: 1 }],
                } });
                expect(forgedUpdate.statusCode, forgedUpdate.body).toBe(409);
                // A second app needs the SAME resource under a NEW variable name.
                // Existing routing/grant coverage cannot prove that binding was saved.
                const pending = await app.inject({ method: 'PATCH', url: base, headers, payload: {
                    serverId, environmentId, expectedRevision: revision,
                    ...await artifact('deployment-environment.v1', { ...content, bindings: [binding] }),
                    referencedSavedSecretRevisions: [{ resourceId, revision: 1 }],
                } });
                expect(pending.statusCode, pending.body).toBe(200);
                revision = (pending.json() as { revision: number }).revision;
            }
            expect(await read()).toMatchObject({ secretScope: {
                status: 'unavailable', reason: 'secret_scope_requirements_unavailable',
            } });
            const pendingCaptures = (await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId } }))
                .referencedSavedSecretRevisions;
            expect(pendingCaptures).toEqual(expect.arrayContaining([{ resourceId, revision: 1 }]));
            if (retainedSharedResourceId) {
                expect(pendingCaptures).toEqual(expect.arrayContaining([{ resourceId: retainedSharedResourceId, revision: 1 }]));
                expect(await inTx(tx => deleteSavedSecretResourceInTx(tx, { accountId: unrelated.id,
                    resourceId: retainedSharedResourceId!, expectedRevision: 1, expectedSettingsVersion: 0,
                    referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] },
                        catalogs: { mcp: 'absent', acp: 'absent', providerConnections: 'absent', connectedConfigurations: 'absent',
                            connectedPurposes: 'absent', registrySources: 'absent' } } })))
                    .toEqual({ ok: false, error: 'resource_in_use' });
            }
            // Account X's incomplete private install must not block Account Y's unused key.
            expect(await inTx(tx => deleteSavedSecretResourceInTx(tx, { accountId: unrelated.id,
                resourceId: unrelatedResourceId, expectedRevision: 1, expectedSettingsVersion: 0,
                referenceCensus: { accountMode: 'plain', profiles: { referenceGuardRevision: 'absent', rows: [] },
                    catalogs: { mcp: 'absent', acp: 'absent', providerConnections: 'absent', connectedConfigurations: 'absent',
                        connectedPurposes: 'absent', registrySources: 'absent' } } })))
                .toEqual({ ok: true, value: { resourceId: unrelatedResourceId } });
            // A refused/absent bindings child leaves this exact projection incomplete.
            // Only the canonical binding writer completes it, preserving the first app.
            await bind(existing ? [binding, { ...binding, name: 'SECOND_PASSWORD' }] : [binding]);
            expect(await read()).toMatchObject({ secretScope: {
                status: 'ready', reason: 'secret_scope_current', requiredGrantCount: 1, missingGrantCount: 0,
            } });
            const stored = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId } });
            expect(stored.referencedSavedSecretRevisions).toEqual([{ resourceId, revision: 1,
                requiredBindings: [{ purpose: 'variable', phase: 'runtime' }] }]);
        });
    });

    it('creates and reloads a platform Environment without Compose or a native target through manager admission', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Static platform site', audience: [],
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'owner/site', cloneUrl: 'https://github.com/owner/site.git' }, protocol: 'https' },
        }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            ...plainMachineContent, installationId: crypto.randomUUID() } });
        const content = DeploymentEnvironmentContentV1Schema.parse({ name: 'Static platform site',
            retainPreviousDeployments: 1, definition: { kind: 'repository', ref: 'main' }, bindings: [] });
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            kind: 'v1:other:deployment-environment.v1',
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: content.name })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(content) })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const input = { serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(),
            protection: 'nonProduction' as const, purpose: 'standard' as const, deployerMode: 'managers' as const,
            controllerMachineId: machine.id, contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const create = async (accountId: string) => app.inject({ method: 'POST', url: '/v1/deployments/environments',
                headers: { 'x-test-user-id': accountId }, payload: input });
            const refused = DeploymentEnvironmentCreateResultV1Schema.parse((await create(outsider.id)).json());
            expect(refused.ok).toBe(false);
            const created = DeploymentEnvironmentCreateResultV1Schema.parse((await create(owner.id)).json());
            expect(created.ok).toBe(true);
            if (!created.ok) throw new Error(created.error);
            const row = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.environmentId } });
            expect(row.runtimeTargetLinkId).toBeNull();
            expect(row.buildMachineId).toBeNull();
            const opened = await inTx(tx => readPlainDeploymentEnvironmentContentInTx(tx, owner.id,
                { kind: 'account', accountId: owner.id }, input));
            expect(opened).toMatchObject({ ok: true, content });
            expect(DeploymentEnvironmentCreateResultV1Schema.parse((await create(owner.id)).json())).toEqual(created);
        });
    });

    it.each(['plain', 'e2ee'] as const)('reads complete %s Domain inventory from current Source authority without opening content', async mode => {
        const { readDeploymentDomainInventoryInTx } = await import('./deploymentDomainService');
        const keys = nacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(keys.publicKey) : {}) } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, reader.id);
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Domain inventory',
            audience: [{ principal: { kind: 'account', accountId: reader.id }, level: 'view' }],
        }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            ...(mode === 'plain' ? plainMachineContent : { metadata: '{}' }), installationId: crypto.randomUUID() } });
        const resourceKey = nacl.randomBytes(32);
        const seal = async (value: unknown) => mode === 'plain'
            ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value))
            : new Uint8Array(await sealSessionDataKeyBundleV0(value, resourceKey));
        const artifactFor = async (kind: string, body: unknown) => {
            const created = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                kind: `v1:other:${kind}`, header: await seal({ kind, title: 'Domain inventory' }),
                body: await seal({ body: JSON.stringify(body) }),
                dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)
                    : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: resourceKey,
                        recipientPublicKey: keys.publicKey, randomBytes: nacl.randomBytes })) });
            if (!created.ok) throw new Error(created.error);
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const document = '{"services":{"app":{"image":"app:1"}}}';
        const content = await artifactFor('deployment-environment.v1', { name: 'Domain inventory', retainPreviousDeployments: 1,
            bindings: [], definition: { kind: 'stored', contentRevision: 1, document, profiles: [], services: ['app'],
                composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}` } });
        const createEnvironment = () => inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, { ...content, serverId,
            projectSourceId: source.source.id, requestKey: crypto.randomUUID(), protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', controllerMachineId: machine.id }));
        const [created, empty] = await Promise.all([createEnvironment(), createEnvironment()]);
        if (!created.ok || !empty.ok) throw new Error('Expected ordinary Source owner Environment admission');
        const targetContent = await artifactFor('deployment-target-link.v1', {});
        const linked = await inTx(tx => linkDeploymentTargetInTx(tx, owner.id, { ...targetContent, serverId,
            environmentId: created.environmentId, expectedRevision: created.revision, requestKey: crypto.randomUUID(),
            targetId: 'own-server', role: 'runtime', machines: [{ machineId: machine.id, installationId: machine.installationId! }] }));
        if (!linked.ok) throw new Error(linked.error);
        // A retained predecessor and partially removed Domain are persisted
        // inputs to cleanup. They are not current-link-only route candidates.
        const predecessor = await db.deploymentTargetLink.create({ data: { environmentId: created.environmentId,
            createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'configured', detachedAt: new Date(), ...targetContent } });
        const domainContent = await artifactFor('deployment-domain.v1', { hostname: 'private.example.test' });
        const insert = (id: string, environmentId: string, targetLinkId: string, state: string, deletedAt: Date | null) =>
            db.$executeRawUnsafe('INSERT INTO "DeploymentDomain" ("id","environmentId","targetLinkId","state","contentArtifactId","contentHeaderVersion","contentBodyVersion","createdByAccountId","updatedAt","deletedAt") VALUES (?, ?, ?, ?, ?, 1, 1, ?, CURRENT_TIMESTAMP, ?)',
                id, environmentId, targetLinkId, state, domainContent.contentArtifactId, owner.id, deletedAt);
        const currentId = crypto.randomUUID();
        const removingId = crypto.randomUUID();
        const oldLinkId = crypto.randomUUID();
        await insert(currentId, created.environmentId, linked.targetLinkId, 'active', null);
        await insert(removingId, created.environmentId, predecessor.id, 'removing', null);
        await insert(oldLinkId, created.environmentId, predecessor.id, 'failed', null);
        await insert(crypto.randomUUID(), created.environmentId, predecessor.id, 'removing', new Date());
        const readInput = { serverId, environmentId: created.environmentId, expectedRevision: linked.revision };
        const requests: { model?: string; action: string; args: unknown }[] = [];
        const stop = observeSqliteRequests({ before: request => {
            requests.push({ model: request.model, action: request.action, args: request.args });
        } });
        const result = await (async () => {
            try { return await inTx(tx => readDeploymentDomainInventoryInTx(tx, owner.id, readInput)); }
            finally { stop(); }
        })();
        expect(result).toMatchObject({ ok: true, environmentId: created.environmentId, environmentRevision: linked.revision });
        if (!result.ok) throw new Error(result.error);
        expect(result.capturedMachineIds).toBeNull();
        expect(result.domains.map(domain => domain.id).sort()).toEqual([currentId, removingId, oldLinkId].sort());
        expect(result.domains.find(domain => domain.id === removingId)).toMatchObject({ targetLinkId: predecessor.id, state: 'removing' });
        expect(result.domains.every(domain => !('hostname' in domain) && !('body' in domain))).toBe(true);
        expect(requests.filter(request => request.model === 'Artifact')).toEqual([]);
        const domainReads = requests.filter(request => request.model === 'DeploymentDomain');
        expect(domainReads).toHaveLength(1);
        expect(domainReads[0]).toMatchObject({ action: 'findMany', args: { where: { environmentId: created.environmentId, deletedAt: null } } });
        for (const field of ['take', 'skip', 'cursor']) expect(domainReads[0]?.args).not.toHaveProperty(field);
        expect(await inTx(tx => readDeploymentDomainInventoryInTx(tx, reader.id, readInput))).toMatchObject({ ok: true, domains: result.domains });
        expect(await inTx(tx => readDeploymentDomainInventoryInTx(tx, owner.id, { ...readInput, expectedRevision: linked.revision + 1 })))
            .toEqual({ ok: false, error: 'deployment_conflict' });
        expect(await inTx(tx => readDeploymentDomainInventoryInTx(tx, outsider.id, readInput)))
            .toEqual({ ok: false, error: 'deployment_unavailable' });
        expect(await inTx(tx => readDeploymentDomainInventoryInTx(tx, owner.id,
            { serverId, environmentId: empty.environmentId, expectedRevision: empty.revision })))
            .toEqual({ ok: true, environmentId: empty.environmentId, environmentRevision: empty.revision, domains: [], capturedMachineIds: [] });
        expect(await inTx(tx => readDeploymentDomainInventoryInTx(tx, owner.id,
            { serverId, environmentId: crypto.randomUUID(), expectedRevision: 1 })))
            .toEqual({ ok: false, error: 'deployment_unavailable' });
        await db.projectSource.update({ where: { id: source.source.id }, data: { audience: [] } });
        expect(await inTx(tx => readDeploymentDomainInventoryInTx(tx, reader.id, readInput)))
            .toEqual({ ok: false, error: 'deployment_unavailable' });
    });

    it.each([false, true])('admits same-confirm Domain retirement with the teardown capture and keeps the final live custody guard (removeEnvironment=%s)', async removeEnvironment => {
        const { createDeploymentInTx, transitionDeploymentInTx } = await import('./deploymentService');
        const { createDeploymentReceiptDetailV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Teardown Domain custody' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id,
            { serverId, requestKey: crypto.randomUUID(), name: 'Teardown Domain custody', audience: [], owner: { kind: 'team', teamId: team.id } }));
        if (!source.ok) throw new Error(source.error);
        const keys = nacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, ...plainMachineContent,
            installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey) } });
        await db.machineTeamGrant.create({ data: { machineId: machine.id, teamId: team.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        const artifactFor = async (kind: string, body: unknown = {}) => {
            const artifact = await createArtifact({ actorUserId: custodian.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Domain custody' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(body) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!artifact.ok) throw new Error(artifact.error);
            await db.artifactTeamGrant.create({ data: { artifactId: artifact.artifact.id, teamId: team.id,
                accessLevel: 'admin', createdByAccountId: custodian.id } });
            return { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const environmentRef = await artifactFor('deployment-environment.v1');
        const linkRef = await artifactFor('deployment-target-link.v1');
        const domainRef = await artifactFor('deployment-domain.v1');
        const historicalEnvironmentRef = await artifactFor('deployment-environment.v1');
        const historicalLinkRef = await artifactFor('deployment-target-link.v1');
        const seedEnvironment = async () => {
            const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
                createdByAccountId: owner.id, controllerMachineId: machine.id, protection: 'nonProduction', purpose: 'standard',
                deployerMode: 'managers', ...environmentRef } });
            const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
                createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
                targetKind: 'ownServer', state: 'configured', ...linkRef,
                machines: { create: [{ machineId: machine.id, installationId: machine.installationId!, position: 0, state: 'active' }] } } });
            await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
            return { environment, link };
        };
        const { environment, link } = await seedEnvironment();
        const unrelated = await seedEnvironment();
        const predecessorRef = await artifactFor('deployment-target-link.v1');
        const predecessor = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'configured', detachedAt: new Date(), ...predecessorRef,
            machines: { create: [{ machineId: machine.id, installationId: machine.installationId!, position: 0, state: 'active' }] } } });
        const insertDomain = async (environmentId: string, targetLinkId: string, state: string) => {
            const id = crypto.randomUUID();
            await db.$executeRawUnsafe('INSERT INTO "DeploymentDomain" ("id","environmentId","targetLinkId","state","contentArtifactId","contentHeaderVersion","contentBodyVersion","createdByAccountId","updatedAt") VALUES (?, ?, ?, ?, ?, 1, 1, ?, CURRENT_TIMESTAMP)',
                id, environmentId, targetLinkId, state, domainRef.contentArtifactId, owner.id);
            await db.deploymentDomain.update({ where: { id }, data: { capturedPlacements: [{ desired: state !== 'removing',
                listener: 'privateOrigin', dockerEngineId: 'engine', content: domainRef,
                ...(targetLinkId === predecessor.id ? {} : {
                    environmentContent: historicalEnvironmentRef, targetLinkContent: historicalLinkRef }),
                installationPublicKey: privacyKit.encodeBase64(keys.publicKey, 'base64url'),
                placement: { serverId, accountId: owner.id, environmentId, targetLinkId, domainId: id,
                    machineId: machine.id, installationId: machine.installationId!, nativeServer: 'private',
                    actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID() } }] } });
            return id;
        };
        const activeId = await insertDomain(environment.id, link.id, 'active');
        const removingId = await insertDomain(environment.id, predecessor.id, 'removing');
        await insertDomain(unrelated.environment.id, unrelated.link.id, 'active');
        // Empty caller-authored resources are intentionally not authority.
        const content = createDeploymentReceiptDetailV1().content;
        const receiptRef = await artifactFor('deployment-receipt.v1', { ...content, teardown: { reason: 'manual',
            targetLinkRevision: link.revision, machines: [{ machineId: machine.id, installationId: machine.installationId! }],
            resources: [], proofs: [] } });
        const input = { serverId, environmentId: environment.id, expectedRevision: environment.revision,
            targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: crypto.randomUUID(),
            actionOperationId: crypto.randomUUID(), reason: 'manual' as const, ...(removeEnvironment ? { removeEnvironment: true as const } : {}), ...receiptRef };
        const target = { kind: 'machine' as const, machineId: machine.id };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: owner.id, authentication: { kind: 'account', tokenEpoch: owner.tokenEpoch },
            actionId: 'deployments.teardown', machineId: machine.id, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const binding = authorization.binding;
        const signedGet = async (path: string, actionId: string) => {
            const result: { response?: { status: number; body: unknown } } = {};
            await withAuthenticatedTestApp(app => { registerDeploymentRoutes(app); artifactsRoutes(app); }, async app => {
                const response = await app.inject({ method: 'GET', url: path, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, effectActionId: actionId, target,
                        installationId: machine.installationId!, requestId: binding.requestId,
                        method: 'GET', path, body: undefined, privateKey: keys.secretKey }),
                } });
                result.response = { status: response.statusCode, body: response.json() };
            }, { authentication: 'real' });
            if (!result.response) throw new Error('Expected signed Domain metadata response');
            return result.response;
        };
        const readDomains = (environmentId: string, domainId?: string) => {
            const actionId = domainId ? 'deployments.domains.get' : 'deployments.domains.list';
            const spec = getActionSpec(actionId);
            if (!spec.serverTransport) throw new Error('Expected Domain metadata transport');
            const bound = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema,
                input: { serverId, environmentId, ...(domainId ? { domainId } : {}) } });
            return signedGet(bound.path, actionId);
        };
        const begin = () => inTx(tx => createDeploymentInTx(tx, owner.id, input, 'teardown', {}, binding));
        const domainRefusal = { ok: false, error: 'unsupported_action', errorCode: 'unsupported_action', effectAttempted: false,
            details: { reason: 'retained_domain_custody', remedy: "Remove this Environment's Domains first, then tear down" },
            failureCause: { phase: 'deployment.teardown.admission', errorClass: 'Error', errorCode: null, httpStatus: null } };
        expect(await readDomains(environment.id)).toMatchObject({ status: 200,
            body: { ok: true, domains: expect.arrayContaining([expect.objectContaining({ id: activeId, state: 'active' })]) } });
        expect(await readDomains(environment.id, activeId)).toMatchObject({ status: 200,
            body: { ok: true, domain: { id: activeId, state: 'active' } } });
        expect((await readDomains(unrelated.environment.id)).status).toBe(401);
        for (const reference of [domainRef, environmentRef, linkRef, predecessorRef, historicalEnvironmentRef, historicalLinkRef]) {
            expect(await signedGet(`/v1/artifacts/${reference.contentArtifactId}`, 'deployments.teardown')).toMatchObject({ status: 200 });
        }
        if (removeEnvironment) {
            // A deployer may Stop, but the existing manager permission owns Environment removal.
            await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: owner.id } }, data: { role: 'member' } });
            await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { deployerMode: 'members' } });
            expect(await begin()).toEqual({ ok: false, error: 'deployment_access_denied' });
            await db.teamMembership.update({ where: { teamId_accountId: { teamId: team.id, accountId: owner.id } }, data: { role: 'owner' } });
            await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { deployerMode: 'managers' } });
            const dependent = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
                createdByAccountId: owner.id, role: 'data', sourceKind: 'plugin', pluginId: 'example.deploy',
                contributionLocalId: 'db', targetKind: 'database', state: 'provisioned', ...linkRef } });
            expect(await begin()).toEqual({ ok: false, error: 'deployment_teardown_required' });
            expect((await db.deploymentDomain.findUniqueOrThrow({ where: { id: activeId } })).state).toBe('active');
            // A configured, resource-free data association follows the existing delete proof rule.
            await db.deploymentTargetLink.update({ where: { id: dependent.id }, data: { state: 'configured' } });
        }
        const admitted = await begin();
        expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true, state: 'queued' });
        if (!admitted.ok || !('deploymentId' in admitted)) throw new Error('Expected captured Domain teardown admission');
        await db.teamMembership.delete({ where: { teamId_accountId: { teamId: team.id, accountId: owner.id } } });
        const { projectDeploymentDomainHeader, readAcceptedDeploymentDomainInTx } = await import('./deploymentDomainService');
        for (const domainId of [activeId, removingId]) {
            const row = await db.deploymentDomain.findUniqueOrThrow({ where: { id: domainId } });
            const header = projectDeploymentDomainHeader(row);
            expect(header).toMatchObject({ state: 'removing', revision: 2,
                operationAddress: { operationId: input.actionOperationId, machineId: machine.id },
                placements: [{ desired: false, environmentContent: domainId === removingId ? environmentRef : historicalEnvironmentRef,
                    targetLinkContent: domainId === removingId ? predecessorRef : historicalLinkRef,
                    placement: { actionOperationId: input.actionOperationId,
                        requestId: binding.requestId } }] });
            const job = { environmentId: environment.id, domainId, expectedDomainRevision: header.revision,
                actionOperationId: input.actionOperationId, capture: header.placements[0]! };
            expect(await inTx(tx => readAcceptedDeploymentDomainInTx(tx, binding, job))).not.toBeNull();
            expect(await inTx(tx => readAcceptedDeploymentDomainInTx(tx, binding,
                { ...job, actionOperationId: crypto.randomUUID() }))).toBeNull();
            expect(await inTx(tx => readAcceptedDeploymentDomainInTx(tx, binding,
                { ...job, capture: { ...job.capture, dockerEngineId: 'another-engine' } }))).toBeNull();
            expect(await inTx(tx => readAcceptedDeploymentDomainInTx(tx,
                { ...binding, requestEnvelopeDigest: 'another-envelope' }, job))).toBeNull();
        }
        expect(await readDomains(environment.id)).toMatchObject({ status: 200,
            body: { ok: true, domains: expect.arrayContaining([expect.objectContaining({ id: activeId, state: 'removing' })]) } });
        expect(await readDomains(environment.id, activeId)).toMatchObject({ status: 200,
            body: { ok: true, domain: { id: activeId, state: 'removing' } } });
        expect((await readDomains(unrelated.environment.id)).status).toBe(401);
        for (const reference of [domainRef, environmentRef, predecessorRef, historicalEnvironmentRef, historicalLinkRef]) {
            expect(await signedGet(`/v1/artifacts/${reference.contentArtifactId}`, 'deployments.teardown')).toMatchObject({ status: 200 });
        }
        const unrelatedReference = await artifactFor('deployment-domain.v1');
        expect(await signedGet(`/v1/artifacts/${unrelatedReference.contentArtifactId}`, 'deployments.teardown')).toMatchObject({ status: 404 });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
        const transition = async (state: 'running' | 'failed' | 'outcome_unknown' | 'succeeded') => {
            const row = await db.deployment.findUniqueOrThrow({ where: { id: admitted.deploymentId } });
            const body: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId, environmentId: environment.id,
                deploymentId: row.id, expectedRevision: row.revision, actionOperationId: row.actionOperationId,
                machineId: machine.id, installationId: machine.installationId!, kind: state === 'running' ? 'stage' : 'settle', state,
                ...(state === 'succeeded' ? { teardownProof: { targetLinkRevision: link.revision,
                    machines: [{ machineId: machine.id, installationId: machine.installationId! }], workloadAbsent: true,
                    retainedProviderResource: false,
                    steps: ['admit', 'settleDeploy', 'removeTarget', 'removeDomain', 'removeRelease', 'withdrawBindings', 'verify'] } } : {}) };
            const proof = signMachineInstallationProof({ payload: { version: 1, machineId: machine.id,
                installationId: machine.installationId!, accountId: owner.id, deploymentTransition: { serverId,
                    environmentId: environment.id, deploymentId: row.id, actionOperationId: row.actionOperationId,
                    expectedRevision: row.revision, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, privateKey: keys.secretKey });
            return inTx(tx => transitionDeploymentInTx(tx, owner.id, { ...body, proof }));
        };
        const expectRefusedStart = async (expectedState: 'queued' | 'failed') => {
            const beforeStart = await db.deployment.findUniqueOrThrow({ where: { id: admitted.deploymentId } });
            expect(beforeStart.state).toBe(expectedState);
            const beforeLink = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } });
            const beforeSequence = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
            expect(await transition('running')).toEqual(domainRefusal);
            expect(await db.deployment.findUniqueOrThrow({ where: { id: admitted.deploymentId } })).toEqual(beforeStart);
            expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } })).toEqual(beforeLink);
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(beforeSequence);
        };
        // Starting the accepted teardown may run its admitted Domain removal;
        // completion must still wait for installation-signed Domain settlement.
        expect(await transition('running')).toMatchObject({ ok: true, state: 'running' });
        expect(await transition('succeeded')).toEqual({ ok: false, error: 'deployment_conflict' });
        expect(await transition('failed')).toMatchObject({ ok: true, state: 'failed' });
        expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } })).deletedAt).toBeNull();
        await db.$executeRawUnsafe('UPDATE "DeploymentDomain" SET "deletedAt"=CURRENT_TIMESTAMP WHERE "id" IN (?, ?)', activeId, removingId);
        // This live retained Domain arrives after receipt admission but before
        // the first native stage. Removing the running guard must fail here.
        const queuedDomainId = await insertDomain(environment.id, predecessor.id, 'removing');
        await expectRefusedStart('failed');
        await db.$executeRawUnsafe('UPDATE "DeploymentDomain" SET "deletedAt"=CURRENT_TIMESTAMP WHERE "id"=?', queuedDomainId);
        expect(await transition('running')).toMatchObject({ ok: true, state: 'running' });
        expect(await transition('failed')).toMatchObject({ ok: true, state: 'failed' });
        // The same canonical receipt can resume from failed. A Domain added
        // while it was settled must refuse that new native stage as well.
        const failedDomainId = await insertDomain(environment.id, link.id, 'active');
        await expectRefusedStart('failed');
        await db.$executeRawUnsafe('UPDATE "DeploymentDomain" SET "deletedAt"=CURRENT_TIMESTAMP WHERE "id"=?', failedDomainId);
        expect(await transition('running')).toMatchObject({ ok: true, state: 'running' });
        // Explicit Retry continues the same admitted receipt after an unproved
        // native removal. Its captured disposition and signed writer stay intact.
        expect(await transition('outcome_unknown')).toMatchObject({ ok: true, state: 'outcome_unknown' });
        expect(await begin()).toMatchObject({ ok: true, deploymentId: admitted.deploymentId, state: 'outcome_unknown' });
        expect(await transition('running')).toMatchObject({ ok: true, deploymentId: admitted.deploymentId, state: 'running' });
        // A late persisted Domain changes no Environment revision. This tests
        // the final current-inventory read, not a future add-writer race proof.
        const lateId = await insertDomain(environment.id, predecessor.id, 'removing');
        const receiptBefore = await db.deployment.findUniqueOrThrow({ where: { id: admitted.deploymentId } });
        const linkBefore = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } });
        const sequenceBefore = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
        expect(await begin()).toMatchObject({ ok: true, deploymentId: admitted.deploymentId, state: 'running' });
        expect(await transition('succeeded')).toEqual({ ok: false, error: 'deployment_conflict' });
        expect(await db.deployment.findUniqueOrThrow({ where: { id: admitted.deploymentId } })).toEqual(receiptBefore);
        expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } })).toEqual(linkBefore);
        expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(sequenceBefore);
        await db.$executeRawUnsafe('UPDATE "DeploymentDomain" SET "deletedAt"=CURRENT_TIMESTAMP WHERE "id"=?', lateId);
        // Excalidraw eb815b48: successful Stop and remove must not leave Nothing deployed yet.
        await db.teamMembership.delete({ where: { teamId_accountId: { teamId: team.id, accountId: owner.id } } });
        const completed = await transition('succeeded');
        expect(completed).toMatchObject({ ok: true, state: 'succeeded' });
        const removed = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.id } });
        const removedLink = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id } });
        if (removeEnvironment) {
            expect(removed.deletedAt).not.toBeNull();
            expect(removedLink.deletedAt).not.toBeNull();
            expect(completed).toMatchObject({ environmentRemoved: true });
        } else {
            expect(removed.deletedAt).toBeNull();
            expect(removedLink.deletedAt).toBeNull();
            expect(completed).not.toHaveProperty('environmentRemoved');
        }
        const sequenceAfter = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
        expect(await transition('succeeded')).toEqual(completed);
        expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(sequenceAfter);
    });

    it('creates the first own-server link atomically with Environment creation and replays one intent', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'One Add', audience: [],
        }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            ...plainMachineContent, installationId: crypto.randomUUID(), active: true } });
        const artifactFor = async (kind: string, body: unknown) => {
            const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'One Add' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(body) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!artifact.ok) throw new Error(artifact.error);
            return { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const environmentContent = await artifactFor('deployment-environment.v1', {
            name: 'One Add', retainPreviousDeployments: 1, bindings: [],
            definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } },
        });
        const linkContent = await artifactFor('deployment-target-link.v1', {});
        const input = { ...environmentContent, serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(),
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.id,
            firstTargetLink: { ...linkContent, machines: [{ machineId: machine.id, installationId: machine.installationId! }] } };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const create = (payload: typeof input) => app.inject({ method: 'POST', url: '/v1/deployments/environments',
                headers: { 'x-test-user-id': owner.id }, payload });
            // Authored Action intent belongs to the receiving host, never Home's prepared storage endpoint.
            const authored = DeploymentActionInputSchemasV1['deployments.environments.create'].parse({
                serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(), name: 'Unprepared app',
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: machine.id, definition: { from: 'image', image: 'nginx:1', port: 80 },
            });
            const initialArtifactCount = await db.artifact.count();
            const initialSequence = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
            const unprepared = await app.inject({ method: 'POST', url: '/v1/deployments/environments',
                headers: { 'x-test-user-id': owner.id }, payload: authored });
            expect(unprepared.statusCode, unprepared.body).toBe(400);
            expect(unprepared.json()).toEqual({ ok: false, error: 'deployment_invalid' });
            expect(await db.deploymentEnvironment.count({ where: { projectSourceId: source.source.id } })).toBe(0);
            expect(await db.artifact.count()).toBe(initialArtifactCount);
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(initialSequence);
            const created = await create(input);
            expect(created.statusCode, created.body).toBe(200);
            const result = DeploymentEnvironmentCreateResultV1Schema.parse(created.json());
            expect(result).toMatchObject({ ok: true, revision: 2 });
            if (!result.ok) throw new Error(result.error);
            const row = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: result.environmentId } });
            expect(row.runtimeTargetLinkId).toBeTruthy();
            expect(await inTx(tx => readDeploymentTargetInTx(tx, row.id, row.runtimeTargetLinkId!)))
                .toMatchObject({ source: { kind: 'host', id: 'own-server' }, machines: [machine.id],
                    contentArtifactId: linkContent.contentArtifactId });
            const seq = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
            expect((await create(input)).json()).toEqual(result);
            expect(await db.deploymentTargetLink.count({ where: { environmentId: row.id } })).toBe(1);
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(seq);
            const changedIntent = await create({ ...input, firstTargetLink: { ...input.firstTargetLink,
                machines: [{ machineId: machine.id, installationId: crypto.randomUUID() }],
            } });
            expect(changedIntent.json()).toMatchObject({ ok: false, error: 'deployment_conflict' });
            const refused = await create({ ...input, requestKey: crypto.randomUUID(), firstTargetLink: {
                ...input.firstTargetLink, machines: [{ machineId: machine.id, installationId: crypto.randomUUID() }],
            } });
            expect(refused.json()).toMatchObject({ ok: false, error: 'machine_unavailable', role: 'target' });
            expect(await db.deploymentEnvironment.count({ where: { projectSourceId: source.source.id } })).toBe(1);
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(seq);
        });
    });

    it('keeps template metadata behind its owning CAS without changing Compose or bindings', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Template metadata', audience: [],
        }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            ...plainMachineContent, installationId: crypto.randomUUID() } });
        const document = '{"services":{"app":{"image":"app:1"}}}';
        const definition = { kind: 'stored' as const, contentRevision: 1,
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`, document, profiles: [], services: ['app'] };
        const initial = DeploymentEnvironmentContentV1Schema.parse({ name: 'App', retainPreviousDeployments: 1, definition, bindings: [] });
        const artifactFor = async (body: unknown) => {
            const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'App' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(body) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!artifact.ok) throw new Error(artifact.error);
            return { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const original = await artifactFor(initial);
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, { ...original, serverId,
            projectSourceId: source.source.id, requestKey: crypto.randomUUID(), protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', controllerMachineId: machine.id }));
        if (!created.ok) throw new Error(created.error);
        const template = { templateRef: { sourceId: 'data', itemId: 'postgres', version: '1', ref: { kind: 'content', digest: `sha256:${'c'.repeat(64)}` } },
            definition: { kind: 'stored', contentRevision: 1, composeDigest: definition.composeDigest }, services: ['db'] };
        const candidate = await artifactFor({ ...initial, template });
        const input = { ...candidate, serverId, environmentId: created.environmentId, expectedRevision: 1 };
        expect(await inTx(tx => environmentService.updateDeploymentEnvironmentInTx(tx, owner.id, input)))
            .toEqual({ ok: false, error: 'deployment_conflict' });
        expect(await inTx(tx => environmentService.setDeploymentEnvironmentTemplateInTx(tx, owner.id, { ...input, expectedRevision: 2 })))
            .toEqual({ ok: false, error: 'deployment_conflict' });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const response = await app.inject({ method: 'POST', url: `/v1/deployments/environments/${created.environmentId}/template`,
                headers: { 'x-test-user-id': owner.id }, payload: input });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ ok: true, environmentId: created.environmentId, revision: 2 });
        });
        const sequence = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
        expect(await inTx(tx => environmentService.setDeploymentEnvironmentTemplateInTx(tx, owner.id, { ...input, expectedRevision: 2 })))
            .toEqual({ ok: true, environmentId: created.environmentId, revision: 2 });
        expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(sequence);
        const foreign = await artifactFor({ ...initial, template, name: 'another-writer' });
        expect(await inTx(tx => environmentService.setDeploymentEnvironmentTemplateInTx(tx, owner.id,
            { ...input, ...foreign, expectedRevision: 2 }))).toEqual({ ok: false, error: 'deployment_conflict' });
        const nextDocument = '{"services":{"app":{"image":"app:2"}}}';
        const composeEdit = await artifactFor({ ...initial, definition: { ...definition, contentRevision: 2,
            document: nextDocument, composeDigest: `sha256:${createHash('sha256').update(nextDocument).digest('hex')}` }, template });
        expect(await inTx(tx => environmentService.setDeploymentEnvironmentTemplateInTx(tx, owner.id,
            { ...input, ...composeEdit, expectedRevision: 2 }))).toEqual({ ok: false, error: 'deployment_conflict' });
        expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.environmentId } }))
            .toMatchObject({ ...candidate, revision: 2 });
        const invalidProvenance = await artifactFor({ ...initial, template: { ...template,
            definition: { ...template.definition, contentRevision: 2 } } });
        expect(await inTx(tx => environmentService.setDeploymentEnvironmentTemplateInTx(tx, owner.id,
            { ...input, ...invalidProvenance, expectedRevision: 2 }))).toEqual({ ok: false, error: 'deployment_conflict' });
        // A later ordinary Compose edit preserves the applied template baseline rather than acquiring its writer.
        expect(await inTx(tx => environmentService.updateDeploymentEnvironmentInTx(tx, owner.id,
            { ...input, ...composeEdit, expectedRevision: 2 }))).toEqual({ ok: true, environmentId: created.environmentId, revision: 3 });
        expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.environmentId } }))
            .toMatchObject({ ...composeEdit, revision: 3 });
    });

    it.each(['plain', 'e2ee'] as const)('admits backup-only %s content through its owning Environment CAS', async mode => {
        const keys = nacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(keys.publicKey) : {}) } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: reader.id, status: 'friend' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Backup CAS',
            audience: [{ principal: { kind: 'account', accountId: reader.id }, level: 'view' }],
        }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            ...(mode === 'plain' ? plainMachineContent : { metadata: '{}' }), installationId: crypto.randomUUID() } });
        const resourceKey = nacl.randomBytes(32);
        const seal = async (value: unknown) => mode === 'plain'
            ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value))
            : new Uint8Array(await sealSessionDataKeyBundleV0(value, resourceKey));
        const artifactFor = async (content: unknown) => {
            const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                kind: 'v1:other:deployment-environment.v1', header: await seal({ kind: 'deployment-environment.v1', title: 'Backup CAS' }),
                body: await seal({ body: JSON.stringify(content) }),
                dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)
                    : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: resourceKey,
                        recipientPublicKey: keys.publicKey, randomBytes: nacl.randomBytes })) });
            if (!artifact.ok) throw new Error(artifact.error);
            return { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const document = '{"services":{"app":{"image":"app:1"}}}';
        const composeDigest = `sha256:${createHash('sha256').update(document).digest('hex')}`;
        const initial = DeploymentEnvironmentContentV1Schema.parse({ name: 'Backup CAS', retainPreviousDeployments: 1, bindings: [],
            definition: { kind: 'stored', contentRevision: 1, document, profiles: [], services: ['app'],
                composeDigest } });
        const original = await artifactFor(initial);
        const createInput = { ...original, serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(),
            protection: 'nonProduction' as const, purpose: 'standard' as const, deployerMode: 'managers' as const,
            controllerMachineId: machine.id };
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, createInput));
        if (!created.ok) throw new Error(created.error);
        const configured = DeploymentEnvironmentContentV1Schema.parse({ ...initial, backup: { notNeeded: true } });
        const candidate = await artifactFor(configured);
        const input = { ...candidate, serverId, environmentId: created.environmentId, expectedRevision: 1 };
        if (mode === 'plain') {
            expect(await inTx(tx => environmentService.updateDeploymentEnvironmentInTx(tx, owner.id, input)))
                .toEqual({ ok: false, error: 'deployment_conflict' });
            expect(await inTx(tx => environmentService.setDeploymentEnvironmentBindingsInTx(tx, owner.id,
                { ...input, grants: [], referencedSavedSecretRevisions: [] })))
                .toEqual({ ok: false, error: 'deployment_conflict' });
            const template = await artifactFor({ ...configured, template: {
                templateRef: { sourceId: 'data', itemId: 'app', version: '1', ref: { kind: 'version', version: '1' } },
                definition: { kind: 'stored', contentRevision: 1, composeDigest }, services: ['app'],
            } });
            expect(await inTx(tx => environmentService.setDeploymentEnvironmentTemplateInTx(tx, owner.id, { ...input, ...template })))
                .toEqual({ ok: false, error: 'deployment_conflict' });
            expect(await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id,
                { ...createInput, ...candidate, requestKey: crypto.randomUUID() })))
                .toEqual({ ok: false, error: 'deployment_conflict' });
        }
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const path = `/v1/deployments/environments/${created.environmentId}/backup`;
            const refused = await app.inject({ method: 'POST', url: path,
                headers: { 'x-test-user-id': reader.id }, payload: input });
            expect(refused.statusCode, refused.body).toBe(403);
            const stale = await app.inject({ method: 'POST', url: path,
                headers: { 'x-test-user-id': owner.id }, payload: { ...input, expectedRevision: 2 } });
            expect(stale.statusCode, stale.body).toBe(409);
            const response = await app.inject({ method: 'POST', url: path,
                headers: { 'x-test-user-id': owner.id }, payload: input });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ ok: true, environmentId: created.environmentId, revision: 2 });
            const copy = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, { ...createInput,
                requestKey: crypto.randomUUID(),
                copyIntentCommitment: createHash('sha256').update('backup-independent-copy-fixture').digest('base64url'),
                copyFrom: { environmentId: created.environmentId, expectedRevision: 2 } }));
            expect(copy.ok).toBe(true);
            if (!copy.ok) throw new Error(copy.error);
            const child = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: copy.environmentId } });
            const childContent = await inTx(tx => readPlainDeploymentEnvironmentContentInTx(tx, owner.id,
                { kind: 'account', accountId: owner.id }, child));
            expect(childContent.ok).toBe(true);
            if (mode === 'plain' && childContent.ok) expect(childContent.content).not.toHaveProperty('backup');
            if (mode === 'plain') {
                const unrelated = await artifactFor({ ...configured, name: 'Not the backup writer' });
                const foreign = await app.inject({ method: 'POST', url: path, headers: { 'x-test-user-id': owner.id },
                    payload: { ...input, ...unrelated, expectedRevision: 2 } });
                expect(foreign.statusCode, foreign.body).toBe(409);
                const ordinary = await artifactFor({ ...configured, name: 'Ordinary edit preserves backup' });
                expect(await inTx(tx => environmentService.updateDeploymentEnvironmentInTx(tx, owner.id,
                    { ...input, ...ordinary, expectedRevision: 2 })))
                    .toEqual({ ok: true, environmentId: created.environmentId, revision: 3 });
            }
        });
        const before = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.environmentId } });
        const overwritten = await updateArtifact({ actorUserId: owner.id, artifactId: before.contentArtifactId,
            body: { bytes: await seal({ body: JSON.stringify(initial) }), expectedVersion: before.contentBodyVersion } });
        expect(overwritten.ok).toBe(true);
        // A generic Artifact head update never advances the reserved Environment pointer or its CAS revision.
        expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: created.environmentId } })).toEqual(before);
        expect(await inTx(tx => readPlainDeploymentEnvironmentContentInTx(tx, owner.id, { kind: 'account', accountId: owner.id }, before)))
            .toEqual({ ok: false, error: 'deployment_conflict' });
    });

    it('admits ID-only backup recovery to the native restore owner without mutating its captured content', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Recovery boundary', audience: [],
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'acme/recovery', cloneUrl: 'https://github.com/acme/recovery.git' }, protocol: 'https' },
        }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            metadata: '{}', installationId: crypto.randomUUID(), active: true } });
        const content = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-receipt.v1', title: 'Recovery' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ snapshot: 'exact-retained-release' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!content.ok) throw new Error(content.error);
        const reference = { contentArtifactId: content.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        // Persisted rows are the fixture boundary; the rollback route performs
        // real Home/Source/Machine/Artifact admission and reservation below.
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: owner.id, protection: 'production', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: machine.id, buildMachineId: machine.id, ...reference } });
        const target = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'deployed', ...reference,
            machines: { create: [{ machineId: machine.id, installationId: machine.installationId!, position: 0, state: 'active' }] } } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: target.id } });
        const retained = await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: target.id,
            operation: 'deploy', state: 'succeeded', requestKey: crypto.randomUUID(), requestedByAccountId: owner.id,
            actionOperationId: crypto.randomUUID(), ...reference } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            let writes = 0;
            const stop = observeSqliteRequests({ before: request => {
                if (['Deployment', 'DeploymentEnvironment', 'Artifact'].includes(request.model ?? '')
                    && ['create', 'update', 'updateMany', 'delete', 'deleteMany'].includes(request.action)) writes++;
            } });
            try {
                const response = await app.inject({ method: 'POST',
                    url: `/v1/deployments/environments/${environment.id}/rollback`, headers: { 'x-test-user-id': owner.id }, payload: {
                        serverId, environmentId: environment.id, expectedRevision: environment.revision,
                        targetLinkId: target.id, expectedTargetLinkRevision: target.revision,
                        deploymentId: retained.id, requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(),
                        restoreBackupId: 'pre-migration-backup', ...reference,
                    } });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({ ok: true, state: 'queued' });
                expect(writes).toBeGreaterThan(0);
                expect((await db.artifact.findUniqueOrThrow({ where: { id: reference.contentArtifactId } })).bodyVersion).toBe(1);
            } finally { stop(); }
        });
    });

    it.each(['plain', 'e2ee'] as const)('saves %s protection through the existing Action and manager CAS without eligibility scans or equal-write publications', async mode => {
        const keys = nacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(keys.publicKey) : {}) } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, reader.id);
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Protection edit',
            audience: [{ principal: { kind: 'account', accountId: reader.id }, level: 'view' }],
        }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            ...(mode === 'plain' ? plainMachineContent : { metadata: '{}' }), installationId: crypto.randomUUID() } });
        const document = '{"services":{"app":{"image":"app:1"}}}';
        const definition = { kind: 'stored' as const, contentRevision: 1, document, profiles: [], services: ['app'],
            composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}` };
        const resourceKey = nacl.randomBytes(32);
        const seal = async (value: unknown) => mode === 'plain'
            ? privacyKit.decodeBase64(encodePlainArtifactStoredContent(value))
            : new Uint8Array(await sealSessionDataKeyBundleV0(value, resourceKey));
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            kind: 'v1:other:deployment-environment.v1',
            header: await seal({ kind: 'deployment-environment.v1', title: 'Protection edit' }),
            body: await seal({ body: JSON.stringify({ name: 'Protection edit', retainPreviousDeployments: 1, definition, bindings: [] }) }),
            dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)
                : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: resourceKey,
                    recipientPublicKey: keys.publicKey, randomBytes: nacl.randomBytes })) });
        if (!artifact.ok) throw new Error(artifact.error);
        const artifactBefore = await db.artifact.findUniqueOrThrow({ where: { id: artifact.artifact.id } });
        const content = { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, { ...content, serverId,
            projectSourceId: source.source.id, requestKey: crypto.randomUUID(), protection: 'production', purpose: 'standard',
            deployerMode: 'managers', controllerMachineId: machine.id, buildMachineId: machine.id }));
        if (!created.ok) throw new Error(created.error);
        const environmentId = created.environmentId;
        const input = { ...content, serverId, environmentId, expectedRevision: created.revision,
            patch: { protection: 'nonProduction' as const } };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const url = `/v1/deployments/environments/${environmentId}`;
            const deploymentAction: NonNullable<ActionExecutorDeps['deploymentAction']> = async (actionId, value) => {
                const spec = getActionSpec(actionId);
                if (!spec.serverTransport) throw new Error('Expected existing storage route');
                const wire = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport,
                    inputSchema: DeploymentActionInputSchemasV1[actionId], input: value });
                const response = await app.inject({ method: wire.method, url: wire.path,
                    headers: { 'x-test-user-id': owner.id }, ...(wire.body ? { payload: wire.body } : {}) });
                return DeploymentActionOutputSchemasV1[actionId].parse(response.json());
            };
            const deps = { deploymentAction, resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(deploymentAction) } satisfies Partial<ActionExecutorDeps>;
            // This boundary invokes only deployment ports; real Action policy,
            // HTTP binding, route, Source admission and SQLite storage remain intact.
            const executor = createActionExecutor(deps as ActionExecutorDeps);
            const context = { surface: 'ui' as const, authority: 'present_user' as const,
                actionCaller: { kind: 'host' as const }, serverId };
            const denied = await app.inject({ method: 'PATCH', url, headers: { 'x-test-user-id': reader.id }, payload: input });
            expect(denied.statusCode).toBe(403);
            const wrongHome = await app.inject({ method: 'PATCH', url, headers: { 'x-test-user-id': owner.id },
                payload: { ...input, serverId: `srv_${'b'.repeat(32)}` } });
            expect(wrongHome.statusCode).toBe(404);
            const reads: { model?: string; action: string; args: unknown }[] = [];
            const stop = observeSqliteRequests({ before: request => { reads.push({ model: request.model, action: request.action, args: request.args }); } });
            const saved = await (async () => {
                try { return await executor.execute('deployments.environments.update', input, context); }
                finally { stop(); }
            })();
            expect(saved).toMatchObject({ ok: true, result: { ok: true, environmentId, revision: created.revision + 1 } });
            expect(reads.filter(query => query.model === 'DeploymentEnvironment' && ['findMany', 'count', 'aggregate'].includes(query.action)))
                .toEqual([]);
            // Ordinary scope admission reads this Environment's own links;
            // the downgrade must not inspect co-resident Environment eligibility.
            for (const query of reads.filter(query => query.model === 'DeploymentTargetLink')) {
                expect(query.args).toMatchObject({ where: { environmentId } });
            }
            const stored = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId } });
            expect(stored).toMatchObject({ protection: 'nonProduction', buildMachineId: machine.id,
                deployerMode: 'managers', ...content, revision: created.revision + 1 });
            expect(await db.artifact.findUniqueOrThrow({ where: { id: artifact.artifact.id } })).toEqual(artifactBefore);
            const seq = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
            const equal = await executor.execute('deployments.environments.update', { ...input, expectedRevision: stored.revision }, context);
            expect(equal).toMatchObject({ ok: true, result: { ok: true, revision: stored.revision } });
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(seq);
            expect((await app.inject({ method: 'PATCH', url, headers: { 'x-test-user-id': owner.id }, payload: input })).statusCode).toBe(409);
            const restored = await executor.execute('deployments.environments.update', { ...input, expectedRevision: stored.revision,
                patch: { protection: 'production' } }, context);
            expect(restored).toMatchObject({ ok: true, result: { ok: true, revision: stored.revision + 1 } });
            expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId } })).protection).toBe('production');
            expect(await inTx(tx => environmentService.setDeploymentEnvironmentTemplateInTx(tx, owner.id, {
                ...input, expectedRevision: stored.revision + 1 }))).toEqual({ ok: false, error: 'deployment_conflict' });
        });
    });

    it('changes future build placement through the manager update without moving a dispatched receipt or publishing equal input', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        await makeShareEligibleForTest(owner.id, reader.id);
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Build placement',
            audience: [{ principal: { kind: 'account', accountId: reader.id }, level: 'view' }],
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'owner/build', cloneUrl: 'https://github.com/owner/build.git' }, protocol: 'https' },
        }));
        if (!source.ok) throw new Error(source.error);
        const [first, next, foreign] = await Promise.all([owner.id, owner.id, outsider.id].map(accountId => db.machine.create({ data: {
            id: crypto.randomUUID(), accountId, ...plainMachineContent, installationId: crypto.randomUUID(), active: false,
        } })));
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Builder' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify({
                name: 'Builder', retainPreviousDeployments: 1, bindings: [],
                definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } },
            }) })), dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const content = { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
            ...content, serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(),
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            controllerMachineId: first.id, buildMachineId: first.id,
        }));
        if (!created.ok) throw new Error(created.error);
        const environmentId = created.environmentId;
        const link = await db.deploymentTargetLink.create({ data: { ...content, environmentId, createdByAccountId: owner.id,
            role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured' } });
        const receipt = await db.deployment.create({ data: { ...content, environmentId, targetLinkId: link.id,
            requestedByAccountId: owner.id, requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(),
            operation: 'deploy', state: 'running' } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const url = `/v1/deployments/environments/${environmentId}`;
            const input = { ...content, serverId, environmentId, expectedRevision: 1, patch: { buildMachineId: next.id } };
            const denied = await app.inject({ method: 'PATCH', url, headers: { 'x-test-user-id': reader.id }, payload: input });
            expect(denied.statusCode, denied.body).toBe(403);
            const unavailable = await app.inject({ method: 'PATCH', url, headers: { 'x-test-user-id': owner.id },
                payload: { ...input, patch: { buildMachineId: foreign.id } } });
            expect(unavailable.statusCode, unavailable.body).toBe(503);
            expect(unavailable.json()).toMatchObject({ ok: false, error: 'machine_unavailable', role: 'build',
                machineIds: [foreign.id], nextActions: ['start', 'chooseAnother'] });
            const accepted = await app.inject({ method: 'PATCH', url, headers: { 'x-test-user-id': owner.id }, payload: input });
            expect(accepted.statusCode, accepted.body).toBe(200);
            expect(accepted.json()).toEqual({ ok: true, environmentId, revision: 2 });
            expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId } }))
                .toMatchObject({ buildMachineId: next.id, controllerMachineId: first.id, ...content });
            expect(await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(receipt);
            const sequence = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
            const repeated = await app.inject({ method: 'PATCH', url, headers: { 'x-test-user-id': owner.id },
                payload: { ...input, expectedRevision: 2 } });
            expect(repeated.json()).toEqual(accepted.json());
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(sequence);
            expect(await db.deployment.count({ where: { environmentId } })).toBe(1);
        });
    });

    it('projects the current Team Source owner without borrowing creator Account authority', async () => {
        const creator = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Explicit workload owner' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: creator.id, role: 'owner' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, creator.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Team workload', audience: [], owner: { kind: 'team', teamId: team.id },
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'team/workload', cloneUrl: 'https://github.com/team/workload.git' }, protocol: 'https' },
        }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: creator.id,
            metadata: '{}', installationId: crypto.randomUUID() } });
        const artifact = await createArtifact({ actorUserId: creator.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Team workload' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        await db.artifactTeamGrant.create({ data: { artifactId: artifact.artifact.id, teamId: team.id,
            accessLevel: 'admin', createdByAccountId: creator.id } });
        const environment = await db.deploymentEnvironment.create({ data: {
            projectSourceId: source.source.id, createdByAccountId: creator.id, protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', controllerMachineId: machine.id,
            contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
        } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const response = await app.inject({ method: 'GET',
                url: `/v1/deployments/environments/${environment.id}?serverId=${serverId}`,
                headers: { 'x-test-user-id': creator.id } });
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ ok: true, environment: { owner: { kind: 'team', teamId: team.id } } });
        });
    });

    it('discloses exact Machine deployment custody without loading inventories or private bodies', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Private reference Source', audience: [],
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'private/references', cloneUrl: 'https://github.com/private/references.git' }, protocol: 'https' },
        }));
        if (!source.ok) throw new Error(source.error);
        const [machine, peer] = await Promise.all(['reference', 'peer'].map(async label => db.machine.create({ data: {
            id: `${label}-${crypto.randomUUID()}`, accountId: owner.id, ...plainMachineContent, installationId: crypto.randomUUID(),
        } })));
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Private Environment' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ sentinel: 'never-open-reference-body' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const content = { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const environment = await db.deploymentEnvironment.create({ data: {
            projectSourceId: source.source.id, createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard',
            deployerMode: 'managers', controllerMachineId: machine.id, buildMachineId: machine.id, edgeMachineId: machine.id, ...content,
        } });
        const targetArtifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-target-link.v1', title: 'Private target' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!targetArtifact.ok) throw new Error(targetArtifact.error);
        const target = await db.deploymentTargetLink.create({ data: {
            environmentId: environment.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'configured', createdByAccountId: owner.id,
            contentArtifactId: targetArtifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
            machines: { create: [peer, machine].map((member, position) => ({ machineId: member.id,
                installationId: member.installationId!, position, state: 'joining' })) },
        } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: target.id } });
        const domainId = crypto.randomUUID();
        await db.deploymentDomain.create({ data: { id: domainId, environmentId: environment.id,
            targetLinkId: target.id, state: 'active', createdByAccountId: owner.id, ...content,
            capturedPlacements: [machine, peer].map(member => ({ placement: { serverId, accountId: owner.id,
                environmentId: environment.id, targetLinkId: target.id, domainId, machineId: member.id,
                installationId: member.installationId!, nativeServer: 'private', actionOperationId: crypto.randomUUID(), requestId: crypto.randomUUID() },
                content, desired: true, listener: 'privateOrigin', installationPublicKey: privacyKit.encodeBase64(new Uint8Array(32)) })),
        } });
        expect(await inTx(tx => readDeploymentTargetsInTx(tx, environment.id))).toMatchObject([{
            machines: [peer.id, machine.id], members: [{ machineId: peer.id, state: 'joining' }, { machineId: machine.id, state: 'joining' }],
        }]);
        await db.deploymentEnvironment.createMany({ data: Array.from({ length: 1_000 }, () => ({
            id: crypto.randomUUID(), projectSourceId: source.source.id, createdByAccountId: owner.id,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: peer.id, ...content,
        })) });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const url = `/v1/deployments/machine-references?homeId=${serverId}&machineId=${machine.id}`;
            const queries: { model: string | undefined; action: string; args: unknown }[] = [];
            const stop = observeSqliteRequests({ before: request => { queries.push({ model: request.model, action: request.action, args: request.args }); } });
            try {
                const response = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': owner.id } });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({ homeId: serverId, machineId: machine.id, coverage: 'complete',
                    references: [{ kind: 'deployment_environment', id: environment.id, deploymentRoles: ['runtime', 'controller', 'build', 'edge'],
                        deploymentDomains: [{ environmentId: environment.id, targetLinkId: target.id, domainId,
                            machineId: machine.id, installationId: machine.installationId }] }], nextCursor: null });
                expect(response.body).not.toContain(peer.installationId);
                expect(response.body).not.toContain('never-open-reference-body');
                expect(response.body).not.toContain('Private');
                const environmentQueries = queries.filter(query => query.model === 'DeploymentEnvironment');
                expect(environmentQueries).toHaveLength(1);
                expect(environmentQueries[0]).toMatchObject({ action: 'findMany' });
                expect(queries.filter(query => query.model === 'Artifact')).toEqual([]);
            } finally { stop(); }
            expect((await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': outsider.id } })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: url.replace(serverId, `srv_${'b'.repeat(32)}`), headers: { 'x-test-user-id': owner.id } })).statusCode).toBe(404);
            await db.deploymentTargetLink.update({ where: { id: target.id }, data: { deletedAt: new Date() } });
            const retained = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': owner.id } });
            expect(retained.json()).toMatchObject({ references: [{ id: environment.id, deploymentRoles: ['retiring', 'controller', 'build', 'edge'] }] });
            await db.deploymentTargetLink.update({ where: { id: target.id }, data: { detachedAt: new Date() } });
            const detached = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': owner.id } });
            expect(detached.json()).toMatchObject({ references: [{ id: environment.id, deploymentRoles: ['detached', 'controller', 'build', 'edge'] }] });
            await db.deploymentTargetLinkMachine.delete({ where: { targetLinkId_machineId: { targetLinkId: target.id, machineId: machine.id } } });
            const separateRoles = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': owner.id } });
            expect(separateRoles.json()).toMatchObject({ references: [{ id: environment.id, deploymentRoles: ['controller', 'build', 'edge'] }] });
            await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { controllerMachineId: peer.id, buildMachineId: peer.id } });
            const edgeOnly = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': owner.id } });
            expect(edgeOnly.json()).toMatchObject({ references: [{ id: environment.id, deploymentRoles: ['edge'] }] });
            const sourceList = await app.inject({ method: 'GET',
                url: `/v1/deployments/environments?serverId=${serverId}&projectSourceId=${source.source.id}&machineId=${machine.id}`,
                headers: { 'x-test-user-id': owner.id } });
            expect(sourceList.statusCode, sourceList.body).toBe(200);
            expect(sourceList.json().items.map((row: { id: string }) => row.id)).toEqual([environment.id]);
            const machineListUrl = `/v1/deployments/environments?serverId=${serverId}&machineId=${machine.id}`;
            const machineListQueries: { model: string | undefined; action: string; args: unknown }[] = [];
            const stopMachineListQueries = observeSqliteRequests({ before: request => {
                machineListQueries.push({ model: request.model, action: request.action, args: request.args });
            } });
            const machineList = await (async () => {
                try { return await app.inject({ method: 'GET', url: machineListUrl, headers: { 'x-test-user-id': owner.id } }); }
                finally { stopMachineListQueries(); }
            })();
            expect(machineList.statusCode, machineList.body).toBe(200);
            expect(machineList.json()).toMatchObject({ coverage: 'complete', nextCursor: null });
            expect(machineList.json().items.map((row: { id: string }) => row.id)).toEqual([environment.id]);
            expect(machineListQueries.filter(query => query.model === 'DeploymentEnvironment')).toMatchObject([
                { action: 'findMany' },
            ]);
            expect(machineListQueries.filter(query => query.model === 'Artifact')).toEqual([]);
            expect(machineListQueries.filter(query => query.model === 'ProjectSource' && query.action === 'findUnique')).toHaveLength(1);
            expect((await app.inject({ method: 'GET', url: machineListUrl,
                headers: { 'x-test-user-id': outsider.id } })).statusCode).toBe(404);
            await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { controllerMachineId: machine.id, buildMachineId: machine.id } });
            await db.deploymentTargetLinkMachine.create({ data: { targetLinkId: target.id, machineId: machine.id,
                installationId: machine.installationId!, position: 1, state: 'active' } });
            const hidden = await inTx(tx => createProjectSourceInTx(tx, outsider.id, {
                serverId, requestKey: crypto.randomUUID(), name: 'Hidden source', audience: [], repository: source.source.repository,
            }));
            if (!hidden.ok) throw new Error(hidden.error);
            const hiddenEnvironment = await db.deploymentEnvironment.create({ data: {
                projectSourceId: hidden.source.id, createdByAccountId: outsider.id, protection: 'nonProduction', purpose: 'standard',
                deployerMode: 'managers', controllerMachineId: machine.id, ...content,
            } });
            const partial = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': owner.id } });
            expect(partial.json()).toMatchObject({ coverage: 'partial', references: [{ id: environment.id }] });
            expect(partial.body).not.toContain(hiddenEnvironment.id);
            expect(partial.body).not.toContain('Hidden');
            const partialMachineList = await app.inject({ method: 'GET', url: machineListUrl,
                headers: { 'x-test-user-id': owner.id } });
            expect(partialMachineList.statusCode, partialMachineList.body).toBe(200);
            expect(partialMachineList.json()).toMatchObject({ coverage: 'partial' });
            expect(partialMachineList.json().items.map((row: { id: string }) => row.id)).toEqual([environment.id]);
            expect(partialMachineList.body).not.toContain(hiddenEnvironment.id);
            expect(partialMachineList.body).not.toContain(hidden.source.id);
            const sibling = await db.deploymentEnvironment.create({ data: {
                projectSourceId: source.source.id, createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard',
                deployerMode: 'managers', controllerMachineId: machine.id, ...content,
            } });
            let sourceReads = 0;
            const stopSources = observeSqliteRequests({ before: request => {
                if (request.model === 'ProjectSource' && request.action === 'findUnique') sourceReads += 1;
            } });
            try {
                const grouped = await app.inject({ method: 'GET', url, headers: { 'x-test-user-id': owner.id } });
                expect(grouped.json().references.map((reference: { id: string }) => reference.id).sort()).toEqual([environment.id, sibling.id].sort());
                expect(sourceReads, 'one current admission per matching Source, independent of its Environment count').toBe(2);
            } finally { stopSources(); }
        });
        const members = await db.deploymentTargetLinkMachine.findMany({ where: { targetLinkId: target.id }, orderBy: { position: 'asc' } });
        expect(members.map(member => member.machineId)).toEqual([peer.id, machine.id]);
        await expect(db.deploymentTargetLinkMachine.create({ data: { targetLinkId: target.id, machineId: crypto.randomUUID(),
            installationId: 'foreign', position: 2, state: 'joining' } })).rejects.toThrow();
        await expect(db.deploymentTargetLinkMachine.update({ where: { targetLinkId_machineId: { targetLinkId: target.id, machineId: machine.id } },
            data: { position: 0 } })).rejects.toThrow();
        await expect(db.machine.delete({ where: { id: machine.id } })).rejects.toThrow();
    });

    // Activate with P41/P42's admitted candidate producer and the exact read route.
    it('resolves an exact candidate receipt through its current Environment authority without inventory reads', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Candidate receipt owner', audience: [],
            repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'acme/candidate', cloneUrl: 'https://github.com/acme/candidate.git' }, protocol: 'https' },
        }));
        if (!source.ok) throw new Error(source.error);
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: '{}', installationId: crypto.randomUUID() } });
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-receipt.v1', title: 'Candidate' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ privateCandidate: 'not-an-http-header' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const content = { contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        // Storage is the genuine boundary: fixtures establish the relational receipt
        // without requiring unrelated deployment mutation routes to be implemented.
        const environment = await db.deploymentEnvironment.create({ data: {
            projectSourceId: source.source.id, createdByAccountId: owner.id,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: machine.id, ...content,
        } });
        const target = await db.deploymentTargetLink.create({ data: {
            environmentId: environment.id, createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host',
            hostTargetId: 'own-server', targetKind: 'ownServer', state: 'configured', ...content,
        } });
        const receipt = await db.deployment.create({ data: {
            environmentId: environment.id, targetLinkId: target.id, requestedByAccountId: owner.id,
            operation: 'deploy', state: 'running', requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), ...content,
        } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id };
            const exact = `/v1/deployments/receipts/${receipt.id}?serverId=${serverId}`;
            const reads: string[] = [];
            const stop = observeSqliteRequests({ before: request => {
                if (request.model === 'Deployment') reads.push(request.action);
            } });
            try {
                const response = await app.inject({ method: 'GET', url: exact, headers });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({ ok: true, deployment: { id: receipt.id, environmentId: environment.id, ...content } });
                expect(response.body).not.toContain('not-an-http-header');
                expect(reads).toEqual(['findUnique']);
            } finally { stop(); }
            const legacy = await app.inject({ method: 'GET',
                url: `/v1/deployments/environments/${environment.id}/deployments/${receipt.id}?serverId=${serverId}`, headers });
            expect(legacy.statusCode, legacy.body).toBe(200);
            expect((await app.inject({ method: 'GET', url: `${exact}&environmentId=wrong-environment`, headers })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: exact.replace(serverId, `srv_${'b'.repeat(32)}`), headers })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: exact, headers: { 'x-test-user-id': outsider.id } })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: exact.replace(receipt.id, 'missing-receipt'), headers })).statusCode).toBe(404);
            expect((await app.inject({ method: 'GET', url: exact })).statusCode).toBe(401);
            expect((await app.inject({ method: 'GET', url: `${exact}&projectSourceId=forged`, headers })).statusCode).toBe(400);
            await updateArtifact({ actorUserId: owner.id, artifactId: content.contentArtifactId,
                body: { expectedVersion: 1, bytes: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ changed: true })) } });
            const stale = await app.inject({ method: 'GET', url: exact, headers });
            expect(stale.statusCode, stale.body).toBe(409);
            expect(stale.json()).toEqual({ ok: false, error: 'deployment_conflict' });
        });
    });

    it('admits a personal Source with no Team through the authenticated create route', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'S0 project', audience: [],
            repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'acme/app', cloneUrl: 'https://github.com/acme/app.git', visibility: 'private' }, protocol: 'https' },
        }));
        expect(source.ok).toBe(true);
        if (!source.ok) throw new Error(source.error);
        await db.machine.create({ data: { id: 'runtime', accountId: custodian.id, installationId: 'installation', ...plainMachineContent } });
        await db.machineAccountGrant.create({ data: { machineId: 'runtime', accountId: owner.id,
            accessLevel: 'view', createdByAccountId: custodian.id } });
        const content = await createArtifact({ actorUserId: owner.id, artifactId: 'environment-content',
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Environment' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify({
                name: 'Staging', retainPreviousDeployments: 1, bindings: [],
                definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } },
            }) })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        expect(content.ok).toBe(true);
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const requestKey = crypto.randomUUID();
            const create = () => app.inject({ method: 'POST', url: '/v1/deployments/environments',
                headers: { 'x-test-user-id': owner.id }, payload: {
                    serverId, projectSourceId: source.source.id, requestKey,
                    protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                    controllerMachineId: 'runtime', contentArtifactId: 'environment-content',
                    contentHeaderVersion: 1, contentBodyVersion: 1,
                } });
            const refused = await create();
            expect(refused.statusCode, refused.body).toBe(403);
            expect(refused.json()).toEqual({ ok: false, error: 'deployment_access_denied' });
            expect(await db.deploymentEnvironment.count({ where: { projectSourceId: source.source.id } })).toBe(0);
            await db.machineAccountGrant.updateMany({ where: { machineId: 'runtime', accountId: owner.id },
                data: { accessLevel: 'admin' } });
            const response = await create();
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ ok: true, environmentId: expect.any(String), revision: 1 });
        });
    });

    it('retains unchanged exact grants, rolls them back with the owning transaction and deletes withdrawn rows', async () => {
            const repository = await import('./environmentSecretGrantRepository.js').catch(() => null);
            expect(repository, 'binding CAS requires the subordinate installation grant repository').not.toBeNull();
            if (!repository) return;
            const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
            const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
                serverId, requestKey: crypto.randomUUID(), name: 'Grant owner', audience: [],
                repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                    repository: { nameWithOwner: 'acme/grants', cloneUrl: 'https://github.com/acme/grants.git' }, protocol: 'https' },
            }));
            if (!source.ok) throw new Error(source.error);
            const machineId = crypto.randomUUID();
            await db.machine.create({ data: { id: machineId, accountId: owner.id, installationId: 'installation',
                installationPublicKey: new Uint8Array(nacl.sign.keyPair().publicKey), ...plainMachineContent } });
            const artifactId = crypto.randomUUID();
            const content = await createArtifact({ actorUserId: owner.id, artifactId,
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Environment' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(DeploymentEnvironmentContentV1Schema.parse({
                    name: 'Grant Environment', retainPreviousDeployments: 1,
                    definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } }, bindings: [],
                })) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!content.ok) throw new Error(content.error);
            const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
                serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(),
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', controllerMachineId: machineId,
                contentArtifactId: artifactId, contentHeaderVersion: 1, contentBodyVersion: 1,
            }));
            if (!created.ok) throw new Error(created.error);
            const environmentId = created.environmentId;
            const resourceId = crypto.randomUUID();
            expect(await inTx(tx => createSavedSecretResourceInTx(tx, {
                accountId: owner.id, resourceId, displayName: 'S0 secret', kind: 'token', encryptionMode: 'plain',
                storedContent: { t: 'plain', v: { v: 1, name: 'S0 secret', kind: 'token', value: 'resource-boundary-sentinel' } },
            }))).toMatchObject({ ok: true });
            const grant: MachineSecretGrantV1 = { v: 1, kind: 'secret', machineId, installationId: 'installation',
                environmentId, resourceId, resourceRevision: 1, sealedContent: 'installation-ciphertext' };
            await inTx(tx => repository.syncEnvironmentSecretGrantsInTx(tx, { environmentId, grants: [grant] }));
            let writes = 0;
            const stopObserving = observeSqliteRequests({ before: request => {
                if (request.model === 'MachineSecretGrant' && !request.action.startsWith('find')) writes += 1;
            } });
            try {
                await inTx(async tx => {
                    await tx.deploymentEnvironment.update({ where: { id: environmentId }, data: { revision: { increment: 1 } } });
                    await repository.syncEnvironmentSecretGrantsInTx(tx, { environmentId, grants: [grant] });
                });
                expect(writes, 'unchanged exact grant subjects do not rewrite or reseal ciphertext').toBe(0);
            } finally { stopObserving(); }
            await expect(inTx(async tx => {
                await repository.syncEnvironmentSecretGrantsInTx(tx, { environmentId, grants: [{ ...grant, sealedContent: 'replacement-ciphertext' }] });
                throw new Error('owning CAS refused');
            })).rejects.toThrow('owning CAS refused');
            expect(await inTx(tx => repository.readEnvironmentMachineSecretGrantsInTx(tx, {
                environmentId, machineId, installationId: 'installation',
            }))).toEqual([grant]);
            const targetContent = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-target-link.v1', title: 'Runtime' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({})),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!targetContent.ok) throw new Error(targetContent.error);
            await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
                const headers = { 'x-test-user-id': owner.id };
                const base = `/v1/deployments/environments/${environmentId}`;
                const linked = await app.inject({ method: 'POST', url: `${base}/targets`, headers, payload: {
                    serverId, environmentId, expectedRevision: 2, requestKey: crypto.randomUUID(), targetId: 'own-server', role: 'runtime',
                    machines: [{ machineId, installationId: 'installation' }],
                    contentArtifactId: targetContent.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
                } });
                expect(linked.statusCode, linked.body).toBe(200);
                const boundContent = DeploymentEnvironmentContentV1Schema.parse({ name: 'Grant Environment', retainPreviousDeployments: 1,
                    definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } },
                    bindings: [{ purpose: 'variable', name: 'TOKEN', phase: 'runtime', source: {
                        kind: 'secret', ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1,
                    } }] });
                const nextContent = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                    header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Environment' })),
                    body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(boundContent) })),
                    dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
                if (!nextContent.ok) throw new Error(nextContent.error);
                const input = { serverId, environmentId, expectedRevision: linked.json().revision,
                    contentArtifactId: nextContent.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
                    referencedSavedSecretRevisions: [{ resourceId, revision: 1 }], grants: [grant] };
                const before = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId } });
                const incompleteContent = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                    header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Invalid bindings' })),
                    body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify({ ...boundContent, bindings: [] }) })),
                    dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
                if (!incompleteContent.ok) throw new Error(incompleteContent.error);
                const contentMismatch = await app.inject({ method: 'POST', url: `${base}/bindings`, headers,
                    payload: { ...input, contentArtifactId: incompleteContent.artifact.id } });
                expect(contentMismatch.statusCode, contentMismatch.body).toBe(409);
                const missingCapture = await app.inject({ method: 'POST', url: `${base}/bindings`, headers,
                    payload: { ...input, referencedSavedSecretRevisions: [] } });
                expect(missingCapture.statusCode, missingCapture.body).toBe(409);
                const staleCapture = await app.inject({ method: 'POST', url: `${base}/bindings`, headers,
                    payload: { ...input, referencedSavedSecretRevisions: [{ resourceId, revision: 2 }] } });
                expect(staleCapture.statusCode, staleCapture.body).toBe(409);
                const wrongRouting = await app.inject({ method: 'POST', url: `${base}/bindings`, headers,
                    payload: { ...input, referencedSavedSecretRevisions: [{ resourceId, revision: 1,
                        requiredBindings: [{ purpose: 'variable', phase: 'build' }] }] } });
                expect(wrongRouting.statusCode, wrongRouting.body).toBe(409);
                expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId } })).toEqual(before);
                const stop = observeSqliteRequests({ before: request => {
                    if (request.model === 'MachineSecretGrant' && !request.action.startsWith('find')) writes += 1;
                } });
                writes = 0;
                try {
                    const accepted = await app.inject({ method: 'POST', url: `${base}/bindings`, headers, payload: input });
                    expect(accepted.statusCode, accepted.body).toBe(200);
                    expect(accepted.json()).toMatchObject({ ok: true, environmentId, revision: input.expectedRevision + 1 });
                    expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId } }))
                        .referencedSavedSecretRevisions).toEqual([{ resourceId, revision: 1,
                            requiredBindings: [{ purpose: 'variable', phase: 'runtime' }] }]);
                    expect(writes, 'unchanged binding grants do not rewrite ciphertext').toBe(0);
                    const publications = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
                    const repeated = await app.inject({ method: 'POST', url: `${base}/bindings`, headers,
                        payload: { ...input, expectedRevision: accepted.json().revision } });
                    expect(repeated.json()).toEqual(accepted.json());
                    expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(publications);
                } finally { stop(); }
                const capturedEnvironment = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId } });
                const project = () => inTx(tx => environmentService.readDeploymentEnvironmentRequiredSecretUsesInTx(tx,
                    capturedEnvironment));
                expect(await project()).toEqual({ status: 'complete', requiredSecretUses: [
                    { resourceId, resourceRevision: 1, machineId, installationId: 'installation' },
                ] });
                await db.machine.update({ where: { id: machineId }, data: { revokedAt: new Date() } });
                expect(await project()).toEqual({ status: 'incomplete', requiredSecretUses: [] });
                await db.machine.update({ where: { id: machineId }, data: { revokedAt: null, installationId: 'replacement' } });
                expect(await project()).toEqual({ status: 'incomplete', requiredSecretUses: [] });
                await db.machine.update({ where: { id: machineId }, data: { installationId: 'installation' } });
                expect(await inTx(tx => environmentService.readDeploymentEnvironmentRequiredSecretUsesInTx(tx,
                    { ...capturedEnvironment, referencedSavedSecretRevisions: [{ resourceId, revision: 1 }] })))
                    .toEqual({ status: 'incomplete', requiredSecretUses: [] });
                const builder = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
                    installationId: 'builder-current', installationPublicKey: new Uint8Array(nacl.sign.keyPair().publicKey), ...plainMachineContent } });
                const registryEnvironment = { ...capturedEnvironment, buildMachineId: builder.id,
                    referencedSavedSecretRevisions: [{ resourceId, revision: 1, requiredBindings: [
                        { purpose: 'registry', targetLinkId: capturedEnvironment.runtimeTargetLinkId!, access: 'pull' },
                    ] }] };
                const registryProjection = (row = registryEnvironment) => inTx(tx =>
                    environmentService.readDeploymentEnvironmentRequiredSecretUsesInTx(tx, row));
                expect(await registryProjection()).toMatchObject({ status: 'complete', requiredSecretUses: expect.arrayContaining([
                    { resourceId, resourceRevision: 1, machineId, installationId: 'installation' },
                    { resourceId, resourceRevision: 1, machineId: builder.id, installationId: 'builder-current' },
                ]) });
                await db.machine.update({ where: { id: builder.id }, data: { revokedAt: new Date() } });
                expect((await registryProjection()).status).toBe('incomplete');
                await db.machine.update({ where: { id: builder.id }, data: { revokedAt: null } });
                expect(await registryProjection({ ...registryEnvironment, runtimeTargetLinkId: null })).toEqual({
                    status: 'complete', requiredSecretUses: [{ resourceId, resourceRevision: 1,
                        machineId: builder.id, installationId: 'builder-current' }],
                });
                const editedContent = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                    header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Renamed' })),
                    body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify({ ...boundContent, name: 'Renamed', retainPreviousDeployments: 2 }) })),
                    dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
                if (!editedContent.ok) throw new Error(editedContent.error);
                const currentEnvironment = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId } });
                const bindingBypass = await app.inject({ method: 'PATCH', url: base, headers, payload: {
                    serverId, environmentId, expectedRevision: currentEnvironment.revision,
                    contentArtifactId: incompleteContent.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
                } });
                expect(bindingBypass.statusCode, bindingBypass.body).toBe(409);
                const updated = await app.inject({ method: 'PATCH', url: base, headers, payload: {
                    serverId, environmentId, expectedRevision: currentEnvironment.revision,
                    contentArtifactId: editedContent.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
                } });
                expect(updated.statusCode, updated.body).toBe(200);
                expect(updated.json()).toEqual({ ok: true, environmentId, revision: currentEnvironment.revision + 1 });
                expect(await inTx(tx => repository.readEnvironmentMachineSecretGrantsInTx(tx, {
                    environmentId, machineId, installationId: 'installation',
                }))).toEqual([grant]);
                const rejected = await app.inject({ method: 'POST', url: `${base}/bindings`, headers,
                    payload: { ...input, grants: [{ ...grant, sealedContent: 'must-not-commit' }] } });
                expect(rejected.statusCode, rejected.body).toBe(409);
                expect(await inTx(tx => repository.readEnvironmentMachineSecretGrantsInTx(tx, {
                    environmentId, machineId, installationId: 'installation',
                }))).toEqual([grant]);
            });
            await inTx(tx => repository.syncEnvironmentSecretGrantsInTx(tx, { environmentId, grants: [] }));
            expect(await inTx(tx => repository.readEnvironmentMachineSecretGrantsInTx(tx, {
                environmentId, machineId, installationId: 'installation',
            }))).toEqual([]);
    });

    it('keeps retained stored definition A from a repository-free Source while definition-only revisions advance through the sole writer', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Stored definition owner', audience: [],
        }));
        if (!source.ok) throw new Error(source.error);
        expect(source.source).not.toHaveProperty('repository');
        const machineId = crypto.randomUUID();
        const installationId = crypto.randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: owner.id, ...plainMachineContent, installationId } });
        const artifact = async (kind: string, value: unknown) => {
            const created = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Private stored definition' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(value) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!created.ok) throw new Error(created.error);
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        // Boundary fixtures carry already prepared content; P41 owns source normalization/digest derivation.
        const digest = (document: string) => `sha256:${createHash('sha256').update(document).digest('hex')}`;
        const documentA = 'services:\n  web:\n    image: nginx:alpine\n';
        const documentB = 'services:\n  web:\n    image: nginx:stable\n';
        const initial = DeploymentEnvironmentContentV1Schema.parse({ name: 'Stored A', retainPreviousDeployments: 1,
            definition: { kind: 'stored', document: documentA,
                contentRevision: 1, composeDigest: digest(documentA), profiles: [], services: ['web'] }, bindings: [] });
        if (initial.definition.kind !== 'stored') throw new Error('Expected stored fixture');
        const definitionA = initial.definition;
        const initialRef = await artifact('deployment-environment.v1', initial);
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const headers = { 'x-test-user-id': owner.id };
            const created = await app.inject({ method: 'POST', url: '/v1/deployments/environments', headers, payload: {
                serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(), protection: 'nonProduction',
                purpose: 'standard', deployerMode: 'managers', controllerMachineId: machineId, buildMachineId: machineId, ...initialRef,
            } });
            expect(created.statusCode, created.body).toBe(200);
            const environmentId: string = created.json().environmentId;
            const base = `/v1/deployments/environments/${environmentId}`;
            const initialRow = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId } });
            expect(await inTx(tx => readPlainDeploymentEnvironmentContentInTx(tx, owner.id,
                { kind: 'account', accountId: owner.id }, initialRow))).toMatchObject({ ok: true, content: { definition: definitionA } });
            const linkRef = await artifact('deployment-target-link.v1', {});
            const linked = await app.inject({ method: 'POST', url: `${base}/targets`, headers, payload: {
                serverId, environmentId, expectedRevision: 1, requestKey: crypto.randomUUID(), targetId: 'own-server', role: 'runtime',
                machines: [{ machineId, installationId }], ...linkRef,
            } });
            expect(linked.statusCode, linked.body).toBe(200);
            const snapshot = await artifact('deployment-receipt.v1', { sourceIntent: definitionA, machines: [machineId],
                buildMachineId: machineId, onFailure: 'rollbackAll', images: [], machineResults: [], steps: [] });
            const admitted = await app.inject({ method: 'POST', url: `${base}/deploy`, headers, payload: {
                serverId, environmentId, expectedRevision: linked.json().revision, targetLinkId: linked.json().targetLinkId,
                expectedTargetLinkRevision: 1, requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), ...snapshot,
            } });
            expect(admitted.statusCode, admitted.body).toBe(200);
            const retained = await db.artifact.findUniqueOrThrow({ where: { id: snapshot.contentArtifactId } });
            const current = () => db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId } });
            const write = async (content: typeof initial, patch?: Readonly<{ ownServer: Readonly<Record<string, unknown>> }>) => {
                const row = await current();
                const reference = await artifact('deployment-environment.v1', content);
                return app.inject({ method: 'PATCH', url: base, headers,
                    payload: { serverId, environmentId, expectedRevision: row.revision, ...reference, ...(patch ? { patch } : {}) } });
            };
            const rejectWithoutMutation = async (content: typeof initial) => {
                const before = await current();
                const response = await write(content);
                expect(response.statusCode, response.body).toBe(409);
                expect(response.json()).toEqual({ ok: false, error: 'deployment_conflict' });
                expect(await current()).toEqual(before);
            };
            await rejectWithoutMutation({ ...initial, definition: { ...definitionA, contentRevision: 2 } });
            await rejectWithoutMutation({ ...initial, definition: { ...definitionA, composeDigest: `sha256:${'b'.repeat(64)}` } });
            const ownServerPatch = { rollout: 'startFirst' as const, autoRestorePreviousRelease: false };
            // Content carries the applied configuration, including the owner's defaults.
            const renamed = { ...initial, name: 'Renamed', retainPreviousDeployments: 3, ownServer: { ...ownServerPatch,
                backupBeforeMigration: true, migrationFailurePolicy: 'ask' as const, serviceExports: [] } };
            // Own-server configuration is written through its patch, not opaque content (0118106b8f8).
            expect((await write(renamed, { ownServer: ownServerPatch })).statusCode).toBe(200);
            const definitionB = { ...definitionA, document: documentB, composeDigest: digest(documentB), contentRevision: 2 };
            await rejectWithoutMutation({ ...renamed, definition: { ...definitionB, contentRevision: 1 } });
            expect((await write({ ...renamed, definition: definitionB })).statusCode).toBe(200);
            const selectorChange = { ...definitionB, profiles: ['production'], contentRevision: 3 };
            expect((await write({ ...renamed, definition: selectorChange })).statusCode).toBe(200);
            const row = await current();
            const currentContent = { ...renamed, definition: selectorChange };
            const bindingBypasses: typeof initial[] = [
                { ...currentContent, definition: { ...selectorChange, contentRevision: 99 } },
                { ...currentContent, definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: ['web'] } } },
                { ...currentContent, name: 'Binding must not rename' },
                { ...currentContent, retainPreviousDeployments: 8 },
                { ...currentContent, ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true } },
            ];
            for (const content of bindingBypasses) {
                const reference = await artifact('deployment-environment.v1', content);
                const bypass = await app.inject({ method: 'POST', url: `${base}/bindings`, headers, payload: {
                    serverId, environmentId, expectedRevision: row.revision, ...reference,
                    referencedSavedSecretRevisions: [], grants: [],
                } });
                expect(bypass.statusCode, bypass.body).toBe(409);
                expect(await current()).toEqual(row);
            }
            const wrongEnvelope = await artifact('deployment-receipt.v1', { ...renamed, definition: selectorChange });
            const refusedEnvelope = await app.inject({ method: 'PATCH', url: base, headers,
                payload: { serverId, environmentId, expectedRevision: row.revision, ...wrongEnvelope } });
            expect(refusedEnvelope.statusCode, refusedEnvelope.body).toBe(409);
            expect(await current()).toEqual(row);
            const opened = await inTx(tx => readPlainDeploymentEnvironmentContentInTx(tx, owner.id, { kind: 'account', accountId: owner.id }, row));
            expect(opened).toMatchObject({ ok: true, content: { name: 'Renamed', definition: selectorChange,
                retainPreviousDeployments: 3, ownServer: renamed.ownServer } });
            expect(await db.artifact.findUniqueOrThrow({ where: { id: snapshot.contentArtifactId } })).toEqual(retained);
            const receipt = await app.inject({ method: 'GET', url: `${base}/deployments/${admitted.json().deploymentId}?serverId=${serverId}`, headers });
            expect(receipt.statusCode, receipt.body).toBe(200);
            expect(receipt.json()).toMatchObject({ deployment: { ...snapshot } });
            const retainedRead = await inTx(tx => readArtifactForCallerInTx(tx, { actorAccountId: owner.id, artifactId: snapshot.contentArtifactId }));
            if (!retainedRead.ok) throw new Error(retainedRead.error);
            const retainedBody = ArtifactBodyEnvelopeV1StoredSchema.parse(decodePlainArtifactStoredContent(privacyKit.encodeBase64(retainedRead.artifact.body)));
            const retainedHeader = ArtifactHeaderMetadataV1Schema.parse(decodePlainArtifactStoredContent(privacyKit.encodeBase64(retainedRead.artifact.header)));
            expect(readDeploymentReceiptArtifactV1(snapshot, { artifactId: retainedRead.artifact.id,
                revision: { headerVersion: retainedRead.artifact.headerVersion, bodyVersion: retainedRead.artifact.bodyVersion },
                header: retainedHeader, body: retainedBody.body })).toMatchObject({ ok: true, content: { sourceIntent: definitionA } });
            const publications = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
            const replay = await app.inject({ method: 'PATCH', url: base, headers,
                payload: { serverId, environmentId, expectedRevision: row.revision, contentArtifactId: row.contentArtifactId,
                    contentHeaderVersion: row.contentHeaderVersion, contentBodyVersion: row.contentBodyVersion } });
            expect(replay.json()).toEqual({ ok: true, environmentId, revision: row.revision });
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(publications);
            const reloadedSource = await inTx(tx => readProjectSourceInTx(tx, owner.id, { serverId, sourceId: source.source.id }));
            if (!reloadedSource.ok) throw new Error(reloadedSource.error);
            expect(reloadedSource.source).not.toHaveProperty('repository');
        });
    });

    it.each(['succeeded', 'running_unverified'] as const)('keeps immutable receipt identity, exclusion and signed CAS across two consecutive single-member deploys (%s)', async firstState => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const keys = nacl.sign.keyPair();
        const machineId = crypto.randomUUID();
        const installationId = crypto.randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: owner.id, installationId, active: true,
            metadata: encodePlainMachineStoredContent({ host: 'Receipt controller', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/receipt', happyHomeDir: '/home/receipt/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            installationPublicKey: new Uint8Array(keys.publicKey) } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Receipt project', audience: [],
            repository: { provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'acme/receipts', cloneUrl: 'https://github.com/acme/receipts.git', visibility: 'private' }, protocol: 'https' },
        }));
        if (!source.ok) throw new Error(source.error);
        const artifact = async (value: unknown, kind: string) => {
            const created = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Deployment content' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent(value)),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!created.ok) throw new Error(created.error);
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: created.artifact.headerVersion,
                contentBodyVersion: created.artifact.bodyVersion };
        };
        const [environmentContent, linkContent, receiptContent, otherContent] = await Promise.all([
            artifact({ body: JSON.stringify({ ...createDeploymentEnvironmentDetailV1().content, name: 'Private Staging' }) },
                'deployment-environment.v1'), artifact({}, 'deployment-target-link.v1'),
            artifact({ snapshot: 'immutable-A' }, 'deployment-receipt.v1'), artifact({ snapshot: 'immutable-B' }, 'deployment-receipt.v1'),
        ]);
        const bearer = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const outsiderBearer = await auth.createToken(outsider.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const headers = { authorization: `Bearer ${bearer}` };
            const created = await app.inject({ method: 'POST', url: '/v1/deployments/environments', headers, payload: {
                serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(),
                protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
                controllerMachineId: machineId, buildMachineId: machineId, ...environmentContent,
            } });
            expect(created.statusCode, created.body).toBe(200);
            const environmentId: string = created.json().environmentId;
            const base = `/v1/deployments/environments/${environmentId}`;
            const linked = await app.inject({ method: 'POST', url: `${base}/targets`, headers, payload: {
                serverId, environmentId, expectedRevision: 1, requestKey: crypto.randomUUID(), targetId: 'own-server', role: 'runtime',
                machines: [{ machineId, installationId }], ...linkContent,
            } });
            expect(linked.statusCode, linked.body).toBe(200);
            const targetLinkId: string = linked.json().targetLinkId;
            const intent = { serverId, environmentId, expectedRevision: linked.json().revision, targetLinkId,
                expectedTargetLinkRevision: 1, requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), ...receiptContent };
            const reserve = async (operation: 'deploy' | 'rollback', payload: typeof intent & { deploymentId?: string }) => {
                const { actionOperationId: _operationId, ...input } = payload;
                const target = { kind: 'machine' as const, machineId };
                const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
                const actionId = operation === 'deploy' ? 'deployments.deploy' : 'deployments.rollback';
                const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
                    accountId: owner.id, authentication: { kind: 'account', tokenEpoch: owner.tokenEpoch }, actionId,
                    machineId, target, requestId: envelope.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
                const path = `${base}/${operation}`;
                return app.inject({ method: 'POST', url: path, payload, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: authorization.token, effectActionId: actionId, target, installationId,
                        requestId: envelope.requestId, method: 'POST', path, body: payload, privateKey: keys.secretKey }),
                } });
            };
            const beforeAdmission = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId } });
            for (const stale of [
                { ...intent, expectedRevision: intent.expectedRevision - 1 },
                { ...intent, expectedTargetLinkRevision: intent.expectedTargetLinkRevision + 1 },
            ]) {
                const refused = await reserve('deploy', stale);
                expect(refused.statusCode, refused.body).toBe(409);
                expect(refused.json()).toEqual({ ok: false, error: 'deployment_conflict' });
                expect(await db.deployment.count({ where: { environmentId } })).toBe(0);
                expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environmentId } })).toEqual(beforeAdmission);
            }
            const first = await reserve('deploy', intent);
            expect(first.statusCode, first.body).toBe(200);
            const firstId: string = first.json().deploymentId;
            const seq = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
            expect(await db.deployment.findUniqueOrThrow({ where: { id: firstId } })).toMatchObject({
                acceptedControllerMachineId: machineId, acceptedControllerInstallationId: installationId,
                acceptedBuildMachineId: machineId, acceptedBuildInstallationId: installationId,
            });
            expect((await reserve('deploy', intent)).json()).toEqual(first.json());
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(seq);
            expect((await reserve('deploy', { ...intent, ...otherContent })).json())
                .toEqual({ ok: false, error: 'deployment_conflict' });
            const busy = await reserve('deploy', { ...intent, requestKey: crypto.randomUUID() });
            expect(busy.statusCode, busy.body).toBe(409);
            expect(busy.json()).toMatchObject({ ok: false, error: 'deployment_in_progress', deploymentId: firstId });
            expect(await db.deployment.count({ where: { environmentId } })).toBe(1);
            const sign = (body: Omit<DeploymentTransitionInputV1, 'proof'>) => ({ ...body,
                proof: signMachineInstallationProof({ payload: { version: 1, machineId, installationId, accountId: owner.id,
                    deploymentTransition: { serverId, environmentId, deploymentId: body.deploymentId,
                        actionOperationId: body.actionOperationId, expectedRevision: body.expectedRevision,
                        requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, privateKey: keys.secretKey }) });
            const running = sign({ serverId, environmentId, deploymentId: firstId, expectedRevision: 1,
                actionOperationId: intent.actionOperationId, machineId, installationId, kind: 'stage', state: 'running' });
            const transitionUrl = `${base}/deployments/${firstId}/transitions`;
            const forged = await app.inject({ method: 'POST', url: transitionUrl, headers, payload: { ...running, state: 'queued' } });
            expect(forged.statusCode, forged.body).toBe(403);
            const started = await app.inject({ method: 'POST', url: transitionUrl, headers, payload: running });
            expect(started.statusCode, started.body).toBe(200);
            const runningSeq = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
            expect((await app.inject({ method: 'POST', url: transitionUrl, headers, payload: running })).statusCode).toBe(200);
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(runningSeq);
            const contentUpdate = ArtifactJsonUpdateHttpInputV1Schema.parse({ body: encodePlainArtifactStoredContent({ snapshot: 'immutable-A', steps: ['started'] }),
                expectedBodyVersion: receiptContent.contentBodyVersion });
            const beforeRejectedUpdate = await db.artifact.findUniqueOrThrow({ where: { id: receiptContent.contentArtifactId } });
            const refused = await app.inject({ method: 'POST', url: transitionUrl, headers, payload: sign({
                serverId, environmentId, deploymentId: firstId, expectedRevision: 1, actionOperationId: intent.actionOperationId,
                machineId, installationId, kind: 'stage', state: 'running', contentUpdate,
            }) });
            expect(refused.statusCode, refused.body).toBe(409);
            expect(await db.artifact.findUniqueOrThrow({ where: { id: receiptContent.contentArtifactId } })).toEqual(beforeRejectedUpdate);
            expect((await db.deployment.findUniqueOrThrow({ where: { id: firstId } })).revision).toBe(2);
            const progressed = await app.inject({ method: 'POST', url: transitionUrl, headers, payload: sign({
                serverId, environmentId, deploymentId: firstId, expectedRevision: 2, actionOperationId: intent.actionOperationId,
                machineId, installationId, kind: 'stage', state: 'running', contentUpdate,
            }) });
            expect(progressed.statusCode, progressed.body).toBe(200);
            expect(await db.deployment.findUniqueOrThrow({ where: { id: firstId } })).toMatchObject({ revision: 3, contentBodyVersion: 2 });
            expect((await db.artifact.findUniqueOrThrow({ where: { id: receiptContent.contentArtifactId } })).bodyVersion).toBe(2);
            const settled = await app.inject({ method: 'POST', url: transitionUrl, headers, payload: sign({
                serverId, environmentId, deploymentId: firstId, expectedRevision: 3, actionOperationId: intent.actionOperationId,
                machineId, installationId, kind: 'settle', state: firstState,
                expectedTargetLinkRevision: 1,
            }) });
            expect(settled.statusCode, settled.body).toBe(200);
            expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: targetLinkId } })).toMatchObject({ activeDeploymentId: firstId, revision: 2 });
            expect(await db.deploymentTargetLinkMachine.findMany({ where: { targetLinkId } })).toMatchObject([{ machineId, state: 'active' }]);
            const firstReceipt = await db.deployment.findUniqueOrThrow({ where: { id: firstId } });
            const secondIntent = { ...intent, ...otherContent, expectedRevision: first.json().revision, expectedTargetLinkRevision: 2,
                requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID() };
            const second = await reserve('deploy', secondIntent);
            expect(second.statusCode, second.body).toBe(200);
            const secondId: string = second.json().deploymentId;
            const secondTransitionUrl = `${base}/deployments/${secondId}/transitions`;
            const secondStarted = await app.inject({ method: 'POST', url: secondTransitionUrl, headers, payload: sign({
                serverId, environmentId, deploymentId: secondId, expectedRevision: 1, actionOperationId: secondIntent.actionOperationId,
                machineId, installationId, kind: 'stage', state: 'running',
            }) });
            expect(secondStarted.statusCode, secondStarted.body).toBe(200);
            const secondSettled = await app.inject({ method: 'POST', url: secondTransitionUrl, headers, payload: sign({
                serverId, environmentId, deploymentId: secondId, expectedRevision: 2, actionOperationId: secondIntent.actionOperationId,
                machineId, installationId, kind: 'settle', state: firstState, expectedTargetLinkRevision: 2,
            }) });
            expect(secondSettled.statusCode, secondSettled.body).toBe(200);
            expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: targetLinkId } }))
                .toMatchObject({ activeDeploymentId: secondId, revision: 3 });
            expect(await db.deploymentTargetLinkMachine.findMany({ where: { targetLinkId } }))
                .toMatchObject([{ machineId, installationId, state: 'active' }]);
            expect(await db.deployment.findUniqueOrThrow({ where: { id: firstId } })).toEqual(firstReceipt);
            const unsignedIntent = { ...intent, ...otherContent, expectedRevision: second.json().revision, expectedTargetLinkRevision: 3,
                requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID() };
            const unsigned = await app.inject({ method: 'POST', url: `${base}/deploy`, headers, payload: unsignedIntent });
            expect(unsigned.statusCode, unsigned.body).toBe(200);
            const unsignedId: string = unsigned.json().deploymentId;
            const history = await app.inject({ method: 'GET', url: `${base}/deployments/${unsignedId}?serverId=${serverId}`, headers });
            expect(history.statusCode, history.body).toBe(200);
            expect(history.json().deployment).not.toHaveProperty('acceptedExecution');
            const unsignedStage = await app.inject({ method: 'POST', url: `${base}/deployments/${unsignedId}/transitions`, headers,
                payload: sign({ serverId, environmentId, machineId, installationId, kind: 'stage', state: 'running',
                    deploymentId: unsignedId, expectedRevision: 1, actionOperationId: unsignedIntent.actionOperationId }) });
            expect(unsignedStage.statusCode, unsignedStage.body).toBe(403);
            const cancelled = await app.inject({ method: 'POST', url: `${base}/deployments/${unsignedId}/transitions`, headers,
                payload: { kind: 'cancel', serverId, environmentId, deploymentId: unsignedId, expectedReceiptRevision: 1 } });
            expect(cancelled.statusCode, cancelled.body).toBe(200);
            const immutable = await db.deployment.findUniqueOrThrow({ where: { id: firstId } });
            const rollback = await reserve('rollback', {
                ...intent, ...otherContent, expectedRevision: unsigned.json().revision, expectedTargetLinkRevision: 3,
                requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), deploymentId: firstId,
            });
            expect(rollback.statusCode, rollback.body).toBe(200);
            expect(rollback.json().deploymentId).not.toBe(firstId);
            expect(await db.deployment.findUniqueOrThrow({ where: { id: rollback.json().deploymentId } })).toMatchObject({
                operation: 'rollback', rollbackOfDeploymentId: firstId, predecessorDeploymentId: secondId,
            });
            expect(await db.deployment.findUniqueOrThrow({ where: { id: firstId } })).toEqual(immutable);
            expect((await app.inject({ method: 'GET', url: `${base}?serverId=${serverId}`,
                headers: { authorization: `Bearer ${outsiderBearer}` } })).statusCode).toBe(404);
            const listed = await app.inject({ method: 'GET', url: `/v1/deployments/environments?serverId=${serverId}&projectSourceId=${source.source.id}`, headers });
            expect(listed.statusCode, listed.body).toBe(200);
            expect(listed.body).not.toContain('Private Staging');
            expect(listed.json().items[0]).not.toHaveProperty('content');
            expect(listed.json().currentDeployments).toMatchObject([{ id: rollback.json().deploymentId,
                environmentId, state: 'queued', operation: 'rollback' }]);
            await updateArtifact({ actorUserId: owner.id, artifactId: receiptContent.contentArtifactId,
                body: { expectedVersion: 2, bytes: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ edited: true })) } });
            const staleRead = await app.inject({ method: 'GET', url: `${base}/deployments/${firstId}?serverId=${serverId}`, headers });
            expect(staleRead.statusCode, staleRead.body).toBe(409);
            expect(staleRead.json()).toEqual({ ok: false, error: 'deployment_conflict' });
            const changes = await db.accountChange.findMany({ where: { accountId: owner.id, kind: 'account' } });
            expect(changes.map(change => readDeploymentAccountChangeV1(change)).filter(Boolean)).toContainEqual({ projectSourceId: source.source.id, environmentId, deploymentId: firstId });
            expect(JSON.stringify(changes)).not.toContain('immutable-A');
        }, { authentication: 'real' });
    });
});
