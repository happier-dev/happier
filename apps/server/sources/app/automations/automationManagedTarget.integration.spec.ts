import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS, AutomationDefinitionDetailSchema,
    AutomationDefinitionListResponseSchema, AutomationDefinitionDetailsRequestSchema,
    AutomationDefinitionDetailsResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { backfillAutomationManagedTargetsV1 } from '@happier-dev/protocol/actions/executor/workflowTriggerAccountHost';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAutomationWorkflowRecipeFixture } from '@/testkit/automationWorkflowRecipe';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerAutomationV3Routes } from '@/app/api/routes/automations/registerAutomationV3Routes';
import { createAutomation, updateAutomation, reconcileAutomationDefinition, listAutomationDefinitionsPage } from './automationCrudService';
import { toAutomationDefinitionListItemApiDto } from './automationApiProjection';

/** Real route/SQLite boundary beneath the shared migration, codec and recipe CAS. */
async function createManagedTargetBackfillBoundary(app: FastifyInstance) {
    const accountId = (await db.account.create({ data: { encryptionMode: 'plain' } })).id;
    // Two full canonical pages and a two-row tail make omissions and repeated
    // final writes visible; every row starts unknown, not already indexed.
    const ids = Array.from({ length: AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS * 2 + 2 }, () => randomUUID()).sort();
    const recipe = createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/private/backfill', prompt: 'Retained content' });
    await db.automation.createMany({ data: ids.map(id => ({ id, accountId, name: 'Retained definition', enabled: false,
        templateVersion: 1, templateCiphertext: JSON.stringify(recipe), managedTargetIndexed: false,
        createdAt: new Date(1), updatedAt: new Date(1) })) });
    const lists: Array<{ cursor?: string; nextCursor: string | null; ids: string[] }> = [];
    const attempts: string[] = [];
    const writes: string[] = [];
    let conflictId: string | undefined;
    const lostAcknowledgements = new Set<string>();
    const headers = { 'x-test-user-id': accountId };
    const automations: Parameters<typeof backfillAutomationManagedTargetsV1>[0]['automations'] = {
        listDetails: async input => {
            const query = AutomationDefinitionDetailsRequestSchema.parse({ ...input, details: true });
            const previous = lists.at(-1);
            // This is a request-cost contract: each pass consumes the previous
            // server-issued continuation once, including after a row conflict.
            const response = await app.inject({ method: 'POST', url: '/v3/automations/query', headers, payload: query });
            expect(response.statusCode, response.body).toBe(200);
            const page = AutomationDefinitionDetailsResponseSchema.parse(response.json());
            lists.push({ ...(query.cursor ? { cursor: query.cursor } : {}), nextCursor: page.nextCursor,
                ids: page.automations.map(row => row.id) });
            if (previous && previous.nextCursor !== null) expect(query.cursor).toBe(previous.nextCursor);
            return page;
        },
        patch: async (id, input, beforeWrite) => {
            await beforeWrite?.();
            attempts.push(id);
            if (id === conflictId) {
                // A real intervening recipe write advances CAS and updatedAt.
                // The stale migration must leave it unknown until a new pass.
                await updateAutomation({ accountId, automationId: id, expectedTemplateVersion: 1,
                    input: { executionRecipe: createAutomationWorkflowRecipeFixture({ templateVersion: 2,
                        directory: '/private/backfill', prompt: 'Concurrent retained content' }) } });
            }
            const response = await app.inject({ method: 'PATCH', url: `/v3/automations/${id}`, headers, payload: input });
            if (response.statusCode === 409) throw Object.assign(new Error('Recipe CAS conflict'), { code: 'currentness_conflict' });
            expect(response.statusCode, response.body).toBe(200);
            const row = AutomationDefinitionDetailSchema.parse(response.json());
            writes.push(id);
            if (lostAcknowledgements.has(id)) throw Object.assign(new Error('Write acknowledgement lost'), { code: 'workflow_outcome_unresolved' });
            return row;
        },
    };
    return { accountId, ids, lists, attempts, writes,
        params: { automations, resolveEncryption: async () => ({ kind: 'available' as const,
            witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null } }),
            randomBytes: (length: number) => new Uint8Array(length).fill(3) },
        conflictOn(id: string | undefined) { conflictId = id; },
        loseAcknowledgementsFor(ids: readonly string[]) { lostAcknowledgements.clear(); ids.forEach(id => lostAcknowledgements.add(id)); },
    };
}

