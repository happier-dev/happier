import { teamResourceGrantFixture } from '@/testkit/resourceGrant.testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent,
    sealEncryptedDataKeyEnvelopeV1, sealSavedSecretResourceStoredContentV1,
    verifyAccountContentKeyBindingV1 } from '@happier-dev/protocol';
import { captureDeploymentBindingSavedSecretRevisionsV1, DeploymentEnvironmentContentV1Schema,
    type MachineSecretGrantV1 } from '@happier-dev/deployment-protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { openSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { listUnreferencedPluginCreatedSecretResources } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import type { Tx } from '@/storage/inTx';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { initEncrypt } from '@/modules/encrypt';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createSavedSecretResourceInTx, repairSavedSecretResourceKeyEnvelopesInTx, setSavedSecretResourceGrantsInTx,
    updateSavedSecretResourceInTx, listSavedSecretResourceMaterialsForAccountInTx,
    deleteSavedSecretResourceInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { createDeploymentEnvironmentInTx, setDeploymentEnvironmentBindingsInTx, updateDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import { linkDeploymentTargetInTx } from './deploymentTargetLinkService';
import { readEnvironmentSecretLaunchAdmissionInTx } from './environmentSecretLaunchAdmission';
import { readDeploymentEnvironmentInTx } from './deploymentReadService';
import { createDeploymentAcceptedExecution, deploymentAcceptedExecutionColumns } from './deploymentAcceptedExecution';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';

const publishedMachine = { metadata: encodePlainMachineStoredContent({ host: 'Binding custody', platform: 'linux',
    happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
    dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) };

describe('Environment installation grants and complete resource captures', () => {
    const serverId = `srv_${'d'.repeat(32)}`;
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    let previousServerId: string | undefined;
    beforeAll(async () => {
        previousServerId = process.env.HAPPIER_SERVER_IDENTITY_ID;
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'happier-grant-contract-' });
        harness.resetEnv({ HAPPIER_SERVER_IDENTITY_ID: serverId,
            HANDY_MASTER_SECRET: 'happier-disposable-grant-contract-master' });
        await initEncrypt();
    }, 180_000);
    afterAll(async () => {
        harness?.resetEnv();
        await harness?.close();
        if (previousServerId === undefined) delete process.env.HAPPIER_SERVER_IDENTITY_ID;
        else process.env.HAPPIER_SERVER_IDENTITY_ID = previousServerId;
    });

    it('distinguishes a repeated Create allocation before a host can repeat later provider effects', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machineId = crypto.randomUUID();
        await db.machine.create({ data: { id: machineId, installationId: crypto.randomUUID(),
            installationPublicKey: new Uint8Array(nacl.box.keyPair().publicKey), accountId: owner.id, ...publishedMachine } });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId,
            requestKey: crypto.randomUUID(), name: 'Repeated allocation', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const content = DeploymentEnvironmentContentV1Schema.parse({ name: 'Repeated allocation', retainPreviousDeployments: 0,
            definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } }, bindings: [] });
        const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: content.name })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(content) })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!artifact.ok) throw new Error(artifact.error);
        const input = { serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(), controllerMachineId: machineId,
            protection: 'nonProduction' as const, purpose: 'standard' as const, deployerMode: 'managers' as const,
            contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const created = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, input));
        expect(created).toMatchObject({ ok: true });
        expect(created).not.toHaveProperty('replayed');
        if (!created.ok) throw new Error(created.error);
        const copyArtifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: content.name })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(content) })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!copyArtifact.ok) throw new Error(copyArtifact.error);
        const copied = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, { ...input,
            requestKey: crypto.randomUUID(), contentArtifactId: copyArtifact.artifact.id,
            copyFrom: { environmentId: created.environmentId, expectedRevision: created.revision },
            copyIntentCommitment: 'A'.repeat(43) }));
        expect(copied).toMatchObject({ ok: true, replayed: false });
        const repeated = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, input));
        expect(repeated).toMatchObject({ ok: true, environmentId: created.environmentId, replayed: true });
    });

    it('admits combined placement and bindings once while refusing accepted same-subject seal replacement', async () => {
        const withAdmissionCount = async <T>(operation: (tx: Tx) => Promise<T>) => {
            let loads = 0;
            const result = await inTx(tx => operation(new Proxy(tx, { get(target, property, receiver) {
                if (property !== 'deploymentEnvironment') return Reflect.get(target, property, receiver);
                return new Proxy(target.deploymentEnvironment, { get(delegate, method, delegateReceiver) {
                    if (method !== 'findUnique') return Reflect.get(delegate, method, delegateReceiver);
                    return (...args: Parameters<typeof delegate.findUnique>) => {
                        loads++;
                        return delegate.findUnique(...args);
                    };
                } });
            } })));
            expect(loads, 'one Environment load/Source admission per mutation').toBe(1);
            return result;
        };
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const a = { machineId: crypto.randomUUID(), installationId: crypto.randomUUID() };
        const b = { machineId: crypto.randomUUID(), installationId: crypto.randomUUID() };
        await db.machine.createMany({ data: [a, b].map(machine => ({ id: machine.machineId,
            installationId: machine.installationId, installationPublicKey: new Uint8Array(nacl.box.keyPair().publicKey),
            accountId: owner.id, ...publishedMachine })) });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId,
            requestKey: crypto.randomUUID(), name: 'Accepted grant custody', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const resourceId = crypto.randomUUID();
        const resource = await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
            displayName: 'Shared phase credential', kind: 'token', encryptionMode: 'plain', accountGrants: [], teamGrants: [],
            storedContent: { t: 'plain', v: { v: 1, name: 'Shared phase credential', kind: 'token', value: 'private-shared-phase-value' } } }));
        if (!resource.ok) throw new Error(resource.error);
        const binding = { purpose: 'variable' as const, phase: 'runtime' as const, name: 'RUNTIME_TOKEN',
            source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 } };
        const content = DeploymentEnvironmentContentV1Schema.parse({ name: 'Accepted custody', retainPreviousDeployments: 1,
            definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } }, bindings: [] });
        const artifact = async (kind: string, body: unknown) => {
            const created = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Accepted custody' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(body) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!created.ok) throw new Error(created.error);
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const initialReference = await artifact('deployment-environment.v1', content);
        const environment = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, { serverId,
            projectSourceId: source.source.id, requestKey: crypto.randomUUID(), controllerMachineId: a.machineId,
            buildMachineId: a.machineId, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            ...initialReference }));
        if (!environment.ok) throw new Error(environment.error);
        const linkContent = await artifact('deployment-target-link.v1', {});
        const linked = await inTx(tx => linkDeploymentTargetInTx(tx, owner.id, { serverId,
            environmentId: environment.environmentId, expectedRevision: environment.revision, requestKey: crypto.randomUUID(),
            targetId: 'own-server', role: 'runtime', machines: [a], ...linkContent }));
        if (!linked.ok) throw new Error(linked.error);
        const reference = await artifact('deployment-environment.v1', { ...content, bindings: [binding, { ...binding, phase: 'build', name: 'BUILD_TOKEN' }] });
        const grant: MachineSecretGrantV1 = { v: 1, kind: 'secret', environmentId: environment.environmentId,
            ...a, resourceId, resourceRevision: 1, sealedContent: 'same-original-A-seal' };
        const bindings = { serverId, environmentId: environment.environmentId, expectedRevision: linked.revision,
            ...reference, grants: [grant], referencedSavedSecretRevisions: [{ resourceId, revision: 1,
                requiredBindings: [{ purpose: 'variable' as const, phase: 'runtime' as const },
                    { purpose: 'variable' as const, phase: 'build' as const }] }] };
        const bound = await withAdmissionCount(tx => setDeploymentEnvironmentBindingsInTx(tx, owner.id, bindings));
        if (!bound.ok) throw new Error(bound.error);
        const readScope = () => inTx(tx => readDeploymentEnvironmentInTx(tx, owner.id,
            { serverId, environmentId: environment.environmentId }));
        expect(await readScope()).toMatchObject({ ok: true, secretScope: {
            status: 'ready', reason: 'secret_scope_current', requiredGrantCount: 1, missingGrantCount: 0,
        } });
        const stored = await db.machineSecretGrant.findFirstOrThrow({ where: { environmentId: environment.environmentId } });
        await db.machineSecretGrant.delete({ where: { subjectKey: stored.subjectKey } });
        const missingScope = await readScope();
        expect(missingScope).toMatchObject({ ok: true, secretScope: {
            status: 'actionNeeded', reason: 'secret_scope_grants_required', requiredGrantCount: 1, missingGrantCount: 1,
        } });
        expect(JSON.stringify(missingScope)).not.toContain(grant.sealedContent);
        await db.machineSecretGrant.create({ data: stored });
        // Persisted receipt is the fixture boundary for this mutation-owner test;
        // the capture columns come from D2's sole identity producer.
        await db.deployment.create({ data: { environmentId: environment.environmentId, targetLinkId: linked.targetLinkId,
            operation: 'deploy', state: 'running', requestKey: crypto.randomUUID(), requestedByAccountId: owner.id,
            actionOperationId: crypto.randomUUID(), ...await artifact('deployment-receipt.v1', {}),
            ...deploymentAcceptedExecutionColumns(createDeploymentAcceptedExecution({ controller: a, builder: a })) } });
        const snapshot = async () => ({
            environment: await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.environmentId } }),
            grants: await db.machineSecretGrant.findMany({ where: { environmentId: environment.environmentId }, orderBy: { subjectKey: 'asc' } }),
            account: await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } }),
        });
        const before = await snapshot();
        const futureGrant: MachineSecretGrantV1 = { ...grant, ...b, sealedContent: 'new-B-seal' };
        const placement = { serverId, environmentId: environment.environmentId, expectedRevision: bound.revision,
            ...reference, patch: { buildMachineId: b.machineId }, preparedBindings: {
                grants: [futureGrant, { ...grant, sealedContent: 'must-not-overwrite-A' }],
                referencedSavedSecretRevisions: bindings.referencedSavedSecretRevisions,
            } };
        expect(await inTx(tx => updateDeploymentEnvironmentInTx(tx, owner.id, placement)))
            .toEqual({ ok: false, error: 'deployment_conflict' });
        expect(await snapshot(), 'conflict cannot partially create B, rewrite A, move placement or publish').toEqual(before);
        const accepted = await withAdmissionCount(tx => updateDeploymentEnvironmentInTx(tx, owner.id, { ...placement,
            preparedBindings: { ...placement.preparedBindings, grants: [futureGrant, grant] } }));
        expect(accepted).toMatchObject({ ok: true, revision: bound.revision + 1 });
        const committed = await snapshot();
        expect(committed.grants).toContainEqual(before.grants[0]);
        expect(await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, owner.id, { ...bindings,
            expectedRevision: bound.revision + 1, grants: [grant, futureGrant] })))
            .toMatchObject({ ok: true, revision: bound.revision + 1 });
        expect(await snapshot()).toEqual(committed);
    });

    async function roundtrip(variant: 'plain' | 'e2ee' | 'team' | 'operational' | 'rotation' | 'isolation' | 'backupBeforePlacement') {
        const mode = variant === 'e2ee' || variant === 'rotation' || variant === 'isolation' ? 'e2ee' : 'plain';
        const recipientKeys = nacl.box.keyPair();
        const recipientBinding = createSignedAccountContentBinding(recipientKeys.publicKey);
        const owner = await db.account.create({ data: mode === 'plain' ? { encryptionMode: mode }
            : { encryptionMode: mode, ...recipientBinding } });
        const donorKeys = nacl.box.keyPair();
        const donorBinding = createSignedAccountContentBinding(donorKeys.publicKey);
        const donor = await db.account.create({ data: mode === 'plain' ? { encryptionMode: mode }
            : { encryptionMode: mode, ...donorBinding } });
        const team = variant === 'team' ? await db.team.create({ data: { name: 'Binding principal' } }) : null;
        if (team) await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: 'owner' },
            { teamId: team.id, accountId: donor.id, role: 'admin' },
        ] });
        await db.userRelationship.create({ data: { fromUserId: donor.id, toUserId: owner.id, status: 'friend' } });
        const machineId = crypto.randomUUID(), installationId = crypto.randomUUID();
        const machineContent = mode === 'plain' ? publishedMachine : { metadata: '{}', dataEncryptionKey: null };
        await db.machine.create({ data: { id: machineId, installationId, accountId: owner.id, ...machineContent } });
        const secondMachineId = crypto.randomUUID(), secondInstallationId = crypto.randomUUID();
        const buildMachineId = crypto.randomUUID(), buildInstallationId = crypto.randomUUID();
        await db.machine.createMany({ data: [
            { id: secondMachineId, installationId: secondInstallationId, accountId: owner.id, ...machineContent },
            { id: buildMachineId, installationId: buildInstallationId, accountId: owner.id, ...machineContent },
        ] });
        if (team) await db.machineGrant.createMany({ data: [machineId, secondMachineId, buildMachineId].map(id => ({ ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'view', createdByAccountId: owner.id }), machineId: id })) });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Capture contract', audience: [],
            ...(team ? { owner: { kind: 'team' as const, teamId: team.id } } : {}),
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'acme/capture', cloneUrl: 'https://github.com/acme/capture.git' }, protocol: 'https' },
        }));
        if (!source.ok) throw new Error(source.error);
        const resourceId = crypto.randomUUID();
        const secret = { v: 1 as const, name: 'Capture secret', kind: 'token' as const, value: 'capture-contract-private-value',
            createdByPlugin: { pluginId: 'acme.database', secretId: 'connection' } };
        const dataKey = nacl.randomBytes(32);
        const envelopes = mode === 'plain' ? [] : [
            { accountId: owner.id, binding: recipientBinding, publicKey: recipientKeys.publicKey },
            { accountId: donor.id, binding: donorBinding, publicKey: donorKeys.publicKey },
        ].map(recipient => {
            const verified = verifyAccountContentKeyBindingV1({ accountSigningPublicKey: privacyKit.decodeHex(recipient.binding.publicKey),
                contentPublicKey: recipient.binding.contentPublicKey, signature: recipient.binding.contentPublicKeySig });
            if (!verified) throw new Error('Expected a verified fixture recipient');
            return { recipientAccountId: recipient.accountId,
                recipientContentPublicKeyFingerprint: verified.contentPublicKeyFingerprint,
                encryptedDataKey: sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: recipient.publicKey, randomBytes: nacl.randomBytes }) };
        });
        const createdSecret = await inTx(tx => createSavedSecretResourceInTx(tx, {
            accountId: donor.id, resourceId, displayName: secret.name, kind: secret.kind, encryptionMode: mode,
            storedContent: sealSavedSecretResourceStoredContentV1(mode === 'plain' ? { resourceId, mode, content: secret }
                : { resourceId, mode, resourceDataKey: dataKey, content: secret, randomBytes: nacl.randomBytes }),
            accountGrants: team ? [] : [owner.id], teamGrants: team ? [team.id] : [], keyEnvelopes: envelopes,
        }));
        if (!createdSecret.ok) throw new Error(createdSecret.error);
        const census = async () => {
            let queries = 0;
            const rows = await inTx(async tx => {
                // Count Environment reads while every application owner stays real.
                // The census is one Environment sweep per catalog read (2b3165e9253).
                const observed = new Proxy(tx, { get(target, property, receiver) {
                    const value = Reflect.get(target, property, receiver);
                    if (property !== 'deploymentEnvironment') return value;
                    return new Proxy(value, { get(delegate, method, delegateReceiver) {
                        const read = Reflect.get(delegate, method, delegateReceiver);
                        return typeof read === 'function' ? (...args: unknown[]) => { queries++; return read.apply(delegate, args); } : read;
                    } });
                } });
                await listSavedSecretResourceMaterialsForAccountInTx(observed, donor.id, undefined, [resourceId]);
                expect(queries, 'ordinary material reads do not query Environments').toBe(0);
                return await listSavedSecretResourceMaterialsForAccountInTx(observed, donor.id, undefined, [resourceId], true);
            });
            expect(queries, 'one Environment sweep serves the requested reference set').toBe(1);
            const row = rows[0];
            if (!row || !('resourceId' in row)) throw new Error('Expected healthy resource');
            expect(row.entry.deploymentReferenceState).toBeDefined();
            const opened = row.storedContent && (mode === 'plain'
                ? openSavedSecretResourceStoredContentV1({ resourceId, mode: 'plain', storedContent: row.storedContent })
                : openSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', storedContent: row.storedContent, resourceDataKey: dataKey }));
            expect(opened?.createdByPlugin).toEqual(secret.createdByPlugin);
            const candidates = listUnreferencedPluginCreatedSecretResources({}, {}, { resources: [{
                ref: formatSharedSavedSecretRefV1(resourceId), createdByPlugin: opened?.createdByPlugin,
                deploymentReferenceState: row.entry.deploymentReferenceState,
            }] });
            expect(candidates).toEqual(row.entry.deploymentReferenceState === 'unreferenced'
                ? [formatSharedSavedSecretRefV1(resourceId)] : []);
            return row.entry.deploymentReferenceState;
        };
        if (variant !== 'backupBeforePlacement') expect(await census()).toBe('unreferenced');
        const deleteResource = async () => {
            const current = await db.savedSecretResource.findUniqueOrThrow({ where: { id: resourceId } });
            return await inTx(tx => deleteSavedSecretResourceInTx(tx, { accountId: donor.id, resourceId,
                expectedRevision: current.revision, expectedSettingsVersion: 0,
                referenceCensus: { accountMode: mode, profileTransferRevision: 'absent', artifacts: [],
                    profiles: { referenceGuardRevision: 'absent', rows: [] },
                    catalogs: { mcp: 'absent', acp: 'absent', providerConnections: 'absent', connectedConfigurations: 'absent', connectedPurposes: 'absent' },
                    remoteHosts: { revision: 'absent', resourceRefs: [] }, notificationChannels: { revision: 'absent', resourceRefs: [] } },
            }), { isolationLevel: 'Serializable' });
        };
        const binding = { purpose: 'variable' as const, phase: 'runtime' as const, name: 'TOKEN',
            source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: 1 } };
        const content = DeploymentEnvironmentContentV1Schema.parse({ name: 'Capture contract', retainPreviousDeployments: 1,
                definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } },
                bindings: [binding, { ...binding, phase: 'build', name: 'BUILD_TOKEN' },
                    { purpose: 'variable', phase: 'runtime', name: 'PORT', source: { kind: 'value', value: '3000' } },
                    { purpose: 'variable', phase: 'runtime', name: 'DATA_HOST',
                        source: { kind: 'reference', environmentId: source.source.id, export: 'host', via: 'auto' } },
                    { purpose: 'variable', phase: 'build', name: 'COMMIT', source: { kind: 'deploymentFact', fact: 'commitSha' } }] });
        async function artifact(kind: string, value: unknown, actorAccountId = owner.id) {
            // The real Artifact writer receives the client crypto boundary's
            // ciphertext; the server cannot interpret these E2EE body bytes.
            const encrypt = (payload: unknown) => {
                const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
                const ciphertext = nacl.secretbox(new TextEncoder().encode(JSON.stringify(payload)), nonce, dataKey);
                return new Uint8Array([...nonce, ...ciphertext]);
            };
            const created = await createArtifact({ actorUserId: actorAccountId, artifactId: crypto.randomUUID(), kind: deriveArtifactStoredKindV1({ kind }),
                header: mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Capture contract' })) : encrypt({ kind }),
                body: mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(value) })) : encrypt({ body: JSON.stringify(value) }),
                dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)
                    : sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: recipientKeys.publicKey, randomBytes: nacl.randomBytes }),
            });
            if (!created.ok) throw new Error(created.error);
            if (team) await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: actorAccountId }), artifactId: created.artifact.id } });
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        }
        const initialContent = await artifact('deployment-environment.v1', { ...content, bindings: [] });
        const environment = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
            serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(), controllerMachineId: machineId, buildMachineId,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', ...initialContent,
        }));
        if (!environment.ok) throw new Error(environment.error);
        if (variant !== 'backupBeforePlacement') {
            expect(await census(), 'admitted creation starts with an empty binding set').toBe('unreferenced');
        }
        if (variant === 'backupBeforePlacement') {
            const bindings = [{ purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword', source: binding.source }];
            const prepared = await artifact('deployment-environment.v1', { ...content, bindings });
            const input = { serverId, environmentId: environment.environmentId, expectedRevision: environment.revision,
                ...prepared, referencedSavedSecretRevisions: [{ resourceId, revision: 1 }], grants: [] };
            const builderGrant: MachineSecretGrantV1 = { v: 1, kind: 'secret', environmentId: environment.environmentId,
                machineId: buildMachineId, installationId: buildInstallationId, resourceId, resourceRevision: 1,
                sealedContent: 'builder-must-not-receive-backup-credentials' };
            expect(await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, owner.id, { ...input, grants: [builderGrant] })))
                .toMatchObject({ ok: false, error: 'deployment_conflict' });
            expect(await db.machineSecretGrant.count({ where: { environmentId: environment.environmentId } })).toBe(0);
            const result = await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, owner.id, input));
            expect(result).toMatchObject({ ok: true, revision: environment.revision + 1 });
            expect(await db.machineSecretGrant.count({ where: { environmentId: environment.environmentId } })).toBe(0);
            expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.environmentId } }))
                .toMatchObject({ runtimeTargetLinkId: null, contentArtifactId: prepared.contentArtifactId,
                    referencedSavedSecretRevisions: [{ resourceId, revision: 1 }] });
            return;
        }
        if (variant === 'isolation') {
            const unrelated = await db.account.create({ data: { encryptionMode: 'plain' } });
            const privateId = crypto.randomUUID();
            const privateSecret = { v: 1 as const, name: 'Private', kind: 'token' as const, value: 'private-unrelated-value' };
            expect(await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: unrelated.id, resourceId: privateId,
                displayName: privateSecret.name, kind: privateSecret.kind, encryptionMode: 'plain',
                storedContent: { t: 'plain', v: privateSecret }, accountGrants: [], teamGrants: [], groupGrants: [] })))
                .toMatchObject({ ok: true });
            const privateRows = await inTx(tx => listSavedSecretResourceMaterialsForAccountInTx(tx, unrelated.id,
                undefined, [privateId], true));
            expect(privateRows[0]?.entry).toMatchObject({ deploymentReferenceState: 'unreferenced' });
            return;
        }
        const targetContent = await artifact('deployment-target-link.v1', {});
        const linked = await inTx(tx => linkDeploymentTargetInTx(tx, owner.id, {
            serverId, environmentId: environment.environmentId, expectedRevision: environment.revision, requestKey: crypto.randomUUID(),
            targetId: 'own-server', role: 'runtime', machines: [{ machineId, installationId },
                { machineId: secondMachineId, installationId: secondInstallationId }],
            ...targetContent,
        }));
        if (!linked.ok) throw new Error(linked.error);
        content.bindings.push({ purpose: 'registry', targetLinkId: linked.targetLinkId, registryOrigin: 'https://registry.example.com',
            access: 'pushPull', source: binding.source });
        if (variant === 'operational') content.bindings.push(
            { purpose: 'backupDestination', configKey: 'destination', role: 'repositoryPassword', source: binding.source },
            { purpose: 'backupDestination', configKey: 'destination', role: 'sshPrivateKey', source: binding.source },
            { purpose: 'domainCredential', domainId: 'missing-domain-a', role: 'privateKey', source: binding.source },
            { purpose: 'domainCredential', domainId: 'missing-domain-b', role: 'privateKey', source: binding.source },
            { purpose: 'dataRole', service: 'missing-postgres-a', role: 'readOnlyPassword', source: binding.source },
            { purpose: 'dataRole', service: 'missing-postgres-b', role: 'readOnlyPassword', source: binding.source },
            { purpose: 'dataRole', targetLinkId: linked.targetLinkId, role: 'readOnlyPassword', source: binding.source },
        );
        const preparedContent = await artifact('deployment-environment.v1', content);
        const grant: MachineSecretGrantV1 = { v: 1, kind: 'secret', environmentId: environment.environmentId,
            machineId, installationId, resourceId, resourceRevision: 1, sealedContent: 'installation-sealed-ciphertext' };
        const grants: MachineSecretGrantV1[] = [grant,
            { ...grant, machineId: secondMachineId, installationId: secondInstallationId, sealedContent: 'runtime-B-sealed-ciphertext' },
            { ...grant, machineId: buildMachineId, installationId: buildInstallationId, sealedContent: 'builder-C-sealed-ciphertext' }];
        for (const row of content.bindings) {
            if (row.purpose !== 'variable' || row.source.kind === 'secret') continue;
            const destinations = row.phase === 'build' ? [{ machineId: buildMachineId, installationId: buildInstallationId }]
                : [{ machineId, installationId }, { machineId: secondMachineId, installationId: secondInstallationId }];
            for (const destination of destinations) grants.push({ v: 1, kind: 'environmentValues', environmentId: environment.environmentId,
                ...destination, binding: { purpose: 'variable', phase: row.phase, name: row.name }, sealedContent: `sealed-${row.name}` });
        }
        const input = { serverId, environmentId: environment.environmentId, expectedRevision: linked.revision,
            ...preparedContent, referencedSavedSecretRevisions: captureDeploymentBindingSavedSecretRevisionsV1(content.bindings), grants };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const url = `/v1/deployments/environments/${environment.environmentId}/bindings`;
            const headers = { 'x-test-user-id': owner.id };
            const snapshot = async () => ({
                environment: await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: environment.environmentId } }),
                grants: await db.machineSecretGrant.findMany({ where: { environmentId: environment.environmentId }, orderBy: { subjectKey: 'asc' } }),
                accounts: await db.account.findMany({ where: { id: { in: [owner.id, donor.id] } },
                    select: { id: true, seq: true }, orderBy: { id: 'asc' } }),
            });
            const refuse = async (payload: object) => {
                const before = await snapshot();
                const response = await app.inject({ method: 'POST', url, headers, payload });
                expect(response.statusCode, response.body).toBe(409);
                expect(response.json()).toEqual({ ok: false, error: 'deployment_conflict' });
                expect(await snapshot(), 'capture refusal must not partially commit grants, Environment CAS or publications').toEqual(before);
            };
            if (variant === 'operational') {
                // The bindings writer authors backup credential and self-hosted service role references itself
                // (6086f127920; backupBeforePlacement covers the former). A repository definition's services are
                // not known to the server. Domain credentials and managed data roles still need their owner.
                const ordinaryBindings = content.bindings.filter(row => row.purpose === 'variable' || row.purpose === 'registry');
                for (const binding of content.bindings.filter(row => row.purpose !== 'variable' && row.purpose !== 'registry'
                    && row.purpose !== 'backupDestination' && !(row.purpose === 'dataRole' && 'service' in row))) {
                    await refuse({ ...input, ...await artifact('deployment-environment.v1', {
                        ...content, bindings: [...ordinaryBindings, binding],
                    }) });
                }
                return;
            }
            await refuse({ ...input, referencedSavedSecretRevisions: [] });
            if (mode === 'plain') {
                await refuse({ ...input, grants: grants.filter(row => !(row.kind === 'secret' && row.machineId === secondMachineId)) });
                await refuse({ ...input, grants: grants.filter(row => !(row.kind === 'environmentValues' && row.binding.name === 'PORT')) });
                await refuse({ ...input, grants: [...grants, { v: 1, kind: 'environmentValues', environmentId: environment.environmentId,
                    machineId, installationId, binding: { purpose: 'variable', phase: 'runtime', name: 'UNBOUND' }, sealedContent: 'unbound' }] });
                await refuse({ ...input, ...await artifact('deployment-environment.v1', { ...content,
                    bindings: content.bindings.filter(row => row.purpose !== 'registry'
                        && !(row.purpose === 'variable' && row.phase === 'build' && row.source.kind === 'secret')) }) });
                await refuse({ ...input, ...await artifact('deployment-environment.v1', { ...content,
                    bindings: content.bindings.map(row => row.purpose === 'registry' ? { ...row, targetLinkId: 'missing-link' } : row) }) });
            }
            await refuse({ ...input, referencedSavedSecretRevisions: [{ resourceId, revision: 2 }],
                grants: [{ ...grant, resourceRevision: 2 }] });
            const missingId = crypto.randomUUID();
            await refuse({ ...input, referencedSavedSecretRevisions: [{ resourceId: missingId, revision: 1 }],
                grants: [{ ...grant, resourceId: missingId }] });
            if (mode === 'plain') await refuse({ ...input,
                ...await artifact('deployment-environment.v1', { ...content, bindings: [] }) });
            const stored = await db.savedSecretResource.findUniqueOrThrow({ where: { id: resourceId } });
            if (team) await db.savedSecretTeamGrant.deleteMany({ where: { resourceId, teamId: team.id } });
            else await db.savedSecretAccountGrant.deleteMany({ where: { resourceId, accountId: owner.id } });
            await refuse(input);
            if (team) await db.savedSecretTeamGrant.create({ data: { resourceId, teamId: team.id, createdByAccountId: donor.id } });
            else await db.savedSecretAccountGrant.create({ data: { resourceId, accountId: owner.id, createdByAccountId: donor.id } });
            await db.savedSecretResource.update({ where: { id: resourceId }, data: { encryptionMode: mode === 'plain' ? 'e2ee' : 'plain' } });
            await refuse(input);
            await db.savedSecretResource.update({ where: { id: resourceId }, data: { encryptionMode: stored.encryptionMode } });
            const beforeStaleInstallation = await snapshot();
            await db.machine.update({ where: { id: secondMachineId }, data: { installationId: 'replaced-B' } });
            const staleDestination = await app.inject({ method: 'POST', url, headers, payload: input });
            expect(staleDestination.statusCode, staleDestination.body).toBe(503);
            expect(staleDestination.json()).toMatchObject({ ok: false, error: 'machine_unavailable', role: 'target', machineIds: [secondMachineId] });
            expect(await snapshot(), 'one stale recipient must leave the entire A/B/C CAS unchanged').toEqual(beforeStaleInstallation);
            await db.machine.update({ where: { id: secondMachineId }, data: { installationId: secondInstallationId } });
            await db.machine.update({ where: { id: buildMachineId }, data: { installationId: 'replaced-C' } });
            const staleBuilder = await app.inject({ method: 'POST', url, headers, payload: input });
            expect(staleBuilder.statusCode, staleBuilder.body).toBe(503);
            expect(staleBuilder.json()).toMatchObject({ ok: false, error: 'machine_unavailable', role: 'build', machineIds: [buildMachineId],
                nextActions: ['start', 'chooseAnother'] });
            expect(await snapshot()).toEqual(beforeStaleInstallation);
            await db.machine.update({ where: { id: buildMachineId }, data: { installationId: buildInstallationId } });
            const accepted = await app.inject({ method: 'POST', url, headers, payload: input });
            expect(accepted.statusCode, accepted.body).toBe(200);
            expect(accepted.json()).toEqual({ ok: true, environmentId: environment.environmentId, revision: input.expectedRevision + 1 });
            expect(accepted.body).not.toContain(secret.value);
            expect((await snapshot()).environment).toMatchObject({
                referencedSavedSecretRevisions: [{ resourceId, revision: 1 }],
            });
            expect(await census()).toBe('referenced');
            expect(await deleteResource()).toEqual({ ok: false, error: 'resource_in_use' });
            expect((await snapshot()).grants).toHaveLength(grants.length);
            expect((await snapshot()).grants).toEqual(expect.arrayContaining(grants.filter(row => row.kind === 'secret').map(row => expect.objectContaining({
                machineId: row.machineId, installationId: row.installationId, resourceId, resourceRevision: 1, contentEnvelope: row.sealedContent,
            }))));
            const committed = await snapshot();
            if (variant === 'rotation') {
                const rotating = { accountId: donor.id, resourceId, expectedRevision: 1,
                    displayName: secret.name, kind: secret.kind,
                    storedContent: sealSavedSecretResourceStoredContentV1({ resourceId, mode: 'e2ee', resourceDataKey: dataKey,
                        content: { ...secret, value: 'rotated-contract-private-value' }, randomBytes: nacl.randomBytes }) };
                expect(await inTx(tx => updateSavedSecretResourceInTx(tx, { ...rotating, expectedRevision: 0 })))
                    .toEqual({ ok: false, error: 'resource_changed' });
                expect((await snapshot()).grants, 'refused rotation keeps current delivery authority').toEqual(committed.grants);
                expect(await inTx(tx => repairSavedSecretResourceKeyEnvelopesInTx(tx, { accountId: donor.id, resourceId,
                    expectedRevision: 1, keyEnvelopes: envelopes }))).toMatchObject({ ok: true, value: { revision: 1 } });
                expect((await snapshot()).grants, 'same-revision key repair keeps exact current installation grants').toEqual(committed.grants);
                const rotated = await inTx(tx => updateSavedSecretResourceInTx(tx, rotating));
                expect(rotated, JSON.stringify(rotated)).toMatchObject({ ok: true, value: { revision: 2 } });
                expect((await snapshot()).grants.filter(row => row.kind === 'secret' && row.resourceId === resourceId),
                    'rotation deletes retired ciphertext instead of retaining it for generation logs').toEqual([]);
                expect((await snapshot()).environment).toMatchObject({
                    referencedSavedSecretRevisions: [{ resourceId, revision: 1 }],
                });
                expect(await census(), 'old bindings remain references when rotation retires delivery grants').toBe('referenced');
                expect(await deleteResource()).toEqual({ ok: false, error: 'resource_in_use' });
                expect((await snapshot()).grants.filter(row => row.kind === 'environmentValues'))
                    .toEqual(committed.grants.filter(row => row.kind === 'environmentValues'));
                await refuse({ ...input, expectedRevision: accepted.json().revision });
                return;
            }
            const repeated = await app.inject({ method: 'POST', url, headers,
                payload: { ...input, expectedRevision: accepted.json().revision } });
            expect(repeated.json()).toEqual(accepted.json());
            expect(await snapshot(), 'unchanged captured inputs publish and rewrite nothing').toEqual(committed);
            if (team) {
                await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: owner.id } });
                const continued = await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': donor.id },
                    payload: { ...input, expectedRevision: accepted.json().revision } });
                expect(continued.statusCode, continued.body).toBe(200);
                expect(continued.json()).toEqual(accepted.json());
                expect(await snapshot(), 'Team grants survive departure of the binding author without re-sealing or publishing').toEqual(committed);
                // Equal-seal maintenance above needs no new Machine decision; changing the definition below does.
                await db.machineGrant.updateMany({ where: { principalKind: 'team', teamId: team.id,
                    machineId: { in: [machineId, secondMachineId, buildMachineId] } }, data: { accessLevel: 'admin' } });
            }
            const actorAccountId = team ? donor.id : owner.id;
            const currentHeaders = { 'x-test-user-id': actorAccountId };
            let currentInput = { ...input, expectedRevision: accepted.json().revision as number };
            const edit = async (nextContent: typeof content, nextGrants: MachineSecretGrantV1[]) => {
                const reference = await artifact('deployment-environment.v1', nextContent, actorAccountId);
                const payload = { ...currentInput, ...reference, grants: nextGrants };
                const response = await app.inject({ method: 'POST', url, headers: currentHeaders, payload });
                expect(response.statusCode, response.body).toBe(200);
                currentInput = { ...payload, expectedRevision: response.json().revision as number };
                const reloaded = await app.inject({ method: 'GET', url: `/v1/deployments/environments/${environment.environmentId}`,
                    headers: currentHeaders, query: { serverId } });
                expect(reloaded.statusCode, reloaded.body).toBe(200);
                expect(reloaded.json()).toMatchObject({ ok: true, environment: { ...reference, revision: currentInput.expectedRevision } });
                expect(reloaded.body).not.toContain(secret.value);
            };
            const editedContent = { ...content, bindings: content.bindings.map(row => row.purpose === 'variable' && row.name === 'PORT'
                ? { ...row, source: { kind: 'value' as const, value: '4000' } } : row) };
            const editedGrants = grants.map(row => row.kind === 'environmentValues' && row.binding.name === 'PORT'
                ? { ...row, sealedContent: 'changed-port-definition' } : row);
            await edit(editedContent, editedGrants);
            expect((await snapshot()).grants.filter(row => row.name !== 'PORT'), 'editing one row preserves sibling grants')
                .toEqual(committed.grants.filter(row => row.name !== 'PORT'));
            await edit({ ...editedContent, bindings: editedContent.bindings.filter(row => row.purpose !== 'variable' || row.name !== 'PORT') },
                editedGrants.filter(row => row.kind !== 'environmentValues' || row.binding.name !== 'PORT'));
            const beforeWithdrawal = await snapshot();
            expect(beforeWithdrawal.grants.filter(row => row.name === 'PORT')).toEqual([]);
            expect(beforeWithdrawal.grants.filter(row => row.name !== 'PORT')).toEqual(committed.grants.filter(row => row.name !== 'PORT'));
            const withdrawn = await inTx(tx => setSavedSecretResourceGrantsInTx(tx, {
                accountId: donor.id, resourceId, expectedRevision: 1, accountGrants: [], teamGrants: [], groupGrants: [],
                keyEnvelopes: envelopes.filter(envelope => envelope.recipientAccountId === donor.id),
            }));
            expect(withdrawn).toMatchObject({ ok: true });
            expect((await snapshot()).grants.filter(row => row.kind === 'secret' && row.resourceId === resourceId),
                'withdrawal retires obsolete installation ciphertext at the resource mutation owner').toEqual([]);
            expect((await snapshot()).grants.filter(row => row.kind === 'environmentValues'))
                .toEqual(beforeWithdrawal.grants.filter(row => row.kind === 'environmentValues'));
            const revoked = await snapshot();
            const refused = await app.inject({ method: 'POST', url, headers: team ? { 'x-test-user-id': donor.id } : headers,
                payload: { ...currentInput,
                    grants: currentInput.grants.map((row, index) => index === 0 ? { ...row, sealedContent: 'must-not-commit' } : row) } });
            expect(refused.statusCode, refused.body).toBe(409);
            expect(await snapshot()).toEqual(revoked);
            const unboundContent = { ...content, bindings: [] };
            const unboundReference = await artifact('deployment-environment.v1', unboundContent, actorAccountId);
            const unboundInput = { ...currentInput, ...unboundReference, grants: [], referencedSavedSecretRevisions: [] };
            const unbound = await app.inject({ method: 'POST', url, headers: currentHeaders, payload: unboundInput });
            expect(unbound.statusCode, unbound.body).toBe(200);
            expect(await census()).toBe('unreferenced');
            const environmentUrl = `/v1/deployments/environments/${environment.environmentId}`;
            const editInput = { serverId, environmentId: environment.environmentId,
                expectedRevision: unbound.json().revision, ...unboundReference };
            const same = await app.inject({ method: 'PATCH', url: environmentUrl, headers: currentHeaders, payload: editInput });
            expect(same.statusCode, same.body).toBe(200);
            expect(same.json().revision).toBe(editInput.expectedRevision);
            expect(await census(), 'same Artifact pointer retains the established capture').toBe('unreferenced');
            const opaqueReference = await artifact('deployment-environment.v1', unboundContent, actorAccountId);
            const edited = await app.inject({ method: 'PATCH', url: environmentUrl, headers: currentHeaders,
                payload: { ...editInput, ...opaqueReference } });
            expect(edited.statusCode, edited.body).toBe(200);
            expect(await census(), 'ordinary admitted content edits preserve bindings and their captures').toBe('unreferenced');
            const recaptured = await app.inject({ method: 'POST', url, headers: currentHeaders,
                payload: { ...unboundInput, ...opaqueReference, expectedRevision: edited.json().revision } });
            expect(recaptured.statusCode, recaptured.body).toBe(200);
            expect(await census()).toBe('unreferenced');
            expect(await deleteResource()).toMatchObject({ ok: true });
            expect(await db.savedSecretResource.findUnique({ where: { id: resourceId } })).toBeNull();
        });
    }

    it.each(['plain', 'e2ee', 'team'] as const)('commits %s captures atomically and rechecks resource authority at the actual binding transaction', roundtrip);
    it('retires rotated exact grants while preserving same-revision repair and non-secret delivery', () => roundtrip('rotation'));
    it('keeps another Account never-shared private resource independent of an opaque Environment', () => roundtrip('isolation'));
    it('authors backup credential references through the binding transaction before placement', () => roundtrip('backupBeforePlacement'));
    it('refuses operational purposes without a current destination, Domain or data/native owner', () => roundtrip('operational'));

    it('seals a live managed data role only to the Environment controller', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const controller = { machineId: crypto.randomUUID(), installationId: crypto.randomUUID() };
        const target = { machineId: crypto.randomUUID(), installationId: crypto.randomUUID() };
        const installationKeys = [nacl.sign.keyPair(), nacl.sign.keyPair()];
        await db.machine.createMany({ data: [controller, target].map((machine, index) => ({ id: machine.machineId,
            installationId: machine.installationId, installationPublicKey: new Uint8Array(installationKeys[index]!.publicKey),
            accountId: owner.id, ...publishedMachine })) });
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId,
            requestKey: crypto.randomUUID(), name: 'Managed data role controller', audience: [] }));
        if (!source.ok) throw new Error(source.error);
        const resourceId = crypto.randomUUID();
        const resource = await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
            displayName: 'Managed readonly password', kind: 'token', encryptionMode: 'plain', accountGrants: [], teamGrants: [],
            storedContent: { t: 'plain', v: { v: 1, name: 'Managed readonly password', kind: 'token', value: 'private-password' } } }));
        if (!resource.ok) throw new Error(resource.error);
        const artifact = async (kind: string, body: unknown) => {
            const created = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Managed data role controller' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(body) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!created.ok) throw new Error(created.error);
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        const baseContent = DeploymentEnvironmentContentV1Schema.parse({ name: 'Managed data role controller', retainPreviousDeployments: 1,
            definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } }, bindings: [] });
        const initialReference = await artifact('deployment-environment.v1', baseContent);
        const environment = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, { serverId,
            projectSourceId: source.source.id, requestKey: crypto.randomUUID(), controllerMachineId: controller.machineId,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            ...initialReference }));
        if (!environment.ok) throw new Error(environment.error);
        const linkReference = await artifact('deployment-target-link.v1', {});
        const link = await inTx(tx => linkDeploymentTargetInTx(tx, owner.id, { serverId,
            environmentId: environment.environmentId, expectedRevision: environment.revision, requestKey: crypto.randomUUID(),
            targetId: 'acme.managed-postgres/database', role: 'data', targetKind: 'database', machines: [],
            source: { kind: 'plugin', contribution: { pluginId: 'acme.managed-postgres', localId: 'database' } },
            ...linkReference }));
        if (!link.ok) throw new Error(link.error);
        const secretSource = { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: resource.value.revision };
        const definition = DeploymentEnvironmentContentV1Schema.parse({ ...baseContent, bindings: [{ purpose: 'dataRole',
            targetLinkId: link.targetLinkId, role: 'readOnlyPassword', source: secretSource }] });
        const controllerGrant: MachineSecretGrantV1 = { v: 1, kind: 'secret', environmentId: environment.environmentId,
            ...controller, resourceId, resourceRevision: resource.value.revision, sealedContent: 'controller-only-readonly-seal' };
        const bindingReference = await artifact('deployment-environment.v1', definition);
        const bound = await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, owner.id, { serverId,
            environmentId: environment.environmentId, expectedRevision: link.revision,
            ...bindingReference, grants: [controllerGrant],
            referencedSavedSecretRevisions: captureDeploymentBindingSavedSecretRevisionsV1(definition.bindings) }));
        expect(bound).toMatchObject({ ok: true, environmentId: environment.environmentId });
        if (!bound.ok) throw new Error(bound.error);
        expect(await db.machineSecretGrant.findMany({ where: { environmentId: environment.environmentId },
            select: { machineId: true, installationId: true, contentEnvelope: true } })).toEqual([{ ...controller,
            contentEnvelope: controllerGrant.sealedContent }]);
        const preparation = await inTx(tx => readEnvironmentSecretLaunchAdmissionInTx(tx, owner.id, { kind: 'clientBindings', serverId,
            environmentId: environment.environmentId, expectedRevision: bound.revision, dataRoleTargetLinkIds: [link.targetLinkId] }));
        expect(preparation).toMatchObject({ ok: true, bindingPreparation: { runtimeInstallations: [],
            controllerInstallation: expect.objectContaining(controller) } });
        const nativeDefinition = DeploymentEnvironmentContentV1Schema.parse({ ...baseContent, bindings: [{ purpose: 'dataRole',
            service: 'postgres', role: 'readOnlyPassword', source: secretSource }] });
        const nativeReference = await artifact('deployment-environment.v1', nativeDefinition);
        expect(await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, owner.id, { serverId,
            environmentId: environment.environmentId, expectedRevision: bound.revision,
            ...nativeReference, grants: [controllerGrant],
            referencedSavedSecretRevisions: captureDeploymentBindingSavedSecretRevisionsV1(nativeDefinition.bindings) })))
            .toEqual({ ok: false, error: 'deployment_conflict' });
    });
});
