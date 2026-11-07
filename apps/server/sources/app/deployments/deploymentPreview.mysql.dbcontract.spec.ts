import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, initDbMysql } from '@/storage/db';
import { createAutomationWorkflowRecipeFixture } from '@/testkit/automationWorkflowRecipe';

const provider = String(process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? '').trim().toLowerCase();

async function createStoredTemplateFixture() {
    const account = await db.account.create({ data: { encryptionMode: 'plain' } });
    const source = await db.projectSource.create({ data: { createdByAccountId: account.id,
        name: 'Preview storage contract', audience: [], attachments: [] } });
    const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
        metadata: '{}', installationId: randomUUID() } });
    const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: account.id,
        header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array(),
        headerVersion: 1, bodyVersion: 1 } });
    const common = { projectSourceId: source.id, createdByAccountId: account.id,
        protection: 'nonProduction', deployerMode: 'managers', controllerMachineId: machine.id,
        contentArtifactId: artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1 };
    const template = await db.deploymentEnvironment.create({ data: { ...common, purpose: 'standard' } });
    return { account, source, artifact, common, template };
}

describe.skipIf(provider !== 'mysql')('MySQL preview Environment relation contract', () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error('MySQL preview contract requires the disposable database harness');
        await initDbMysql();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it('enforces preview CHECKs, exact case/accent PR identity, full width, live uniqueness and relation FKs', async () => {
        // These structural fixtures exercise the real migrated storage boundary;
        // API admission is covered by deploymentPreview.sqlite.integration.spec.ts.
        const { account, source, artifact, common, template } = await createStoredTemplateFixture();
        const link = await db.deploymentTargetLink.create({ data: { environmentId: template.id,
            createdByAccountId: account.id, role: 'runtime', sourceKind: 'host', hostTargetId: 'own-server',
            targetKind: 'ownServer', state: 'configured', contentArtifactId: artifact.id,
            contentHeaderVersion: 1, contentBodyVersion: 1 } });
        const relation = { previewTemplateEnvironmentId: template.id, previewRepositoryId: source.id,
            previewTargetLinkId: link.id };
        const createChild = (previewPullRequestId: string, overrides: Partial<typeof relation> = {}) =>
            db.deploymentEnvironment.create({ data: { ...common, purpose: 'preview', ...relation,
                ...overrides, previewPullRequestId } });
        await expect(db.deploymentEnvironment.create({ data: { ...common, purpose: 'preview' } })).rejects.toThrow();
        await expect(db.deploymentEnvironment.update({ where: { id: template.id },
            data: { previewRepositoryId: source.id } })).rejects.toThrow();
        const automation = await db.automation.create({ data: { accountId: account.id,
            name: 'Preview role storage contract', deploymentEnvironmentId: template.id,
            templateCiphertext: JSON.stringify(createAutomationWorkflowRecipeFixture({
                templateVersion: 1, directory: '/workspace/app', prompt: 'Preview',
            })) } });
        for (const deploymentPreviewRole of ['preview_admission', 'preview_cleanup']) {
            expect((await db.automation.update({ where: { id: automation.id }, data: { deploymentPreviewRole } }))
                .deploymentPreviewRole).toBe(deploymentPreviewRole);
        }
        await expect(db.automation.update({ where: { id: automation.id },
            data: { deploymentPreviewRole: 'other' } })).rejects.toThrow();
        for (const previewPullRequestId of ['case-PR', 'case-pr', 'accent-é', 'accent-e']) {
            expect((await createChild(previewPullRequestId)).previewPullRequestId).toBe(previewPullRequestId);
        }
        for (const character of ['a', '🙂']) {
            const id = character.repeat(191);
            const child = await createChild(id);
            expect((await db.deploymentEnvironment.findUniqueOrThrow({ where: { id: child.id } })).previewPullRequestId).toBe(id);
            await expect(createChild(character.repeat(192))).rejects.toMatchObject({ code: 'P2000' });
            await expect(createChild(id)).rejects.toMatchObject({ code: 'P2002' });
            await db.deploymentEnvironment.update({ where: { id: child.id }, data: { deletedAt: new Date() } });
            expect((await createChild(id)).previewPullRequestId).toBe(id);
        }
        for (const field of ['previewTemplateEnvironmentId', 'previewRepositoryId', 'previewTargetLinkId'] as const) {
            await expect(createChild(randomUUID(), { [field]: randomUUID() })).rejects.toMatchObject({ code: 'P2003' });
        }
    });

    it('rejects differently cased preview roles in the migrated closed role CHECK', async () => {
        const { account, template } = await createStoredTemplateFixture();
        const automation = await db.automation.create({ data: { accountId: account.id,
            name: 'Exact preview role storage contract', deploymentEnvironmentId: template.id,
            deploymentPreviewRole: 'preview_admission',
            templateCiphertext: JSON.stringify(createAutomationWorkflowRecipeFixture({
                templateVersion: 1, directory: '/workspace/app', prompt: 'Preview',
            })) } });
        expect(automation.deploymentPreviewRole).toBe('preview_admission');
        await expect(db.automation.update({ where: { id: automation.id },
            data: { deploymentPreviewRole: 'PREVIEW_ADMISSION' } })).rejects.toThrow();
    });
});
