import { teamResourceGrantFixture } from '@/testkit/resourceGrant.testkit';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import nacl from 'tweetnacl';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent,
    computeDeploymentTransitionRequestDigestV1, signMachineInstallationProof, DeploymentPendingDeployV1Schema,
    type DeploymentTransitionInputV1 } from '@happier-dev/protocol';
import { AutomationDefinitionCreateRequestSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { ExternalActionExecutionAuthorizationBindingV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { createProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { unlinkDeploymentTargetInTx, deleteDeploymentEnvironmentInTx, hasCompleteTeardownInTx } from './deploymentDispositionService';
import { createDeploymentInTx, requestCancelDeploymentInTx, transitionDeploymentInTx } from './deploymentService';
import { linkDeploymentTargetInTx } from './deploymentTargetLinkService';
import { createDeploymentAcceptedExecution, deploymentAcceptedExecutionColumns } from './deploymentAcceptedExecution';
import { syncEnvironmentSecretGrantsInTx } from './environmentSecretGrantRepository';
import { createAutomation } from '@/app/automations/automationCrudService';
import { createAutomationWorkflowRecipeFixture } from '@/testkit/automationWorkflowRecipe';
import { readDeploymentMachineReferencesInTx, readDeploymentReceiptInTx } from './deploymentReadService';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerDeploymentRoutes } from '@/app/api/routes/deployments/deploymentRoutes';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';

const publishedMachine = { metadata: encodePlainMachineStoredContent({ host: 'Disposition', platform: 'linux',
    happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
    dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) };

const serverId = `srv_${'e'.repeat(32)}`;
let harness: LightSqliteHarness;
beforeAll(async () => { harness = await createLightSqliteHarness({
    tempDirPrefix: 'happier-deployment-disposition-', initEncrypt: true,
    env: { HAPPIER_SERVER_IDENTITY_ID: serverId },
}); }, 180_000);
afterAll(async () => { await harness?.close(); });

async function fixture(teamOwned = false) {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
    const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
    await db.userRelationship.create({ data: { fromUserId: owner.id, toUserId: reader.id, status: 'friend' } });
    const team = teamOwned ? await db.team.create({ data: { name: 'Disposition managers' } }) : null;
    if (team) await db.teamMembership.create({ data: { teamId: team.id, accountId: owner.id, role: 'owner' } });
    const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId,
        requestKey: crypto.randomUUID(), name: 'Disposition source',
        ...(team ? { owner: { kind: 'team' as const, teamId: team.id } } : {}),
        audience: [{ principal: { kind: 'account', accountId: reader.id }, level: 'view' }],
    }));
    if (!source.ok) throw new Error(source.error);
    const keys = nacl.sign.keyPair();
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
        ...publishedMachine, installationId: crypto.randomUUID(), installationPublicKey: new Uint8Array(keys.publicKey) } });
    if (team) await db.machineGrant.create({ data: { ...teamResourceGrantFixture({ teamId: team.id, accessLevel: 'view', createdByAccountId: owner.id }), machineId: machine.id } });
    const content = async (kind: string) => {
        const created = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind, title: 'Disposition' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: '{}' })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        if (!created.ok) throw new Error(created.error);
        return { contentArtifactId: created.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
    };
    const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.source.id,
        createdByAccountId: owner.id, protection: 'nonProduction', purpose: 'standard', deployerMode: 'managers',
        controllerMachineId: machine.id, ...await content('deployment-environment.v1') } });
    const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
        createdByAccountId: owner.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
        targetKind: 'ownServer', state: 'configured', ...await content('deployment-target-link.v1'),
        machines: { create: [{ machineId: machine.id, installationId: machine.installationId!, position: 0, state: 'joining' }] } } });
    await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
    const base = { serverId, environmentId: environment.id, expectedRevision: environment.revision, requestKey: crypto.randomUUID() };
    const input = { ...base, targetLinkId: link.id, expectedTargetLinkRevision: link.revision };
    let receiptOrdinal = 0;
    const receipt = async (state: string, operation = 'deploy') => db.deployment.create({ data: {
        environmentId: environment.id, targetLinkId: link.id, state, operation, requestKey: crypto.randomUUID(),
        requestedAt: new Date(Date.now() + receiptOrdinal++ * 1_000),
        actionOperationId: crypto.randomUUID(), requestedByAccountId: owner.id, ...await content('deployment-receipt.v1'),
    } });
    return { owner, reader, foreign, team, source: source.source, environment, link, input, base, receipt, content, machine, keys };
}

it.each([false, true])('allows the current %s Source manager to unlink a resource-free association with quiet replay', async team => {
    const f = await fixture(team);
    const result = await inTx(tx => unlinkDeploymentTargetInTx(tx, f.owner.id, f.input));
    expect(result).toMatchObject({ ok: true, environmentId: f.environment.id, revision: 2,
        targetLinkId: f.link.id, targetLinkRevision: 2, detached: false });
    expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: f.link.id } })).toMatchObject({ deletedAt: expect.any(Date) });
    expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).toMatchObject({ runtimeTargetLinkId: null });
    let writes = 0;
    const stop = observeSqliteRequests({ before: request => {
        if (['create', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert'].includes(request.action)) writes++;
    } });
    const replay = await inTx(tx => unlinkDeploymentTargetInTx(tx, f.owner.id, f.input)).finally(stop);
    expect(replay).toEqual(result);
    expect(writes).toBe(0);
});

