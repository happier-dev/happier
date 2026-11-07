import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, encodePlainMachineStoredContent,
    MACHINE_PLAIN_DATA_KEY_MARKER, computeDeploymentTransitionRequestDigestV1, readDeploymentAccountChangeV1,
    type DeploymentTransitionInputV1 } from '@happier-dev/protocol';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { auth } from '@/app/auth/auth';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { createDeploymentInTx, requestCancelDeploymentInTx, transitionDeploymentInTx } from './deploymentService';
import { deleteDeploymentEnvironmentInTx } from './deploymentDispositionService';

describe('admitted deployment settlement', () => {
    const serverId = `srv_${'e'.repeat(32)}`;
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-admitted-deployment-', initEncrypt: true, initAuth: true,
            env: { HAPPIER_SERVER_IDENTITY_ID: serverId, AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function fixture() {
        const requester = await db.account.create({ data: { encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Deployment audience' } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: requester.id, role: 'owner' } });
        const source = await inTx(tx => createProjectSourceInTx(tx, requester.id, { serverId,
            requestKey: crypto.randomUUID(), name: 'Admitted settlement',
            audience: [{ principal: { kind: 'team', teamId: team.id }, level: 'view' }] }));
        if (!source.ok) throw new Error(source.error);
        const keys = nacl.sign.keyPair();
        const machineId = crypto.randomUUID(), installationId = crypto.randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: custodian.id, installationId,
            installationPublicKey: new Uint8Array(keys.publicKey),
            metadata: encodePlainMachineStoredContent({ host: 'Settlement', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/settlement', happyHomeDir: '/home/settlement/.happier' }),
            dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        await db.machineAccountGrant.create({ data: { machineId, accountId: requester.id,
            accessLevel: 'admin', createdByAccountId: custodian.id } });
        const artifact = async (kind: string) => {
            const result = await createArtifact({ actorUserId: requester.id, artifactId: crypto.randomUUID(),
                kind: `v1:other:${kind}`,
                header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Settlement' })),
                body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })),
                dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
            if (!result.ok) throw new Error(result.error);
            return { contentArtifactId: result.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        };
        // Genuine storage fixtures establish definitions; admission and all receipt writes use the real service.
        const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
            createdByAccountId: requester.id, controllerMachineId: machineId, buildMachineId: machineId,
            protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
            ...await artifact('deployment-environment.v1') } });
        const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
            createdByAccountId: requester.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'configured', ...await artifact('deployment-target-link.v1'),
            machines: { create: [{ machineId, installationId, position: 0, state: 'active' }] } } });
        await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
        const input = { serverId, environmentId: environment.id, expectedRevision: environment.revision,
            targetLinkId: link.id, expectedTargetLinkRevision: link.revision, requestKey: crypto.randomUUID(),
            actionOperationId: crypto.randomUUID(), ...await artifact('deployment-receipt.v1') };
        const target = { kind: 'machine' as const, machineId };
        const requestId = crypto.randomUUID();
        const authorization = await auth.mintExternalActionExecutionAuthorization({ serverIdentityId: serverId,
            accountId: requester.id, authentication: { kind: 'account', tokenEpoch: requester.tokenEpoch },
            actionId: 'deployments.deploy', machineId, target, requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1({ v: 1, requestId, target, input }) }, { input });
        const create = () => inTx(tx => createDeploymentInTx(tx, requester.id, input, 'deploy', {}, authorization.binding));
        const sign = (body: Omit<DeploymentTransitionInputV1, 'proof'>): DeploymentTransitionInputV1 => ({ ...body,
            proof: signMachineInstallationProof({ payload: { version: 1, machineId, installationId, accountId: requester.id,
                deploymentTransition: { serverId, environmentId: environment.id, deploymentId: body.deploymentId,
                    actionOperationId: body.actionOperationId, expectedRevision: body.expectedRevision,
                    requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body) } }, privateKey: keys.secretKey }) });
        return { requester, custodian, source: source.source, machineId, installationId, environment, link, input, create, sign };
    }

    it('settles admitted work after the other Account withdraws its Machine grant, while new work stays refused', async () => {
        const f = await fixture();
        const admitted = await f.create();
        expect(admitted).toMatchObject({ ok: true, state: 'queued' });
        if (!admitted.ok || !('deploymentId' in admitted)) throw new Error('Missing receipt');
        const body = { serverId, environmentId: f.environment.id, deploymentId: admitted.deploymentId,
            actionOperationId: f.input.actionOperationId, machineId: f.machineId, installationId: f.installationId };
        expect(await inTx(tx => transitionDeploymentInTx(tx, f.requester.id,
            f.sign({ ...body, expectedRevision: 1, kind: 'stage', state: 'running' })))).toMatchObject({ ok: true, state: 'running' });
        await db.machineAccountGrant.deleteMany({ where: { machineId: f.machineId, accountId: f.requester.id } });
        const settlement = f.sign({ ...body, expectedRevision: 2, kind: 'settle', state: 'succeeded', expectedTargetLinkRevision: 1 });
        // Captured work still requires the exact installation, requester-bound signature, and receipt CAS.
        expect(await inTx(tx => transitionDeploymentInTx(tx, f.custodian.id, settlement)))
            .toEqual({ ok: false, error: 'deployment_access_denied' });
        await db.machine.update({ where: { id: f.machineId }, data: { revokedAt: new Date() } });
        expect(await inTx(tx => transitionDeploymentInTx(tx, f.requester.id, settlement)))
            .toEqual({ ok: false, error: 'deployment_access_denied' });
        await db.machine.update({ where: { id: f.machineId }, data: { revokedAt: null } });
        expect(await inTx(tx => transitionDeploymentInTx(tx, f.requester.id, settlement)))
            .toMatchObject({ ok: true, state: 'succeeded', deploymentRevision: 3 });
        const receipt = await db.deployment.findUniqueOrThrow({ where: { id: admitted.deploymentId } });
        expect(receipt.state).toBe('succeeded');
        expect(receipt.settledAt).not.toBeNull();
        expect(await inTx(tx => transitionDeploymentInTx(tx, f.requester.id, settlement)))
            .toMatchObject({ ok: true, state: 'succeeded', deploymentRevision: 3 });
        expect(await inTx(tx => createDeploymentInTx(tx, f.requester.id, { ...f.input,
            expectedRevision: admitted.revision, expectedTargetLinkRevision: 2,
            requestKey: crypto.randomUUID(), actionOperationId: crypto.randomUUID() }, 'deploy')))
            .toMatchObject({ ok: false, error: 'machine_unavailable' });
    });

    it('resolves one audience for each create, cancellation and settling operation while publishing both facts', async () => {
        const f = await fixture();
        let audienceReads = 0;
        const stop = observeSqliteRequests({ before(request) {
            if (request.model === 'TeamMembership' && request.action === 'findMany'
                && JSON.stringify(Reflect.get(Object(request.args), 'select')) === JSON.stringify({ accountId: true })) audienceReads++;
        } });
        try {
            let observedCursor = (await db.account.findUniqueOrThrow({ where: { id: f.requester.id } })).seq;
            const admitted = await f.create();
            expect(admitted).toMatchObject({ ok: true, state: 'queued' });
            if (!admitted.ok || !('deploymentId' in admitted)) throw new Error('Missing receipt');
            expect(audienceReads).toBe(1);
            const expectPublishedFacts = async (environmentChanged: boolean) => {
                const changes = await db.accountChange.findMany({ where: { accountId: f.requester.id, kind: 'account',
                    cursor: { gt: observedCursor } } });
                const facts = changes.map(change => readDeploymentAccountChangeV1(change)).filter(Boolean);
                if (environmentChanged) expect(facts).toContainEqual({ projectSourceId: f.source.id, environmentId: f.environment.id });
                expect(facts).toContainEqual({ projectSourceId: f.source.id, environmentId: f.environment.id,
                    deploymentId: admitted.deploymentId });
                observedCursor = (await db.account.findUniqueOrThrow({ where: { id: f.requester.id } })).seq;
            };
            await expectPublishedFacts(true);
            audienceReads = 0;
            expect(await inTx(tx => requestCancelDeploymentInTx(tx, f.requester.id, { serverId,
                environmentId: f.environment.id, deploymentId: admitted.deploymentId, expectedReceiptRevision: 1 })))
                .toMatchObject({ ok: true, state: 'outcome_unknown' });
            expect(audienceReads).toBe(1);
            await expectPublishedFacts(true);
            audienceReads = 0;
            expect(await inTx(tx => transitionDeploymentInTx(tx, f.requester.id, f.sign({ serverId,
                environmentId: f.environment.id, deploymentId: admitted.deploymentId,
                actionOperationId: f.input.actionOperationId, machineId: f.machineId, installationId: f.installationId,
                expectedRevision: 2, kind: 'settle', state: 'cancelled' })))).toMatchObject({ ok: true, state: 'cancelled' });
            expect(audienceReads).toBe(1);
            await expectPublishedFacts(false);
        } finally { stop(); }
    });

    it('reuses the loaded links for deletion and keeps retained intermediates in the lineage', async () => {
        const f = await fixture();
        const middle = await db.deploymentTargetLink.create({ data: { environmentId: f.environment.id,
            createdByAccountId: f.requester.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'configured', deletedAt: new Date(), predecessorTargetLinkId: f.link.id,
            contentArtifactId: f.link.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1,
            machines: { create: [{ machineId: f.machineId, installationId: f.installationId, position: 0, state: 'active' }] } } });
        const successor = await db.deploymentTargetLink.create({ data: { environmentId: f.environment.id,
            createdByAccountId: f.requester.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'configured', predecessorTargetLinkId: middle.id,
            contentArtifactId: f.link.contentArtifactId, contentHeaderVersion: 1, contentBodyVersion: 1,
            machines: { create: [{ machineId: f.machineId, installationId: f.installationId, position: 0, state: 'active' }] } } });
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { runtimeTargetLinkId: successor.id } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { state: 'deployed' } });
        let lineageReads = 0;
        const stop = observeSqliteRequests({ before(request) {
            if (request.model === 'DeploymentTargetLink' && request.action === 'findMany'
                && Reflect.get(Object(Reflect.get(Object(request.args), 'include')), 'machines')) lineageReads++;
        } });
        try {
            expect(await inTx(tx => deleteDeploymentEnvironmentInTx(tx, f.requester.id, { serverId,
                environmentId: f.environment.id, expectedRevision: f.environment.revision, requestKey: crypto.randomUUID() })))
                .toMatchObject({ ok: true, detached: false });
            expect(lineageReads).toBe(1);
        } finally { stop(); }
    });
});
