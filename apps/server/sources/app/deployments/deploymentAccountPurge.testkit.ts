import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { deleteDeploymentEnvironmentInTx, removeAdmittedDeploymentEnvironmentInTx } from './deploymentDispositionService';
import { deleteAutomation } from '@/app/automations/automationCrudService';
import { sourceFromRow } from '@/app/projects/sources/projectSourceService';
import { readDeploymentTargetInTx } from './deploymentTargetLinkService';
import * as blobFiles from '@/storage/blob/files';
import { deleteAccountForErasure } from '@/app/plugins/data/accountDataErase';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { createDeploymentAcceptedExecution, deploymentAcceptedExecutionColumns } from './deploymentAcceptedExecution';
import { projectDeploymentReceiptHeader } from './deploymentService';
import { listDeploymentReceiptsInTx, readDeploymentReceiptInTx } from './deploymentReadService';
import { DeploymentTeardownProofV1Schema } from '@happier-dev/protocol';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';

function teardownProof(machine: { id: string; installationId: string | null }, retainedProviderResource: boolean) {
    return DeploymentTeardownProofV1Schema.parse({ targetLinkRevision: 1,
        machines: [{ machineId: machine.id, installationId: machine.installationId! }], workloadAbsent: true,
        retainedProviderResource,
        steps: ['admit', 'settleDeploy', 'removeTarget', 'removeDomain', 'removeRelease', 'withdrawBindings', 'verify'] });
}

/** Real retained graph: the public disposition leaves these Restrict references behind. */
async function fixture(retired: boolean, encryptionMode: 'plain' | 'e2ee' = 'plain', sharedSourceId?: string) {
    const account = await db.account.create({ data: {
        encryptionMode, ...(encryptionMode === 'e2ee' ? createSignedAccountContentBinding() : {}),
    } });
    const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}', installationId: randomUUID() } });
    const source = sharedSourceId
        ? await db.projectSource.findUniqueOrThrow({ where: { id: sharedSourceId } })
        : await db.projectSource.create({ data: { createdByAccountId: account.id, name: 'Purge', audience: [], attachments: [] } });
    const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: account.id,
        header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array() } });
    const content = { contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
    const environment = await db.deploymentEnvironment.create({ data: { projectSourceId: source.id,
        createdByAccountId: account.id, controllerMachineId: machine.id, protection: 'nonProduction',
        purpose: 'standard', deployerMode: 'managers', deletedAt: retired ? new Date() : null, ...content } });
    const link = await db.deploymentTargetLink.create({ data: { environmentId: environment.id,
        createdByAccountId: account.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server', targetKind: 'ownServer',
        state: 'configured', revision: retired ? 3 : 1, deletedAt: retired ? new Date() : null,
        machines: { create: [{ machineId: machine.id, installationId: machine.installationId!, position: 0, state: 'active' }] }, ...content } });
    const receipt = await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: link.id,
        operation: 'teardown', state: retired ? 'succeeded' : 'running', requestKey: randomUUID(),
        requestedByAccountId: account.id, actionOperationId: randomUUID(), settledAt: retired ? new Date() : null, ...content,
        ...deploymentAcceptedExecutionColumns(createDeploymentAcceptedExecution({ controller: {
            machineId: machine.id, installationId: machine.installationId! } })),
        ...(retired ? { teardownProof: teardownProof(machine, false) } : {}) } });
    if (!sharedSourceId) await db.projectDeploymentDefaults.create({ data: { projectSourceId: source.id, ...content } });
    await db.deploymentEnvironmentDeployer.create({ data: { environmentId: environment.id, purpose: 'deploy',
        principalKind: 'account', principalId: account.id, createdByAccountId: account.id } });
    if (retired) await db.deploymentDomain.create({ data: { environmentId: environment.id, targetLinkId: link.id,
        createdByAccountId: account.id, state: 'removing', deletedAt: new Date(), ...content } });
    return { account, machine, source, artifact, environment, link, receipt };
}

async function sharedTeamFixture() {
    const owner = await fixture(true);
    const admin = await fixture(true, 'plain', owner.source.id);
    const team = await db.team.create({ data: { name: 'Retired Team', archivedAt: new Date(), memberships: { create: [
        { accountId: owner.account.id, role: 'owner' },
        { accountId: admin.account.id, role: 'admin' },
    ] } } });
    await db.projectSource.update({ where: { id: owner.source.id }, data: {
        owner: { kind: 'team', teamId: team.id }, deletedAt: new Date(),
    } });
    return { owner, admin, team };
}