it('refuses foreign, reader, revoked manager, stale revision, and forged teardown without writing', async () => {
    const f = await fixture(true);
    expect(await inTx(tx => unlinkDeploymentTargetInTx(tx, f.foreign.id, f.input))).toMatchObject({ ok: false });
    expect(await inTx(tx => unlinkDeploymentTargetInTx(tx, f.reader.id, f.input))).toMatchObject({ ok: false });
    expect(await inTx(tx => unlinkDeploymentTargetInTx(tx, f.owner.id, { ...f.input, expectedRevision: 99 }))).toMatchObject({ error: 'deployment_conflict' });
    await db.teamMembership.delete({ where: { teamId_accountId: { teamId: f.team!.id, accountId: f.owner.id } } });
    expect(await inTx(tx => unlinkDeploymentTargetInTx(tx, f.owner.id, f.input))).toMatchObject({ ok: false });
    const own = await fixture();
    await own.receipt('succeeded');
    expect(await inTx(tx => unlinkDeploymentTargetInTx(tx, own.owner.id, { ...own.input,
        teardownDeploymentId: crypto.randomUUID() }))).toMatchObject({ error: 'deployment_teardown_required' });
    expect((await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: own.link.id } })).deletedAt).toBeNull();
});

it.each(['queued', 'running'])('refuses %s dependent receipt even for explicit detach', async state => {
    const f = await fixture();
    const receipt = await f.receipt(state);
    expect(await inTx(tx => unlinkDeploymentTargetInTx(tx, f.owner.id, { ...f.input, detachKeepRunning: true })))
        .toMatchObject({ ok: false, error: 'deployment_in_progress', deploymentId: receipt.id,
            href: `/deployments/environments/${f.environment.id}/deployments/${receipt.id}` });
    expect(await inTx(tx => deleteDeploymentEnvironmentInTx(tx, f.owner.id, { ...f.base, detachKeepRunning: true })))
        .toMatchObject({ error: 'deployment_in_progress', deploymentId: receipt.id });
    expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).deletedAt).toBeNull();
});

it.each(['delete', 'unlink'] as const)('allows %s with explicit detach after Stop leaves the rollout outcome unknown', async action => {
    const f = await fixture();
    await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { buildMachineId: f.machine.id } });
    // The HTTP authentication boundary supplies a schema-admitted binding;
    // reservation, controller capture, signed start and Stop remain real owners.
    const binding = ExternalActionExecutionAuthorizationBindingV1Schema.parse({
        accountId: f.owner.id, authentication: { kind: 'account', tokenEpoch: 0 },
        serverIdentityId: serverId, machineId: f.machine.id, custodianAccountId: f.owner.id,
        installationId: f.machine.installationId!, actionId: 'deployments.deploy',
        requestId: crypto.randomUUID(), requestEnvelopeDigest: 'A'.repeat(43),
        environmentId: f.environment.id, target: { kind: 'machine', machineId: f.machine.id },
    });
    const receiptContent = await f.content('deployment-receipt.v1');
    const admitted = await inTx(tx => createDeploymentInTx(tx, f.owner.id, { ...f.input,
        actionOperationId: crypto.randomUUID(), ...receiptContent,
    }, 'deploy', {}, binding));
    expect(admitted).toMatchObject({ ok: true, state: 'queued' });
    if (!admitted.ok || !('deploymentId' in admitted)) throw new Error('Expected rollout reservation');
    const receipt = await db.deployment.findUniqueOrThrow({ where: { id: admitted.deploymentId } });
    const start: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId, environmentId: f.environment.id,
        deploymentId: receipt.id, expectedRevision: receipt.revision, actionOperationId: receipt.actionOperationId,
        machineId: f.machine.id, installationId: f.machine.installationId!, kind: 'stage', state: 'running' };
    const proof = signMachineInstallationProof({ payload: { version: 1, machineId: f.machine.id,
        installationId: f.machine.installationId!, accountId: f.owner.id, deploymentTransition: {
            serverId, environmentId: f.environment.id, deploymentId: receipt.id, actionOperationId: receipt.actionOperationId,
            expectedRevision: receipt.revision, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(start),
        } }, privateKey: f.keys.secretKey });
    const running = await inTx(tx => transitionDeploymentInTx(tx, f.owner.id, { ...start, proof }));
    expect(running).toMatchObject({ ok: true, state: 'running' });
    if (!running.ok || !('deploymentRevision' in running)) throw new Error('Expected running rollout');
    const dispose = () => inTx(tx => action === 'delete'
        ? deleteDeploymentEnvironmentInTx(tx, f.owner.id, { ...f.base, expectedRevision: admitted.revision, detachKeepRunning: true })
        : unlinkDeploymentTargetInTx(tx, f.owner.id, { ...f.input, expectedRevision: admitted.revision, detachKeepRunning: true }));
    expect(await dispose()).toMatchObject({ ok: false, error: 'deployment_in_progress', deploymentId: receipt.id });
    const stopped = await inTx(tx => requestCancelDeploymentInTx(tx, f.owner.id, { serverId,
        environmentId: f.environment.id, deploymentId: receipt.id, expectedReceiptRevision: running.deploymentRevision }));
    expect(stopped).toMatchObject({ ok: true, state: 'outcome_unknown' });
    expect(await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } }))
        .toMatchObject({ state: 'outcome_unknown', cancelRequestedAt: expect.any(Date), settledAt: null });
    // P40-R13: an unknown outcome is retained/disclosed, not an effecting slot.
    const result = await dispose();
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, detached: true });
    expect(await inTx(tx => readDeploymentReceiptInTx(tx, f.owner.id, { serverId,
        environmentId: f.environment.id, deploymentId: receipt.id })))
        .toMatchObject({ ok: true, deployment: { id: receipt.id, state: 'outcome_unknown', cancelRequestedAtMs: expect.any(Number) } });
});

