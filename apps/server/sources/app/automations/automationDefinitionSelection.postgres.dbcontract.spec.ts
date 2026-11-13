import { randomUUID } from "node:crypto";
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, initDbPostgres } from "@/storage/db";
import { createAutomation, updateAutomation, listAutomationDefinitionsPage } from "./automationCrudService";
import { createAutomationWorkflowRecipeFixture } from '@/testkit/automationWorkflowRecipe';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { AutomationDefinitionListResponseSchema } from "@happier-dev/protocol/automations/automationApiV3";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerAutomationV3Routes } from "@/app/api/routes/automations/registerAutomationV3Routes";
import { inTx } from '@/storage/inTx';
import { readSharedWorkflowTriggerSummaries } from './automationSharedWorkflowSummaries';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== "postgres")("Automation definition demand (PostgreSQL)", () => {
    const definitionIds = [randomUUID(), randomUUID()];
    let accountId: string;
    let otherAccountId: string;
    const selectedIds = [randomUUID(), randomUUID()];
    const managedTarget = { homeId: 'managed-home', managedId: 'managed-resource' };
    const managedId = randomUUID();
    const unknownId = randomUUID();

    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
        accountId = (await db.account.create({ data: { encryptionMode: "plain" } })).id;
        otherAccountId = (await db.account.create({ data: { encryptionMode: "plain" } })).id;
        const row = (id: string, workflowDefinitionId: string, owner = accountId) => ({ id,
            accountId: owner, workflowDefinitionId, name: "Definition selection fixture", templateCiphertext: "{}",
            managedTargetIndexed: true, managedTargetHomeId: 'unrelated-home', managedTargetManagedId: 'unrelated-resource' });
        await db.automation.createMany({ data: [
            ...Array.from({ length: 2500 }, () => row(randomUUID(), "builtin:unrelated")),
            ...selectedIds.map((id, index) => row(id, definitionIds[index]!)),
            row(randomUUID(), definitionIds[0]!, otherAccountId),
            { ...row(randomUUID(), definitionIds[0]!), deletedAt: new Date() },
            { ...row(managedId, 'builtin:managed'), managedTargetHomeId: managedTarget.homeId, managedTargetManagedId: managedTarget.managedId },
            { ...row(unknownId, 'builtin:unknown'), managedTargetIndexed: false, managedTargetHomeId: null, managedTargetManagedId: null },
            { ...row(randomUUID(), 'builtin:managed', otherAccountId), managedTargetHomeId: managedTarget.homeId, managedTargetManagedId: managedTarget.managedId },
            { ...row(randomUUID(), 'builtin:managed'), deletedAt: new Date(), managedTargetHomeId: managedTarget.homeId, managedTargetManagedId: managedTarget.managedId },
        ] });
    });
    afterAll(async () => {
        if (accountId) await db.machine.deleteMany({ where: { accountId } });
        if (accountId) await db.account.delete({ where: { id: accountId } });
        if (otherAccountId) await db.account.delete({ where: { id: otherAccountId } });
        await db.$disconnect();
    });

    it('reads only the selected Team schedule alongside unrelated Account definitions', async () => {
        const team = await db.team.create({ data: { name: 'Schedule audience' } });
        const artifactId = randomUUID();
        try {
            await db.teamMembership.create({ data: { teamId: team.id, accountId: otherAccountId, role: 'member' } });
            const artifact = await db.artifact.create({ data: { id: artifactId, accountId,
                header: Buffer.from(encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1' }), 'base64'),
                body: Buffer.from(encodePlainArtifactStoredContent({}), 'base64'),
                dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64') } });
            await db.artifactGrant.create({ data: { principalKind: 'team', artifactId: artifact.id, teamId: team.id, accessLevel: 'view', createdByAccountId: accountId } });
            const nextRunAt = new Date('2030-01-01T12:00:00Z');
            await db.automation.create({ data: { id: randomUUID(), accountId, name: 'Private schedule', enabled: true,
                managedTargetIndexed: true,
                workflowDefinitionId: artifact.id, templateVersion: 1, templateCiphertext: JSON.stringify({
                    v: 2, templateVersion: 1, workflow: { t: 'plain', v: { workspace: { directory: '/private' },
                        executionTarget: { kind: 'session' }, visibleTeamId: team.id } }, triggerEvidence: null }),
                triggers: { create: { id: randomUUID(), kind: 'schedule', enabled: true, scheduleKind: 'interval', everyMs: 60_000, nextRunAt } } } });
            expect(await readSharedWorkflowTriggerSummaries({ accountId: otherAccountId,
                workflowDefinitionIds: [artifact.id, ...definitionIds] })).toMatchObject([
                { workflowDefinitionId: artifact.id, nextRunAt: nextRunAt.getTime(), triggers: [{ kind: 'schedule' }] },
            ]);
        } finally {
            await db.artifact.deleteMany({ where: { id: artifactId } });
            await db.team.delete({ where: { id: team.id } });
        }
    });

    it('commits an owner context reseal and Team invalidation through the PostgreSQL publication audience', async () => {
        const team = await db.team.create({ data: { name: 'Reseal audience' } });
        const artifactId = randomUUID();
        const automationId = randomUUID();
        const machineId = randomUUID();
        const triggerId = randomUUID();
        const recipe = (templateVersion: number, kind: 'session' | 'detached_run') => ({ v: 2 as const, templateVersion,
            workflow: { t: 'plain' as const, v: { workspace: { directory: '/private' }, executionTarget: { kind }, visibleTeamId: team.id } },
            visibleTeamId: team.id, triggerEvidence: null });
        try {
            await db.teamMembership.create({ data: { teamId: team.id, accountId: otherAccountId, role: 'member' } });
            await db.artifact.create({ data: { id: artifactId, accountId,
                header: Buffer.from(encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1' }), 'base64'),
                body: Buffer.from(encodePlainArtifactStoredContent({}), 'base64'),
                dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64') } });
            await db.artifactGrant.create({ data: { principalKind: 'team', artifactId, teamId: team.id, accessLevel: 'edit', createdByAccountId: accountId } });
            await db.machine.create({ data: { id: machineId, accountId, metadata: '{}' } });
            await db.automation.create({ data: { id: automationId, accountId, name: 'Retained Team schedule', enabled: true,
                workflowDefinitionId: artifactId, templateVersion: 8, templateCiphertext: JSON.stringify(recipe(8, 'session')),
                assignments: { create: { machineId, enabled: true } },
                triggers: { create: { id: triggerId, revision: 4, kind: 'schedule', enabled: true, scheduleKind: 'interval',
                    everyMs: 60_000, nextRunAt: new Date('2030-01-01T12:00:00Z') } } } });
            const app = createAuthenticatedTestApp();
            registerAutomationV3Routes(app);
            await app.ready();
            try {
                const response = await app.inject({ method: 'PUT', url: `/v3/automations/${automationId}`,
                    headers: { 'x-test-user-id': accountId }, payload: {
                        expectedTemplateVersion: 8, name: 'Retained Team schedule', description: null, enabled: true,
                        workflowDefinitionId: artifactId, executionRecipe: recipe(9, 'detached_run'), assignments: [{ machineId, enabled: true }],
                        triggers: [{ kind: 'existing', triggerId, expectedRevision: 4 }], removedTriggers: [],
                    } });
                expect(response.statusCode, response.body).toBe(200);
                expect(response.json()).toMatchObject({ templateVersion: 9, executionRecipe: recipe(9, 'detached_run'),
                    triggers: [{ id: triggerId, revision: 4, enabled: true }] });
                expect(await db.accountChange.count({ where: { accountId: otherAccountId, kind: 'artifact', entityId: artifactId } })).toBe(1);
            } finally { await app.close(); }
        } finally {
            await db.automation.deleteMany({ where: { id: automationId } });
            await db.artifact.deleteMany({ where: { id: artifactId } });
            await db.machine.deleteMany({ where: { id: machineId } });
            await db.team.delete({ where: { id: team.id } });
        }
    });

    it("pages only requested definition rows and retains Account and deletion admission", async () => {
        const selection = { accountId, workflowDefinitionIds: definitionIds };
        const rows: string[] = [];
        let cursor: string | null = null;
        let pages = 0;
        do {
            const page = await listAutomationDefinitionsPage({ ...selection, cursor });
            pages += 1;
            rows.push(...page.automations.map(row => row.id));
            cursor = page.nextCursor;
        } while (cursor);
        expect({ rows: rows.length, pages }).toEqual({ rows: 2, pages: 1 });
        expect(rows.sort()).toEqual([...selectedIds].sort());
        const empty = { accountId, workflowDefinitionIds: [] };
        expect(await listAutomationDefinitionsPage(empty)).toEqual({ automations: [], nextCursor: null });
    });


    it('selects the exact managed target and only unknown fallback in one page at scale', async () => {
        const exact = await listAutomationDefinitionsPage({ accountId, managedTarget });
        expect(exact.automations.map(row => row.id)).toEqual([managedId]);
        expect(exact.nextCursor).toBeNull();
        const fallback = await listAutomationDefinitionsPage({ accountId, managedTarget, includeUnindexedManagedTargets: true });
        expect(fallback.automations.map(row => row.id).sort()).toEqual([managedId, unknownId].sort());
        expect(fallback.nextCursor).toBeNull();
        const unknown = await listAutomationDefinitionsPage({ accountId, managedTargetUnindexed: true });
        expect(unknown.automations.map(row => row.id)).toEqual([unknownId]);
    });

    it("carries set demand through the body-bearing HTTP read without dropping its filter", async () => {
        const app = createAuthenticatedTestApp();
        registerAutomationV3Routes(app);
        await app.ready();
        try {
            const demand = [...definitionIds, ...Array.from({ length: 498 }, () => randomUUID())];
            const response = await app.inject({ method: "POST", url: "/v3/automations/query",
                headers: { "x-test-user-id": accountId }, payload: { workflowDefinitionIds: demand } });
            expect(response.statusCode, response.body).toBe(200);
            const page = AutomationDefinitionListResponseSchema.parse(response.json());
            expect(page.automations.map(row => row.id).sort()).toEqual([...selectedIds].sort());
            expect(page.nextCursor).toBeNull();
            const oversized = await app.inject({ method: "POST", url: "/v3/automations/query",
                headers: { "x-test-user-id": accountId }, payload: { workflowDefinitionIds: [...demand, randomUUID()] } });
            expect(oversized.statusCode).toBe(400);
            const denied = await app.inject({ method: "POST", url: "/v3/automations/query",
                headers: { "x-test-user-id": accountId, "x-test-auth-token-kind": "api_token" },
                payload: { workflowDefinitionIds: definitionIds } });
            expect(denied.statusCode).toBe(403);
        } finally { await app.close(); }
    });

    it('backfills structurally unrelated retained rows without inspecting opaque Workflow content', async () => {
        const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        const row = (id: string) => ({ id, accountId, name: 'Migration fixture', templateVersion: 1,
            templateCiphertext: '{}', managedTargetIndexed: false });
        await db.automation.createMany({ data: [
            { ...row(ids[0]!), targetType: 'new_session' },
            { ...row(ids[1]!), templateCiphertext: '{"kind":"observationOnly","templateVersion":1}' },
            row(ids[2]!),
            { ...row(ids[3]!), templateCiphertext: '{"kind":"observationOnly","templateVersion":2}' },
        ] });
        const sql = readFileSync(new URL('../../../prisma/migrations/20261026111000_automation_managed_target/migration.sql', import.meta.url), 'utf8');
        const backfill = sql.match(/UPDATE "Automation"[\s\S]*?;/)?.[0];
        expect(backfill).toBeDefined();
        await db.$executeRawUnsafe(backfill!);
        await db.$executeRawUnsafe(backfill!);
        const rows = await db.automation.findMany({ where: { id: { in: ids } }, select: { id: true, managedTargetIndexed: true } });
        expect(rows.filter(row => row.managedTargetIndexed).map(row => row.id).sort()).toEqual(ids.slice(0, 2).sort());
    });

    it('recipe-only backfill preserves a newer metadata edit and every assignment and trigger', async () => {
        const machineId = randomUUID();
        await db.machine.create({ data: { id: machineId, accountId, metadata: '{}' } });
        const recipe = (templateVersion: number) => createAutomationWorkflowRecipeFixture({ templateVersion, directory: '/private', prompt: 'private' });
        const triggerId = AutomationTriggerIdSchema.parse(randomUUID());
        const created = await createAutomation({ accountId, input: {
            automationId: randomUUID(), name: 'Before', enabled: false, executionRecipe: recipe(1),
            assignments: [{ machineId, enabled: true, priority: 3 }],
            triggers: [{ triggerId, trigger: { kind: 'schedule', enabled: true,
                schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } } }],
        } });
        const renamed = await updateAutomation({ accountId, automationId: created.id, expectedTemplateVersion: 1,
            input: { name: 'Renamed', enabled: true } });
        expect(renamed?.templateVersion).toBe(1);
        const managedTarget = { homeId: 'backfill-home', managedId: 'backfill-managed' };
        const patched = await updateAutomation({ accountId, automationId: created.id, expectedTemplateVersion: 1,
            input: { executionRecipe: { ...recipe(2), managedTarget } } });
        expect(patched).toMatchObject({ name: 'Renamed', enabled: true, templateVersion: 2,
            managedTargetIndexed: true, managedTargetHomeId: managedTarget.homeId, managedTargetManagedId: managedTarget.managedId });
        expect(patched?.assignments).toEqual(renamed?.assignments);
        expect(patched?.triggers.map(trigger => ({ id: trigger.id, revision: trigger.revision, enabled: trigger.enabled })))
            .toEqual([{ id: triggerId, revision: 0, enabled: true }]);
        await expect(updateAutomation({ accountId, automationId: created.id, expectedTemplateVersion: 1,
            input: { executionRecipe: { ...recipe(2), managedTarget: null } } })).rejects.toThrow();
    });
});
