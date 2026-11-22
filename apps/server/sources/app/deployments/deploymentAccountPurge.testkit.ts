import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { db } from '@/storage/db';
import { deleteAccountForErasure } from '@/app/plugins/data/accountDataErase';
import { createDeploymentAcceptedExecution, deploymentAcceptedExecutionColumns } from './deploymentAcceptedExecution';
import { projectDeploymentReceiptHeader } from './deploymentService';
import { DeploymentTeardownProofV1Schema } from '@happier-dev/protocol';

function teardownProof(machine: { id: string; installationId: string | null }, retainedProviderResource: boolean) {
    return DeploymentTeardownProofV1Schema.parse({ targetLinkRevision: 1,
        machines: [{ machineId: machine.id, installationId: machine.installationId! }], workloadAbsent: true,
        retainedProviderResource,
        steps: ['admit', 'settleDeploy', 'removeTarget', 'removeDomain', 'removeRelease', 'withdrawBindings', 'verify'] });
}

/** Real retained graph: the public disposition leaves these Restrict references behind. */
async function fixture(retired: boolean) {
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}', installationId: randomUUID() } });
    const source = await db.projectSource.create({ data: { createdByAccountId: account.id, name: 'Purge', audience: [], attachments: [] } });
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
    await db.projectDeploymentDefaults.create({ data: { projectSourceId: source.id, ...content } });
    await db.deploymentEnvironmentDeployer.create({ data: { environmentId: environment.id, purpose: 'deploy',
        principalKind: 'account', principalId: account.id, createdByAccountId: account.id } });
    if (retired) await db.deploymentDomain.create({ data: { environmentId: environment.id, targetLinkId: link.id,
        createdByAccountId: account.id, state: 'removing', deletedAt: new Date(), ...content } });
    return { account, machine, source, artifact, environment, link, receipt };
}