it('publishes receipt cancellation availability from the admitted lifecycle owner without changing protected content', async () => {
    const f = await fixture();
    const receipt = await f.receipt('running');
    const input = { serverId, environmentId: f.environment.id, deploymentId: receipt.id };
    const read = (actor = f.owner.id) => inTx(tx => readDeploymentReceiptInTx(tx, actor, input));
    expect(await read()).toMatchObject({ ok: true, cancellable: true });
    await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: receipt.contentArtifactId, accountId: f.reader.id,
        accessLevel: 'view', createdByAccountId: f.owner.id } });
    expect(await read(f.reader.id)).toMatchObject({ ok: true, cancellable: false });
    expect(await read(f.foreign.id)).toMatchObject({ ok: false });
    const contentBefore = await db.artifact.findUniqueOrThrow({ where: { id: receipt.contentArtifactId } });
    expect(await inTx(tx => requestCancelDeploymentInTx(tx, f.owner.id,
        { ...input, expectedReceiptRevision: receipt.revision }))).toMatchObject({ ok: true, state: 'outcome_unknown' });
    expect(await read()).toMatchObject({ ok: true, cancellable: false,
        deployment: { cancelRequestedAtMs: expect.any(Number) } });
    expect(await db.artifact.findUniqueOrThrow({ where: { id: receipt.contentArtifactId } })).toEqual(contentBefore);
    const settled = await f.receipt('succeeded');
    expect(await inTx(tx => readDeploymentReceiptInTx(tx, f.owner.id, { ...input, deploymentId: settled.id })))
        .toMatchObject({ ok: true, cancellable: false });
});

it('releases former builder grants and Machine references after Stop leaves the rollout outcome unknown', async () => {
    const f = await fixture();
    const formerBuilder = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.owner.id,
        ...publishedMachine, installationId: crypto.randomUUID() } });
    // Retained receipt custody can name a former builder; the current
    // Environment and runtime belong to f.machine. No old seal is delivered.
    const receipt = await f.receipt('running');
    await db.deployment.update({ where: { id: receipt.id }, data: deploymentAcceptedExecutionColumns(
        createDeploymentAcceptedExecution({ controller: { machineId: f.machine.id, installationId: f.machine.installationId! },
            builder: { machineId: formerBuilder.id, installationId: formerBuilder.installationId! } })) });
    await inTx(tx => syncEnvironmentSecretGrantsInTx(tx, { environmentId: f.environment.id, grants: [{
        v: 1, kind: 'environmentValues', environmentId: f.environment.id, machineId: formerBuilder.id,
        installationId: formerBuilder.installationId!, binding: { purpose: 'variable', phase: 'build', name: 'BUILD_TOKEN' },
        sealedContent: 'sealed-build-input',
    }] }));
    const retain = () => inTx(tx => syncEnvironmentSecretGrantsInTx(tx, {
        environmentId: f.environment.id, grants: [], retainAcceptedBuildCustody: true,
    }));
    await retain();
    expect(await db.machineSecretGrant.count({ where: { environmentId: f.environment.id } })).toBe(1);
    const references = () => inTx(tx => readDeploymentMachineReferencesInTx(tx, f.owner.id, { homeId: serverId, machineId: formerBuilder.id }));
    expect(await references()).toMatchObject({ references: [{ id: f.environment.id, deploymentRoles: ['build'] }] });
    expect(await inTx(tx => requestCancelDeploymentInTx(tx, f.owner.id, { serverId,
        environmentId: f.environment.id, deploymentId: receipt.id, expectedReceiptRevision: receipt.revision })))
        .toMatchObject({ ok: true, state: 'outcome_unknown' });
    await retain();
    expect.soft(await db.machineSecretGrant.count({ where: { environmentId: f.environment.id } })).toBe(0);
    expect.soft(await references()).toMatchObject({ references: [] });
});

it('admits explicit detach without changing workload custody, and deletes all links atomically', async () => {
    const f = await fixture();
    const active = await f.receipt('succeeded');
    await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { state: 'deployed', activeDeploymentId: active.id } });
    const second = await db.deploymentTargetLink.create({ data: { environmentId: f.environment.id,
        createdByAccountId: f.owner.id, role: 'data', sourceKind: 'plugin', pluginId: 'example.deploy',
        contributionLocalId: 'db', targetKind: 'database', state: 'provisioned', ...await f.content('deployment-target-link.v1') } });
    expect(await inTx(tx => deleteDeploymentEnvironmentInTx(tx, f.owner.id, f.base)))
        .toMatchObject({ error: 'deployment_teardown_required' });
    expect((await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: f.link.id } })).deletedAt).toBeNull();
    expect((await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: second.id } })).deletedAt).toBeNull();
    expect(await inTx(tx => deleteDeploymentEnvironmentInTx(tx, f.owner.id, { ...f.base, detachKeepRunning: true })))
        .toMatchObject({ ok: true, environmentId: f.environment.id, revision: 2, detached: true });
    expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: f.link.id } }))
        .toMatchObject({ state: 'deployed', activeDeploymentId: active.id, detachedAt: expect.any(Date) });
    expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).deletedAt).toBeInstanceOf(Date);
});

