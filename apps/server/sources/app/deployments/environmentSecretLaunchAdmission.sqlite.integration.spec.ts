import { teamResourceGrantFixture } from '@/testkit/resourceGrant.testkit';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import nacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent,
    encodePlainArtifactStoredContent, signMachineInstallationProof, encodeBase64 } from '@happier-dev/protocol';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { MachineSetupApplyInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { prepareEnvironmentSecretBindingsV1 } from '@happier-dev/deployments';
import { createMachineSetupEffectPlan } from '@happier-dev/cli-common/machineSetup';
import { getActionSpec } from '@happier-dev/protocol';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { sealSavedSecretResourceStoredContentV1 } from '@happier-dev/protocol/account/settings/savedSecretResourceContentV1';
import { computeContentPublicKeyFingerprint, sealEncryptedDataKeyEnvelopeV1, sealSessionDataKeyBundleV0 } from '@happier-dev/protocol';
import { DeploymentEnvironmentContentV1Schema, captureDeploymentBindingSavedSecretRevisionsV1, computeEnvironmentSecretLaunchAdmissionDigestV1, EnvironmentSecretLaunchAdmissionBodyV1Schema, EnvironmentSecretLaunchAdmissionResultV1Schema,
    machineSecretGrantSubjectKey, type EnvironmentSecretLaunchAdmissionBodyV1, type MachineSecretGrantV1 } from '@happier-dev/deployment-protocol';
import { db } from '@/storage/db';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';
import { setEligibleMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { inTx } from '@/storage/inTx';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { initEncrypt } from '@/modules/encrypt';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { observeDeploymentDomainNativeForTest } from '@/testkit/observedDeploymentDomain.testkit';
import { createAuthenticatedTestApp, withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { accountRoutes } from '@/app/api/routes/account/accountRoutes';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { createProjectSourceInTx, updateProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createSavedSecretResourceInTx, setSavedSecretResourceGrantsInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { auth } from '@/app/auth/auth';
import { computeExternalActionRequestEnvelopeDigestV1, encodeExternalActionResolvedTargetV1,
    signExternalActionMachineRequestV1, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
    EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
    EXTERNAL_ACTION_RESOLVED_TARGET_HEADER } from '@happier-dev/protocol/actions';
import { projectDeploymentReadAdmissionV1, projectDeploymentPreparationAdmissionV1, projectDeploymentNativeAdmissionV1, DeploymentPreparationAdmissionV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { projectRegistryAppUpdateAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { createDeploymentEnvironmentInTx, setDeploymentEnvironmentBindingsInTx, updateDeploymentEnvironmentInTx } from './deploymentEnvironmentService';
import { linkDeploymentTargetInTx } from './deploymentTargetLinkService';
import { createDeploymentInTx } from './deploymentService';
import { readEnvironmentSecretLaunchAdmissionInTx } from './environmentSecretLaunchAdmission';
import { syncEnvironmentSecretGrantsInTx } from './environmentSecretGrantRepository';
import { createDeploymentDomainInTx } from './deploymentDomainService';
import type { Server } from 'socket.io';
import { Server as SocketServer } from 'socket.io';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { createExternalActionDaemonDispatcher, type ExternalActionForwardRpcCall } from '@/app/api/socket/externalActionDispatcher';
import { withTempDir } from '../../../../cli/src/testkit/fs/tempDir';
import { createEnvKeyScope } from '../../../../cli/src/testkit/env/envScope';
import { seedTestServerProfile } from '../../../../cli/src/testkit/serverProfiles';
import { reloadConfiguration } from '../../../../cli/src/configuration';
import { readOrCreateInstallationIdentitySync } from '../../../../cli/src/daemon/identity/store';
import { createDeploymentTargetRoleAdmissionHost } from '../../../../cli/src/deployments/targets/createDeploymentTargetRoleAdmissionHost';
import { createManagedDataRoleSecretReaderForHost } from '../../../../cli/src/deployments/secrets/createManagedDataRoleSecretReaderForHost';
import { sealMachineSecretGrant } from '../../../../cli/src/deployments/secrets/machineSecretGrant';
import { createDeclaredPluginSecretsService } from '../../../../cli/src/plugins/runtime/context/secrets';
import { admitRequesterAccountActionContext } from '../../../../cli/src/daemon/sessionEncryption/requesterAccountActionProjection';
import { projectExternalActionRequesterHttpAuthorization } from '../../../../cli/src/api/externalActionExecutionAuthorization';
import { managedDataQueryPostgresAvailable, managedQueryProviderHttp, managedQueryRolePassword,
    startManagedQueryPostgres } from '../../../../cli/src/plugins/runtime/invocation/managedDataQueryPostgresql.testkit';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { DATABASE_STATEMENT_RUN_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIdsDatabaseV1';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import * as neonEntry from '../../../../../packages/plugins/deployment-neon/src/index.js';

describe('private installed Environment secret launch transport', () => {
    const serverId = `srv_${'c'.repeat(32)}`;
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'happier-secret-launch-',
            env: { HAPPIER_SERVER_IDENTITY_ID: serverId,
                HANDY_MASTER_SECRET: 'happier-disposable-environment-secret-launch-master' } });
        await auth.init();
        await initEncrypt();
    }, 180_000);
    afterAll(async () => { await harness?.close(); });

    async function admittedTeamDelivery(mode: 'plain' | 'e2ee' = 'plain', distinctController = false, roleService?: string,
        runtimePlacement: 'host' | 'plugin' = 'host', secretValue = 'launch-trims-private-sentinel') {
        const ownerKey = nacl.box.keyPair(), requesterKey = nacl.box.keyPair();
        const owner = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(ownerKey.publicKey) : {}) } });
        const requester = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(requesterKey.publicKey) : {}) } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Admitted delivery principal' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: 'owner' },
            { teamId: team.id, accountId: requester.id, role: 'admin' },
        ] });
        const keys = nacl.sign.keyPair();
        const machineId = crypto.randomUUID(), installationId = crypto.randomUUID();
        const metadata = MachinePublishedMetadataV1Schema.parse({ host: 'delivery-host', platform: 'linux',
            happyCliVersion: '0.0.0-test', homeDir: '/home/happier', happyHomeDir: '/home/happier/.happier' });
        await db.machine.create({ data: { id: machineId, accountId: custodian.id,
            metadata: encodePlainMachineStoredContent(metadata), dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId,
            installationPublicKey: new Uint8Array(keys.publicKey) } });
        await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'view', createdByAccountId: owner.id }), machineId } });
        // The definition/binding writer manages the Machine; workload delivery
        // retains only the Team's View grant, including the separate requester.
        expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId,
            principal: { kind: 'account', accountId: owner.id }, level: 'admin' }))).toMatchObject({ kind: 'saved' });
        const controller = distinctController ? {
            machineId: crypto.randomUUID(), installationId: crypto.randomUUID(), keys: nacl.sign.keyPair(),
        } : { machineId, installationId, keys };
        if (distinctController) {
            const controllerCustodian = await db.account.create({ data: { encryptionMode: 'plain' } });
            await db.machine.create({ data: { id: controller.machineId, accountId: controllerCustodian.id,
                metadata: encodePlainMachineStoredContent(metadata), dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
                installationId: controller.installationId, installationPublicKey: new Uint8Array(controller.keys.publicKey) } });
            await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'view', createdByAccountId: owner.id }), machineId: controller.machineId } });
            expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: controllerCustodian.id,
                machineId: controller.machineId, principal: { kind: 'account', accountId: owner.id }, level: 'admin' })))
                .toMatchObject({ kind: 'saved' });
        }
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Admitted delivery', audience: [],
            owner: { kind: 'team', teamId: team.id },
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'acme/delivery', cloneUrl: 'https://github.com/acme/delivery.git' }, protocol: 'https' },
        }));
        if (!source.ok) throw new Error(source.error);
        async function artifact(kind: string, content: unknown = {}) {
            const dataKey = nacl.randomBytes(32);
            const created = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                kind: `v1:other:${kind}`,
                header: mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Admitted delivery' }))
                    : new Uint8Array(await sealSessionDataKeyBundleV0({ kind, title: 'Admitted delivery' }, dataKey)),
                body: mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(content) }))
                    : new Uint8Array(await sealSessionDataKeyBundleV0({ body: JSON.stringify(content) }, dataKey)),
                dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)
                    : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: ownerKey.publicKey, randomBytes: nacl.randomBytes })) });
            if (!created.ok) throw new Error(created.error);
            await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: owner.id }), artifactId: created.artifact.id } });
            if (mode === 'e2ee') await db.artifactKeyEnvelope.create({ data: { artifactId: created.artifact.id,
                recipientAccountId: requester.id, encryptedDataKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey,
                    recipientPublicKey: requesterKey.publicKey, randomBytes: nacl.randomBytes })),
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(requesterKey.publicKey) } });
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        }
        const content = DeploymentEnvironmentContentV1Schema.parse({ name: 'Delivery', retainPreviousDeployments: 1,
            definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } }, bindings: [] });
        const environmentContent = await artifact('deployment-environment.v1', content);
        const environment = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
            serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(), controllerMachineId: controller.machineId, buildMachineId: machineId,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            ...environmentContent,
        }));
        if (!environment.ok) throw new Error(environment.error);
        const targetContent = await artifact('deployment-target-link.v1');
        const linked = await inTx(tx => linkDeploymentTargetInTx(tx, owner.id, { serverId,
            environmentId: environment.environmentId, expectedRevision: environment.revision,
            ...(runtimePlacement === 'host' ? { targetId: 'own-server' as const, machines: [{ machineId, installationId }] }
                : { source: { kind: 'plugin' as const, contribution: { pluginId: 'acme.daemon-runtime', localId: 'runtime' } },
                    targetKind: 'platform' as const, machineId, installationId, machines: [] }),
            role: 'runtime', requestKey: crypto.randomUUID(), ...targetContent }));
        if (!linked.ok) throw new Error(linked.error);
        const resourceId = crypto.randomUUID();
        const resourceKey = nacl.randomBytes(32);
        const resourceContent = { v: 1 as const, name: 'Delivery credential', kind: 'token' as const, value: secretValue };
        const envelopes = (dataKey: Uint8Array, recipients: readonly Readonly<{ id: string; publicKey: Uint8Array }>[]) =>
            mode === 'plain' ? [] : recipients.map(recipient => ({ recipientAccountId: recipient.id,
                encryptedDataKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: recipient.publicKey,
                    randomBytes: nacl.randomBytes })), recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(recipient.publicKey) }));
        const recipients = [{ id: owner.id, publicKey: ownerKey.publicKey }, { id: requester.id, publicKey: requesterKey.publicKey }];
        const resource = await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: owner.id, resourceId,
            displayName: 'Delivery credential', kind: 'token', encryptionMode: mode, teamGrants: [team.id], accountGrants: [],
            keyEnvelopes: envelopes(resourceKey, recipients), storedContent: sealSavedSecretResourceStoredContentV1(mode === 'plain'
                ? { resourceId, mode, content: resourceContent }
                : { resourceId, mode, resourceDataKey: resourceKey, content: resourceContent, randomBytes: nacl.randomBytes }) }));
        if (!resource.ok) throw new Error(resource.error);
        const grant: MachineSecretGrantV1 = { v: 1, kind: 'secret', environmentId: environment.environmentId,
            machineId, installationId, resourceId, resourceRevision: resource.value.revision, sealedContent: 'launch-trims-installed-ciphertext' };
        const secretSource = { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: resource.value.revision };
        const boundDefinition = DeploymentEnvironmentContentV1Schema.parse({ ...content, bindings: [roleService
            ? { purpose: 'dataRole', service: roleService, role: 'readOnlyPassword', source: secretSource }
            : { purpose: 'variable', phase: 'runtime', name: 'TOKEN', grantRef: crypto.randomUUID(), source: secretSource }] });
        const boundContent = await artifact('deployment-environment.v1', boundDefinition);
        const preparedBindings = { grants: [grant],
            referencedSavedSecretRevisions: roleService ? captureDeploymentBindingSavedSecretRevisionsV1(boundDefinition.bindings)
                : [{ resourceId, revision: resource.value.revision }] };
        // A plugin link's bindings writer owns provider variables and adds no
        // Machine grants; its runtime grants come from the Environment writer.
        const bound = await inTx(tx => runtimePlacement === 'plugin'
            ? updateDeploymentEnvironmentInTx(tx, owner.id, { serverId, environmentId: environment.environmentId,
                expectedRevision: linked.revision, ...boundContent, preparedBindings })
            : setDeploymentEnvironmentBindingsInTx(tx, owner.id, { serverId,
                environmentId: environment.environmentId, expectedRevision: linked.revision, ...boundContent, ...preparedBindings }));
        if (!bound.ok) throw new Error(bound.error);
        const actionOperationId = crypto.randomUUID();
        const candidate = await artifact('deployment-receipt.v1');
        const receiptInput = { serverId, environmentId: environment.environmentId, expectedRevision: bound.revision,
            targetLinkId: linked.targetLinkId, expectedTargetLinkRevision: linked.targetLinkRevision,
            requestKey: crypto.randomUUID(), actionOperationId, ...candidate };
        const target = { kind: 'machine' as const, machineId: controller.machineId };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input: receiptInput };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: requester.id, authentication: { kind: 'account', tokenEpoch: requester.tokenEpoch },
            actionId: 'deployments.deploy', machineId: controller.machineId, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input: receiptInput });
        const receipt = await inTx(tx => createDeploymentInTx(tx, requester.id, receiptInput, 'deploy', {}, authorization.binding));
        if (!receipt.ok) throw new Error(receipt.error);
        if (!('deploymentId' in receipt)) throw new Error('Expected an admitted Team deployment');
        const body: EnvironmentSecretLaunchAdmissionBodyV1 = { serverId, environmentId: environment.environmentId,
            targetLinkId: linked.targetLinkId, machineId, installationId,
            materialization: { kind: 'deployment', deploymentId: receipt.deploymentId, actionOperationId } };
        const payload = { ...body, proof: signMachineInstallationProof({ payload: { version: 1, machineId, installationId,
            accountId: requester.id, deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } },
            privateKey: keys.secretKey }) };
        return { owner, requester, team, keys, controller, authorization, resourceId, resourceRevision: resource.value.revision, grant, payload,
            artifact, content, envelopes, recipients, receipt,
            url: `/v1/deployments/environments/${environment.environmentId}/secret-launch-admission` };
    }


    it('keeps query sibling reads on the exact admitted receipt at the scope owner', async () => {
        const f = await admittedTeamDelivery('plain', false, 'postgres');
        const { isDeploymentReadOperandInAdmittedScopeInTx } = await import('./deploymentPreparationAuthorization');
        const row = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.payload.environmentId } });
        const receipt = await db.deployment.findUniqueOrThrow({ where: { id: f.receipt.deploymentId } });
        const content = await f.artifact('deployment-receipt.v1');
        const other = await db.deployment.create({ data: { ...receipt, id: crypto.randomUUID(),
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), ...content } });
        const admission = projectDeploymentReadAdmissionV1('deployments.data.query', { serverId,
            environmentId: row.id, expectedRevision: row.revision, targetLinkId: receipt.targetLinkId,
            deploymentId: receipt.id, machineId: f.payload.machineId,
            installationId: f.payload.installationId, service: 'postgres', sql: 'SELECT 1', params: {} });
        const binding = { ...f.authorization.binding, actionId: 'deployments.data.query',
            deploymentNativeAdmission: undefined, deploymentReadAdmission: admission };
        for (const [deploymentId, expected] of [[receipt.id, true], [other.id, false]] as const) {
            expect(await isDeploymentReadOperandInAdmittedScopeInTx(db, binding,
                { serverId, environmentId: row.id, deploymentId }, undefined, undefined,
                'deployments.receipts.get')).toBe(expected);
        }
    });
    it('keeps health Domain reads on the live admitted target at the scope owner', async () => {
        const f = await admittedTeamDelivery();
        const { isDeploymentReadOperandInAdmittedScopeInTx: inScope } = await import('./deploymentPreparationAuthorization');
        const link = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: f.payload.targetLinkId } });
        const other = await db.deploymentTargetLink.create({ data: { ...link, id: crypto.randomUUID(),
            ...await f.artifact('deployment-target-link.v1') } });
        const binding = { ...f.authorization.binding, actionId: 'deployments.health.current',
            deploymentNativeAdmission: undefined, deploymentReadAdmission: projectDeploymentReadAdmissionV1('deployments.health.current', {
                serverId, environmentId: link.environmentId, targetLinkId: link.id, machineId: f.payload.machineId }) };
        for (const [targetLinkId, deletedAt, expected] of [[link.id, null, true], [other.id, null, false],
            [link.id, new Date(), false]] as const) {
            const domain = await db.deploymentDomain.create({ data: { environmentId: link.environmentId, targetLinkId,
                state: 'pending', deletedAt, createdByAccountId: f.owner.id, ...await f.artifact('deployment-domain.v1') } });
            expect(await inScope(db, binding, { serverId, environmentId: link.environmentId, domainId: domain.id },
                undefined, undefined, 'deployments.domains.get')).toBe(expected);
        }
    });

    it('admits a restore source by its own active receipt rather than the destination receipt', async () => {
        const f = await admittedTeamDelivery();
        const destination = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.payload.environmentId } });
        const destinationReceipt = await db.deployment.findUniqueOrThrow({ where: { id: f.receipt.deploymentId } });
        const destinationLink = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: f.payload.targetLinkId }, include: { machines: true } });
        const source = await db.deploymentEnvironment.create({ data: { ...destination, id: crypto.randomUUID(),
            revision: destination.revision + 3, runtimeTargetLinkId: null,
            ...await f.artifact('deployment-environment.v1') } });
        const { machines, ...link } = destinationLink;
        const sourceLink = await db.deploymentTargetLink.create({ data: { ...link, id: crypto.randomUUID(),
            environmentId: source.id, activeDeploymentId: null,
            machines: { create: machines.map(({ id: _id, targetLinkId: _targetLinkId, ...member }) => ({ ...member, state: 'active' })) },
            ...await f.artifact('deployment-target-link.v1') } });
        const sourceReceipt = await db.deployment.create({ data: { ...destinationReceipt, id: crypto.randomUUID(),
            environmentId: source.id, targetLinkId: sourceLink.id, requestKey: crypto.randomUUID(),
            actionOperationId: crypto.randomUUID(), ...await f.artifact('deployment-receipt.v1') } });
        await db.deploymentEnvironment.update({ where: { id: source.id }, data: { runtimeTargetLinkId: sourceLink.id } });
        await db.deploymentTargetLink.update({ where: { id: sourceLink.id }, data: { activeDeploymentId: sourceReceipt.id } });
        await db.deploymentTargetLink.update({ where: { id: destinationLink.id }, data: { activeDeploymentId: destinationReceipt.id } });
        const input = { serverId, environmentId: destination.id, targetLinkId: destinationLink.id,
            deploymentId: sourceReceipt.id, expectedRevision: destination.revision,
            machineId: f.payload.machineId, installationId: f.payload.installationId, mode: 'prepare' as const,
            source: { kind: 'repository' as const, snapshotId: 'a'.repeat(64),
                origin: { environmentId: source.id, targetLinkId: sourceLink.id } } };
        const mint = (value: typeof input) => {
            const requestId = crypto.randomUUID(), target = { kind: 'machine' as const, machineId: f.payload.machineId };
            return auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
                accountId: f.requester.id, authentication: { kind: 'account', tokenEpoch: f.requester.tokenEpoch },
                actionId: 'deployments.backups.restore', machineId: f.payload.machineId, target, requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId, target, input: value }) },
            { input: value });
        };
        await expect(mint(input)).resolves.toMatchObject({ binding: { environmentId: destination.id } });
        await expect(mint({ ...input, deploymentId: destinationReceipt.id }))
            .rejects.toMatchObject({ code: 'credential_scope_denied' });
        await expect(mint({ ...input, expectedRevision: destination.revision + 1 }))
            .rejects.toMatchObject({ code: 'source_changed' });
        await expect(mint({ ...input, source: { ...input.source,
            origin: { environmentId: source.id, targetLinkId: destinationLink.id } } }))
            .rejects.toMatchObject({ code: 'credential_scope_denied' });
        await db.deploymentTargetLink.update({ where: { id: sourceLink.id }, data: { activeDeploymentId: null } });
        await expect(mint(input)).rejects.toMatchObject({ code: 'credential_scope_denied' });
    });

    it.each(['plain', 'e2ee'] as const)('spends the admitted %s restore root on its current destination read role', async mode => {
        const f = await admittedTeamDelivery(mode, false, 'postgres');
        const row = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.payload.environmentId } });
        const captured = await db.deployment.update({ where: { id: f.receipt.deploymentId }, data: { state: 'succeeded' } });
        await db.deploymentTargetLink.update({ where: { id: f.payload.targetLinkId }, data: { activeDeploymentId: captured.id,
            machines: { updateMany: { where: { machineId: f.payload.machineId, installationId: f.payload.installationId },
                data: { state: 'active' } } } } });
        const actionId = 'deployments.backups.restore' as const;
        const input = { serverId, environmentId: row.id, targetLinkId: f.payload.targetLinkId,
            deploymentId: captured.id, expectedRevision: row.revision, machineId: f.payload.machineId,
            installationId: f.payload.installationId, mode: 'confirm' as const, prepareOperationId: crypto.randomUUID(),
            source: { kind: 'repository' as const, snapshotId: 'a'.repeat(64) },
            destination: { kind: 'database' as const, service: 'postgres', database: 'app' } };
        const target = { kind: 'machine' as const, machineId: input.machineId };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.requester.id, authentication: { kind: 'account', tokenEpoch: f.requester.tokenEpoch },
            actionId, machineId: input.machineId, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        const active = await db.deployment.create({ data: { ...captured, id: crypto.randomUUID(),
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), ...await f.artifact('deployment-receipt.v1') } });
        await db.deploymentTargetLink.update({ where: { id: input.targetLinkId }, data: { activeDeploymentId: active.id } });
        await db.deploymentEnvironment.update({ where: { id: row.id }, data: { revision: { increment: 1 } } });
        await db.teamMembership.delete({ where: { teamId_accountId: { teamId: f.team.id, accountId: f.requester.id } } });
        const request = (changes: Partial<EnvironmentSecretLaunchAdmissionBodyV1> = {}) => {
            const body: EnvironmentSecretLaunchAdmissionBodyV1 = { serverId, environmentId: row.id,
                targetLinkId: input.targetLinkId, machineId: input.machineId, installationId: input.installationId,
                materialization: { kind: 'dataRole', expectedRevision: row.revision + 1,
                    deploymentId: active.id, service: input.destination.service }, ...changes };
            const payload = { ...body, proof: signMachineInstallationProof({ payload: { version: 1,
                accountId: f.requester.id, machineId: body.machineId, installationId: body.installationId,
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } },
                privateKey: f.keys.secretKey }) };
            return { method: 'POST' as const, url: f.url, payload, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: actionId, target, installationId: input.installationId, requestId: envelope.requestId,
                    method: 'POST', path: f.url, body: payload, privateKey: f.keys.secretKey }),
            } };
        };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const allowed = await app.inject(request());
            expect(allowed.statusCode, allowed.body).toBe(200);
            expect(allowed.json()).toMatchObject({ ok: true, grants: [f.grant] });
            for (const changes of [
                { materialization: { kind: 'dataRole' as const, expectedRevision: row.revision + 1,
                    deploymentId: captured.id, service: 'postgres' } },
                { materialization: { kind: 'dataRole' as const, expectedRevision: row.revision + 1,
                    deploymentId: active.id, service: 'other-service' } },
                { targetLinkId: crypto.randomUUID() }, { machineId: crypto.randomUUID() },
            ]) expect((await app.inject(request(changes))).statusCode).toBe(401);
        }, { authentication: 'real' });
    });

    it.each(['plain', 'e2ee'] as const)('spends the admitted %s size root only on its signed native service', async mode => {
        const f = await admittedTeamDelivery(mode, false, 'postgres');
        const row = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.payload.environmentId } });
        await db.deployment.update({ where: { id: f.receipt.deploymentId }, data: { state: 'succeeded' } });
        await db.deploymentTargetLink.update({ where: { id: f.payload.targetLinkId }, data: { activeDeploymentId: f.receipt.deploymentId,
            machines: { updateMany: { where: { machineId: f.payload.machineId, installationId: f.payload.installationId },
                data: { state: 'active' } } } } });
        const actionId = 'deployments.data.size' as const;
        const input = { serverId, environmentId: row.id, targetLinkId: f.payload.targetLinkId,
            deploymentId: f.receipt.deploymentId, expectedRevision: row.revision, machineId: f.payload.machineId,
            installationId: f.payload.installationId, service: 'postgres' };
        const target = { kind: 'machine' as const, machineId: input.machineId };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.requester.id, authentication: { kind: 'account', tokenEpoch: f.requester.tokenEpoch },
            actionId, machineId: input.machineId, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            deploymentReadAdmission: projectDeploymentReadAdmissionV1(actionId, input) }, { input });
        await db.deploymentEnvironment.update({ where: { id: row.id }, data: { revision: { increment: 1 } } });
        await db.teamMembership.delete({ where: { teamId_accountId: { teamId: f.team.id, accountId: f.requester.id } } });
        const request = (service = input.service) => {
            const body: EnvironmentSecretLaunchAdmissionBodyV1 = { serverId, environmentId: row.id,
                targetLinkId: input.targetLinkId, machineId: input.machineId, installationId: input.installationId,
                materialization: { kind: 'dataRole', expectedRevision: input.expectedRevision,
                    deploymentId: input.deploymentId, service } };
            const payload = { ...body, proof: signMachineInstallationProof({ payload: { version: 1,
                accountId: f.requester.id, machineId: body.machineId, installationId: body.installationId,
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } },
                privateKey: f.keys.secretKey }) };
            return { method: 'POST' as const, url: f.url, payload, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: actionId, target, installationId: input.installationId, requestId: envelope.requestId,
                    method: 'POST', path: f.url, body: payload, privateKey: f.keys.secretKey }),
            } };
        };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const allowed = await app.inject(request());
            expect(allowed.statusCode, allowed.body).toBe(200);
            expect(allowed.json()).toMatchObject({ ok: true, grants: [f.grant] });
            expect((await app.inject(request('another-service'))).statusCode).toBe(401);
        }, { authentication: 'real' });
    });

    it('keeps backup receipt selection on the destination and copy-source targets at the scope owner', async () => {
        const f = await admittedTeamDelivery();
        const { isDeploymentReadOperandInAdmittedScopeInTx: inScope } = await import('./deploymentPreparationAuthorization');
        const row = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.payload.environmentId } });
        const receipt = await db.deployment.findUniqueOrThrow({ where: { id: f.receipt.deploymentId } });
        const link = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: receipt.targetLinkId } });
        const sourceLink = await db.deploymentTargetLink.create({ data: { ...link, id: crypto.randomUUID(),
            activeDeploymentId: null, ...await f.artifact('deployment-target-link.v1') } });
        const active = await db.deployment.create({ data: { ...receipt, id: crypto.randomUUID(),
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), ...await f.artifact('deployment-receipt.v1') } });
        const sourceActive = await db.deployment.create({ data: { ...receipt, id: crypto.randomUUID(), targetLinkId: sourceLink.id,
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID(), ...await f.artifact('deployment-receipt.v1') } });
        await db.deploymentTargetLink.update({ where: { id: link.id }, data: { activeDeploymentId: active.id } });
        await db.deploymentTargetLink.update({ where: { id: sourceLink.id }, data: { activeDeploymentId: sourceActive.id } });
        const binding = { ...f.authorization.binding, actionId: 'deployments.backups.restore',
            deploymentNativeAdmission: projectDeploymentNativeAdmissionV1('deployments.backups.restore', { serverId,
                environmentId: row.id, targetLinkId: link.id, deploymentId: receipt.id, expectedRevision: row.revision,
                machineId: f.payload.machineId, installationId: f.payload.installationId, mode: 'prepare',
                source: { kind: 'repository', snapshotId: 'snapshot', origin: { environmentId: row.id, targetLinkId: sourceLink.id } } }) };
        for (const [deploymentId, expected] of [[receipt.id, true], [active.id, true], [sourceActive.id, false]] as const)
            expect(await inScope(db, binding, { serverId, environmentId: row.id, deploymentId },
                undefined, undefined, 'deployments.receipts.get')).toBe(expected);
    });

    it('keeps catalog Source revision and setup receiver selections at the scope owner', async () => {
        const f = await admittedTeamDelivery();
        const { isDeploymentReadOperandInAdmittedScopeInTx: inScope } = await import('./deploymentPreparationAuthorization');
        const row = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.payload.environmentId } });
        const source = await db.projectSource.findUniqueOrThrow({ where: { id: row.projectSourceId } });
        const binding = { ...f.authorization.binding, actionId: 'deployments.publish.prepare', deploymentNativeAdmission: undefined,
            deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('deployments.publish.prepare', { serverId,
                projectSourceId: source.id, sourceRevision: source.revision, machineId: f.controller.machineId,
                installationId: f.authorization.binding.installationId }) };
        const operand = { serverId, sourceId: source.id };
        expect(await inScope(db, binding, operand, undefined, undefined, 'projects.sources.read')).toBe(true);
        await db.projectSource.update({ where: { id: source.id }, data: { revision: { increment: 1 } } });
        expect(await inScope(db, binding, operand, undefined, undefined, 'projects.sources.read')).toBe(false);
        const setup = { ...binding, actionId: 'machines.setup.apply', deploymentPreparationAdmission:
            DeploymentPreparationAdmissionV1Schema.parse({ operation: 'setup', deployments: [],
                catalogSources: [{ machineId: f.payload.machineId, source: { id: source.id } }] }) };
        expect(await inScope(db, setup, operand, undefined, undefined, 'projects.sources.read', f.payload.machineId)).toBe(true);
        expect(await inScope(db, setup, operand, undefined, undefined, 'projects.sources.read', 'another-machine')).toBe(false);
    });

    it('keeps preview inventory and allocated Create receipts at the scope owner', async () => {
        const f = await admittedTeamDelivery();
        const { isDeploymentReadOperandInAdmittedScopeInTx: inScope } = await import('./deploymentPreparationAuthorization');
        const row = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.payload.environmentId } });
        const create = { ...f.authorization.binding, actionId: 'deployments.environments.create', deploymentNativeAdmission: undefined,
            deploymentPreparationAdmission: DeploymentPreparationAdmissionV1Schema.parse({ operation: 'create', mode: 'apply',
                source: { id: row.projectSourceId }, requestKey: 'not-allocated', protection: 'nonProduction', purpose: 'preview',
                deployerMode: 'managers', copyFrom: { environmentId: row.id, expectedRevision: row.revision },
                preview: { templateEnvironmentId: row.id, expectedTemplateRevision: row.revision, pullRequestId: '17', runtimeTargetLinkId: f.payload.targetLinkId } }) };
        const inventory = { serverId, projectSourceId: row.projectSourceId, previewRepositoryId: row.projectSourceId, previewTemplateEnvironmentId: row.id, previewPullRequestIds: ['17'] };
        expect(await inScope(db, create, inventory, undefined, undefined, 'deployments.environments.list')).toBe(true);
        expect(await inScope(db, create, { ...inventory, previewPullRequestIds: ['18'] }, undefined, undefined,
            'deployments.environments.list')).toBe(false);
        expect(await inScope(db, create, { serverId, environmentId: row.id }, undefined, undefined, 'deployments.receipts.list')).toBe(false);
        expect(await inScope(db, create, { serverId, environmentId: row.id }, undefined, undefined,
            'deployments.environments.get')).toBe(true);
        expect(await inScope(db, create, { serverId, environmentId: row.id }, undefined, undefined,
            'deployments.environments.get', undefined, true)).toBe(false);
    });

    it('delivers runtime grants to a plugin scalar placement without native member rows', async () => {
        const fixture = await admittedTeamDelivery('plain', true, undefined, 'plugin');
        expect(await inTx(tx => readEnvironmentSecretLaunchAdmissionInTx(tx, fixture.requester.id, fixture.payload)))
            .toMatchObject({ ok: true, grants: [fixture.grant] });
    });

    it.each([false, true])('delivers a managed data-role grant through its exact signed scope (semantic=%s)', async semantic => {
        const f = await admittedTeamDelivery('plain', true, undefined, 'plugin');
        await db.teamMembership.update({ where: { teamId_accountId: { teamId: f.team.id, accountId: f.requester.id } },
            data: { role: 'member' } });
        const runtime = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.payload.environmentId } });
        const grant = { ...f.grant, machineId: f.controller.machineId, installationId: f.controller.installationId };
        await inTx(tx => syncEnvironmentSecretGrantsInTx(tx, { environmentId: runtime.id, grants: [grant] }));
        const action = { pluginId: 'acme.daemon-runtime', localId: 'query-read' };
        const dataContent = await f.artifact('deployment-target-link.v1');
        const data = await inTx(tx => linkDeploymentTargetInTx(tx, f.owner.id, { serverId,
            environmentId: runtime.id, expectedRevision: runtime.revision,
            source: { kind: 'plugin', contribution: { pluginId: action.pluginId, localId: 'database' } },
            targetKind: 'neon', machineId: f.controller.machineId, installationId: f.controller.installationId, machines: [],
            role: 'data', requestKey: crypto.randomUUID(), ...dataContent }));
        if (!data.ok) throw new Error(data.error);
        const row = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.payload.environmentId } });
        const link = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: data.targetLinkId } });
        const credentialRef = { service: { pluginId: action.pluginId, localId: 'connection' }, accountId: 'connected' };
        const query = { v: 1 as const, serverId, environmentId: row.id, expectedRevision: row.revision,
            targetLinkId: link.id, expectedTargetLinkRevision: link.revision, credentialRef,
            credentialPrincipal: { kind: 'account' as const, accountId: f.owner.id, purpose: {
                consumer: action, purpose: 'deploy-manage' as const,
            }, target: { kind: 'account' as const, account: credentialRef } },
            providerIdentity: { providerAccountId: 'org', providerResourceId: 'project', providerEnvironment: 'branch' },
            providerEnvironment: { kind: 'custom' as const, id: 'branch' }, database: 'managed', sql: 'SELECT 1', params: {} };
        const target = { kind: 'machine' as const, machineId: f.controller.machineId };
        const semanticAction = parseQualifiedPluginActionId(DATABASE_STATEMENT_RUN_ACTION_ID_V1);
        if (!semanticAction) throw new Error('The canonical database Action has a qualified identity');
        const databaseTarget = { kind: 'managed_deployment' as const, environment: { serverId,
            projectSourceId: row.projectSourceId, environmentId: row.id }, targetLinkId: link.id,
            contribution: { pluginId: action.pluginId, contributionId: 'database' },
            platformProjectId: 'project', branchId: 'branch', database: 'managed' };
        const semanticInput = { action: semanticAction, input: { operation: 'statement.run', mode: 'read',
            target: databaseTarget, statement: { sql: 'SELECT 1', parameters: [] } } };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target,
            input: semantic ? semanticInput : { action, input: query } };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ accountId: f.requester.id,
            serverIdentityId: serverId, authentication: { kind: 'account', tokenEpoch: f.requester.tokenEpoch },
            actionId: 'action.invoke', machineId: f.controller.machineId, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            deploymentReadAdmission: projectDeploymentReadAdmissionV1('action.invoke', envelope.input) });
        const body = { serverId, environmentId: row.id, targetLinkId: link.id,
            machineId: f.controller.machineId, installationId: f.controller.installationId,
            materialization: { kind: 'dataRole' as const, expectedRevision: row.revision, targetLinkId: link.id } };
        const url = `/v1/deployments/environments/${encodeURIComponent(body.environmentId)}/secret-launch-admission`;
        await withAuthenticatedTestApp(app => registerDeploymentRoutes(app), async app => {
            const launch = async (current: EnvironmentSecretLaunchAdmissionBodyV1, privateKey = f.controller.keys.secretKey,
                authorizationToken = authorization.token, requestId = envelope.requestId) => {
                const payload = { ...current, proof: signMachineInstallationProof({ payload: { version: 1, accountId: f.requester.id,
                    machineId: current.machineId, installationId: current.installationId,
                    deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(current) } }, privateKey }) };
                return app.inject({ method: 'POST', url, payload, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorizationToken,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'action.invoke',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken,
                    effectActionId: 'action.invoke', target, installationId: current.installationId, requestId,
                    method: 'POST', path: url, body: payload, privateKey }),
                } });
            };
            const result = await launch(body);
            expect(result.statusCode, result.body).toBe(200);
            expect(result.json()).toEqual({ ok: true, grants: [grant] });
            if (semantic) {
                const writeBody = { ...body, materialization: { ...body.materialization, role: 'write' as const } };
                const refused = await launch(writeBody);
                expect(refused.statusCode, refused.body).toBe(401);
                const writeEnvelope = { ...envelope, requestId: crypto.randomUUID(), input: { action: semanticAction,
                    input: { operation: 'statement.run', mode: 'write', target: databaseTarget,
                        executionMode: 'transaction', statements: [{ sql: 'UPDATE selected SET value=$1',
                            parameters: [{ type: 'text', value: 'private-write-value' }] }] } } };
                const writeAuthorization = await auth.mintExternalActionExecutionAuthorization({ accountId: f.requester.id,
                    serverIdentityId: serverId, authentication: { kind: 'account', tokenEpoch: f.requester.tokenEpoch },
                    actionId: 'action.invoke', machineId: f.controller.machineId, target, requestId: writeEnvelope.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(writeEnvelope),
                    deploymentReadAdmission: projectDeploymentReadAdmissionV1('action.invoke', writeEnvelope.input) });
                const delivered = await launch(writeBody, f.controller.keys.secretKey, writeAuthorization.token, writeEnvelope.requestId);
                expect(delivered.statusCode, delivered.body).toBe(200);
                expect(delivered.json()).toEqual({ ok: true, grants: [grant] });
                expect(JSON.stringify(projectDeploymentReadAdmissionV1('action.invoke', writeEnvelope.input)))
                    .not.toContain('private-write-value');
            }
            const crossArm = await launch({ ...body, materialization: { kind: 'dataRole', expectedRevision: row.revision,
                deploymentId: f.receipt.deploymentId, service: 'neon' } });
            expect(crossArm.statusCode, crossArm.body).toBe(401);
            const wrongController = await launch({ ...body, machineId: f.payload.machineId, installationId: f.payload.installationId }, f.keys.secretKey);
            expect(wrongController.statusCode, wrongController.body).toBe(401);
            await db.deploymentTargetLink.update({ where: { id: link.id }, data: semantic
                ? { detachedAt: new Date() } : { revision: { increment: 1 } } });
            const stale = await launch(body);
            expect(stale.statusCode, stale.body).toBe(403);
            expect(stale.json()).toEqual({ ok: false, error: 'deployment_access_denied' });
        }, { authentication: 'real' });
        if (semantic) await db.deploymentTargetLink.update({ where: { id: link.id }, data: { detachedAt: null } });
        const mismatchEnvelope = { ...envelope, requestId: crypto.randomUUID(), input: semantic
            ? { ...semanticInput, input: { ...semanticInput.input, target: { ...databaseTarget,
                contribution: { ...databaseTarget.contribution, pluginId: 'other.plugin' } } } }
            : { action: { pluginId: 'other.plugin', localId: action.localId }, input: query } };
        await expect(auth.mintExternalActionExecutionAuthorization({ accountId: f.requester.id, serverIdentityId: serverId,
            authentication: { kind: 'account', tokenEpoch: f.requester.tokenEpoch }, actionId: 'action.invoke',
            machineId: f.controller.machineId, target, requestId: mismatchEnvelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(mismatchEnvelope),
            deploymentReadAdmission: projectDeploymentReadAdmissionV1('action.invoke', mismatchEnvelope.input) })).rejects.toMatchObject({ code: 'credential_scope_denied' });
        await db.teamMembership.delete({ where: { teamId_accountId: { teamId: f.team.id, accountId: f.requester.id } } });
        const withdrawnEnvelope = { ...envelope, requestId: crypto.randomUUID() };
        await expect(auth.mintExternalActionExecutionAuthorization({ accountId: f.requester.id, serverIdentityId: serverId,
            authentication: { kind: 'account', tokenEpoch: f.requester.tokenEpoch }, actionId: 'action.invoke',
            machineId: f.controller.machineId, target, requestId: withdrawnEnvelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(withdrawnEnvelope),
            deploymentReadAdmission: projectDeploymentReadAdmissionV1('action.invoke', withdrawnEnvelope.input) })).rejects.toMatchObject({ code: 'credential_scope_denied' });
    });

    it.skipIf(!managedDataQueryPostgresAvailable)('composes Neon data query through a real Home socket, installed P42 identity and database role', async () => {
        await withTempDir('happier-managed-query-home-', async homeDir => {
            const environment = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL']);
            const lifetime = new AbortController();
            const app = createAuthenticatedTestApp({ authentication: 'real' });
            const sockets = new SocketServer(app.server, { path: '/v1/updates' });
            let requester: Awaited<ReturnType<typeof admitRequesterAccountActionContext>> | undefined;
            let kit: Awaited<ReturnType<typeof createPluginTestkit>> | undefined;
            let postgres: Awaited<ReturnType<typeof startManagedQueryPostgres>> | undefined;
            try {
                environment.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: serverId });
                reloadConfiguration();
                accountRoutes(app); artifactsRoutes(app); registerDeploymentRoutes(app);
                const origin = await app.listen({ host: '127.0.0.1', port: 0 });
                environment.patch({ HAPPIER_SERVER_URL: origin });
                reloadConfiguration();
                await seedTestServerProfile({ id: serverId, homeId: serverId, serverUrl: origin });

                // The host reads this isolated on-disk identity; neither the reader nor
                // the server transport receives a fixture identity or secret callback.
                const installation = readOrCreateInstallationIdentitySync();
                const installationPublicKey = decodeBase64(installation.publicKey, 'base64url');
                const f = await admittedTeamDelivery('plain', true, undefined, 'host', managedQueryRolePassword);
                await db.machine.update({ where: { id: f.controller.machineId }, data: {
                    installationId: installation.installationId, installationPublicKey,
                } });
                const runtime = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.payload.environmentId } });
                const action = { pluginId: neonEntry.manifest.id, localId: 'query-read' };
                const targetContent = await f.artifact('deployment-target-link.v1');
                const data = await inTx(tx => linkDeploymentTargetInTx(tx, f.owner.id, { serverId,
                    environmentId: runtime.id, expectedRevision: runtime.revision,
                    source: { kind: 'plugin', contribution: { pluginId: action.pluginId, localId: 'database' } },
                    targetKind: 'neon', machineId: f.controller.machineId, installationId: installation.installationId, machines: [],
                    role: 'data', requestKey: crypto.randomUUID(), ...targetContent }));
                if (!data.ok) throw new Error(data.error);
                const link = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: data.targetLinkId } });
                const row = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: runtime.id } });
                const definition = DeploymentEnvironmentContentV1Schema.parse({ ...f.content, bindings: [{ purpose: 'dataRole',
                    targetLinkId: link.id, role: 'readOnlyPassword', source: { kind: 'secret',
                        ref: formatSharedSavedSecretRefV1(f.resourceId), resourceRevision: f.resourceRevision } }] });
                const definitionContent = await f.artifact('deployment-environment.v1', definition);
                const grant = sealMachineSecretGrant({ subject: { v: 1, kind: 'secret', environmentId: row.id,
                    machineId: f.controller.machineId, installationId: installation.installationId,
                    resourceId: f.resourceId, resourceRevision: f.resourceRevision }, installationPublicKey,
                    content: { kind: 'secret', value: managedQueryRolePassword } });
                const bound = await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, f.owner.id, { serverId, environmentId: row.id,
                    expectedRevision: row.revision, ...definitionContent, grants: [grant],
                    referencedSavedSecretRevisions: captureDeploymentBindingSavedSecretRevisionsV1(definition.bindings) }));
                if (!bound.ok) throw new Error(bound.error);
                const current = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: row.id } });
                const credentialRef = { service: { pluginId: action.pluginId, localId: 'neon' }, accountId: 'connected' };
                const query = { v: 1 as const, serverId, environmentId: current.id, expectedRevision: current.revision,
                    targetLinkId: link.id, expectedTargetLinkRevision: link.revision, credentialRef,
                    credentialPrincipal: { kind: 'account' as const, accountId: f.owner.id, purpose: {
                        consumer: action, purpose: 'deploy-manage' as const,
                    }, target: { kind: 'account' as const, account: credentialRef } },
                    providerIdentity: { providerAccountId: 'org', providerResourceId: 'project', providerEnvironment: 'br-main' },
                    providerEnvironment: { kind: 'custom' as const, id: 'br-main' }, database: 'neondb',
                    sql: 'SELECT value FROM query_fixture', params: {} };
                const target = { kind: 'machine' as const, machineId: f.controller.machineId };
                const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input: { action, input: query } };
                const authorization = await auth.mintExternalActionExecutionAuthorization({ accountId: f.requester.id,
                    serverIdentityId: serverId, authentication: { kind: 'account', tokenEpoch: f.requester.tokenEpoch },
                    actionId: 'action.invoke', machineId: f.controller.machineId, target, requestId: envelope.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                    deploymentReadAdmission: projectDeploymentReadAdmissionV1('action.invoke', envelope.input) });
                const token = await auth.createToken(f.requester.id, undefined, { kind: 'account', authority: 'present_user' });
                requester = await admitRequesterAccountActionContext({ authorization, credentials: { token, encryption: null },
                    serverId, serverIdentityId: serverId, serverHttpBaseUrl: origin,
                    isCurrent: async () => !lifetime.signal.aborted, isCustodyCurrent: async () => !lifetime.signal.aborted,
                    signal: lifetime.signal });
                if (!requester) throw new Error('Expected real requester Account admission');
                const projected = await projectExternalActionRequesterHttpAuthorization({ authorization: requester.authorization,
                    target, serverId, serverIdentityId: serverId, serverHttpBaseUrl: origin,
                    installationId: installation.installationId, privateKey: installation.privateKey,
                    isCurrent: requester.isCurrent, signal: lifetime.signal });
                if (!projected) throw new Error('Expected signed requester HTTP projection');
                const context = { signal: lifetime.signal, externalActionTarget: target,
                    externalActionExecutionAuthorization: projected };
                const host = await createDeploymentTargetRoleAdmissionHost(context, { readCurrentMachineId: () => f.controller.machineId,
                    resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }) });
                if (!host) throw new Error('Expected real deployment query host');
                const admittedEnvironment = await host.readEnvironment({ environmentId: current.id, targetLinkId: link.id, context });
                const readDataRole = createManagedDataRoleSecretReaderForHost({ host, environment: admittedEnvironment, query, context });
                const secrets = createDeclaredPluginSecretsService({ pluginId: action.pluginId, declarations: [],
                    resolveCustody: () => null, signal: lifetime.signal, isOccurrenceCurrent: () => true,
                    registerRawForRedaction: () => {}, readDataRole });
                postgres = await startManagedQueryPostgres();
                console.info(`[managedDataQuery.real-home] started owned PostgreSQL PID ${postgres.pid}`);
                const requests: HttpRequest[] = [];
                kit = await createPluginTestkit({ manifest: neonEntry.manifest, module: neonEntry, services: {
                    secrets, http: createPluginHttpFixture(managedQueryProviderHttp(postgres, requests)),
                } });
                await expect(kit.invokeAction('query-read', query, { surface: 'cli' })).resolves.toEqual({ ok: true,
                    columns: [{ name: 'value' }], rows: [['original']], complete: true });
                await expect(kit.invokeAction('query-read', { ...query, sql: "INSERT INTO query_fixture VALUES ('changed')" },
                    { surface: 'cli' })).rejects.toMatchObject({ code: 'query_failed' });
                expect(postgres.run('SELECT value FROM query_fixture').stdout.trim()).toBe('original');
                expect(requests.filter(request => new URL(request.url).pathname === '/sql')).toHaveLength(2);
            } finally {
                lifetime.abort(); await kit?.dispose(); await requester?.dispose();
                if (postgres) {
                    await postgres.stop();
                    console.info(`[managedDataQuery.real-home] stopped owned PostgreSQL PID ${postgres.pid}`);
                }
                await new Promise<void>(resolve => sockets.close(() => resolve()));
                await app.close(); environment.restore(); reloadConfiguration();
            }
        });
    });

    it.each([
        { mode: 'plain', semantic: false }, { mode: 'e2ee', semantic: false },
        { mode: 'plain', semantic: true }, { mode: 'e2ee', semantic: true },
    ] as const)('delivers $mode installed role custody through exact signed query scope (semantic=$semantic)', async ({ mode, semantic }) => {
        const f = await admittedTeamDelivery(mode, false, 'postgres');
        const row = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.payload.environmentId } });
        const otherEnvironmentContent = await f.artifact('deployment-environment.v1', f.content);
        const other = await inTx(tx => createDeploymentEnvironmentInTx(tx, f.owner.id, { serverId,
            projectSourceId: row.projectSourceId, requestKey: crypto.randomUUID(), controllerMachineId: f.payload.machineId,
            buildMachineId: f.payload.machineId, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            ...otherEnvironmentContent }));
        if (!other.ok) throw new Error(other.error);
        const otherTargetContent = await f.artifact('deployment-target-link.v1');
        const otherTarget = await inTx(tx => linkDeploymentTargetInTx(tx, f.owner.id, { serverId,
            environmentId: other.environmentId, expectedRevision: other.revision, targetId: 'own-server', role: 'runtime',
            requestKey: crypto.randomUUID(), machines: [{ machineId: f.payload.machineId, installationId: f.payload.installationId }],
            ...otherTargetContent }));
        if (!otherTarget.ok) throw new Error(otherTarget.error);
        const otherDefinition = DeploymentEnvironmentContentV1Schema.parse({ ...f.content, bindings: [{ purpose: 'dataRole',
            service: 'postgres', role: 'readOnlyPassword', source: { kind: 'secret',
                ref: formatSharedSavedSecretRefV1(f.resourceId), resourceRevision: f.resourceRevision } }] });
        const otherContent = await f.artifact('deployment-environment.v1', otherDefinition);
        const otherGrant = { ...f.grant, environmentId: other.environmentId, sealedContent: 'other-environment-installed-ciphertext' };
        expect(await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, f.owner.id, { serverId,
            environmentId: other.environmentId, expectedRevision: otherTarget.revision, ...otherContent, grants: [otherGrant],
            referencedSavedSecretRevisions: captureDeploymentBindingSavedSecretRevisionsV1(otherDefinition.bindings) }))).toMatchObject({ ok: true });
        const deploymentId = f.payload.materialization.kind === 'deployment' ? f.receipt.deploymentId : '';
        await db.deployment.update({ where: { id: deploymentId }, data: { state: 'succeeded' } });
        await db.deploymentTargetLink.update({ where: { id: f.payload.targetLinkId }, data: { activeDeploymentId: deploymentId,
            machines: { updateMany: { where: { machineId: f.payload.machineId, installationId: f.payload.installationId },
                data: { state: 'active' } } } } });
        const actionId = semantic ? 'action.invoke' as const : 'deployments.data.query' as const;
        const input = { serverId, environmentId: row.id, expectedRevision: row.revision, deploymentId,
            targetLinkId: f.payload.targetLinkId, machineId: f.payload.machineId, installationId: f.payload.installationId,
            service: 'postgres', sql: 'SELECT 1', params: {} };
        const target = { kind: 'machine' as const, machineId: input.machineId };
        const action = parseQualifiedPluginActionId(DATABASE_STATEMENT_RUN_ACTION_ID_V1);
        if (!action) throw new Error('The canonical database Action has a qualified identity');
        const actionInput = semantic ? { action, input: { operation: 'statement.run', mode: 'read',
            target: { kind: 'deployment_service', environment: { serverId, projectSourceId: row.projectSourceId,
                environmentId: row.id }, deploymentId, targetLinkId: input.targetLinkId, serviceId: input.service, database: 'postgres' },
            statement: { sql: 'SELECT 1', parameters: [] } } } : input;
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input: actionInput };
        const admission = projectDeploymentReadAdmissionV1(actionId, actionInput);
        const mint = () => auth.mintExternalActionExecutionAuthorization({ accountId: f.owner.id,
            serverIdentityId: serverId, authentication: { kind: 'account', tokenEpoch: f.owner.tokenEpoch },
            actionId, machineId: input.machineId, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), deploymentReadAdmission: admission });
        const authorization = await mint();
        const request = (changes: Partial<EnvironmentSecretLaunchAdmissionBodyV1> = {}) => {
            const body = { serverId, environmentId: row.id, targetLinkId: input.targetLinkId, machineId: input.machineId,
                installationId: input.installationId, materialization: { kind: 'dataRole' as const,
                    expectedRevision: row.revision, deploymentId, service: input.service }, ...changes };
            const payload = { ...body, proof: signMachineInstallationProof({ payload: { version: 1, accountId: f.owner.id,
                machineId: body.machineId, installationId: body.installationId, deploymentSecretLaunch: {
                    requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } }, privateKey: f.keys.secretKey }) };
            const url = `/v1/deployments/environments/${encodeURIComponent(body.environmentId)}/secret-launch-admission`;
            return { method: 'POST' as const, url, payload, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: actionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId: actionId, target, installationId: input.installationId, requestId: envelope.requestId,
                    method: 'POST', path: url, body: payload, privateKey: f.keys.secretKey }),
            } };
        };
        const readRequest = (effectActionId: typeof actionId | 'deployments.environments.get' | 'deployments.receipts.get', url: string) => ({
            method: 'GET' as const, url, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: effectActionId,
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({ authorizationToken: authorization.token,
                    effectActionId, target, installationId: input.installationId, requestId: envelope.requestId,
                    method: 'GET', path: url, privateKey: f.keys.secretKey }),
            },
        });
        await withAuthenticatedTestApp(app => { registerDeploymentRoutes(app); artifactsRoutes(app); }, async app => {
            const allowed = await app.inject(request());
            expect(allowed.statusCode, allowed.body).toBe(200);
            expect(allowed.json()).toEqual({ ok: true, grants: [f.grant] });
            expect(allowed.body).not.toContain('launch-trims-private-sentinel');
            await db.teamMembership.deleteMany({ where: { teamId: f.team.id, accountId: f.owner.id } });
            const authorityReads: string[] = [];
            const stopObserving = observePrismaRequests(db, { before(query) {
                // Source/Account custody remains current; requester membership and credential admission belongs to mint.
                if (query.model && ['TeamMembership', 'ApiToken'].includes(query.model)) authorityReads.push(query.model);
            } });
            try {
                const continued = await app.inject(request());
                expect(continued.statusCode, continued.body).toBe(200);
                expect(continued.json()).toEqual({ ok: true, grants: [f.grant] });
                for (const read of [
                    readRequest('deployments.environments.get', `/v1/deployments/environments/${row.id}?serverId=${serverId}`),
                    readRequest('deployments.receipts.get', `/v1/deployments/receipts/${deploymentId}?serverId=${serverId}&environmentId=${row.id}`),
                    readRequest(actionId, `/v1/artifacts/${row.contentArtifactId}`),
                    // The installed role admission host signs its metadata reads with the
                    // admitted root (createDeploymentTargetRoleAdmissionHost), not a sibling.
                    readRequest(actionId, `/v1/deployments/environments/${row.id}?serverId=${serverId}`),
                    readRequest(actionId, `/v1/deployments/receipts/${deploymentId}?serverId=${serverId}&environmentId=${row.id}`),
                ]) {
                    const response = await app.inject(read);
                    expect(response.statusCode, `${read.url}: ${response.body}`).toBe(200);
                    expect(response.json()).toMatchObject(read.url.startsWith('/v1/artifacts/')
                        ? { id: row.contentArtifactId } : { ok: true });
                }
                for (const read of [
                    readRequest('deployments.environments.get', `/v1/deployments/environments/${other.environmentId}?serverId=${serverId}`),
                    readRequest(actionId, `/v1/artifacts/${otherContent.contentArtifactId}`),
                ]) {
                    const refused = await app.inject(read);
                    expect(refused.statusCode, refused.body).toBe(401);
                }
                expect(authorityReads, 'finite signed Query acquisition must not re-admit requester permission').toEqual([]);
            } finally { stopObserving(); }
            await expect(mint()).rejects.toMatchObject({ code: 'credential_scope_denied' });
            for (const changed of [{ environmentId: other.environmentId }, { targetLinkId: crypto.randomUUID() },
                ...(!semantic ? [{ materialization: { kind: 'dataRole' as const, expectedRevision: row.revision + 1, deploymentId, service: input.service } }] : []),
                ...(semantic ? [{ materialization: { kind: 'dataRole' as const, expectedRevision: row.revision, deploymentId, service: 'neighbor' } }] : []),
                { materialization: { kind: 'dataRole' as const, expectedRevision: row.revision, deploymentId: crypto.randomUUID(), service: input.service } }]) {
                const refused = await app.inject(request(changed));
                expect(refused.statusCode, refused.body).toBe(401);
                expect(refused.body).not.toContain(f.grant.sealedContent);
                expect(refused.body).not.toContain(otherGrant.sealedContent);
            }
            await db.deploymentEnvironment.update({ where: { id: row.id }, data: { revision: { increment: 1 } } });
            const continued = await app.inject(request());
            expect(continued.statusCode, continued.body).toBe(200);
            expect(continued.json()).toEqual({ ok: true, grants: [f.grant] });
        }, { authentication: 'real' });
    });

    it('refuses a person-presented data.query root after its member left the Source Team', async () => {
        const f = await admittedTeamDelivery('plain', false, 'postgres');
        const row = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.payload.environmentId } });
        const deploymentId = f.payload.materialization.kind === 'deployment' ? f.receipt.deploymentId : '';
        await db.deployment.update({ where: { id: deploymentId }, data: { state: 'succeeded' } });
        await db.deploymentTargetLink.update({ where: { id: f.payload.targetLinkId }, data: { activeDeploymentId: deploymentId,
            machines: { updateMany: { where: { machineId: f.payload.machineId, installationId: f.payload.installationId },
                data: { state: 'active' } } } } });
        // The member owns the executing Machine, so Machine admission alone cannot see the withdrawal.
        await db.machine.update({ where: { id: f.payload.machineId }, data: { accountId: f.owner.id, active: true, operationProtocolCapabilitiesRevision: 1,
            operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
        const actionId = 'deployments.data.query' as const;
        const input = { serverId, environmentId: row.id, expectedRevision: row.revision, deploymentId,
            targetLinkId: f.payload.targetLinkId, machineId: f.payload.machineId, installationId: f.payload.installationId,
            service: 'postgres', sql: 'SELECT 1', params: {} };
        const target = { kind: 'machine' as const, machineId: input.machineId };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const root = await auth.mintExternalActionExecutionAuthorization({ accountId: f.owner.id,
            serverIdentityId: serverId, authentication: { kind: 'account', tokenEpoch: f.owner.tokenEpoch },
            actionId, machineId: input.machineId, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            deploymentReadAdmission: projectDeploymentReadAdmissionV1(actionId, input) });
        // The daemon transport is the system boundary; Home's relay and dispatcher admission run for real.
        const forwarded: unknown[] = [];
        const forwardRpc = (async (request: unknown) => {
            forwarded.push(request);
            return { ok: false, error: 'daemon_boundary', errorCode: 'daemon_boundary' };
        }) as unknown as ExternalActionForwardRpcCall;
        const token = await auth.createToken(f.owner.id, undefined, { kind: 'account', authority: 'present_user' });
        await withAuthenticatedTestApp(app => registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({
            io: { to: () => ({ emit: () => undefined }) } as unknown as Server, forwardRpc }) }), async app => {
            const execute = () => app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                headers: { authorization: `Bearer ${token}` },
                payload: { v: 1, machineId: input.machineId, envelope, executionAuthorization: root } });
            const started = await execute();
            expect(forwarded, started.body).toHaveLength(1);
            // Only Source Team membership is withdrawn; the member still owns the Machine.
            await db.teamMembership.deleteMany({ where: { teamId: f.team.id, accountId: f.owner.id } });
            const retried = await execute();
            expect(forwarded, retried.body).toHaveLength(1);
            expect(retried.json()).toMatchObject({ error: 'credential_scope_denied' });
        }, { authentication: 'real' });
    });

    // Mint's binding admission (registry, preparation) runs again on each person-presented relay.
    it.each(['registries.updates.check', 'deployments.publish.prepare'] as const)(
        'refuses a person-presented %s root after its member left the Source Team', async actionId => {
            const f = await admittedTeamDelivery();
            const row = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.payload.environmentId } });
            const source = await db.projectSource.findUniqueOrThrow({ where: { id: row.projectSourceId } });
            await db.machine.update({ where: { id: f.payload.machineId }, data: { accountId: f.owner.id, active: true,
                operationProtocolCapabilitiesRevision: 1,
                operationProtocolCapabilities: { externalActionExecutionAuthorization: { protocolVersions: [1] } } } });
            const target = { kind: 'machine' as const, machineId: f.payload.machineId };
            const registryInput = { kind: 'app', environments: [{ environmentId: row.id, expectedRevision: row.revision }] };
            const prepareInput = { serverId, projectSourceId: source.id, sourceRevision: source.revision,
                machineId: f.payload.machineId, installationId: f.payload.installationId };
            const input = actionId === 'registries.updates.check' ? registryInput : prepareInput;
            const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
            const root = await auth.mintExternalActionExecutionAuthorization({ accountId: f.owner.id,
                serverIdentityId: serverId, authentication: { kind: 'account', tokenEpoch: f.owner.tokenEpoch },
                actionId, machineId: target.machineId, target, requestId: envelope.requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
                ...(actionId === 'registries.updates.check'
                    ? { registryAppUpdateAdmission: projectRegistryAppUpdateAdmissionV1(actionId, input) }
                    : { deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId, input) }) }, { input });
            const forwarded: unknown[] = [];
            const forwardRpc = (async (request: unknown) => {
                forwarded.push(request);
                return { ok: false, error: 'daemon_boundary', errorCode: 'daemon_boundary' };
            }) as unknown as ExternalActionForwardRpcCall;
            const token = await auth.createToken(f.owner.id, undefined, { kind: 'account', authority: 'present_user' });
            await withAuthenticatedTestApp(app => registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({
                io: { to: () => ({ emit: () => undefined }) } as unknown as Server, forwardRpc }) }), async app => {
                const execute = () => app.inject({ method: 'POST', url: `/v1/actions/${actionId}`,
                    headers: { authorization: `Bearer ${token}` },
                    payload: { v: 1, machineId: target.machineId, envelope, executionAuthorization: root } });
                const started = await execute();
                expect(forwarded, started.body).toHaveLength(1);
                await db.teamMembership.deleteMany({ where: { teamId: f.team.id, accountId: f.owner.id } });
                const retried = await execute();
                expect(forwarded, retried.body).toHaveLength(1);
                expect(retried.json()).toMatchObject({ error: 'credential_scope_denied' });
            }, { authentication: 'real' });
        });

    it.each(['plain', 'e2ee'] as const)('admits a %s manager binding save before a runtime target is linked', async mode => {
        const accountKeys = nacl.box.keyPair();
        const manager = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(accountKeys.publicKey) : {}) } });
        const keys = nacl.sign.keyPair(), machineId = crypto.randomUUID(), installationId = crypto.randomUUID();
        const metadata = MachinePublishedMetadataV1Schema.parse({ host: 'pre-link-manager', platform: 'linux',
            happyCliVersion: '0.0.0-test', homeDir: '/home/happier', happyHomeDir: '/home/happier/.happier' });
        const machineDataKey = nacl.randomBytes(32);
        await db.machine.create({ data: { id: machineId, accountId: manager.id,
            metadata: mode === 'plain' ? encodePlainMachineStoredContent(metadata)
                : encodeBase64(new Uint8Array(await sealSessionDataKeyBundleV0(metadata, machineDataKey))),
            dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)
                : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: machineDataKey,
                    recipientPublicKey: accountKeys.publicKey, randomBytes: nacl.randomBytes })),
            installationId, installationPublicKey: new Uint8Array(keys.publicKey) } });
        const source = await inTx(tx => createProjectSourceInTx(tx, manager.id, { serverId, requestKey: crypto.randomUUID(),
            name: 'Pre-link variables', owner: { kind: 'account', accountId: manager.id }, audience: [],
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'acme/pre-link', cloneUrl: 'https://github.com/acme/pre-link.git' }, protocol: 'https' } }));
        if (!source.ok) throw new Error(source.error);
        const content = DeploymentEnvironmentContentV1Schema.parse({ name: 'Pre-link variables', retainPreviousDeployments: 1,
            definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } }, bindings: [] });
        async function artifact(value: unknown) {
            const kind = 'deployment-environment.v1', dataKey = nacl.randomBytes(32);
            const created = await createArtifact({ actorUserId: manager.id, artifactId: crypto.randomUUID(), kind: `v1:other:${kind}`,
                header: mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: content.name }))
                    : new Uint8Array(await sealSessionDataKeyBundleV0({ kind, title: content.name }, dataKey)),
                body: mode === 'plain' ? privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(value) }))
                    : new Uint8Array(await sealSessionDataKeyBundleV0({ body: JSON.stringify(value) }, dataKey)),
                dataEncryptionKey: mode === 'plain' ? privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)
                    : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: accountKeys.publicKey, randomBytes: nacl.randomBytes })) });
            if (!created.ok) throw new Error(created.error);
            return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        }
        const initial = await artifact(content);
        const environment = await inTx(tx => createDeploymentEnvironmentInTx(tx, manager.id, { serverId,
            projectSourceId: source.source.id, requestKey: crypto.randomUUID(), controllerMachineId: machineId,
            ...(mode === 'e2ee' ? { buildMachineId: machineId } : {}),
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', ...initial }));
        if (!environment.ok) throw new Error(environment.error);
        const payload = { kind: 'clientBindings', serverId, environmentId: environment.environmentId, expectedRevision: environment.revision };
        const url = `/v1/deployments/environments/${environment.environmentId}/secret-launch-admission`;
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const prepared = await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': manager.id }, payload });
            expect(prepared.statusCode, prepared.body).toBe(200);
            const admitted = EnvironmentSecretLaunchAdmissionResultV1Schema.parse(prepared.json());
            expect(admitted).toMatchObject({ ok: true, grants: [], bindingPreparation: { runtimeInstallations: [] } });
            if (!admitted.ok) throw new Error(admitted.error);
            expect(admitted.bindingPreparation?.buildInstallation).toEqual(mode === 'e2ee'
                ? { machineId, installationId, publicKey: encodeBase64(keys.publicKey, 'base64url') }
                : undefined);
            const denied = await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': stranger.id }, payload });
            expect(denied.json()).toMatchObject({ ok: false, error: 'deployment_unavailable' });
            const stale = await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': manager.id },
                payload: { ...payload, expectedRevision: environment.revision + 1 } });
            expect(stale.json()).toMatchObject({ ok: false, error: 'deployment_conflict' });
            const wrongTarget = await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': manager.id },
                payload: { ...payload, targetLinkId: crypto.randomUUID() } });
            expect(wrongTarget.json()).toMatchObject({ ok: false, error: 'deployment_invalid' });
        });
        const resourceId = crypto.randomUUID(), resourceKey = nacl.randomBytes(32);
        const resourceContent = { v: 1 as const, name: 'Pre-link credential', kind: 'token' as const, value: 'pre-link-test-value' };
        const resource = await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: manager.id, resourceId,
            displayName: resourceContent.name, kind: 'token', encryptionMode: mode, teamGrants: [], accountGrants: [],
            keyEnvelopes: mode === 'plain' ? [] : [{ recipientAccountId: manager.id,
                encryptedDataKey: new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: resourceKey,
                    recipientPublicKey: accountKeys.publicKey, randomBytes: nacl.randomBytes })),
                recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(accountKeys.publicKey) }],
            storedContent: sealSavedSecretResourceStoredContentV1(mode === 'plain'
                ? { resourceId, mode, content: resourceContent }
                : { resourceId, mode, resourceDataKey: resourceKey, content: resourceContent, randomBytes: nacl.randomBytes }) }));
        if (!resource.ok) throw new Error(resource.error);
        const savedContent = DeploymentEnvironmentContentV1Schema.parse({ ...content, bindings: [
            { purpose: 'variable', name: 'PORT', phase: 'runtime', grantRef: crypto.randomUUID(), source: { kind: 'value', value: '3000' } },
            { purpose: 'variable', name: 'TOKEN', phase: 'runtime', grantRef: crypto.randomUUID(), source: { kind: 'secret',
                ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: resource.value.revision } },
        ] });
        const preparation = await prepareEnvironmentSecretBindingsV1({ environmentId: environment.environmentId,
            bindings: savedContent.bindings, previousBindings: [], runtimeInstallations: [], existingGrants: [],
            sealGrant: () => { throw new Error('An unlinked runtime must not acquire or seal secret material'); },
            assertCurrent: async () => {} });
        expect(preparation.grants).toEqual([]);
        const candidate = await artifact(savedContent);
        expect(await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, manager.id, { ...payload, ...candidate,
            grants: [], referencedSavedSecretRevisions: preparation.referencedSavedSecretRevisions.map(ref => ({
                ...ref, resourceId: crypto.randomUUID(),
            })) }))).toMatchObject({ ok: false, error: 'deployment_conflict' });
        expect(await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, manager.id, { ...payload, ...candidate,
            grants: preparation.grants, referencedSavedSecretRevisions: preparation.referencedSavedSecretRevisions })))
            .toMatchObject({ ok: true, environmentId: environment.environmentId });
    });

    it.each(['plain', 'e2ee'] as const)('PL-19 keeps the %s owner link as approval without resource re-admission at installed acquisition', async mode => {
        const f = await admittedTeamDelivery(mode);
        expect((await db.savedSecretResource.findUniqueOrThrow({ where: { id: f.resourceId } })).ownerAccountId).toBe(f.owner.id);
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const secretReads: string[] = [];
            const stop = observePrismaRequests(db, { before: request => {
                if (request.model === 'SavedSecretResource' || request.model === 'Account'
                    || request.model === 'SavedSecretResourceKeyEnvelope') secretReads.push(`${request.model}.${request.action}`);
            } });
            let response;
            try { response = await app.inject({ method: 'POST', url: f.url,
                headers: { 'x-test-user-id': f.requester.id }, payload: f.payload }); }
            finally { stop(); }
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ ok: true, grants: [f.grant] });
            expect(response.body).not.toContain('launch-trims-private-sentinel');
            expect(secretReads).toEqual([]);
            const row = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.payload.environmentId } });
            const unlinkedContent = await f.artifact('deployment-environment.v1', f.content);
            expect(await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, f.owner.id, { serverId,
                environmentId: row.id, expectedRevision: row.revision,
                ...unlinkedContent, grants: [], referencedSavedSecretRevisions: [] })))
                .toMatchObject({ ok: true });
            const unlinked = await app.inject({ method: 'POST', url: f.url,
                headers: { 'x-test-user-id': f.requester.id }, payload: f.payload });
            expect(unlinked.json()).toEqual({ ok: true, grants: [] });
            expect(unlinked.body).not.toContain(f.grant.sealedContent);
        });
    });

    it.each(['plain', 'e2ee'] as const)('PL-19 accepts the %s resource owner link without a separate Team resource share', async mode => {
        const f = await admittedTeamDelivery(mode);
        const withdrawn = await inTx(tx => setSavedSecretResourceGrantsInTx(tx, { accountId: f.owner.id,
            resourceId: f.resourceId, expectedRevision: f.resourceRevision, accountGrants: [], teamGrants: [], groupGrants: [] }));
        if (!withdrawn.ok) throw new Error(withdrawn.error);
        expect(await db.machineSecretGrant.count({ where: { environmentId: f.payload.environmentId, resourceId: f.resourceId } })).toBe(0);
        const row = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.payload.environmentId } });
        // Preparation returns installation custody, not a Source Team catalog.
        // The actual owner's Account reader supplies material for the new seal.
        const { proof: _oldProof, ...installedBody } = f.payload;
        const preparationBody = { ...installedBody, materialization: { kind: 'bindings' as const, expectedRevision: row.revision } };
        const preparationPayload = { ...preparationBody, proof: signMachineInstallationProof({ privateKey: f.keys.secretKey,
            payload: { version: 1, accountId: f.owner.id, machineId: installedBody.machineId,
                installationId: installedBody.installationId,
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(preparationBody) } } }) };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const prepared = await app.inject({ method: 'POST', url: f.url,
                headers: { 'x-test-user-id': f.owner.id }, payload: preparationPayload });
            expect(prepared.statusCode, prepared.body).toBe(200);
            expect(prepared.json()).toMatchObject({ ok: true, grants: [], bindingPreparation: {
                runtimeInstallations: [{ machineId: installedBody.machineId, installationId: installedBody.installationId,
                    publicKey: encodeBase64(f.keys.publicKey, 'base64url') }],
            } });
            expect(prepared.body).not.toContain('launch-trims-private-sentinel');
        });
        const grant: MachineSecretGrantV1 = { ...f.grant, resourceRevision: withdrawn.value.revision,
            sealedContent: 'owner-linked-without-team-resource-share' };
        const content = await f.artifact('deployment-environment.v1', { ...f.content, bindings: [{ purpose: 'variable',
            phase: 'runtime', name: 'OWNER_TOKEN', grantRef: crypto.randomUUID(), source: { kind: 'secret', ref: formatSharedSavedSecretRefV1(f.resourceId),
                resourceRevision: withdrawn.value.revision } }] });
        const linked = await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, f.owner.id, { serverId,
            environmentId: row.id, expectedRevision: row.revision, ...content, grants: [grant],
            referencedSavedSecretRevisions: [{ resourceId: f.resourceId, revision: withdrawn.value.revision }] }));
        expect(linked).toMatchObject({ ok: true });
        expect(await db.savedSecretTeamGrant.count({ where: { resourceId: f.resourceId } })).toBe(0);
        expect(await db.savedSecretAccountGrant.count({ where: { resourceId: f.resourceId } })).toBe(0);
        expect(await db.machineSecretGrant.count({ where: { environmentId: row.id, resourceId: f.resourceId } })).toBe(1);
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const delivered = await app.inject({ method: 'POST', url: f.url,
                headers: { 'x-test-user-id': f.requester.id }, payload: f.payload });
            expect(delivered.statusCode, delivered.body).toBe(200);
            expect(delivered.json()).toEqual({ ok: true, grants: [grant] });
            expect(delivered.body).not.toContain('launch-trims-private-sentinel');
        });
    });

    it.each(['plain', 'e2ee'] as const)('PL-19 requires the %s foreign owner consent even beside an owned link and prunes delivery after withdrawal', async mode => {
        const f = await admittedTeamDelivery(mode);
        const foreignKey = nacl.box.keyPair();
        const foreign = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding(foreignKey.publicKey) : {}) } });
        await db.userRelationship.createMany({ data: [
            { fromUserId: foreign.id, toUserId: f.owner.id, status: 'friend' },
            { fromUserId: f.owner.id, toUserId: foreign.id, status: 'friend' },
        ] });
        await makeShareEligibleForTest(f.owner.id, foreign.id);
        await db.teamMembership.create({ data: { teamId: f.team.id, accountId: foreign.id, role: 'admin' } });
        const resourceId = crypto.randomUUID(), dataKey = nacl.randomBytes(32);
        const content = { v: 1 as const, name: 'Foreign credential', kind: 'token' as const, value: 'foreign-owner-private-sentinel' };
        const foreignRecipient = { id: foreign.id, publicKey: foreignKey.publicKey };
        // The configuring Account can use this resource, but that is not the
        // resource owner's consent to its use by the Source Team.
        const resource = await inTx(tx => createSavedSecretResourceInTx(tx, { accountId: foreign.id, resourceId,
            displayName: content.name, kind: content.kind, encryptionMode: mode, accountGrants: [f.owner.id], teamGrants: [],
            keyEnvelopes: f.envelopes(dataKey, [foreignRecipient, f.recipients[0]!]),
            storedContent: sealSavedSecretResourceStoredContentV1(mode === 'plain' ? { resourceId, mode, content }
                : { resourceId, mode, content, resourceDataKey: dataKey, randomBytes: nacl.randomBytes }) }));
        if (!resource.ok) throw new Error(resource.error);
        const bind = async (revision: number) => {
            const row = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.payload.environmentId } });
            const grant: MachineSecretGrantV1 = { ...f.grant, resourceId, resourceRevision: revision, sealedContent: 'foreign-owner-consented-seal' };
            const candidate = await f.artifact('deployment-environment.v1', { ...f.content, bindings: [
                { purpose: 'variable', phase: 'runtime', name: 'OWNER_TOKEN', grantRef: crypto.randomUUID(), source: { kind: 'secret',
                    ref: formatSharedSavedSecretRefV1(f.resourceId), resourceRevision: f.resourceRevision } },
                { purpose: 'variable', phase: 'runtime', name: 'FOREIGN_TOKEN', grantRef: crypto.randomUUID(), source: { kind: 'secret',
                    ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: revision } },
            ] });
            return { grant, result: await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, f.owner.id, { serverId,
                environmentId: row.id, expectedRevision: row.revision, ...candidate, grants: [f.grant, grant],
                referencedSavedSecretRevisions: [{ resourceId: f.resourceId, revision: f.resourceRevision }, { resourceId, revision }] })) };
        };
        const beforeRefusal = await db.machineSecretGrant.findMany({ where: { environmentId: f.payload.environmentId } });
        expect((await bind(resource.value.revision)).result).toEqual({ ok: false, error: 'deployment_conflict' });
        expect(await db.machineSecretGrant.findMany({ where: { environmentId: f.payload.environmentId } })).toEqual(beforeRefusal);
        expect(await db.machineSecretGrant.count({ where: { environmentId: f.payload.environmentId, resourceId } })).toBe(0);
        const shared = await inTx(tx => setSavedSecretResourceGrantsInTx(tx, { accountId: foreign.id, resourceId,
            expectedRevision: resource.value.revision, accountGrants: [f.owner.id], teamGrants: [f.team.id], groupGrants: [],
            keyEnvelopes: f.envelopes(dataKey, [foreignRecipient, ...f.recipients]) }));
        if (!shared.ok) throw new Error(shared.error);
        const consented = await bind(shared.value.revision);
        expect(consented.result).toMatchObject({ ok: true });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const read = () => app.inject({ method: 'POST', url: f.url,
                headers: { 'x-test-user-id': f.requester.id }, payload: f.payload });
            const allowed = await read();
            expect(allowed.statusCode, allowed.body).toBe(200);
            expect(allowed.json()).toEqual({ ok: true, grants: expect.arrayContaining([f.grant, consented.grant]) });
            expect(allowed.json().grants).toHaveLength(2);
            const withdrawn = await inTx(tx => setSavedSecretResourceGrantsInTx(tx, { accountId: foreign.id, resourceId,
                expectedRevision: shared.value.revision, accountGrants: [], teamGrants: [], groupGrants: [],
                keyEnvelopes: f.envelopes(dataKey, [foreignRecipient]) }));
            expect(withdrawn).toMatchObject({ ok: true, value: { revision: shared.value.revision + 1 } });
            expect(await db.machineSecretGrant.count({ where: { environmentId: f.payload.environmentId, resourceId } })).toBe(0);
            const denied = await read();
            expect(denied.json()).toEqual({ ok: true, grants: [f.grant] });
            expect(denied.body).not.toContain(consented.grant.sealedContent);
            expect(denied.body).not.toContain(content.value);
        });
    });

    it('admits only the exact captured desired Domain installation and selected resource through the private route', async () => {
        const f = await admittedTeamDelivery();
        const environment = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.payload.environmentId } });
        const link = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: f.payload.targetLinkId } });
        const content = await f.artifact('deployment-domain.v1', { hostname: 'domain.example.test' });
        const native = await observeDeploymentDomainNativeForTest();
        onTestFinished(native.close);
        expect(native.reads.filter(args => args[0] === 'info')).toHaveLength(1);
        expect(native.reads.filter(args => args[0] !== 'info'
            && !(args[0] === 'container' && ['ls', 'inspect'].includes(args[1] ?? '')))).toHaveLength(0);
        const target = { kind: 'machine' as const, machineId: f.payload.machineId };
        const requestId = crypto.randomUUID();
        const actionOperationId = crypto.randomUUID();
        const input = { serverId, environmentId: environment.id, domainId: crypto.randomUUID(), expectedRevision: environment.revision,
            targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: crypto.randomUUID(), ...content,
            placements: [{ machineId: f.payload.machineId, installationId: f.payload.installationId,
                nativeServer: native.nativeServer, dockerEngineId: native.dockerEngineId, listener: 'public' as const }] };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.requester.id, authentication: { kind: 'account', tokenEpoch: f.requester.tokenEpoch },
            actionId: 'deployments.domains.add', machineId: target.machineId, target, requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId, target, input }) }, { input });
        const domain = await inTx(tx => createDeploymentDomainInTx(tx, f.requester.id, { ...input, requestId, actionOperationId }, {}, authorization.binding));
        expect(domain).toMatchObject({ ok: true });
        if (!domain.ok) throw new Error(domain.error);
        expect(domain.domain.placements).toMatchObject([{ dockerEngineId: native.dockerEngineId,
            placement: { nativeServer: native.nativeServer } }]);
        const materialization = { kind: 'domain' as const, domainId: domain.domain.id, expectedDomainRevision: domain.domain.revision,
            actionOperationId, capture: domain.domain.placements![0]!,
            use: { purpose: 'domainCredential' as const, domainId: domain.domain.id, role: 'basicAuth' as const,
                source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1(f.resourceId), resourceRevision: f.resourceRevision } } };
        const signed = (next = materialization) => {
            const body = { ...f.payload, materialization: next };
            const { proof: _old, ...unsigned } = body;
            return { ...unsigned, proof: signMachineInstallationProof({ privateKey: f.keys.secretKey,
                payload: { version: 1, accountId: f.requester.id, machineId: unsigned.machineId, installationId: unsigned.installationId,
                    deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(unsigned) } } }) };
        };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const read = (next = materialization) => app.inject({ method: 'POST', url: f.url,
                headers: { 'x-test-user-id': f.requester.id }, payload: signed(next) });
            const prepare = (domainIds?: string[]) => app.inject({ method: 'POST', url: f.url,
                headers: { 'x-test-user-id': f.requester.id }, payload: { kind: 'clientBindings', serverId,
                    environmentId: environment.id, expectedRevision: domain.revision, ...(domainIds ? { domainIds } : {}) } });
            expect((await prepare()).json()).toMatchObject({ ok: true,
                bindingPreparation: { domainDestinations: { status: 'complete', domains: [] } } });
            const projection = await prepare([domain.domain.id]);
            expect(projection.statusCode, projection.body).toBe(200);
            expect(projection.json()).toMatchObject({ bindingPreparation: { domainDestinations: { status: 'complete', domains: [{
                domainId: domain.domain.id, installations: [{ machineId: f.payload.machineId, installationId: f.payload.installationId,
                    publicKey: encodeBase64(f.keys.publicKey, 'base64url') }],
            }] } } });
            expect((await prepare(['unknown-domain'])).json()).toMatchObject({ ok: true,
                bindingPreparation: { domainDestinations: { status: 'incomplete', domains: [] } } });
            const allowed = await read();
            expect(allowed.statusCode, allowed.body).toBe(200);
            expect(allowed.json()).toMatchObject({ ok: true, grants: [f.grant] });
            for (const next of [{ ...materialization, expectedDomainRevision: materialization.expectedDomainRevision + 1 },
                { ...materialization, actionOperationId: 'wrong-operation' },
                { ...materialization, capture: { ...materialization.capture, placement: { ...materialization.capture.placement, installationId: 'wrong-installation' } } },
                { ...materialization, use: { ...materialization.use, domainId: 'wrong-domain' } }]) {
                const denied = await read(next);
                expect(denied.statusCode, denied.body).toBe(403);
            }
            const missing = await read({ ...materialization, use: { ...materialization.use,
                source: { ...materialization.use.source, resourceRevision: materialization.use.source.resourceRevision + 1 } } });
            expect(missing.json()).toMatchObject({ ok: false, error: 'secret_missing' });
            await db.deploymentDomain.update({ where: { id: domain.domain.id }, data: { state: 'active' } });
            expect((await read()).statusCode).toBe(403);
        });
    });

    it('refuses Domain controller facts without a genuinely authenticated child through the private route', async () => {
        const f = await admittedTeamDelivery('plain', true);
        const environment = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.payload.environmentId } });
        const link = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: f.payload.targetLinkId } });
        const content = await f.artifact('deployment-domain.v1', { hostname: 'connector.example.test' });
        const native = await observeDeploymentDomainNativeForTest();
        onTestFinished(native.close);
        const target = { kind: 'machine' as const, machineId: f.controller.machineId };
        const requestId = crypto.randomUUID(), actionOperationId = crypto.randomUUID();
        const input = { serverId, environmentId: environment.id, domainId: crypto.randomUUID(), expectedRevision: environment.revision,
            targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: crypto.randomUUID(), ...content,
            placements: [{ machineId: f.payload.machineId, installationId: f.payload.installationId,
                nativeServer: native.nativeServer, dockerEngineId: native.dockerEngineId, listener: 'public' as const }] };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: f.requester.id, authentication: { kind: 'account', tokenEpoch: f.requester.tokenEpoch },
            actionId: 'deployments.domains.add', machineId: target.machineId, target, requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId, target, input }) }, { input });
        const domain = await inTx(tx => createDeploymentDomainInTx(tx, f.requester.id,
            { ...input, requestId, actionOperationId }, {}, authorization.binding));
        expect(domain).toMatchObject({ ok: true });
        if (!domain.ok) throw new Error(domain.error);
        const capture = domain.domain.placements![0]!;
        expect(capture).toMatchObject({ dockerEngineId: native.dockerEngineId, placement: {
            machineId: f.payload.machineId, installationId: f.payload.installationId, actionOperationId } });
        expect(f.controller.machineId).not.toBe(f.payload.machineId);
        const controllerRow = await db.machine.findUniqueOrThrow({ where: { id: f.controller.machineId } });
        const targetRow = await db.machine.findUniqueOrThrow({ where: { id: f.payload.machineId } });
        expect(controllerRow.accountId).not.toBe(f.requester.id);
        expect(targetRow.accountId).not.toBe(f.requester.id);
        expect(controllerRow.accountId).not.toBe(targetRow.accountId);
        const materialization = { kind: 'domain' as const, domainId: domain.domain.id,
            expectedDomainRevision: domain.domain.revision, actionOperationId, capture };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            // This target read proves the real desired Domain and its existing
            // grant are valid before the new facts-only controller acquisition.
            const targetBody = { serverId, environmentId: environment.id, targetLinkId: link.id,
                machineId: f.payload.machineId, installationId: f.payload.installationId,
                materialization: { ...materialization, use: { purpose: 'domainCredential' as const,
                    domainId: domain.domain.id, role: 'basicAuth' as const,
                    source: { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1(f.resourceId), resourceRevision: f.resourceRevision } } } };
            const targetRead = await app.inject({ method: 'POST', url: f.url,
                headers: { 'x-test-user-id': f.requester.id }, payload: { ...targetBody,
                    proof: signMachineInstallationProof({ privateKey: f.keys.secretKey, payload: { version: 1,
                        accountId: f.requester.id, machineId: targetBody.machineId, installationId: targetBody.installationId,
                        deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(targetBody) } } }) } });
            expect(targetRead.statusCode, targetRead.body).toBe(200);
            expect(targetRead.json()).toMatchObject({ ok: true, grants: [f.grant] });
            const body = { serverId, environmentId: environment.id, targetLinkId: link.id,
                machineId: f.controller.machineId, installationId: f.controller.installationId, materialization };
            const response = await app.inject({ method: 'POST', url: f.url,
                headers: { 'x-test-user-id': f.requester.id }, payload: { ...body,
                    proof: signMachineInstallationProof({ privateKey: f.controller.keys.secretKey, payload: { version: 1,
                        accountId: f.requester.id, machineId: body.machineId, installationId: body.installationId,
                        deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } } }) } });
            expect(response.statusCode, response.body).toBe(403);
            expect(response.json()).toEqual({ ok: false, error: 'deployment_access_denied' });
            expect(response.body).not.toContain('domainAdmission');
            expect(response.body).not.toContain(f.grant.sealedContent);
            expect(response.body).not.toContain('launch-trims-private-sentinel');
        });
    });

    it('admits an authorized review without candidate re-admission but refuses a read-only Team requester', async () => {
        const fixture = await admittedTeamDelivery();
        const { proof: _proof, ...body } = fixture.payload;
        const review = { ...body, materialization: { kind: 'review' as const, contentArtifactId: 'not-a-second-admission' } };
        const payload = { ...review, proof: signMachineInstallationProof({ privateKey: fixture.keys.secretKey,
            payload: { version: 1, accountId: fixture.requester.id, machineId: review.machineId,
                installationId: review.installationId,
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(review) } } }) };
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const read = () => app.inject({ method: 'POST', url: fixture.url,
                headers: { 'x-test-user-id': fixture.requester.id }, payload });
            expect((await read()).json()).toEqual({ ok: true, grants: [fixture.grant] });
            await db.teamMembership.updateMany({ where: { teamId: fixture.team.id,
                accountId: fixture.requester.id }, data: { role: 'member' } });
            const denied = await read();
            expect(denied.statusCode, denied.body).toBe(403);
            expect(denied.json()).toEqual({ ok: false, error: 'deployment_access_denied' });
            expect(denied.body).not.toContain(fixture.grant.sealedContent);
        });
    });

    it.each(['catalog', 'requester', 'audience'] as const)('launch admission trims preserve %s custody through the real route', async scenario => {
        const fixture = await admittedTeamDelivery();
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const read = () => app.inject({ method: 'POST', url: fixture.url,
                headers: { 'x-test-user-id': fixture.requester.id }, payload: fixture.payload });
            if (scenario === 'requester') await db.teamMembership.updateMany({ where: {
                teamId: fixture.team.id, accountId: fixture.requester.id }, data: { role: 'member' } });
            if (scenario === 'audience') {
                expect(await inTx(tx => setSavedSecretResourceGrantsInTx(tx, { accountId: fixture.owner.id,
                    resourceId: fixture.resourceId, expectedRevision: fixture.resourceRevision,
                    accountGrants: [], teamGrants: [], groupGrants: [] }))).toMatchObject({ ok: true });
            }
            const response = await read();
            expect(response.statusCode, response.body).toBe(200);
            if (scenario === 'catalog') expect(response.json()).toEqual({ ok: true, grants: [fixture.grant] });
            else if (scenario === 'requester') expect(response.json()).toMatchObject({ ok: true, grants: [fixture.grant] });
            else {
                expect(response.json()).toMatchObject({ ok: true, grants: [] });
                expect(response.body).not.toContain(fixture.grant.sealedContent);
            }
        });
    });

    it.each([
        { pluginId: 'example.network', localId: 'connector' },
        { kind: 'builtin' as const, id: 'tailscale' },
        { kind: 'builtin' as const, id: 'cloudflare' },
    ])('stores and reads an exact Machine connector grant for %j through signed setup and installed authority without an Environment', async provider => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const stranger = await db.account.create({ data: { encryptionMode: 'plain' } });
        const keys = nacl.sign.keyPair();
        const controllerKeys = nacl.sign.keyPair();
        const machineId = crypto.randomUUID(), installationId = crypto.randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: owner.id, active: true,
            metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({ host: 'Connector', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/home/connector', happyHomeDir: '/home/connector/.happier' })),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId,
            installationPublicKey: new Uint8Array(keys.publicKey) } });
        const controllerMachineId = crypto.randomUUID(), controllerInstallationId = crypto.randomUUID();
        await db.machine.create({ data: { id: controllerMachineId, accountId: owner.id, metadata: '{}',
            installationId: controllerInstallationId, installationPublicKey: new Uint8Array(controllerKeys.publicKey) } });
        const grant = { v: 1 as const, kind: 'connectorToken' as const, machineId, installationId,
            provider, connectorId: 'admitted-connector',
            sealedContent: 'installed-ciphertext-without-token' };
        const { sealedContent: _sealed, ...subject } = grant;
        const common = { serverId, hostMachineId: machineId, hostInstallationId: installationId, subject };
        const signed = (body: typeof common & ({ operation: 'read' | 'remove' } | { operation: 'set'; grant: typeof grant }), signingKeys = keys) => ({ ...body,
            proof: signMachineInstallationProof({ payload: { version: 1, machineId: body.hostMachineId,
                installationId: body.hostInstallationId, accountId: owner.id,
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } }, privateKey: signingKeys.secretKey }) });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const url = `/v1/deployments/machines/${machineId}/connector-secret-grant`;
            const send = (payload: object, accountId = owner.id) => app.inject({ method: 'POST', url,
                headers: { 'x-test-user-id': accountId }, payload });
            const controller = { ...common, hostMachineId: controllerMachineId, hostInstallationId: controllerInstallationId };
            let response = await send(signed({ ...controller, operation: 'set', grant }, controllerKeys));
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual({ ok: true, grant });
            expect(await db.machineSecretGrant.count({ where: { machineId, environmentId: null } })).toBe(1);
            expect((await send(signed({ ...controller, operation: 'read' }, controllerKeys))).statusCode).toBe(403);
            const writes: string[] = [];
            const stop = observePrismaRequests(db, { before: request => {
                if (request.model === 'MachineSecretGrant' && !request.action.startsWith('find')) writes.push(request.action);
            } });
            try {
                expect((await send(signed({ ...common, operation: 'set', grant }))).statusCode).toBe(200);
                expect((await send(signed({ ...common, operation: 'read' }))).json()).toEqual({ ok: true, grant });
                expect(writes).toEqual([]);
            } finally { stop(); }
            const rotated = { ...grant, sealedContent: 'replacement-installed-ciphertext' };
            expect((await send(signed({ ...controller, operation: 'set', grant: rotated }, controllerKeys))).json())
                .toEqual({ ok: true, grant: rotated });
            expect((await send(signed({ ...common, operation: 'read' }))).json()).toEqual({ ok: true, grant: rotated });
            expect(await db.machineSecretGrant.count({ where: { machineId, environmentId: null } })).toBe(1);
            expect((await send(signed({ ...common, operation: 'read' }), stranger.id)).statusCode).toBe(403);
            expect((await send(signed({ ...common, subject: { ...subject, connectorId: 'other' }, operation: 'read' }))).json())
                .toMatchObject({ ok: false, error: 'secret_missing' });
            const tampered = { ...signed({ ...common, operation: 'read' }), subject: { ...subject, installationId: 'retired' } };
            expect((await send(tampered)).statusCode).toBe(403);
            const setupInput = MachineSetupApplyInputV1Schema.parse({ homeId: serverId, machineId, targets: [{
                homeId: serverId, machineId, desiredRevision: 0, recipePlans: [],
                sources: [{ kind: 'direct', setup: {} }],
            }] });
            const target = { kind: 'machine' as const, machineId };
            const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input: setupInput };
            const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
                accountId: owner.id, authentication: { kind: 'account', tokenEpoch: owner.tokenEpoch },
                actionId: 'machines.setup.apply', machineId, target, requestId: envelope.requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input: setupInput });
            // Compose production authentication, purpose narrowing, installed
            // proof and the exact repository read; no fixture bearer shortcut.
            await withAuthenticatedTestApp(registerDeploymentRoutes, async authenticated => {
                const signedRead = signed({ ...common, operation: 'read' });
                const sendRoot = (body: object, admitted = authorization) => authenticated.inject({ method: 'POST', url, payload: body, headers: {
                    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: admitted.token,
                    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.setup.apply',
                    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                        authorizationToken: admitted.token, effectActionId: 'machines.setup.apply', target,
                        installationId, requestId: admitted.binding.requestId, method: 'POST', path: url, body,
                        privateKey: keys.secretKey }),
                } });
                const read = await sendRoot(signedRead);
                expect(read.statusCode, read.body).toBe(200);
                expect(read.json()).toEqual({ ok: true, grant: rotated });
                const wrongProof = signed({ ...common, operation: 'read' }, controllerKeys);
                expect((await sendRoot(wrongProof)).statusCode).toBe(403);
                expect((await sendRoot(signed({ ...common, operation: 'set', grant: rotated }))).statusCode).toBe(401);
                expect((await sendRoot(signed({ ...common, operation: 'remove' }))).statusCode).toBe(401);
                expect(await db.machineSecretGrant.count({ where: { machineId } })).toBe(1);

                const selection = { ref: { pluginId: 'example.network', recipeId: 'connector-join', revision: '1' }, inputs: {} };
                const plan = createMachineSetupEffectPlan({ basis: { kind: 'setup', machineId, desiredRevision: 0, selection },
                    steps: [{ id: 'connector-key', kind: 'file', path: '/run/happier/connector-key',
                        owner: 'root', group: 'root', mode: 0o600, lifetime: 'invocation',
                        content: { kind: 'secretGrant', grantRef: machineSecretGrantSubjectKey(subject) } }],
                    nativeFacts: [{ stepId: 'connector-key', status: 'drifted', facts: { present: false } }] });
                const reviewedInput = MachineSetupApplyInputV1Schema.parse({ ...setupInput, targets: [{
                    ...setupInput.targets[0], sources: [{ kind: 'direct', setup: {
                        items: [{ kind: 'setupRecipe', selection }],
                    } }], recipePlans: [{ sourceIndex: 0, itemIndex: 0, plan }],
                }] });
                const reviewedEnvelope = { ...envelope, requestId: crypto.randomUUID(), input: reviewedInput };
                const reviewedAuthorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
                    accountId: owner.id, authentication: { kind: 'account', tokenEpoch: owner.tokenEpoch },
                    actionId: 'machines.setup.apply', machineId, target, requestId: reviewedEnvelope.requestId,
                    requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(reviewedEnvelope),
                    deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('machines.setup.apply', reviewedInput),
                }, { input: reviewedInput });
                const stored = await sendRoot(signed({ ...common, operation: 'set', grant: rotated }), reviewedAuthorization);
                expect(stored.statusCode, stored.body).toBe(200);
                expect(stored.json()).toEqual({ ok: true, grant: rotated });
                for (const unreviewed of [{ ...subject, connectorId: 'unreviewed-connector' },
                    { ...subject, provider: { kind: 'builtin' as const, id: 'unreviewed-provider' } }]) {
                    for (const operation of ['set', 'remove'] as const) {
                        const body = operation === 'set'
                            ? { ...common, subject: unreviewed, operation, grant: { ...rotated, ...unreviewed } }
                            : { ...common, subject: unreviewed, operation };
                        const refused = await sendRoot(signed(body), reviewedAuthorization);
                        expect(refused.statusCode, refused.body).toBe(401);
                        expect(refused.body).not.toContain(rotated.sealedContent);
                    }
                }
                expect(await db.machineSecretGrant.count({ where: { machineId } })).toBe(1);
                const removed = await sendRoot(signed({ ...common, operation: 'remove' }), reviewedAuthorization);
                expect(removed.statusCode, removed.body).toBe(200);
                expect(removed.json()).toEqual({ ok: true });
                expect(await db.machineSecretGrant.count({ where: { machineId } })).toBe(0);
            }, { authentication: 'real' });
            response = await send(signed({ ...common, operation: 'remove' }));
            expect(response.json()).toEqual({ ok: true });
            expect((await send(signed({ ...common, operation: 'read' }))).json()).toMatchObject({ ok: false, error: 'secret_missing' });
            expect(await db.machineSecretGrant.count({ where: { machineId } })).toBe(0);
            await db.machine.update({ where: { id: machineId }, data: { installationId: 'replacement' } });
            response = await send(signed({ ...common, operation: 'set', grant }));
            expect(response.statusCode).toBe(403);
            expect(response.body).not.toContain(grant.sealedContent);
            expect(await db.machineSecretGrant.count({ where: { machineId } })).toBe(0);
        });
    });

    it('admits signed Manage grantee connector set, read and remove while refusing Use, foreign and cross-host access', async () => {
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
        const user = await db.account.create({ data: { encryptionMode: 'plain' } });
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        const keys = nacl.sign.keyPair(), controllerKeys = nacl.sign.keyPair();
        const machineId = crypto.randomUUID(), installationId = crypto.randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: custodian.id, active: true,
            metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({ host: 'Shared connector', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/home/connector', happyHomeDir: '/home/connector/.happier' })),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), installationId,
            installationPublicKey: new Uint8Array(keys.publicKey),
            operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1 } });
        for (const [accountId, level] of [[manager.id, 'admin'], [user.id, 'view']] as const) {
            expect(await inTx(tx => setEligibleMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId,
                principal: { kind: 'account', accountId }, level }))).toMatchObject({ kind: 'saved' });
        }
        const controllerMachineId = crypto.randomUUID(), controllerInstallationId = crypto.randomUUID();
        await db.machine.create({ data: { id: controllerMachineId, accountId: custodian.id, metadata: '{}',
            installationId: controllerInstallationId, installationPublicKey: new Uint8Array(controllerKeys.publicKey) } });
        const grant = { v: 1 as const, kind: 'connectorToken' as const, machineId, installationId,
            provider: { kind: 'builtin' as const, id: 'tailscale' }, connectorId: 'admitted-shared-connector',
            sealedContent: 'sealed-requester-connector-token' };
        const { sealedContent: _sealed, ...subject } = grant;
        const common = { serverId, hostMachineId: machineId, hostInstallationId: installationId, subject };
        const signed = (body: typeof common & ({ operation: 'read' | 'remove' } | { operation: 'set'; grant: typeof grant }),
            accountId = manager.id, signingKeys = keys) => ({ ...body,
            proof: signMachineInstallationProof({ payload: { version: 1, machineId: body.hostMachineId,
                installationId: body.hostInstallationId, accountId,
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(body) } }, privateKey: signingKeys.secretKey }) });
        const change = { kind: 'privateNetwork' as const, intent: 'join' as const,
            selection: { provider: grant.provider, config: {}, credentialRefs: [] } };
        const input = getActionSpec('machines.reachability.configure').inputSchema.parse({ serverId, machineId, change,
            reviewedPlanDigest: '0'.repeat(64), reviewedPlanBasis: { machineId, installationId, currentPostureRevision: null,
                currentSelections: [], change, occurrences: [], recipePlans: [] } });
        const target = { kind: 'machine' as const, machineId };
        const envelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input };
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: manager.id, authentication: { kind: 'account', tokenEpoch: manager.tokenEpoch },
            actionId: 'machines.reachability.configure', machineId, target, requestId: envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) }, { input });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const url = `/v1/deployments/machines/${machineId}/connector-secret-grant`;
            const sendRoot = (body: object) => app.inject({ method: 'POST', url, payload: body, headers: {
                [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
                [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'machines.reachability.configure',
                [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(target),
                [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
                    authorizationToken: authorization.token, effectActionId: 'machines.reachability.configure', target,
                    installationId, requestId: authorization.binding.requestId, method: 'POST', path: url, body,
                    privateKey: keys.secretKey }),
            } });
            const stored = await sendRoot(signed({ ...common, operation: 'set', grant }));
            expect(stored.statusCode, stored.body).toBe(200);
            expect(stored.json()).toEqual({ ok: true, grant });
            const read = await sendRoot(signed({ ...common, operation: 'read' }));
            expect(read.statusCode, read.body).toBe(200);
            expect(read.json()).toEqual({ ok: true, grant });
            // Valid actor-bound proofs prevent these controls from passing only
            // because a different Account's installation signature was reused.
            for (const account of [user, foreign]) {
                const token = await auth.createToken(account.id, undefined, { kind: 'account', authority: 'present_user' });
                for (const operation of ['set', 'read', 'remove'] as const) {
                    const body = operation === 'set' ? { ...common, operation, grant } : { ...common, operation };
                    const denied = await app.inject({ method: 'POST', url, payload: signed(body, account.id),
                        headers: { authorization: `Bearer ${token}` } });
                    expect(denied.statusCode, denied.body).toBe(403);
                    expect(denied.body).not.toContain(grant.sealedContent);
                }
            }
            const managerToken = await auth.createToken(manager.id, undefined, { kind: 'account', authority: 'present_user' });
            const controller = { ...common, hostMachineId: controllerMachineId, hostInstallationId: controllerInstallationId };
            // The manager can control the subject, but cannot borrow a separate
            // custodian Machine as its signer without Manage on that host.
            for (const operation of ['set', 'read', 'remove'] as const) {
                const body = operation === 'set' ? { ...controller, operation, grant } : { ...controller, operation };
                const denied = await app.inject({ method: 'POST', url, payload: signed(body, manager.id, controllerKeys),
                    headers: { authorization: `Bearer ${managerToken}` } });
                expect(denied.statusCode, denied.body).toBe(403);
                expect(denied.body).not.toContain(grant.sealedContent);
            }
            // Manage on the signing host does not grant access to an unshared
            // subject, even with a valid host signature for that exact body.
            const unmanagedGrant = { ...grant, machineId: controllerMachineId, installationId: controllerInstallationId };
            const { sealedContent: _unmanagedSealed, ...unmanagedSubject } = unmanagedGrant;
            const unmanaged = { ...common, subject: unmanagedSubject };
            for (const operation of ['set', 'remove'] as const) {
                const body = operation === 'set' ? { ...unmanaged, operation, grant: unmanagedGrant } : { ...unmanaged, operation };
                const denied = await app.inject({ method: 'POST',
                    url: `/v1/deployments/machines/${controllerMachineId}/connector-secret-grant`,
                    payload: signed(body), headers: { authorization: `Bearer ${managerToken}` } });
                expect(denied.statusCode, denied.body).toBe(403);
                expect(denied.json()).toEqual({ ok: false, error: 'deployment_access_denied' });
                expect(denied.body).not.toContain(unmanagedGrant.sealedContent);
            }
            expect(await db.machineSecretGrant.count({ where: { machineId: controllerMachineId } })).toBe(0);
            const wrongProof = await sendRoot(signed({ ...common, operation: 'read' }, manager.id, controllerKeys));
            expect(wrongProof.statusCode, wrongProof.body).toBe(403);
            expect((await sendRoot(signed({ ...common, operation: 'read' }))).json()).toEqual({ ok: true, grant });
            expect(await db.machineSecretGrant.count({ where: { machineId } })).toBe(1);
            const removed = await sendRoot(signed({ ...common, operation: 'remove' }));
            expect(removed.statusCode, removed.body).toBe(200);
            expect(removed.json()).toEqual({ ok: true });
            const missing = await sendRoot(signed({ ...common, operation: 'read' }));
            expect(missing.statusCode, missing.body).toBe(404);
            expect(missing.json()).toMatchObject({ ok: false, error: 'secret_missing' });
            expect(await db.machineSecretGrant.count({ where: { machineId } })).toBe(0);
        }, { authentication: 'real' });
    });

    it.each((['account', 'team'] as const).flatMap(ownerKind => [
        [`reads only the exact installation under current ${ownerKind} Source authority, surviving author removal and refusing withdrawal`, ownerKind, false] as const,
        [`retains accepted ${ownerKind} builder custody through legacy capture enrichment`, ownerKind, true] as const,
    ]))('%s', async (_title, ownerKind, retentionOnly) => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const author = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.userRelationship.create({ data: { fromUserId: author.id, toUserId: owner.id, status: 'friend' } });
        const team = ownerKind === 'team' ? await db.team.create({ data: { name: 'Source principal' } }) : null;
        const custodian = team ? await db.account.create({ data: { encryptionMode: 'plain' } }) : owner;
        if (team) await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: 'owner' },
            { teamId: team.id, accountId: author.id, role: 'admin' },
        ] });
        const publishedMachine = { metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse({
            host: 'Accepted builder fixture', platform: 'linux', happyCliVersion: '0.0.0-test',
            homeDir: '/home/happier', happyHomeDir: '/home/happier/.happier',
        })), dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) };
        const keys = nacl.sign.keyPair();
        const machineId = crypto.randomUUID(), installationId = crypto.randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: custodian.id, ...publishedMachine, installationId,
            installationPublicKey: new Uint8Array(keys.publicKey) } });
        if (team) await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: owner.id }), machineId } });
        const builderKeys = nacl.sign.keyPair();
        const builderMachineId = crypto.randomUUID(), builderInstallationId = crypto.randomUUID();
        await db.machine.create({ data: { id: builderMachineId, accountId: owner.id, ...publishedMachine, installationId: builderInstallationId,
            installationPublicKey: new Uint8Array(builderKeys.publicKey) } });
        if (team) await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: owner.id }), machineId: builderMachineId } });
        const futureBuilderKeys = nacl.sign.keyPair();
        const futureBuilderMachineId = crypto.randomUUID(), futureBuilderInstallationId = crypto.randomUUID();
        await db.machine.create({ data: { id: futureBuilderMachineId, accountId: owner.id, ...publishedMachine,
            installationId: futureBuilderInstallationId, installationPublicKey: new Uint8Array(futureBuilderKeys.publicKey) } });
        if (team) await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: owner.id }), machineId: futureBuilderMachineId } });
        await makeShareEligibleForTest(owner.id, author.id);
        const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, {
            serverId, requestKey: crypto.randomUUID(), name: 'Private launch',
            audience: team ? [] : [{ principal: { kind: 'account', accountId: author.id }, level: 'view' }],
            ...(team ? { owner: { kind: 'team', teamId: team.id } } : {}),
            repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
                repository: { nameWithOwner: 'acme/launch', cloneUrl: 'https://github.com/acme/launch.git' }, protocol: 'https' },
        }));
        if (!source.ok) throw new Error(source.error);
        const emptyContent = DeploymentEnvironmentContentV1Schema.parse({ name: 'Staging', retainPreviousDeployments: 1,
            definition: { kind: 'repository', ref: 'main', compose: { path: 'compose.yaml', profiles: [], services: [] } }, bindings: [] });
        async function artifact(kind: string, content: unknown = { name: 'Staging' }) {
            const result = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Private launch' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(content) })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!result.ok) throw new Error(result.error);
            if (team) await db.artifactGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'admin', createdByAccountId: owner.id }), artifactId: result.artifact.id } });
            return { contentArtifactId: result.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        }
        let environmentContent = await artifact('deployment-environment.v1', emptyContent);
        const environment = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
            serverId, projectSourceId: source.source.id, requestKey: crypto.randomUUID(), controllerMachineId: machineId, buildMachineId: builderMachineId,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers', ...environmentContent,
        }));
        if (!environment.ok) throw new Error(environment.error);
        const targetContent = await artifact('deployment-target-link.v1');
        const linked = await inTx(tx => linkDeploymentTargetInTx(tx, owner.id, {
            serverId, environmentId: environment.environmentId, expectedRevision: environment.revision,
            targetId: 'own-server', role: 'runtime', requestKey: crypto.randomUUID(), machines: [{ machineId, installationId }], ...targetContent,
        }));
        if (!linked.ok) throw new Error(linked.error);
        const resourceId = crypto.randomUUID();
        const resource = await inTx(tx => createSavedSecretResourceInTx(tx, {
            accountId: author.id, resourceId, displayName: 'Runtime credential', kind: 'token', encryptionMode: 'plain',
            storedContent: { t: 'plain', v: { v: 1, name: 'Runtime credential', kind: 'token', value: 'never-a-transport-value' } },
            accountGrants: team ? [] : [owner.id], teamGrants: team ? [team.id] : [],
        }));
        if (!resource.ok) throw new Error(resource.error);
        const grant: MachineSecretGrantV1 = { v: 1, kind: 'secret', environmentId: environment.environmentId,
            machineId, installationId, resourceId, resourceRevision: resource.value.revision, sealedContent: 'only-the-installed-box-ciphertext' };
        const builderGrant: MachineSecretGrantV1 = { ...grant, machineId: builderMachineId, installationId: builderInstallationId,
            sealedContent: 'only-the-build-installed-box-ciphertext' };
        const bindingSource = { kind: 'secret' as const, ref: formatSharedSavedSecretRefV1(resourceId), resourceRevision: resource.value.revision };
        const boundContent = await artifact('deployment-environment.v1', DeploymentEnvironmentContentV1Schema.parse({ ...emptyContent,
            bindings: [{ purpose: 'variable', phase: 'runtime', name: 'RUNTIME_TOKEN', grantRef: crypto.randomUUID(), source: bindingSource },
                { purpose: 'variable', phase: 'build', name: 'BUILD_TOKEN', grantRef: crypto.randomUUID(), source: bindingSource }] }));
        const bound = await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, owner.id, {
            serverId, environmentId: environment.environmentId, expectedRevision: linked.revision, ...boundContent,
            grants: [grant, builderGrant], referencedSavedSecretRevisions: [{ resourceId, revision: resource.value.revision }],
        }));
        if (!bound.ok) throw new Error(bound.error);
        environmentContent = boundContent;
        if (team) await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: author.id } });
        const candidate = await artifact('deployment-receipt.v1');
        const body: EnvironmentSecretLaunchAdmissionBodyV1 = { serverId, environmentId: environment.environmentId,
            targetLinkId: linked.targetLinkId, machineId, installationId,
            materialization: { kind: 'review', contentArtifactId: candidate.contentArtifactId } };
        const signed = (input = body) => ({ ...input, proof: signMachineInstallationProof({
            payload: { version: 1, machineId: input.machineId, installationId: input.installationId, accountId: owner.id,
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(input) } }, privateKey: keys.secretKey,
        }) });
        const builderBody = { ...body, machineId: builderMachineId, installationId: builderInstallationId };
        const builderPayload = { ...builderBody, proof: signMachineInstallationProof({ payload: {
            version: 1, machineId: builderMachineId, installationId: builderInstallationId, accountId: owner.id,
            deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(builderBody) },
        }, privateKey: builderKeys.secretKey }) };
        expect(await inTx(tx => readEnvironmentSecretLaunchAdmissionInTx(tx, owner.id, builderPayload)))
            .toMatchObject({ ok: true, grants: [builderGrant] });
        await db.deploymentEnvironment.update({ where: { id: environment.environmentId }, data: { buildMachineId: machineId } });
        expect(await inTx(tx => readEnvironmentSecretLaunchAdmissionInTx(tx, owner.id, builderPayload)))
            .toEqual({ ok: false, error: 'deployment_access_denied' });
        await db.deploymentEnvironment.update({ where: { id: environment.environmentId }, data: { buildMachineId: builderMachineId } });
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const url = `/v1/deployments/environments/${environment.environmentId}/secret-launch-admission`;
            const headers = { 'x-test-user-id': owner.id };
            const read = (payload: object = signed()) => app.inject({ method: 'POST', url, headers, payload });
            let response = await read();
            expect(response.statusCode, response.body).toBe(200);
            const result = EnvironmentSecretLaunchAdmissionResultV1Schema.parse(response.json());
            expect(result).toEqual({ ok: true, grants: [grant] });
            expect(response.body).not.toContain('never-a-transport-value');
            expect(response.body).not.toContain('storedContent');
            expect(response.body).not.toContain('encryptedDataKey');
            const preparationBody = { ...body, materialization: { kind: 'bindings', expectedRevision: bound.revision } };
            const preparationPayload = { ...preparationBody, proof: signMachineInstallationProof({ payload: {
                version: 1, machineId, installationId, accountId: owner.id,
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(
                    EnvironmentSecretLaunchAdmissionBodyV1Schema.parse(preparationBody)) },
            }, privateKey: keys.secretKey }) };
            const prepared = await read(preparationPayload);
            expect(prepared.statusCode, prepared.body).toBe(200);
            const clientPreparation = { kind: 'clientBindings', serverId, environmentId: environment.environmentId,
                expectedRevision: bound.revision };
            const clientPrepared = await read(clientPreparation);
            expect(clientPrepared.statusCode, clientPrepared.body).toBe(200);
            expect(clientPrepared.json()).toEqual(prepared.json());
            for (const authKind of ['terminal', 'api_token', 'account_directory']) {
                const restricted = await app.inject({ method: 'POST', url,
                    headers: { ...headers, 'x-test-auth-token-kind': authKind }, payload: clientPreparation });
                expect(restricted.statusCode).toBe(403);
                expect(restricted.body).not.toContain(grant.sealedContent);
            }
            expect((await read({ ...clientPreparation, expectedRevision: bound.revision + 1 })).statusCode).toBe(409);
            expect((await read({ ...clientPreparation, machineId, installationId })).statusCode).toBe(400);
            const foreignPrepared = await app.inject({ method: 'POST', url,
                headers: { 'x-test-user-id': author.id }, payload: clientPreparation });
            expect(foreignPrepared.statusCode).toBe(team ? 404 : 403);
            expect(foreignPrepared.json()).toEqual({ ok: false,
                error: team ? 'deployment_unavailable' : 'deployment_access_denied' });
            expect(foreignPrepared.body).not.toContain(grant.sealedContent);
            expect(prepared.json()).toMatchObject({ ok: true, grants: expect.arrayContaining([grant, builderGrant]),
                bindingPreparation: { runtimeInstallations: [{ machineId, installationId,
                    publicKey: Buffer.from(keys.publicKey).toString('base64url') }],
                    buildInstallation: { machineId: builderMachineId, installationId: builderInstallationId,
                        publicKey: Buffer.from(builderKeys.publicKey).toString('base64url') } } });
            const builderRead = await read(builderPayload);
            expect(builderRead.statusCode, builderRead.body).toBe(200);
            expect(builderRead.json()).toEqual({ ...result, grants: [builderGrant] });
            const actionOperationId = crypto.randomUUID();
            const receiptInput = { serverId, environmentId: environment.environmentId,
                expectedRevision: bound.revision, targetLinkId: linked.targetLinkId, expectedTargetLinkRevision: linked.targetLinkRevision,
                requestKey: crypto.randomUUID(), actionOperationId, ...candidate };
            const target = { kind: 'machine' as const, machineId };
            const actionEnvelope = { v: 1 as const, requestId: crypto.randomUUID(), target, input: receiptInput };
            const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
                accountId: owner.id, authentication: { kind: 'account', tokenEpoch: owner.tokenEpoch },
                actionId: 'deployments.deploy', machineId, target, requestId: actionEnvelope.requestId,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(actionEnvelope) }, { input: receiptInput });
            const receipt = await inTx(tx => createDeploymentInTx(tx, owner.id, receiptInput, 'deploy', {}, authorization.binding));
            if (!receipt.ok) throw new Error(receipt.error);
            // This fixture submits no pending/superseding intent. Only an
            // actually admitted receipt can name a generation delivery read.
            if (!('deploymentId' in receipt)) throw new Error('Expected an admitted deployment receipt, not pending intent');
            const deployedBody: EnvironmentSecretLaunchAdmissionBodyV1 = { ...body,
                materialization: { kind: 'deployment', deploymentId: receipt.deploymentId, actionOperationId } };
            response = await read(signed(deployedBody));
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual(result);
            // Retained pre-projection metadata has no binding identities. Its
            // enrichment must not revoke the builder of this admitted work.
            await db.deploymentEnvironment.update({ where: { id: environment.environmentId }, data: {
                referencedSavedSecretRevisions: [{ resourceId, revision: resource.value.revision }],
            } });
            // Placement prepares future custody while preserving the SAME live
            // rows required by the accepted invocation, without a receipt copy.
            const acceptedRows = await db.machineSecretGrant.findMany({ where: { environmentId: environment.environmentId },
                orderBy: { subjectKey: 'asc' } });
            const futureBuilderGrant: MachineSecretGrantV1 = { ...builderGrant, machineId: futureBuilderMachineId,
                installationId: futureBuilderInstallationId, sealedContent: 'future-build-installation-ciphertext' };
            const placement = { serverId, environmentId: environment.environmentId, expectedRevision: receipt.revision,
                ...environmentContent, patch: { buildMachineId: futureBuilderMachineId },
                preparedBindings: { grants: [grant, futureBuilderGrant], referencedSavedSecretRevisions: [{ resourceId, revision: resource.value.revision,
                    requiredBindings: [
                        { purpose: 'variable' as const, phase: 'build' as const },
                        { purpose: 'variable' as const, phase: 'runtime' as const },
                    ] }] } };
            const placed = await inTx(tx => updateDeploymentEnvironmentInTx(tx, owner.id, placement));
            expect(placed, JSON.stringify(placed))
                .toMatchObject({ ok: true, revision: receipt.revision + 1 });
            const retainedRows = await db.machineSecretGrant.findMany({ where: { environmentId: environment.environmentId },
                orderBy: { subjectKey: 'asc' } });
            expect(retainedRows.some(row => row.machineId === futureBuilderMachineId
                && row.installationId === futureBuilderInstallationId && row.contentEnvelope === futureBuilderGrant.sealedContent)).toBe(true);
            for (const row of acceptedRows) expect(retainedRows).toContainEqual(row);
            const bindingRefreshWrites: string[] = [];
            const stopBindingRefresh = observePrismaRequests(db, { before: request => {
                if (request.model === 'MachineSecretGrant' && !request.action.startsWith('find')) bindingRefreshWrites.push(request.action);
            } });
            try {
                expect(await inTx(tx => setDeploymentEnvironmentBindingsInTx(tx, owner.id, {
                    serverId, environmentId: environment.environmentId, expectedRevision: receipt.revision + 1,
                    ...environmentContent, ...placement.preparedBindings,
                }))).toMatchObject({ ok: true, revision: receipt.revision + 1 });
                expect(bindingRefreshWrites).toEqual([]);
            } finally { stopBindingRefresh(); }
            expect(await db.machineSecretGrant.findMany({ where: { environmentId: environment.environmentId },
                orderBy: { subjectKey: 'asc' } })).toEqual(retainedRows);
            const replayed = await inTx(tx => createDeploymentInTx(tx, owner.id, receiptInput, 'deploy', {}, authorization.binding));
            expect(replayed).toMatchObject({ ok: true, deploymentId: receipt.deploymentId });
            const acceptedRead = await read(signed(deployedBody));
            expect(acceptedRead.statusCode, acceptedRead.body).toBe(200);
            expect(acceptedRead.json()).toEqual(result);
            const acceptedBuilderBody: EnvironmentSecretLaunchAdmissionBodyV1 = { ...deployedBody,
                machineId: builderMachineId, installationId: builderInstallationId };
            const acceptedBuilderPayload = { ...acceptedBuilderBody, proof: signMachineInstallationProof({ payload: {
                version: 1, machineId: builderMachineId, installationId: builderInstallationId, accountId: owner.id,
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(acceptedBuilderBody) },
            }, privateKey: builderKeys.secretKey }) };
            expect((await read(acceptedBuilderPayload)).json()).toEqual({ ...result, grants: [builderGrant] });
            const futureBuilderBody: EnvironmentSecretLaunchAdmissionBodyV1 = { ...deployedBody,
                machineId: futureBuilderMachineId, installationId: futureBuilderInstallationId };
            const futureBuilderPayload = { ...futureBuilderBody, proof: signMachineInstallationProof({ payload: {
                version: 1, machineId: futureBuilderMachineId, installationId: futureBuilderInstallationId, accountId: owner.id,
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(futureBuilderBody) },
            }, privateKey: futureBuilderKeys.secretKey }) };
            const substitutedBuilderRead = await read(futureBuilderPayload);
            expect(substitutedBuilderRead.json()).toMatchObject({ ok: false, error: 'deployment_access_denied' });
            expect(substitutedBuilderRead.body).not.toContain(futureBuilderGrant.sealedContent);
            const wrongOperationBody: EnvironmentSecretLaunchAdmissionBodyV1 = { ...acceptedBuilderBody,
                materialization: { kind: 'deployment', deploymentId: receipt.deploymentId, actionOperationId: crypto.randomUUID() } };
            const wrongOperationRead = await read({ ...wrongOperationBody, proof: signMachineInstallationProof({ payload: {
                version: 1, machineId: builderMachineId, installationId: builderInstallationId, accountId: owner.id,
                deploymentSecretLaunch: { requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(wrongOperationBody) },
            }, privateKey: builderKeys.secretKey }) });
            expect(wrongOperationRead.json()).toMatchObject({ ok: false, error: 'deployment_unavailable' });
            expect(wrongOperationRead.body).not.toContain(builderGrant.sealedContent);
            await db.machine.update({ where: { id: builderMachineId }, data: { installationId: crypto.randomUUID() } });
            expect((await read(acceptedBuilderPayload)).json()).toMatchObject({ ok: false, error: 'deployment_access_denied' });
            await db.machine.update({ where: { id: builderMachineId }, data: { installationId: builderInstallationId, revokedAt: new Date() } });
            expect((await read(acceptedBuilderPayload)).json()).toMatchObject({ ok: false, error: 'deployment_access_denied' });
            await db.machine.update({ where: { id: builderMachineId }, data: { revokedAt: null } });
            expect((await read(acceptedBuilderPayload)).json()).toEqual({ ...result, grants: [builderGrant] });
            await db.deployment.update({ where: { id: receipt.deploymentId }, data: { cancelRequestedAt: new Date() } });
            const cancelledBuilderRead = await read(acceptedBuilderPayload);
            expect(cancelledBuilderRead.json()).toMatchObject({ ok: false, error: 'deployment_unavailable' });
            expect(cancelledBuilderRead.body).not.toContain(builderGrant.sealedContent);
            await db.deployment.update({ where: { id: receipt.deploymentId }, data: { cancelRequestedAt: null } });
            if (retentionOnly) return;
            // The launch protocol has no generation recovery admission. Native
            // recovery keeps original material on the Machine; a signed unknown
            // wire kind cannot acquire replacement material from Home.
            const generationBody = { ...body, materialization: { kind: 'generation' as const,
                deploymentId: receipt.deploymentId } };
            const generationPayload = (input = generationBody) => ({ ...input,
                proof: signMachineInstallationProof({ payload: { version: 1, machineId: input.machineId,
                    installationId: input.installationId, accountId: custodian.id, deploymentSecretLaunch: {
                        // Raw future-wire HTTP fixture; signing precedes schema
                        // admission and supplies no internal recovery authority.
                        requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(
                            input as unknown as EnvironmentSecretLaunchAdmissionBodyV1),
                    } }, privateKey: keys.secretKey }) });
            const readGeneration = (input = generationBody) => app.inject({ method: 'POST', url,
                headers: { 'x-test-user-id': custodian.id }, payload: generationPayload(input) });
            // A global failed result may leave a keepPartial member running.
            // No activeDeploymentId or successful aggregate is a read authority.
            await db.deployment.update({ where: { id: receipt.deploymentId }, data: { state: 'failed' } });
            try {
                const generationGrantReads: unknown[] = [], generationResourceReads: unknown[] = [], generationWrites: string[] = [];
                const stopGenerationReads = observePrismaRequests(db, { before: request => {
                    if (request.model === 'MachineSecretGrant') {
                        if (request.action === 'findMany') generationGrantReads.push(request.args);
                        else if (!request.action.startsWith('find')) generationWrites.push(request.action);
                    }
                    if (request.model === 'SavedSecretResource' && request.action === 'findMany') generationResourceReads.push(request.args);
                } });
                const recovered = await readGeneration().finally(stopGenerationReads);
                expect(recovered.statusCode, recovered.body).toBe(400);
                expect(recovered.json()).toEqual({ ok: false, error: 'deployment_invalid' });
                expect(recovered.body).not.toContain(grant.sealedContent);
                expect(generationGrantReads).toEqual([]);
                expect(generationResourceReads).toEqual([]);
                expect(generationWrites).toEqual([]);
            } finally {
                await db.deployment.update({ where: { id: receipt.deploymentId }, data: { state: 'queued' } });
            }
            // Subsequent audience/resource/installation revocation controls must
            // still withdraw this accepted operation's delivery authority.
            // The custodian never joined the Team or Source audience. Installed
            // delivery uses the Source principal's current Machine grant.
            const readInstalled = () => app.inject({ method: 'POST', url,
                headers: { 'x-test-user-id': custodian.id }, payload: { ...deployedBody,
                    proof: signMachineInstallationProof({ payload: { version: 1, machineId, installationId,
                        accountId: custodian.id, deploymentSecretLaunch: {
                            requestBodyDigest: computeEnvironmentSecretLaunchAdmissionDigestV1(deployedBody),
                        } }, privateKey: keys.secretKey }) } });
            response = await readInstalled();
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toEqual(result);
            if (team) {
                expect(await db.teamMembership.count({ where: { teamId: team.id, accountId: custodian.id } })).toBe(0);
                await db.machineGrant.deleteMany({ where: { principalKind: 'team', machineId, teamId: team.id } });
                response = await readInstalled();
                expect(response.json()).toMatchObject({ ok: false, error: 'machine_unavailable' });
                expect(response.body).not.toContain(grant.sealedContent);
                await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'view', createdByAccountId: owner.id }), machineId } });
                expect((await readInstalled()).json()).toEqual(result);
            }
            expect((await read(signed({ ...deployedBody, materialization: { ...deployedBody.materialization,
                kind: 'deployment', deploymentId: receipt.deploymentId, actionOperationId: 'foreign-operation' } }))).json())
                .toMatchObject({ ok: false, error: 'deployment_unavailable' });
            const writes: string[] = [], resourceSelections: unknown[] = [];
            const stop = observePrismaRequests(db, { before: request => {
                if (!request.action.startsWith('find') && request.model === 'MachineSecretGrant') writes.push(request.action);
                if (request.model === 'SavedSecretResource' && request.action === 'findMany') resourceSelections.push(request.args);
            } });
            try {
                await inTx(tx => updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: source.source.id,
                    expectedRevision: source.source.revision, patch: { audience: [] } }));
                // Unrelated Environment content revision never changes exact grant custody.
                await db.deploymentEnvironment.update({ where: { id: environment.environmentId }, data: { revision: { increment: 1 } } });
                response = await read();
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toEqual(result);
                expect(writes).toEqual([]);
                // Binding admission records consent; withdrawal prunes stored
                // seals at the resource writer, so delivery does not re-admit it.
                expect(resourceSelections).toEqual([]);
            } finally { stop(); }
            // Preparation is a current writer read, unlike runtime delivery's
            // author/revision-independent exact installation subject.
            expect((await read(preparationPayload)).json()).toMatchObject({ ok: false, error: 'deployment_conflict' });
            expect((await read({ ...signed(), targetLinkId: 'substituted-link' })).statusCode).toBe(403);
            expect((await read(signed({ ...body, installationId: 'replaced-installation' }))).statusCode).toBe(403);
            expect((await app.inject({ method: 'POST', url, payload: signed() })).statusCode).toBe(401);
            // Withdrawal deletes obsolete ciphertext. The host's known bindings
            // still require exact material; an empty private read cannot launch it.
            expect(await inTx(tx => setSavedSecretResourceGrantsInTx(tx, { accountId: author.id, resourceId,
                expectedRevision: resource.value.revision, accountGrants: [], teamGrants: [], groupGrants: [] }))).toMatchObject({ ok: true });
            response = await read();
            expect(response.json()).toEqual({ ok: true, grants: [] });
            expect(response.body).not.toContain(grant.sealedContent);
            expect(await db.machineSecretGrant.count({ where: { environmentId: environment.environmentId } })).toBe(0);
            const withdrawnAccepted = await read(signed(deployedBody));
            expect(withdrawnAccepted.json()).toEqual({ ok: true, grants: [] });
            expect(withdrawnAccepted.body).not.toContain(grant.sealedContent);
            const withdrawnGeneration = await readGeneration();
            expect(withdrawnGeneration.statusCode, withdrawnGeneration.body).toBe(400);
            expect(withdrawnGeneration.json()).toEqual({ ok: false, error: 'deployment_invalid' });
            expect(withdrawnGeneration.body).not.toContain(grant.sealedContent);
            // An empty delivery read is not Source authority. Even the still-valid
            // installation proof must observe the canonical Source on each read.
            await db.account.update({ where: { id: owner.id }, data: { status: 'suspended' } });
            response = await read();
            expect(response.json()).toMatchObject({ ok: false, error: 'deployment_unavailable' });
            expect(response.body).not.toContain(grant.sealedContent);
        });
    });
});