describe('managed Automation target custody (SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'automgt1-' }); });
    afterAll(async () => { await harness?.close(); });

    it('pages all unknown definitions through real cursors once and writes zero on the second startup', async () => {
        await withAuthenticatedTestApp(app => registerAutomationV3Routes(app), async app => {
            const f = await createManagedTargetBackfillBoundary(app);
            expect(await backfillAutomationManagedTargetsV1(f.params)).toEqual({ updated: f.ids.length, unresolved: 0 });
            expect(f.lists.map(page => page.ids.length)).toEqual([100, 100, 2]);
            expect(f.lists.flatMap(page => page.ids)).toEqual(f.ids);
            expect(f.attempts).toEqual(f.ids);
            expect(f.writes).toEqual(f.ids);
            expect(new Set(f.writes).size).toBe(f.ids.length);
            const persisted = await db.automation.findMany({ where: { accountId: f.accountId }, orderBy: { id: 'asc' },
                select: { id: true, templateVersion: true, managedTargetIndexed: true } });
            expect(persisted).toEqual(f.ids.map(id => ({ id, templateVersion: 2, managedTargetIndexed: true })));
            expect(await backfillAutomationManagedTargetsV1(f.params)).toEqual({ updated: 0, unresolved: 0 });
            expect(f.lists.at(-1)?.ids).toEqual([]);
            expect(f.lists).toHaveLength(4);
            expect(f.attempts).toEqual(f.ids);
            expect(f.writes).toEqual(f.ids);
        });
    });

    it('continues past a real CAS conflict without revisiting a page and resumes lost final acknowledgements without repeat writes', async () => {
        await withAuthenticatedTestApp(app => registerAutomationV3Routes(app), async app => {
            const f = await createManagedTargetBackfillBoundary(app);
            // The conflict is the first page's cursor anchor. Both final rows
            // commit, but the client receives neither acknowledgement.
            const conflicted = f.ids[AUTOMATION_V3_DEFINITION_LIST_MAX_ITEMS - 1]!;
            const tail = f.ids.slice(-2);
            f.conflictOn(conflicted);
            f.loseAcknowledgementsFor(tail);
            expect(await backfillAutomationManagedTargetsV1(f.params)).toEqual({ updated: f.ids.length - 3, unresolved: 3 });
            expect(f.lists.map(page => page.ids.length)).toEqual([100, 100, 2]);
            expect(f.lists.flatMap(page => page.ids)).toEqual(f.ids);
            expect(f.attempts).toEqual(f.ids);
            expect(f.writes).toEqual(f.ids.filter(id => id !== conflicted));
            expect(await db.automation.count({ where: { accountId: f.accountId, managedTargetIndexed: false } })).toBe(1);
            expect(await db.automation.findUnique({ where: { id: conflicted }, select: { templateVersion: true,
                managedTargetIndexed: true } })).toEqual({ templateVersion: 2, managedTargetIndexed: false });
            expect(await db.automation.findMany({ where: { accountId: f.accountId, id: { in: tail } }, orderBy: { id: 'asc' },
                select: { id: true, templateVersion: true, managedTargetIndexed: true } }))
                .toEqual(tail.map(id => ({ id, templateVersion: 2, managedTargetIndexed: true })));
            f.conflictOn(undefined);
            f.loseAcknowledgementsFor([]);
            expect(await backfillAutomationManagedTargetsV1(f.params)).toEqual({ updated: 1, unresolved: 0 });
            expect(f.attempts).toEqual([...f.ids, conflicted]);
            expect(f.writes).toEqual([...f.ids.filter(id => id !== conflicted), conflicted]);
            expect(new Set(f.writes).size).toBe(f.ids.length);
            expect(tail.map(id => f.writes.filter(written => written === id).length)).toEqual([1, 1]);
            expect(await backfillAutomationManagedTargetsV1(f.params)).toEqual({ updated: 0, unresolved: 0 });
            expect(f.lists.slice(3).map(page => page.ids)).toEqual([[conflicted], []]);
            expect(f.attempts).toHaveLength(f.ids.length + 1);
            expect(f.writes).toHaveLength(f.ids.length);
            expect(await db.automation.findMany({ where: { accountId: f.accountId }, orderBy: { id: 'asc' },
                select: { id: true, templateVersion: true, managedTargetIndexed: true } }))
                .toEqual(f.ids.map(id => ({ id, templateVersion: id === conflicted ? 3 : 2, managedTargetIndexed: true })));
        });
    });

    it('selects one target plus unknown fallback among 1,000 indexed unrelated rows through the real route', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const managedTarget = { homeId: 'home-1', managedId: 'managed-1' };
        const selectedId = randomUUID();
        const unknownId = randomUUID();
        const recipe = createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/private/path', prompt: 'private content' });
        const row = (id: string, owner = account.id) => ({ id, accountId: owner, name: 'Fixture',
            templateCiphertext: JSON.stringify(recipe), managedTargetIndexed: true,
            managedTargetHomeId: 'unrelated-home', managedTargetManagedId: 'unrelated-managed' });
        await db.automation.createMany({ data: [
            ...Array.from({ length: 1000 }, () => row(randomUUID())),
            { ...row(selectedId), scopeSessionId: 'session-source', managedTargetHomeId: managedTarget.homeId, managedTargetManagedId: managedTarget.managedId },
            { ...row(unknownId), managedTargetIndexed: false, managedTargetHomeId: null, managedTargetManagedId: null },
            { ...row(randomUUID(), other.id), managedTargetHomeId: managedTarget.homeId, managedTargetManagedId: managedTarget.managedId },
            { ...row(randomUUID()), managedTargetHomeId: managedTarget.homeId, managedTargetManagedId: managedTarget.managedId, deletedAt: new Date() },
        ] });
        await withAuthenticatedTestApp(app => registerAutomationV3Routes(app), async app => {
            const read = async (payload: object) => {
                const response = await app.inject({ method: 'POST', url: '/v3/automations/query', headers: { 'x-test-user-id': account.id }, payload });
                expect(response.statusCode, response.body).toBe(200);
                return AutomationDefinitionListResponseSchema.parse(response.json());
            };
            const page = await read({ managedTarget, includeUnindexedManagedTargets: true });
            expect(page.automations.map(item => item.id).sort()).toEqual([selectedId, unknownId].sort());
            expect(page.nextCursor).toBeNull();
            expect(page.automations.find(item => item.id === selectedId)).toMatchObject({ managedTarget });
            expect(page.automations.find(item => item.id === unknownId)).not.toHaveProperty('managedTarget');
            for (const item of page.automations) expect(item).not.toHaveProperty('executionRecipe');
            expect((await read({ managedTargetUnindexed: true })).automations.map(item => item.id)).toEqual([unknownId]);
            const first = await read({ managedTarget, includeUnindexedManagedTargets: true, limit: 1 });
            const second = await read({ managedTarget, includeUnindexedManagedTargets: true, limit: 1, cursor: first.nextCursor });
            expect([...first.automations, ...second.automations].map(item => item.id).sort()).toEqual([selectedId, unknownId].sort());
            expect(second.nextCursor).toBeNull();
            for (const payload of [{ includeUnindexedManagedTargets: true }, { managedTarget, scopeSessionId: 'session' }, { managedTargte: managedTarget }]) {
                const response = await app.inject({ method: 'POST', url: '/v3/automations/query', headers: { 'x-test-user-id': account.id }, payload });
                expect(response.statusCode).toBe(400);
            }
        });
    });

    it('marks only structurally unrelated retained definitions as known during the migration', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const legacyId = randomUUID();
        const observationId = randomUUID();
        const opaqueId = randomUUID();
        const malformedId = randomUUID();
        const row = (id: string) => ({ id, accountId: account.id, name: 'Migration fixture',
            templateVersion: 1, templateCiphertext: '{}', managedTargetIndexed: false });
        await db.automation.createMany({ data: [
            { ...row(legacyId), targetType: 'new_session' },
            { ...row(observationId), templateCiphertext: '{"kind":"observationOnly","templateVersion":1}' },
            { ...row(opaqueId), templateCiphertext: JSON.stringify(createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/private', prompt: 'private' })) },
            { ...row(malformedId), templateCiphertext: '{"kind":"observationOnly","templateVersion":2}' },
        ] });
        const sql = readFileSync(new URL('../../../prisma/sqlite/migrations/20261026111000_automation_managed_target/migration.sql', import.meta.url), 'utf8');
        const backfill = sql.match(/UPDATE "Automation"[\s\S]*?;/)?.[0];
        expect(backfill).toBeDefined();
        await db.$executeRawUnsafe(backfill!);
        await db.$executeRawUnsafe(backfill!);
        const unknown = await listAutomationDefinitionsPage({ accountId: account.id, managedTargetUnindexed: true });
        expect(unknown.automations.map(item => item.id).sort()).toEqual([opaqueId, malformedId].sort());
    });

    it('keeps relationship writes inside recipe CAS and preserves old-client rewrites as unknown', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const managedTarget = { homeId: 'home-cas', managedId: 'managed-cas' };
        const recipe = (templateVersion: number) => createAutomationWorkflowRecipeFixture({ templateVersion, directory: '/private/path', prompt: 'private content' });
        const input = { automationId: randomUUID(), name: 'Custody', enabled: false, assignments: [], triggers: [],
            executionRecipe: { ...recipe(1), managedTarget } };
        const created = await createAutomation({ accountId: account.id, input });
        expect(toAutomationDefinitionListItemApiDto(created)).toMatchObject({ managedTarget });
        expect((await createAutomation({ accountId: account.id, input })).templateVersion).toBe(1);
        const legacyRewrite = await updateAutomation({ accountId: account.id, automationId: created.id,
            expectedTemplateVersion: 1, input: { executionRecipe: recipe(2) } });
        expect(legacyRewrite).toMatchObject({ managedTargetIndexed: false, managedTargetHomeId: managedTarget.homeId, managedTargetManagedId: managedTarget.managedId });
        expect(toAutomationDefinitionListItemApiDto(legacyRewrite!)).not.toHaveProperty('managedTarget');
        expect((await listAutomationDefinitionsPage({ accountId: account.id, managedTarget })).automations).toEqual([]);
        expect((await listAutomationDefinitionsPage({ accountId: account.id, managedTarget, includeUnindexedManagedTargets: true })).automations.map(item => item.id)).toEqual([created.id]);
        await expect(updateAutomation({ accountId: account.id, automationId: created.id,
            expectedTemplateVersion: 1, input: { executionRecipe: { ...recipe(2), managedTarget: null } } })).rejects.toThrow();
        const current = await reconcileAutomationDefinition({ accountId: account.id, automationId: created.id, input: {
            expectedTemplateVersion: 2, name: 'Custody', description: null, enabled: false, assignments: [], triggers: [], removedTriggers: [],
            executionRecipe: { ...recipe(3), managedTarget: null },
        } });
        expect(current).toMatchObject({ managedTargetIndexed: true, managedTargetHomeId: null, managedTargetManagedId: null });
        expect(toAutomationDefinitionListItemApiDto(current!)).toHaveProperty('managedTarget', null);
        expect((await listAutomationDefinitionsPage({ accountId: account.id, managedTargetUnindexed: true })).automations).toEqual([]);
        const replacement = { homeId: 'home-next', managedId: 'managed-next' };
        const replaced = await updateAutomation({ accountId: account.id, automationId: created.id,
            expectedTemplateVersion: 3, input: { executionRecipe: { ...recipe(4), managedTarget: replacement } } });
        expect(toAutomationDefinitionListItemApiDto(replaced!)).toMatchObject({ managedTarget: replacement });
    });

    it('recipe-only backfill preserves a newer metadata edit and every assignment and trigger', async () => {
        const accountId = (await db.account.create({ data: { encryptionMode: 'plain' } })).id;
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