it.each([false, true])('requires complete signed teardown including retained-provider=%s and refuses stale or foreign cleanup receipts', async retainedProviderResource => {
    const f = await fixture();
    const peer = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.owner.id,
        ...publishedMachine, installationId: crypto.randomUUID() } });
    await db.deploymentTargetLinkMachine.create({ data: { targetLinkId: f.link.id, machineId: peer.id,
        installationId: peer.installationId!, position: 1, state: 'active' } });
    await f.receipt('failed');
    const members = [f.machine, peer].map(machine => ({ machineId: machine.id, installationId: machine.installationId! }));
    const settle = async (selected: typeof members) => {
        const receipt = await f.receipt('running', 'teardown');
        // Fixture captures are built by the real admission producer; only the
        // signed transition below can establish native removal authority.
        await db.deployment.update({ where: { id: receipt.id }, data: deploymentAcceptedExecutionColumns(
            createDeploymentAcceptedExecution({ controller: members[0] })) });
        const link = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: f.link.id } });
        const body: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId, environmentId: f.environment.id,
            deploymentId: receipt.id, expectedRevision: receipt.revision, actionOperationId: receipt.actionOperationId,
            machineId: f.machine.id, installationId: f.machine.installationId!, kind: 'settle', state: 'succeeded',
            teardownProof: { targetLinkRevision: link.revision, machines: selected, workloadAbsent: true,
                retainedProviderResource,
                steps: ['admit', 'settleDeploy', 'removeTarget', 'removeDomain', 'removeRelease', 'withdrawBindings', 'verify'] } };
        const proof = signMachineInstallationProof({ payload: { version: 1, machineId: f.machine.id,
            installationId: f.machine.installationId!, accountId: f.owner.id, deploymentTransition: {
                serverId, environmentId: f.environment.id, deploymentId: receipt.id, actionOperationId: receipt.actionOperationId,
                expectedRevision: receipt.revision, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body),
            } }, privateKey: f.keys.secretKey });
        expect(await inTx(tx => transitionDeploymentInTx(tx, f.owner.id, { ...body, proof }))).toMatchObject({ ok: true });
        return receipt.id;
    };
    const subset = await settle([members[0]]);
    expect(await inTx(tx => unlinkDeploymentTargetInTx(tx, f.owner.id, { ...f.input, teardownDeploymentId: subset })))
        .toMatchObject({ error: 'deployment_teardown_required' });
    const complete = await settle(members);
    const currentLink = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: f.link.id } });
    const input = { ...f.input, expectedTargetLinkRevision: currentLink.revision, teardownDeploymentId: complete };
    const other = await fixture();
    const foreign = await other.receipt('succeeded', 'teardown');
    expect(await inTx(tx => unlinkDeploymentTargetInTx(tx, f.owner.id, { ...input, teardownDeploymentId: foreign.id })))
        .toMatchObject({ error: 'deployment_teardown_required' });
    const later = await f.receipt('failed');
    expect(await inTx(tx => unlinkDeploymentTargetInTx(tx, f.owner.id, input)))
        .toMatchObject({ error: 'deployment_teardown_required' });
    // A later receipt is retained history, never silently deleted to make the
    // old proof current. A fresh signed complete teardown establishes it again.
    expect(await db.deployment.findUnique({ where: { id: later.id } })).not.toBeNull();
    const fresh = await settle(members);
    const freshLink = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: f.link.id } });
    expect(await inTx(tx => unlinkDeploymentTargetInTx(tx, f.owner.id, { ...input,
        expectedTargetLinkRevision: freshLink.revision, teardownDeploymentId: fresh })))
        .toMatchObject({ ok: true, detached: false });
    const retiredLink = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: f.link.id }, include: { machines: true } });
    expect(await inTx(tx => hasCompleteTeardownInTx(tx, retiredLink, undefined, null)),
        'a real signed cleanup remains complete after canonical unlink').toBe(true);
    expect(await inTx(tx => hasCompleteTeardownInTx(tx, retiredLink, [fresh], null)),
        'explicit disposition receipt admission cannot reuse an already disposed revision').toBe(false);
    const unproven = await Promise.all(['deleted', 'detached'].map(async retained => db.deploymentTargetLink.create({ data: {
        environmentId: f.environment.id, createdByAccountId: f.owner.id, role: 'runtime', sourceKind: 'host',
        hostTargetId: 'own-server', targetKind: 'ownServer', state: 'deployed',
        ...(retained === 'deleted' ? { deletedAt: new Date() } : { detachedAt: new Date() }),
        ...await f.content('deployment-target-link.v1'), machines: { create: { machineId: f.machine.id,
            installationId: f.machine.installationId!, position: 0, state: 'active' } },
    } })));
    await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
        const base = `/v1/deployments/environments/${f.environment.id}?serverId=${serverId}`;
        const read = (url: string, actor = f.owner.id) => app.inject({ method: 'GET', url,
            headers: { 'x-test-user-id': actor } });
        const queries: { model?: string; action: string }[] = [];
        const stop = observeSqliteRequests({ before: request => { queries.push(request); } });
        const ordinary = await read(base).finally(stop);
        expect(ordinary.statusCode, ordinary.body).toBe(200);
        expect(ordinary.json()).not.toHaveProperty('retainedTargetLinkCleanupCompleteIds');
        expect(queries.filter(query => query.model === 'Deployment' && query.action === 'findFirst')).toEqual([]);
        const projected = await read(`${base}&includeRetainedTargetLinkCleanup=true`);
        expect(projected.statusCode, projected.body).toBe(200);
        expect(projected.json().retainedTargetLinkCleanupCompleteIds).toEqual([f.link.id]);
        expect(projected.json().targetLinks.map((link: { id: string }) => link.id).sort())
            .toEqual([f.link.id, ...unproven.map(link => link.id)].sort());
        expect(projected.body).not.toContain('teardownProof');
        const hidden = await read(`${base}&includeRetainedTargetLinkCleanup=true`, f.foreign.id);
        expect(hidden.statusCode).toBe(404);
        expect(hidden.body).not.toContain(f.link.id);
    });
    const changedLink = await db.deploymentTargetLink.update({ where: { id: f.link.id },
        data: { revision: { increment: 1 } }, include: { machines: true } });
    expect(await inTx(tx => hasCompleteTeardownInTx(tx, changedLink, undefined, null)),
        'another revision after canonical unlink cannot inherit the old cleanup fact').toBe(false);
});