export function deploymentAccountPurgeCases() {
    it.each(['owner', 'admin'] as const)('erases both authors of a retired Team graph with the %s first', async first => {
        const graph = await sharedTeamFixture();
        const eraser = graph[first];
        const other = first === 'owner' ? graph.admin : graph.owner;

        expect(await deleteAccountForErasure({ accountId: eraser.account.id })).toEqual({ status: 'deleted' });
        expect(await db.account.findUnique({ where: { id: eraser.account.id } })).toBeNull();
        expect(await db.account.findUnique({ where: { id: other.account.id }, select: { status: true } })).toEqual({ status: 'active' });
        expect(await db.artifact.findUnique({ where: { id: other.artifact.id } })).toEqual(other.artifact);
        expect(await db.machine.findUnique({ where: { id: other.machine.id } })).toEqual(other.machine);
        expect(await db.deploymentEnvironment.count({ where: { projectSourceId: graph.owner.source.id } })).toBe(0);
        expect(await db.deployment.count({ where: { id: { in: [eraser.receipt.id, other.receipt.id] } } })).toBe(0);
        expect(await db.projectSource.findUnique({ where: { id: graph.owner.source.id }, select: { deletedAt: true } }))
            .toEqual(first === 'owner' ? null : { deletedAt: expect.any(Date) });

        expect(await deleteAccountForErasure({ accountId: other.account.id })).toEqual({ status: 'deleted' });
        expect(await db.account.findUnique({ where: { id: other.account.id } })).toBeNull();
        expect(await db.projectSource.findUnique({ where: { id: graph.owner.source.id } })).toBeNull();
        expect(await db.team.findUnique({ where: { id: graph.team.id } })).toEqual(graph.team);
    });

    it.each(['live Source', 'live Environment', 'active direct reader', 'active Team'] as const)('preserves a Team graph with a %s', async blocker => {
        const { owner, admin, team } = await sharedTeamFixture();
        if (blocker === 'live Source') {
            await db.projectSource.update({ where: { id: owner.source.id }, data: { deletedAt: null } });
        } else if (blocker === 'live Environment') {
            await db.deploymentEnvironment.update({ where: { id: admin.environment.id }, data: { deletedAt: null } });
        } else if (blocker === 'active direct reader') {
            await db.projectSource.update({ where: { id: owner.source.id }, data: { audience: [
                { principal: { kind: 'account', accountId: owner.account.id }, level: 'view' },
            ] } });
        } else {
            // The Source creator has left. The former admin is the active Team's only reader and owner.
            await db.teamMembership.updateMany({ where: { teamId: team.id, accountId: admin.account.id }, data: { role: 'owner' } });
            await db.teamMembership.deleteMany({ where: { teamId: team.id, accountId: owner.account.id } });
            await db.team.update({ where: { id: team.id }, data: { archivedAt: null } });
        }

        const eraser = blocker === 'live Environment' ? owner : admin;
        expect(await deleteAccountForErasure({ accountId: eraser.account.id })).toEqual({
            status: 'failed', code: 'account_erasure_deployment_cleanup_required',
            blocker: { reason: 'source_sharing', ...(eraser === owner ? { projectSourceId: owner.source.id } : {}) },
        });
        expect(await db.account.findUnique({ where: { id: eraser.account.id }, select: { status: true } })).toEqual({ status: 'active' });
        expect(await db.deploymentEnvironment.count({ where: { projectSourceId: owner.source.id } })).toBe(2);
    });

    it('preserves a live foreign-authored Environment on an Account Source', async () => {
        const owner = await fixture(true);
        const foreign = await fixture(true, 'plain', owner.source.id);
        const environment = await db.deploymentEnvironment.update({ where: { id: foreign.environment.id }, data: { deletedAt: null } });

        expect(await deleteAccountForErasure({ accountId: owner.account.id })).toEqual({
            status: 'failed', code: 'account_erasure_deployment_cleanup_required',
            blocker: { reason: 'graph_dependencies', projectSourceId: owner.source.id },
        });
        expect(await db.account.findUnique({ where: { id: owner.account.id }, select: { status: true } })).toEqual({ status: 'active' });
        expect(await db.deploymentEnvironment.findUnique({ where: { id: environment.id } })).toEqual(environment);
    });

    it('preserves the retired graph when an unrelated Account erases a referenced Machine', async () => {
        const { admin } = await sharedTeamFixture();
        const outsider = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: outsider.id, metadata: '{}' } });
        await db.deploymentEnvironment.update({ where: { id: admin.environment.id }, data: { controllerMachineId: machine.id } });

        expect(await deleteAccountForErasure({ accountId: outsider.id })).toEqual({
            status: 'failed', code: 'account_erasure_deployment_cleanup_required', blocker: { reason: 'source_sharing' },
        });
        expect(await db.machine.findUnique({ where: { id: machine.id } })).toEqual(machine);
        expect(await db.deploymentEnvironment.count({ where: { projectSourceId: admin.source.id } })).toBe(2);
    });

    it('preserves a retained provider resource without disclosing a foreign Environment or target', async () => {
        const { owner, admin } = await sharedTeamFixture();
        await db.deploymentTargetLink.update({ where: { id: owner.link.id }, data: { state: 'provisioned' } });

        expect(await deleteAccountForErasure({ accountId: admin.account.id })).toEqual({
            status: 'failed', code: 'account_erasure_deployment_cleanup_required', blocker: { reason: 'provider_resource' },
        });
        expect(await db.account.findUnique({ where: { id: admin.account.id }, select: { status: true } })).toEqual({ status: 'active' });
        expect(await db.deploymentTargetLink.findUnique({ where: { id: owner.link.id }, select: { state: true } })).toEqual({ state: 'provisioned' });
    });

    it('erases a retired solely Account-owned graph including an unknown Deploy before its Artifacts and Machines', async () => {
        const f = await fixture(true);
        const unknown = await db.deployment.create({ data: { environmentId: f.environment.id, targetLinkId: f.link.id,
            state: 'outcome_unknown', operation: 'deploy', requestKey: randomUUID(), actionOperationId: randomUUID(),
            requestedAt: new Date(1), startedAt: new Date(2),
            requestedByAccountId: f.account.id, contentArtifactId: f.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 } });
        expect(await deleteAccountForErasure({ accountId: f.account.id })).toEqual({ status: 'deleted' });
        expect(await db.account.findUnique({ where: { id: f.account.id } })).toBeNull();
        expect(await db.deploymentEnvironment.findUnique({ where: { id: f.environment.id } })).toBeNull();
        expect(await db.deployment.findUnique({ where: { id: f.receipt.id } })).toBeNull();
        expect(await db.deployment.findUnique({ where: { id: unknown.id } })).toBeNull();
        expect(await db.artifact.findUnique({ where: { id: f.artifact.id } })).toBeNull();
    });

    it.each([
        { first: 'grantee', separateReceiptArtifact: false, platformState: null },
        { first: 'owner', separateReceiptArtifact: false, platformState: null },
        { first: 'owner', separateReceiptArtifact: true, platformState: null },
        { first: 'grantee', separateReceiptArtifact: true, platformState: 'current' },
        { first: 'grantee', separateReceiptArtifact: true, platformState: 'legacy' },
    ] as const)('erases $first first after Rollback and teardown (grantee owns Artifact: $separateReceiptArtifact, detach: $platformState)', async ({ first, separateReceiptArtifact, platformState }) => {
        const f = await fixture(false);
        const grantee = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.projectSource.update({ where: { id: f.source.id }, data: { audience: [
            { principal: { kind: 'account', accountId: grantee.id }, level: 'view' },
        ] } });
        await db.deploymentEnvironmentDeployer.create({ data: { environmentId: f.environment.id,
            purpose: 'deploy', principalKind: 'account', principalId: grantee.id, createdByAccountId: f.account.id } });
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { deployerMode: 'chosen' } });
        await db.deployment.update({ where: { id: f.receipt.id }, data: {
            operation: 'deploy', state: 'succeeded', requestedAt: new Date(0), settledAt: new Date(0),
        } });
        const settledAt = new Date();
        const rollbackRequestedAt = new Date(settledAt.getTime() - 1_000);
        const content = { contentArtifactId: f.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const deployed = await db.deployment.create({ data: { environmentId: f.environment.id, targetLinkId: f.link.id,
            operation: 'deploy', state: 'succeeded', requestKey: randomUUID(), requestedByAccountId: f.account.id,
            actionOperationId: randomUUID(), requestedAt: new Date(settledAt.getTime() - 2_000), settledAt, ...content } });
        const privateNote = 'Private grantee Rollback note that must be erased';
        const receiptArtifact = separateReceiptArtifact ? await db.artifact.create({ data: { id: randomUUID(), accountId: grantee.id,
            header: new Uint8Array(), body: new TextEncoder().encode(privateNote), dataEncryptionKey: new Uint8Array(),
            grants: { create: { principalKind: 'account', accountId: f.account.id, accessLevel: 'admin', createdByAccountId: grantee.id } } },
        }) : f.artifact;
        const rollback = await db.deployment.create({ data: { environmentId: f.environment.id, targetLinkId: f.link.id,
            operation: 'rollback', state: 'succeeded', requestKey: randomUUID(), requestedByAccountId: grantee.id,
            actionOperationId: randomUUID(), predecessorDeploymentId: deployed.id, rollbackOfDeploymentId: deployed.id,
            requestedAt: rollbackRequestedAt, settledAt, ...content, contentArtifactId: receiptArtifact.id } });
        const source = sourceFromRow(f.source);
        if (!source.success) throw source.error;
        async function retireOwnServer() {
            // Native settlement records absence; Environment deletion spends that proof.
            const now = new Date(Math.max(Date.now(), settledAt.getTime() + 1));
            await db.deployment.update({ where: { id: f.receipt.id }, data: {
                operation: 'teardown', state: 'succeeded', requestedAt: now, settledAt: now, predecessorDeploymentId: rollback.id,
                teardownProof: teardownProof(f.machine, false),
            } });
            await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { activeDeploymentId: null, revision: 2 } });
            await inTx(tx => removeAdmittedDeploymentEnvironmentInTx(tx, {
                environment: f.environment, source: source.data, now,
            }));
            await db.projectSource.update({ where: { id: f.source.id }, data: { audience: [], deletedAt: now } });
        }
        // The sweep withdrew the Deploy grant before either Account erased.
        await db.deploymentEnvironmentDeployer.deleteMany({ where: { environmentId: f.environment.id,
            purpose: 'deploy', principalKind: 'account', principalId: grantee.id } });
        await db.projectSource.update({ where: { id: f.source.id }, data: { audience: [] } });
        if (first === 'owner') await retireOwnServer();

        const platform = platformState ? await (async () => {
            const environment = await db.deploymentEnvironment.create({ data: {
                projectSourceId: f.source.id, createdByAccountId: f.account.id, controllerMachineId: f.machine.id,
                protection: 'production', purpose: 'standard', deployerMode: 'managers', ...content,
            } });
            const link = await db.deploymentTargetLink.create({ data: {
                environmentId: environment.id, createdByAccountId: f.account.id, role: 'runtime', sourceKind: 'plugin',
                pluginId: 'happier.deploy.vercel', contributionLocalId: 'runtime', targetKind: 'vercel', state: 'deployed', ...content,
            } });
            const release = await db.deployment.create({ data: { environmentId: environment.id, targetLinkId: link.id,
                operation: 'rollback', state: 'succeeded', requestKey: randomUUID(), requestedByAccountId: f.account.id,
                actionOperationId: randomUUID(), settledAt, ...content } });
            await db.deploymentTargetLink.update({ where: { id: link.id }, data: { activeDeploymentId: release.id } });
            await db.deploymentEnvironment.update({ where: { id: environment.id }, data: { runtimeTargetLinkId: link.id } });
            await inTx(tx => removeAdmittedDeploymentEnvironmentInTx(tx, {
                environment, source: source.data, now: new Date(), detachKeepRunning: true,
            }));
            if (platformState === 'legacy') {
                // Existing rows recorded the same disposition timestamp but retained their old state.
                await db.deploymentTargetLink.update({ where: { id: link.id }, data: { state: 'deployed' } });
            }
            return { environment, link, release };
        })() : null;

        if (first === 'grantee' && separateReceiptArtifact) {
            // The incumbent erasure owner must keep custody and report pending
            // if the private object store cannot delete the Receipt's bytes.
            const blobId = randomUUID();
            const storageKey = `artifacts/${receiptArtifact.id}/${blobId}`;
            await db.artifactBlob.create({ data: { id: blobId, artifactId: receiptArtifact.id, storageKey,
                encryptionMode: 'plain', storedSizeBytes: 1n } });
            const removePrivate = vi.spyOn(blobFiles, 'deletePrivateFile')
                .mockRejectedValueOnce(new Error('private store unavailable')).mockResolvedValueOnce(undefined);
            try {
                expect(await deleteAccountForErasure({ accountId: grantee.id })).toEqual({ status: 'disabled_pending_completion' });
                expect(await db.artifactBlob.findUnique({ where: { id: blobId } })).not.toBeNull();
                expect(await db.deployment.findUnique({ where: { id: rollback.id } })).toEqual(rollback);
                expect(await deleteAccountForErasure({ accountId: grantee.id })).toEqual({ status: 'deleted' });
                expect(removePrivate.mock.calls).toEqual([[storageKey], [storageKey]]);
                expect(await db.artifactBlob.findUnique({ where: { id: blobId } })).toBeNull();
            } finally {
                removePrivate.mockRestore();
            }
        }
        const accountOrder = first === 'grantee' ? [grantee.id, f.account.id] : [f.account.id, grantee.id];
        if (!(first === 'grantee' && separateReceiptArtifact)) {
            expect(await deleteAccountForErasure({ accountId: accountOrder[0] })).toEqual({ status: 'deleted' });
        }
        expect(await db.account.findUnique({ where: { id: accountOrder[0] } })).toBeNull();
        const detached = platform && await readDeploymentTargetInTx(db, platform.environment.id, platform.link.id);
        if (first === 'grantee') {
            const retained = await db.deployment.findUniqueOrThrow({ where: { id: rollback.id } });
            const contentArtifactId = separateReceiptArtifact ? null : receiptArtifact.id;
            expect(retained).toEqual({ ...rollback, requestedByAccountId: null, contentArtifactId });
            expect(projectDeploymentReceiptHeader(retained)).toMatchObject({
                id: rollback.id, operation: 'rollback', state: 'succeeded', settledAtMs: settledAt.getTime(),
                requestedByAccountId: null, contentArtifactId,
            });
            expect(await db.account.findUnique({ where: { id: f.account.id }, select: { status: true } })).toEqual({ status: 'active' });
            if (separateReceiptArtifact) {
                expect(await db.artifact.findUnique({ where: { id: receiptArtifact.id } })).toBeNull();
                const serverId = await getOrCreateServerIdentityId();
                const input = { serverId, environmentId: f.environment.id };
                const expected = { ...projectDeploymentReceiptHeader(rollback), requestedByAccountId: null, contentArtifactId: null };
                expect(await readDeploymentReceiptInTx(db, f.account.id, { ...input, deploymentId: rollback.id }))
                    .toEqual({ ok: true, deployment: expected, cancellable: false });
                const history = await listDeploymentReceiptsInTx(db, f.account.id, input);
                expect(history).toMatchObject({ ok: true, items: expect.arrayContaining([expected]) });
                expect(JSON.stringify(history)).not.toContain(grantee.id);
                expect(JSON.stringify(history)).not.toContain(privateNote);
                expect(JSON.stringify(history)).not.toContain(receiptArtifact.id);
            }
            expect(await db.artifact.findUnique({ where: { id: f.artifact.id } })).toEqual(f.artifact);
            await retireOwnServer();
            expect(await deleteAccountForErasure({ accountId: accountOrder[1] })).toEqual({ status: 'deleted' });
            if (platform) {
                expect(detached).toMatchObject({ state: 'detached', detachedAtMs: expect.any(Number) });
                expect(detached?.activeDeploymentId).toBe(platform.release.id);
                expect(await db.deploymentTargetLink.findUnique({ where: { id: platform.link.id } })).toBeNull();
                expect(await db.deployment.findUnique({ where: { id: platform.release.id } })).toBeNull();
            }
        } else {
            expect(await db.deployment.findUnique({ where: { id: rollback.id } })).toBeNull();
            expect(await db.account.findUnique({ where: { id: grantee.id }, select: { status: true } })).toEqual({ status: 'active' });
            if (separateReceiptArtifact) expect(await db.artifact.findUnique({ where: { id: receiptArtifact.id } })).toEqual(receiptArtifact);
        }
        if (first === 'owner') expect(await deleteAccountForErasure({ accountId: accountOrder[1] })).toEqual({ status: 'deleted' });
        expect(await db.account.findUnique({ where: { id: accountOrder[1] } })).toBeNull();
        expect(await db.deployment.count({ where: { environmentId: f.environment.id } })).toBe(0);
        expect(await db.artifact.findUnique({ where: { id: f.artifact.id } })).toBeNull();
        if (separateReceiptArtifact) expect(await db.artifact.findUnique({ where: { id: receiptArtifact.id } })).toBeNull();
    });

    it.each(['queued', 'running'] as const)('refuses a %s deployment before retirement or partial graph deletion', async (state) => {
        const f = await fixture(false);
        await db.deployment.update({ where: { id: f.receipt.id }, data: { state } });
        expect(await deleteAccountForErasure({ accountId: f.account.id })).toMatchObject({ status: 'failed', code: 'account_erasure_deployment_cleanup_required', blocker: { reason: 'running_work', deploymentId: f.receipt.id } });
        expect(await db.account.findUnique({ where: { id: f.account.id }, select: { status: true } })).toEqual({ status: 'active' });
        expect(await db.deployment.count({ where: { id: f.receipt.id } })).toBe(1);
    });

    it('refuses a grantee erasure while their Rollback is still running', async () => {
        const f = await fixture(false);
        const grantee = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.deployment.update({ where: { id: f.receipt.id }, data: { operation: 'rollback', requestedByAccountId: grantee.id } });
        expect(await deleteAccountForErasure({ accountId: grantee.id })).toMatchObject({ status: 'failed', code: 'account_erasure_deployment_cleanup_required', blocker: { reason: 'running_work', deploymentId: f.receipt.id } });
        expect(await db.account.findUnique({ where: { id: grantee.id }, select: { status: true } })).toEqual({ status: 'active' });
    });

    it('refuses erasure while the grantee’s private Receipt Artifact is used by running work on another Account', async () => {
        const f = await fixture(false);
        const grantee = await db.account.create({ data: { encryptionMode: 'plain' } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: grantee.id,
            header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array() } });
        await db.deployment.update({ where: { id: f.receipt.id }, data: { contentArtifactId: artifact.id } });
        expect(await deleteAccountForErasure({ accountId: grantee.id }))
            .toMatchObject({ status: 'failed', code: 'account_erasure_deployment_cleanup_required', blocker: { reason: 'running_work', artifactId: artifact.id } });
        expect(await db.artifact.findUnique({ where: { id: artifact.id } })).toEqual(artifact);
    });

    it('refuses a retired graph when teardown retained a provider resource', async () => {
        const f = await fixture(true);
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { sourceKind: 'plugin', hostTargetId: null,
            pluginId: 'example.platform', contributionLocalId: 'runtime', targetKind: 'platform', state: 'provisioned' } });
        await db.deployment.update({ where: { id: f.receipt.id }, data: { teardownProof: teardownProof(f.machine, true) } });
        expect(await deleteAccountForErasure({ accountId: f.account.id })).toMatchObject({ status: 'failed', code: 'account_erasure_deployment_cleanup_required', blocker: { reason: 'provider_resource', environmentId: f.environment.id, targetLinkId: f.link.id, targetKind: 'platform' } });
        expect(await db.account.findUnique({ where: { id: f.account.id }, select: { status: true } })).toEqual({ status: 'active' });
    });

    it.each([
        { sourceDeleted: false, environmentDeleted: true },
        { sourceDeleted: true, environmentDeleted: false },
    ])('preserves Team deployment history (Source deleted: $sourceDeleted, Environment deleted: $environmentDeleted)', async ({ sourceDeleted, environmentDeleted }) => {
        const f = await fixture(true);
        const team = await db.team.create({ data: { name: 'Retained Team' } });
        await db.projectSource.update({ where: { id: f.source.id }, data: {
            owner: { kind: 'team', teamId: team.id }, deletedAt: sourceDeleted ? new Date() : null,
        } });
        const environment = await db.deploymentEnvironment.update({ where: { id: f.environment.id },
            data: { deletedAt: environmentDeleted ? f.environment.deletedAt : null } });
        expect(await deleteAccountForErasure({ accountId: f.account.id })).toMatchObject({ status: 'failed', code: 'account_erasure_deployment_cleanup_required', blocker: { reason: 'source_sharing', projectSourceId: f.source.id } });
        expect(await db.deploymentEnvironment.findUnique({ where: { id: environment.id } })).toEqual(environment);
        expect(await db.deployment.findUnique({ where: { id: f.receipt.id } })).toEqual(f.receipt);
    });

    it('erases an E2EE Account after its Team Source and Environment were retired', async () => {
        const f = await fixture(true, 'e2ee');
        const team = await db.team.create({ data: { name: 'Retiring Team' } });
        const member = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: member.id, role: 'owner' } });
        await db.projectSource.update({ where: { id: f.source.id }, data: {
            owner: { kind: 'team', teamId: team.id }, deletedAt: new Date(),
        } });

        expect(await deleteAccountForErasure({ accountId: f.account.id })).toMatchObject({
            status: 'failed', code: 'account_erasure_deployment_cleanup_required',
            blocker: { reason: 'source_sharing', projectSourceId: f.source.id },
        });
        const archived = await db.team.update({ where: { id: team.id }, data: { archivedAt: new Date() } });
        expect(await deleteAccountForErasure({ accountId: f.account.id })).toEqual({ status: 'deleted' });
        expect(await db.account.findUnique({ where: { id: f.account.id } })).toBeNull();
        expect(await db.projectSource.findUnique({ where: { id: f.source.id } })).toBeNull();
        expect(await db.projectDeploymentDefaults.count({ where: { projectSourceId: f.source.id } })).toBe(0);
        expect(await db.deploymentEnvironment.findUnique({ where: { id: f.environment.id } })).toBeNull();
        expect(await db.deploymentTargetLink.findUnique({ where: { id: f.link.id } })).toBeNull();
        expect(await db.deployment.count({ where: { environmentId: f.environment.id } })).toBe(0);
        expect(await db.deploymentDomain.count({ where: { environmentId: f.environment.id } })).toBe(0);
        expect(await db.team.findUnique({ where: { id: team.id } })).toEqual(archived);
        expect(await db.teamMembership.findUnique({ where: { id: membership.id } })).toEqual(membership);
    });

    it('erases an Own-server Environment after successful teardown, with a revoked Machine and the erased grantee’s grant', async () => {
        const f = await fixture(true);
        const grantee = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.deploymentEnvironmentDeployer.create({ data: {
            environmentId: f.environment.id, purpose: 'deploy', principalKind: 'account',
            principalId: grantee.id, createdByAccountId: f.account.id,
        } });
        expect(await deleteAccountForErasure({ accountId: grantee.id })).toEqual({ status: 'deleted' });
        await db.machine.update({ where: { id: f.machine.id }, data: { revokedAt: new Date() } });
        await db.projectSource.update({ where: { id: f.source.id }, data: { deletedAt: new Date() } });
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: {
            buildMachineId: f.machine.id, deployerMode: 'chosen',
        } });
        expect(await deleteAccountForErasure({ accountId: f.account.id })).toEqual({ status: 'deleted' });
        expect(await db.deploymentEnvironment.findUnique({ where: { id: f.environment.id } })).toBeNull();
        expect(await db.machine.findUnique({ where: { id: f.machine.id } })).toBeNull();
    });

    it('names the managed Worker and erases after Detach when its provider credential is absent', async () => {
        const f = await fixture(false);
        await db.machine.update({ where: { id: f.machine.id }, data: {
            metadata: encodePlainMachineStoredContent({ host: 'Purge', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
        } });
        await db.deployment.update({ where: { id: f.receipt.id }, data: { operation: 'deploy', state: 'succeeded', settledAt: new Date() } });
        // Persist the Worker as provisioned without a connected Account, as after credential withdrawal.
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: {
            sourceKind: 'plugin', hostTargetId: null, pluginId: 'cloudflare', contributionLocalId: 'workers',
            targetKind: 'cloudflare-workers', state: 'provisioned',
        } });
        await db.deploymentDomain.create({ data: {
            targetLinkId: f.link.id, environmentId: f.environment.id, createdByAccountId: f.account.id,
            state: 'active', contentArtifactId: f.artifact.id, contentBodyVersion: 1, contentHeaderVersion: 1,
        } });
        await db.automation.create({ data: {
            accountId: f.account.id, name: 'Worker cleanup', enabled: true, deploymentEnvironmentId: f.environment.id, templateCiphertext: '{}',
        } });
        expect(await deleteAccountForErasure({ accountId: f.account.id })).toEqual({
            status: 'failed', code: 'account_erasure_deployment_cleanup_required',
            blocker: { reason: 'provider_resource', environmentId: f.environment.id, targetLinkId: f.link.id, targetKind: 'cloudflare-workers' },
        });
        const serverId = await getOrCreateServerIdentityId();
        expect(await inTx(tx => deleteDeploymentEnvironmentInTx(tx, f.account.id, {
            serverId, environmentId: f.environment.id, expectedRevision: f.environment.revision,
            requestKey: randomUUID(), detachKeepRunning: true,
        }))).toMatchObject({ ok: true, detached: true });
        expect(await db.deploymentTargetLink.findUnique({ where: { id: f.link.id } })).toMatchObject({ state: 'detached' });
        expect(await deleteAccountForErasure({ accountId: f.account.id })).toEqual({ status: 'deleted' });
        expect(await db.deploymentDomain.count({ where: { targetLinkId: f.link.id } })).toBe(0);
    });

    it.each([false, true])('protects a managed deployment until explicit detach after failed teardown (revoked Machine: %s)', async revoked => {
        const f = await fixture(false);
        await db.machine.update({ where: { id: f.machine.id }, data: {
            metadata: encodePlainMachineStoredContent({ host: 'Purge', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
        } });
        await db.deployment.update({ where: { id: f.receipt.id }, data: {
            operation: 'deploy', state: 'succeeded', requestedAt: new Date(1), settledAt: new Date(1),
        } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: {
            state: 'deployed', activeDeploymentId: f.receipt.id,
        } });
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { runtimeTargetLinkId: f.link.id } });
        const target = { environmentId: f.environment.id, targetLinkId: f.link.id, targetKind: 'ownServer' };
        expect(await deleteAccountForErasure({ accountId: f.account.id })).toEqual({
            status: 'failed', code: 'account_erasure_deployment_cleanup_required',
            blocker: { reason: 'provider_resource', ...target },
        });
        await db.deployment.create({ data: {
            environmentId: f.environment.id, targetLinkId: f.link.id, operation: 'teardown', state: 'failed',
            requestKey: randomUUID(), actionOperationId: randomUUID(), requestedByAccountId: f.account.id,
            predecessorDeploymentId: f.receipt.id, requestedAt: new Date(2), startedAt: new Date(3), settledAt: new Date(4),
            contentArtifactId: f.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
        } });
        if (revoked) await db.machine.update({ where: { id: f.machine.id }, data: { revokedAt: new Date(), active: false } });
        expect(await deleteAccountForErasure({ accountId: f.account.id })).toEqual({
            status: 'failed', code: 'account_erasure_deployment_cleanup_required',
            blocker: { reason: 'teardown_incomplete', ...target },
        });
        expect(await db.account.findUnique({ where: { id: f.account.id }, select: { status: true } })).toEqual({ status: 'active' });
        const serverId = await getOrCreateServerIdentityId();
        const disposition = await inTx(tx => deleteDeploymentEnvironmentInTx(tx, f.account.id, {
            serverId, environmentId: f.environment.id, expectedRevision: f.environment.revision,
            requestKey: randomUUID(), detachKeepRunning: true,
        }));
        expect(disposition.ok, JSON.stringify(disposition)).toBe(true);
        expect(disposition).toMatchObject({ detached: true });
        expect(await deleteAccountForErasure({ accountId: f.account.id })).toEqual({ status: 'deleted' });
        expect(await db.deploymentEnvironment.findUnique({ where: { id: f.environment.id } })).toBeNull();
    });

    it('refuses incoming foreign receipt lineage and preserves both graphs', async () => {
        const own = await fixture(true);
        const foreign = await fixture(true);
        await db.deployment.update({ where: { id: foreign.receipt.id }, data: { predecessorDeploymentId: own.receipt.id } });
        expect(await deleteAccountForErasure({ accountId: own.account.id })).toMatchObject({ status: 'failed', code: 'account_erasure_deployment_cleanup_required', blocker: { reason: 'graph_dependencies', deploymentId: own.receipt.id } });
        expect(await db.deployment.count({ where: { id: { in: [own.receipt.id, foreign.receipt.id] } } })).toBe(2);
    });

    it('erases a retired graph with its disabled retained Automation', async () => {
        const f = await fixture(true);
        await db.automation.create({ data: { accountId: f.account.id, name: 'Retired deployment', enabled: false,
            deploymentEnvironmentId: f.environment.id, templateCiphertext: '{}' } });
        expect(await deleteAccountForErasure({ accountId: f.account.id })).toEqual({ status: 'deleted' });
    });

    it('names a foreign Automation and allows erasure after its owner deletes it', async () => {
        const own = await fixture(true);
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const automation = await db.automation.create({ data: { accountId: other.id, name: 'Shared Environment',
            enabled: false, deploymentEnvironmentId: own.environment.id, templateCiphertext: '{}' } });
        expect(await deleteAccountForErasure({ accountId: own.account.id })).toMatchObject({
            status: 'failed', code: 'account_erasure_deployment_cleanup_required',
            blocker: { reason: 'foreign_automation', environmentId: own.environment.id },
        });
        expect(await deleteAutomation({ accountId: other.id, automationId: automation.id })).toBeTruthy();
        expect(await deleteAccountForErasure({ accountId: own.account.id })).toEqual({ status: 'deleted' });
        expect(await db.automation.findUnique({ where: { id: automation.id } })).toMatchObject({
            accountId: other.id, deploymentEnvironmentId: null, name: automation.name, deletedAt: expect.any(Date),
        });
    });

    it.each(['machine', 'target lineage', 'definition Artifact'] as const)('erases owned history with an outgoing foreign %s reference', async (dependency) => {
        const own = await fixture(true);
        const foreign = await fixture(true);
        if (dependency === 'machine') {
            await db.deploymentEnvironment.update({ where: { id: own.environment.id }, data: { buildMachineId: foreign.machine.id } });
        } else if (dependency === 'target lineage') {
            await db.deploymentTargetLink.update({ where: { id: own.link.id }, data: { predecessorTargetLinkId: foreign.link.id } });
        } else {
            await db.deploymentEnvironment.update({ where: { id: own.environment.id }, data: { contentArtifactId: foreign.artifact.id } });
        }
        expect(await deleteAccountForErasure({ accountId: own.account.id })).toEqual({ status: 'deleted' });
        expect(await db.deployment.findUnique({ where: { id: own.receipt.id } })).toBeNull();
        expect(await db.deployment.findUnique({ where: { id: foreign.receipt.id } })).toEqual(foreign.receipt);
        expect(await db.machine.findUnique({ where: { id: foreign.machine.id } })).toEqual(foreign.machine);
        expect(await db.artifact.findUnique({ where: { id: foreign.artifact.id } })).toEqual(foreign.artifact);
    });
}