export function deploymentAccountPurgeCases() {
    it('erases a retired solely Account-owned graph before its Artifacts and Machines', async () => {
        const f = await fixture(true);
        expect(await deleteAccountForErasure({ accountId: f.account.id })).toEqual({ status: 'deleted' });
        expect(await db.account.findUnique({ where: { id: f.account.id } })).toBeNull();
        expect(await db.deploymentEnvironment.findUnique({ where: { id: f.environment.id } })).toBeNull();
        expect(await db.deployment.findUnique({ where: { id: f.receipt.id } })).toBeNull();
        expect(await db.artifact.findUnique({ where: { id: f.artifact.id } })).toBeNull();
    });

    it.each([
        { first: 'grantee', separateReceiptArtifact: false },
        { first: 'owner', separateReceiptArtifact: false },
        { first: 'owner', separateReceiptArtifact: true },
    ] as const)('erases $first first after Rollback and teardown (grantee owns Artifact: $separateReceiptArtifact)', async ({ first, separateReceiptArtifact }) => {
        const f = await fixture(false);
        const grantee = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.projectSource.update({ where: { id: f.source.id }, data: { audience: [
            { principal: { kind: 'account', accountId: grantee.id }, level: 'view' },
        ] } });
        await db.deploymentEnvironmentDeployer.create({ data: { environmentId: f.environment.id,
            purpose: 'deploy', principalKind: 'account', principalId: grantee.id, createdByAccountId: f.account.id } });
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { deployerMode: 'chosen' } });
        const settledAt = new Date();
        const rollbackRequestedAt = new Date(settledAt.getTime() - 1_000);
        const content = { contentArtifactId: f.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
        const deployed = await db.deployment.create({ data: { environmentId: f.environment.id, targetLinkId: f.link.id,
            operation: 'deploy', state: 'succeeded', requestKey: randomUUID(), requestedByAccountId: f.account.id,
            actionOperationId: randomUUID(), requestedAt: new Date(settledAt.getTime() - 2_000), settledAt, ...content } });
        const receiptArtifact = separateReceiptArtifact ? await db.artifact.create({ data: { id: randomUUID(), accountId: grantee.id,
            header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array(),
            grants: { create: { principalKind: 'account', accountId: f.account.id, accessLevel: 'admin', createdByAccountId: grantee.id } } },
        }) : f.artifact;
        const rollback = await db.deployment.create({ data: { environmentId: f.environment.id, targetLinkId: f.link.id,
            operation: 'rollback', state: 'succeeded', requestKey: randomUUID(), requestedByAccountId: grantee.id,
            actionOperationId: randomUUID(), predecessorDeploymentId: deployed.id, rollbackOfDeploymentId: deployed.id,
            requestedAt: rollbackRequestedAt, settledAt, ...content, contentArtifactId: receiptArtifact.id } });
        // Persist the native settlement and disposition left by successful teardown.
        await db.deployment.update({ where: { id: f.receipt.id }, data: { state: 'succeeded', requestedAt: settledAt, settledAt,
            predecessorDeploymentId: rollback.id, teardownProof: teardownProof(f.machine, false) } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { deletedAt: settledAt, revision: 3 } });
        await db.deploymentEnvironment.update({ where: { id: f.environment.id }, data: { deletedAt: settledAt, deployerMode: 'managers' } });
        await db.deploymentEnvironmentDeployer.deleteMany({ where: { environmentId: f.environment.id,
            purpose: 'deploy', principalKind: 'account', principalId: grantee.id } });
        await db.projectSource.update({ where: { id: f.source.id }, data: { audience: [], deletedAt: settledAt } });

        if (separateReceiptArtifact) {
            // The remaining dependency is the grantee's actual private Artifact, rather than authorship.
            expect(await deleteAccountForErasure({ accountId: grantee.id })).toEqual({ status: 'failed', code: 'account_erasure_deployment_cleanup_required' });
            expect(await db.account.findUnique({ where: { id: grantee.id }, select: { status: true } })).toEqual({ status: 'active' });
        }
        const accountOrder = first === 'grantee' ? [grantee.id, f.account.id] : [f.account.id, grantee.id];
        expect(await deleteAccountForErasure({ accountId: accountOrder[0] })).toEqual({ status: 'deleted' });
        expect(await db.account.findUnique({ where: { id: accountOrder[0] } })).toBeNull();
        if (first === 'grantee') {
            const retained = await db.deployment.findUniqueOrThrow({ where: { id: rollback.id } });
            expect(retained).toEqual({ ...rollback, requestedByAccountId: null });
            expect(projectDeploymentReceiptHeader(retained)).toMatchObject({ id: rollback.id, requestedByAccountId: null });
            expect(await db.artifact.findUnique({ where: { id: f.artifact.id } })).toEqual(f.artifact);
        } else {
            expect(await db.deployment.findUnique({ where: { id: rollback.id } })).toBeNull();
            expect(await db.account.findUnique({ where: { id: grantee.id }, select: { status: true } })).toEqual({ status: 'active' });
            if (separateReceiptArtifact) expect(await db.artifact.findUnique({ where: { id: receiptArtifact.id } })).toEqual(receiptArtifact);
        }
        expect(await deleteAccountForErasure({ accountId: accountOrder[1] })).toEqual({ status: 'deleted' });
        expect(await db.account.findUnique({ where: { id: accountOrder[1] } })).toBeNull();
        expect(await db.deployment.count({ where: { environmentId: f.environment.id } })).toBe(0);
        expect(await db.artifact.findUnique({ where: { id: f.artifact.id } })).toBeNull();
        if (separateReceiptArtifact) expect(await db.artifact.findUnique({ where: { id: receiptArtifact.id } })).toBeNull();
    });

    it('refuses an active deployment before retirement or partial graph deletion', async () => {
        const f = await fixture(false);
        expect(await deleteAccountForErasure({ accountId: f.account.id })).toEqual({ status: 'failed', code: 'account_erasure_deployment_cleanup_required' });
        expect(await db.account.findUnique({ where: { id: f.account.id }, select: { status: true } })).toEqual({ status: 'active' });
        expect(await db.deployment.count({ where: { id: f.receipt.id } })).toBe(1);
    });

    it('refuses a grantee erasure while their Rollback is still running', async () => {
        const f = await fixture(false);
        const grantee = await db.account.create({ data: { encryptionMode: 'plain' } });
        await db.deployment.update({ where: { id: f.receipt.id }, data: { operation: 'rollback', requestedByAccountId: grantee.id } });
        expect(await deleteAccountForErasure({ accountId: grantee.id })).toEqual({ status: 'failed', code: 'account_erasure_deployment_cleanup_required' });
        expect(await db.account.findUnique({ where: { id: grantee.id }, select: { status: true } })).toEqual({ status: 'active' });
    });

    it('refuses a retired graph when teardown retained a provider resource', async () => {
        const f = await fixture(true);
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { sourceKind: 'plugin', hostTargetId: null,
            pluginId: 'example.platform', contributionLocalId: 'runtime', targetKind: 'platform', state: 'provisioned' } });
        await db.deployment.update({ where: { id: f.receipt.id }, data: { teardownProof: teardownProof(f.machine, true) } });
        expect(await deleteAccountForErasure({ accountId: f.account.id })).toEqual({ status: 'failed', code: 'account_erasure_deployment_cleanup_required' });
        expect(await db.account.findUnique({ where: { id: f.account.id }, select: { status: true } })).toEqual({ status: 'active' });
    });

    it('leaves a Team-owned Environment and its history untouched', async () => {
        const f = await fixture(true);
        const team = await db.team.create({ data: { name: 'Retained Team' } });
        await db.projectSource.update({ where: { id: f.source.id }, data: { owner: { kind: 'team', teamId: team.id } } });
        expect(await deleteAccountForErasure({ accountId: f.account.id })).toEqual({ status: 'failed', code: 'account_erasure_deployment_cleanup_required' });
        expect(await db.deploymentEnvironment.findUnique({ where: { id: f.environment.id } })).toEqual(f.environment);
        expect(await db.deployment.findUnique({ where: { id: f.receipt.id } })).toEqual(f.receipt);
    });

    it('refuses detached workloads and missing teardown proof before deleting the graph', async () => {
        const f = await fixture(true);
        await db.deployment.update({ where: { id: f.receipt.id }, data: { operation: 'deploy' } });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: {
            detachedAt: new Date(), state: 'deployed', activeDeploymentId: f.receipt.id } });
        expect(await deleteAccountForErasure({ accountId: f.account.id })).toEqual({ status: 'failed', code: 'account_erasure_deployment_cleanup_required' });
        await db.deploymentTargetLink.update({ where: { id: f.link.id }, data: { detachedAt: null, state: 'configured', activeDeploymentId: null } });
        await db.deployment.update({ where: { id: f.receipt.id }, data: { operation: 'teardown', state: 'failed' } });
        expect(await deleteAccountForErasure({ accountId: f.account.id })).toEqual({ status: 'failed', code: 'account_erasure_deployment_cleanup_required' });
        expect(await db.account.findUnique({ where: { id: f.account.id }, select: { status: true } })).toEqual({ status: 'active' });
        expect(await db.deploymentEnvironment.count({ where: { id: f.environment.id } })).toBe(1);
    });

    it('refuses incoming foreign receipt lineage and preserves both graphs', async () => {
        const own = await fixture(true);
        const foreign = await fixture(true);
        await db.deployment.update({ where: { id: foreign.receipt.id }, data: { predecessorDeploymentId: own.receipt.id } });
        expect(await deleteAccountForErasure({ accountId: own.account.id })).toEqual({ status: 'failed', code: 'account_erasure_deployment_cleanup_required' });
        expect(await db.deployment.count({ where: { id: { in: [own.receipt.id, foreign.receipt.id] } } })).toBe(2);
    });

    it('erases a retired graph with its disabled retained Automation', async () => {
        const f = await fixture(true);
        await db.automation.create({ data: { accountId: f.account.id, name: 'Retired deployment', enabled: false,
            deploymentEnvironmentId: f.environment.id, templateCiphertext: '{}' } });
        expect(await deleteAccountForErasure({ accountId: f.account.id })).toEqual({ status: 'deleted' });
    });

    it.each(['machine', 'target lineage'] as const)('refuses an outgoing foreign %s dependency', async (dependency) => {
        const own = await fixture(true);
        const foreign = await fixture(true);
        if (dependency === 'machine') {
            await db.deploymentEnvironment.update({ where: { id: own.environment.id }, data: { buildMachineId: foreign.machine.id } });
        } else {
            await db.deploymentTargetLink.update({ where: { id: own.link.id }, data: { predecessorTargetLinkId: foreign.link.id } });
        }
        expect(await deleteAccountForErasure({ accountId: own.account.id })).toEqual({ status: 'failed', code: 'account_erasure_deployment_cleanup_required' });
        expect(await db.deployment.count({ where: { id: { in: [own.receipt.id, foreign.receipt.id] } } })).toBe(2);
        expect(await db.machine.findUnique({ where: { id: foreign.machine.id } })).toEqual(foreign.machine);
    });
}