it('requires detach for live Domains and refuses tombstones while retaining resource disclosure', async () => {
    const f = await fixture();
    await db.deploymentDomain.create({ data: { environmentId: f.environment.id, targetLinkId: f.link.id,
        createdByAccountId: f.owner.id, state: 'removing', ...await f.content('deployment-domain.v1') } });
    expect(await inTx(tx => unlinkDeploymentTargetInTx(tx, f.owner.id, f.input)))
        .toMatchObject({ error: 'deployment_teardown_required' });
    expect(await inTx(tx => unlinkDeploymentTargetInTx(tx, f.owner.id, { ...f.input, detachKeepRunning: true })))
        .toMatchObject({ ok: true, detached: true });
    expect(await db.deploymentDomain.count({ where: { environmentId: f.environment.id, deletedAt: null } })).toBe(1);
    expect(await inTx(tx => readDeploymentMachineReferencesInTx(tx, f.owner.id, { homeId: serverId, machineId: f.machine.id })))
        .toMatchObject({ references: [expect.objectContaining({ id: f.environment.id, deploymentRoles: expect.arrayContaining(['detached']) })] });
    expect(await inTx(tx => unlinkDeploymentTargetInTx(tx, f.owner.id, { ...f.input, requestKey: crypto.randomUUID() })))
        .toMatchObject({ ok: false });
});

it('deletes a resource-free Environment once and replays without writes or publication', async () => {
    const f = await fixture();
    const result = await inTx(tx => deleteDeploymentEnvironmentInTx(tx, f.owner.id, f.base));
    expect(result).toMatchObject({ ok: true, revision: 2, detached: false });
    const seq = (await db.account.findUniqueOrThrow({ where: { id: f.owner.id } })).seq;
    let writes = 0;
    const stop = observeSqliteRequests({ before: request => {
        if (['create', 'update', 'updateMany', 'delete', 'deleteMany', 'upsert'].includes(request.action)) writes++;
    } });
    expect(await inTx(tx => deleteDeploymentEnvironmentInTx(tx, f.owner.id, f.base)).finally(stop)).toEqual(result);
    expect(writes).toBe(0);
    expect((await db.account.findUniqueOrThrow({ where: { id: f.owner.id } })).seq).toBe(seq);
    expect(await inTx(tx => deleteDeploymentEnvironmentInTx(tx, f.owner.id, { ...f.base, requestKey: crypto.randomUUID() })))
        .toMatchObject({ error: 'deployment_unavailable' });
});

it('preserves a pending Action and requires its canonical cancellation before disposition', async () => {
    const f = await fixture();
    const pending = DeploymentPendingDeployV1Schema.parse({ t: 'plain', v: {
        sourceIntent: { kind: 'repository', projectSourceId: f.source.id, sourceRevision: f.source.revision,
            sha: 'a'.repeat(40), compose: { path: 'compose.yaml', profiles: [], services: [] } },
        requestKey: crypto.randomUUID(), targetLinkId: f.link.id,
        actionOperationId: crypto.randomUUID(),
    } });
    // Stored pending intent is the retained `{ pendingDeploy }` record (9871b103b09), not the bare envelope.
    await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { pendingDeployContent: { pendingDeploy: pending } } });
    expect(await inTx(tx => unlinkDeploymentTargetInTx(tx, f.owner.id, { ...f.input, detachKeepRunning: true })))
        .toMatchObject({ error: 'deployment_conflict' });
    expect(await inTx(tx => deleteDeploymentEnvironmentInTx(tx, f.owner.id, { ...f.base, detachKeepRunning: true })))
        .toMatchObject({ error: 'deployment_conflict' });
    expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } })).pendingDeployContent).toEqual({ pendingDeploy: pending });
});

it('retires Automation and exact grant authority only when its surviving runtime is removed', async () => {
    const f = await fixture();
    const builder = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.owner.id,
        ...publishedMachine, installationId: crypto.randomUUID() } });
    await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { buildMachineId: builder.id } });
    const recipe = createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/workspace/app', prompt: 'Disposition task' });
    const job = await createAutomation({ accountId: f.owner.id, input: AutomationDefinitionCreateRequestSchema.parse({
        automationId: crypto.randomUUID(), name: 'Environment work', enabled: true, triggers: [],
        assignments: [{ machineId: f.machine.id }], executionRecipe: { ...recipe, deploymentEnvironment: {
            serverId, projectSourceId: f.source.id, environmentId: f.environment.id,
        } },
    }) });
    await inTx(tx => syncEnvironmentSecretGrantsInTx(tx, { environmentId: f.environment.id, grants: [{
        v: 1, kind: 'environmentValues', environmentId: f.environment.id, machineId: f.machine.id,
        installationId: f.machine.installationId!, binding: { purpose: 'variable', phase: 'runtime', name: 'TOKEN' },
        sealedContent: 'sealed-environment-values',
    }, { v: 1, kind: 'environmentValues', environmentId: f.environment.id, machineId: builder.id,
        installationId: builder.installationId!, binding: { purpose: 'variable', phase: 'build', name: 'BUILD_TOKEN' },
        sealedContent: 'sealed-build-values' }] }));
    const predecessor = await db.deploymentTargetLink.create({ data: { environmentId: f.environment.id,
        createdByAccountId: f.owner.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer',
        state: 'configured', ...await f.content('deployment-target-link.v1'), machines: { create: [{
            machineId: f.machine.id, installationId: f.machine.installationId!, position: 0, state: 'joining',
        }] } } });
    expect(await inTx(tx => unlinkDeploymentTargetInTx(tx, f.owner.id, { ...f.input, targetLinkId: predecessor.id,
        expectedTargetLinkRevision: predecessor.revision, detachKeepRunning: true }))).toMatchObject({ ok: true });
    expect((await db.automation.findUniqueOrThrow({ where: { id: job.id } })).enabled).toBe(true);
    expect(await db.machineSecretGrant.count({ where: { environmentId: f.environment.id } })).toBe(2);
    const current = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
    expect(await inTx(tx => unlinkDeploymentTargetInTx(tx, f.owner.id, { ...f.input, expectedRevision: current.revision,
        requestKey: crypto.randomUUID(), detachKeepRunning: true }))).toMatchObject({ ok: true });
    expect((await db.automation.findUniqueOrThrow({ where: { id: job.id } })).enabled).toBe(false);
    expect(await db.machineSecretGrant.count({ where: { environmentId: f.environment.id } })).toBe(0);
});

it.each([false, true])('composes both disposition HTTP routes through current Source authority (Team=%s)', async team => {
    for (const action of ['unlink', 'delete'] as const) {
        const f = await fixture(team);
        const path = `/v1/deployments/environments/${f.environment.id}`
            + (action === 'unlink' ? `/targets/${f.link.id}/unlink` : '/delete');
        const payload = action === 'unlink' ? f.input : f.base;
        await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
            const send = (accountId: string, body = payload) => app.inject({ method: 'POST', url: path,
                headers: { 'x-test-user-id': accountId }, payload: body });
            expect((await send(f.reader.id)).statusCode).toBe(403);
            expect((await send(f.foreign.id)).statusCode).toBe(404);
            const invalidPath = await app.inject({ method: 'POST', url: path,
                headers: { 'x-test-user-id': f.owner.id }, payload: { ...payload, environmentId: crypto.randomUUID() } });
            expect(invalidPath.statusCode).toBe(400);
            const response = await send(f.owner.id);
            expect(response.statusCode, response.body).toBe(200);
            expect(response.json()).toMatchObject({ ok: true, detached: false, environmentId: f.environment.id });
            expect((await send(f.owner.id)).json()).toEqual(response.json());
        });
    }
});

it('settles one data target teardown while retaining another runtime target Domain', async () => {
    const f = await fixture();
    const domain = await db.deploymentDomain.create({ data: { environmentId: f.environment.id,
        targetLinkId: f.link.id, state: 'active', createdByAccountId: f.owner.id,
        ...await f.content('deployment-domain.v1') } });
    const linkContent = await f.content('deployment-target-link.v1');
    const linked = await inTx(tx => linkDeploymentTargetInTx(tx, f.owner.id, { ...f.base,
        targetId: 'database', role: 'data', machines: [], targetKind: 'database',
        source: { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'database' } },
        ...linkContent,
    }));
    if (!linked.ok) throw new Error('Expected data association');
    const receiptContent = await f.content('deployment-receipt.v1');
    const admitted = await inTx(tx => createDeploymentInTx(tx, f.owner.id, { ...f.base,
        expectedRevision: linked.revision, targetLinkId: linked.targetLinkId,
        expectedTargetLinkRevision: linked.targetLinkRevision, reason: 'manual', actionOperationId: crypto.randomUUID(),
        ...receiptContent,
    }, 'teardown'));
    expect(admitted, JSON.stringify(admitted)).toMatchObject({ ok: true });
    if (!admitted.ok || !('deploymentId' in admitted)) throw new Error('Expected data teardown reservation');
    expect(await db.deploymentDomain.findUniqueOrThrow({ where: { id: domain.id } }))
        .toMatchObject({ state: 'active', revision: 1, deletedAt: null });
    await db.deployment.update({ where: { id: admitted.deploymentId }, data: deploymentAcceptedExecutionColumns(
        createDeploymentAcceptedExecution({ controller: { machineId: f.machine.id, installationId: f.machine.installationId! } })) });
    for (const state of ['running', 'succeeded'] as const) {
        const receipt = await db.deployment.findUniqueOrThrow({ where: { id: admitted.deploymentId } });
        const body: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId, environmentId: f.environment.id,
            deploymentId: receipt.id, expectedRevision: receipt.revision, actionOperationId: receipt.actionOperationId,
            machineId: f.machine.id, installationId: f.machine.installationId!, kind: state === 'running' ? 'stage' : 'settle', state,
            ...(state === 'succeeded' ? { teardownProof: { targetLinkRevision: linked.targetLinkRevision,
                machines: [{ machineId: f.machine.id, installationId: f.machine.installationId! }], workloadAbsent: true as const,
                retainedProviderResource: false,
                steps: ['admit', 'settleDeploy', 'removeTarget', 'removeDomain', 'removeRelease', 'withdrawBindings', 'verify'] } } : {}) };
        const proof = signMachineInstallationProof({ payload: { version: 1, machineId: f.machine.id,
            installationId: f.machine.installationId!, accountId: f.owner.id, deploymentTransition: {
                serverId, environmentId: f.environment.id, deploymentId: receipt.id, actionOperationId: receipt.actionOperationId,
                expectedRevision: receipt.revision, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body),
            } }, privateKey: f.keys.secretKey });
        expect(await inTx(tx => transitionDeploymentInTx(tx, f.owner.id, { ...body, proof }))).toMatchObject({ ok: true });
    }
    expect(await db.deploymentDomain.findUniqueOrThrow({ where: { id: domain.id } }))
        .toMatchObject({ state: 'active', revision: 1, deletedAt: null });
});

it.each([false, true].flatMap(scalar => (['unlink', 'delete'] as const).map(action => [scalar, action] as const)))(
    'accepts signed plugin teardown using its exact %s scalar/controller custody through %s', async (scalarPlacement, action) => {
    const f = await fixture();
    const subject = scalarPlacement ? await db.machine.create({ data: { id: crypto.randomUUID(), accountId: f.owner.id,
        ...publishedMachine, installationId: crypto.randomUUID() } }) : f.machine;
    const linkContent = await f.content('deployment-target-link.v1');
    const linked = await inTx(tx => linkDeploymentTargetInTx(tx, f.owner.id, { ...f.base,
        targetId: 'plugin-data', role: 'data', machines: [], targetKind: 'database',
        source: { kind: 'plugin', contribution: { pluginId: 'example.deploy', localId: 'database' } },
        ...(scalarPlacement ? { machineId: subject.id, installationId: subject.installationId! } : {}),
        ...linkContent,
    }));
    expect(linked).toMatchObject({ ok: true });
    if (!linked.ok) throw new Error('Expected plugin association');
    // Provider-resource state is a persisted boundary fixture; only the signed
    // transition below may establish its complete cleanup proof.
    await db.deploymentTargetLink.update({ where: { id: linked.targetLinkId }, data: { state: 'provisioned' } });
    const receiptContent = await f.content('deployment-receipt.v1');
    const admitted = await inTx(tx => createDeploymentInTx(tx, f.owner.id, { ...f.base,
        expectedRevision: linked.revision, targetLinkId: linked.targetLinkId,
        expectedTargetLinkRevision: linked.targetLinkRevision, reason: 'manual', requestKey: crypto.randomUUID(),
        actionOperationId: crypto.randomUUID(), ...receiptContent,
    }, 'teardown'));
    expect(admitted).toMatchObject({ ok: true });
    if (!admitted.ok || !('deploymentId' in admitted)) throw new Error('Expected teardown reservation');
    await db.deployment.update({ where: { id: admitted.deploymentId }, data: deploymentAcceptedExecutionColumns(
        createDeploymentAcceptedExecution({ controller: { machineId: f.machine.id, installationId: f.machine.installationId! } })) });
    for (const state of ['running', 'succeeded'] as const) {
        const receipt = await db.deployment.findUniqueOrThrow({ where: { id: admitted.deploymentId } });
        const body: Omit<DeploymentTransitionInputV1, 'proof'> = { serverId, environmentId: f.environment.id,
            deploymentId: receipt.id, expectedRevision: receipt.revision, actionOperationId: receipt.actionOperationId,
            machineId: f.machine.id, installationId: f.machine.installationId!, kind: state === 'running' ? 'stage' : 'settle', state,
            ...(state === 'succeeded' ? { teardownProof: { targetLinkRevision: linked.targetLinkRevision,
                machines: [{ machineId: subject.id, installationId: subject.installationId! }], workloadAbsent: true as const,
                retainedProviderResource: false,
                steps: ['admit', 'settleDeploy', 'removeTarget', 'removeDomain', 'removeRelease', 'withdrawBindings', 'verify'] } } : {}) };
        const proof = signMachineInstallationProof({ payload: { version: 1, machineId: f.machine.id,
            installationId: f.machine.installationId!, accountId: f.owner.id, deploymentTransition: {
                serverId, environmentId: f.environment.id, deploymentId: receipt.id, actionOperationId: receipt.actionOperationId,
                expectedRevision: receipt.revision, requestBodyDigest: computeDeploymentTransitionRequestDigestV1(body),
            } }, privateKey: f.keys.secretKey });
        const transitioned = await inTx(tx => transitionDeploymentInTx(tx, f.owner.id, { ...body, proof }));
        expect(transitioned, `${state}: ${transitioned.ok ? 'accepted' : transitioned.error}`).toMatchObject({ ok: true });
    }
    const receipt = await db.deployment.findUniqueOrThrow({ where: { id: admitted.deploymentId } });
    const link = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: linked.targetLinkId } });
    const result = action === 'unlink'
        ? await inTx(tx => unlinkDeploymentTargetInTx(tx, f.owner.id, { ...f.input,
            expectedRevision: admitted.revision, targetLinkId: link.id, expectedTargetLinkRevision: link.revision,
            requestKey: crypto.randomUUID(), teardownDeploymentId: receipt.id }))
        : await inTx(tx => deleteDeploymentEnvironmentInTx(tx, f.owner.id, { ...f.base,
            expectedRevision: admitted.revision, requestKey: crypto.randomUUID(), teardownDeploymentIds: [receipt.id] }));
    expect(result).toMatchObject({ ok: true, detached: false });
    const disposed = await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: link.id }, include: { machines: true } });
    expect(await inTx(tx => hasCompleteTeardownInTx(tx, disposed, undefined, null))).toBe(true);
    expect(await inTx(tx => hasCompleteTeardownInTx(tx, disposed, [receipt.id], null))).toBe(false);
});

it.each([false, true])('recognizes inherited own-server custody but never same-installation plugin placement (plugin=%s)', async plugin => {
    const f = await fixture();
    const serving = await f.receipt('succeeded');
    await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { state: 'deployed', activeDeploymentId: serving.id } });
    const linkContent = await f.content('deployment-target-link.v1');
    const successor = await inTx(tx => linkDeploymentTargetInTx(tx, f.owner.id, { ...f.base,
        targetId: plugin ? 'plugin-runtime' : 'own-server', role: 'runtime',
        machines: plugin ? [] : [{ machineId: f.machine.id, installationId: f.machine.installationId! }],
        ...(plugin ? { source: { kind: 'plugin' as const, contribution: { pluginId: 'example.deploy', localId: 'runtime' } },
            targetKind: 'platform', machineId: f.machine.id, installationId: f.machine.installationId! } : {}),
        replacesLinkId: f.link.id, expectedTargetLinkRevision: f.link.revision,
        ...linkContent,
    }));
    expect(successor).toMatchObject({ ok: true });
    if (!successor.ok) throw new Error('Expected selected successor');
    const result = await inTx(tx => unlinkDeploymentTargetInTx(tx, f.owner.id, { ...f.input,
        expectedRevision: successor.revision, requestKey: crypto.randomUUID() }));
    expect(result).toMatchObject(plugin ? { error: 'deployment_teardown_required' } : { ok: true, detached: false });
    expect(await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } }))
        .toMatchObject({ runtimeTargetLinkId: successor.targetLinkId });
    expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: successor.targetLinkId } }))
        .toMatchObject({ detachedAt: null, ...(plugin ? { state: 'configured', activeDeploymentId: null }
            : { state: 'deployed', activeDeploymentId: serving.id }) });
});


it.each([false, true])('removes a never-deployed Environment through teardown without a receipt, and refuses other-target work (deployed=%s)', async deployed => {
    const f = await fixture();
    if (deployed) {
        const receipt = await f.receipt('succeeded');
        const other = await db.deploymentTargetLink.create({ data: { ...f.link,
            id: crypto.randomUUID(), state: 'deployed', activeDeploymentId: receipt.id,
            machines: { create: [{ machineId: f.machine.id, installationId: f.machine.installationId!, position: 0, state: 'active' }] } } });
        await db.deployment.update({ where: { id: receipt.id }, data: { targetLinkId: other.id } });
    }
    const payload = { ...f.input, reason: 'manual', removeEnvironment: true, nothingDeployed: true, volumes: [] };
    await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
        const send = (accountId: string) => app.inject({ method: 'POST',
            url: `/v1/deployments/environments/${f.environment.id}/teardown`,
            headers: { 'x-test-user-id': accountId }, payload });
        expect((await send(f.reader.id)).statusCode).toBe(403);
        expect((await send(f.foreign.id)).statusCode).toBe(404);
        const response = await send(f.owner.id);
        expect(response.statusCode, response.body).toBe(deployed ? 409 : 200);
        expect(response.json()).toMatchObject(deployed ? { ok: false, error: 'deployment_teardown_required' }
            : { ok: true, nothingDeployed: true, environmentRemoved: true });
        if (!deployed) expect((await send(f.owner.id)).json()).toEqual(response.json());
    });
    const environment = await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: f.environment.id } });
    if (deployed) expect(environment.deletedAt).toBeNull();
    else expect(environment.deletedAt).not.toBeNull();
    expect(await db.deployment.count({ where: { environmentId: f.environment.id } })).toBe(deployed ? 1 : 0);
});

it('teardown plain detach keeps manager-only removal and retained failed receipt', async () => {
    const f = await fixture();
    const receipt = await f.receipt('failed');
    const deployer = await db.account.create({ data: { encryptionMode: 'plain' } });
    await db.userRelationship.create({ data: { fromUserId: f.owner.id, toUserId: deployer.id, status: 'friend' } });
    await db.projectSource.update({ where: { id: f.source.id }, data: { audience: [
        { principal: { kind: 'account', accountId: f.reader.id }, level: 'view' },
        { principal: { kind: 'account', accountId: deployer.id }, level: 'view' },
    ] } });
    await db.deploymentEnvironmentDeployer.create({ data: { environmentId: f.environment.id,
        principalKind: 'account', principalId: deployer.id, createdByAccountId: f.owner.id } });
    await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { deployerMode: 'chosen' } });
    await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { sourceKind: 'plugin',
        hostTargetId: null, pluginId: 'example.platform', contributionLocalId: 'runtime', targetKind: 'platform',
        machineId: f.machine.id, installationId: f.machine.installationId } });
    await db.deploymentTargetLinkMachine.deleteMany({ where: { targetLinkId: f.link.id } });
    const payload = { ...f.input, reason: 'manual', detachKeepRunning: true };
    await withAuthenticatedTestApp(registerDeploymentRoutes, async app => {
        const send = (accountId: string) => app.inject({ method: 'POST',
            url: `/v1/deployments/environments/${f.environment.id}/teardown`,
            headers: { 'x-test-user-id': accountId }, payload });
        expect((await send(f.reader.id)).statusCode).toBe(403);
        const readable = await app.inject({ method: 'POST', url: '/v1/deployments/environments/access',
            headers: { 'x-test-user-id': deployer.id }, payload: { serverId, environmentIds: [f.environment.id] } });
        expect(readable.json(), readable.body).toMatchObject({ ok: true,
            items: [{ environmentId: f.environment.id, read: true, deploy: true }] });
        expect((await send(deployer.id)).statusCode).toBe(403);
        expect((await send(f.foreign.id)).statusCode).toBe(404);
        const response = await send(f.owner.id);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toMatchObject({ ok: true, environmentId: f.environment.id,
            targetLinkId: f.link.id, targetLinkRevision: f.link.revision + 1, detached: true });
        expect((await send(f.owner.id)).json()).toEqual(response.json());
    });
    expect(await db.deploymentTargetLink.findUniqueOrThrow({ where: { id: f.link.id } }))
        .toMatchObject({ detachedAt: expect.any(Date), deletedAt: expect.any(Date) });
    expect(await db.deployment.findUniqueOrThrow({ where: { id: receipt.id } })).toMatchObject({ state: 'failed' });
    expect(await db.deployment.count({ where: { environmentId: f.environment.id } })).toBe(1);
});
