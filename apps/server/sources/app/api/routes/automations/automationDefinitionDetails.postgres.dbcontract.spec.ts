import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { withAuthenticatedTestApp } from '../../testkit/sqliteFastify';
import { automationRoutes } from './automationRoutes';
import { AUTOMATION_TEMPLATE_V02_PLAIN } from '@happier-dev/protocol/testing/accountScopedCipherFixtures';
import { AutomationDefinitionDetailsResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { serializeAutomationStoredWorkflowDefinitionRecipeV2 } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Automation private detail query on Postgres', () => {
    const previousFeature = process.env.HAPPIER_FEATURE_AUTOMATIONS__ENABLED;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('An isolated Postgres contract database is required');
        }
        initDbPostgres();
        await db.$connect();
        process.env.HAPPIER_FEATURE_AUTOMATIONS__ENABLED = '1';
    });
    afterAll(async () => {
        await db.$disconnect();
        if (previousFeature === undefined) delete process.env.HAPPIER_FEATURE_AUTOMATIONS__ENABLED;
        else process.env.HAPPIER_FEATURE_AUTOMATIONS__ENABLED = previousFeature;
    });

    it('reads seventy private definitions in one Account-filtered query and preserves public-list privacy', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        const rows = await Promise.all(Array.from({ length: 70 }, (_, index) => db.automation.create({ data: {
            accountId: account.id, name: `Detail ${index}`, targetType: 'new_session',
            templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN,
        } })));
        await db.automation.create({ data: { accountId: foreign.id, name: 'Foreign detail', targetType: 'new_session',
            templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN } });
        const delegate = db.automation;
        const readPage = delegate.findMany;
        const readExact = delegate.findFirst;
        const pages = vi.spyOn(delegate, 'findMany').mockImplementation(readPage);
        const exact = vi.spyOn(delegate, 'findFirst').mockImplementation(readExact);
        try {
            await withAuthenticatedTestApp(automationRoutes, async app => {
                const headers = { 'x-test-user-id': account.id };
                const response = await app.inject({ method: 'POST', url: '/v3/automations/query', headers,
                    payload: { details: true } });
                expect(response.statusCode).toBe(200);
                const page = AutomationDefinitionDetailsResponseSchema.parse(response.json());
                expect(new Set(page.automations.map(row => row.id))).toEqual(new Set(rows.map(row => row.id)));
                expect(page.automations.every(row => row.templateCiphertext === AUTOMATION_TEMPLATE_V02_PLAIN)).toBe(true);
                expect(page.nextCursor).toBeNull();
                expect(pages).toHaveBeenCalledTimes(1);
                expect(exact).not.toHaveBeenCalled();
                const first = await app.inject({ method: 'POST', url: '/v3/automations/query', headers,
                    payload: { details: true, limit: 40 } });
                const firstPage = AutomationDefinitionDetailsResponseSchema.parse(first.json());
                expect(firstPage.automations).toHaveLength(40);
                const second = await app.inject({ method: 'POST', url: '/v3/automations/query', headers,
                    payload: { details: true, limit: 40, cursor: firstPage.nextCursor } });
                const secondPage = AutomationDefinitionDetailsResponseSchema.parse(second.json());
                expect(secondPage.automations).toHaveLength(30);
                expect(secondPage.nextCursor).toBeNull();
                expect(new Set([...firstPage.automations, ...secondPage.automations].map(row => row.id)))
                    .toEqual(new Set(rows.map(row => row.id)));
                expect(pages).toHaveBeenCalledTimes(3);
                expect(exact).not.toHaveBeenCalled();
                const publicPage = await app.inject({ method: 'POST', url: '/v3/automations/query', headers, payload: {} });
                expect(publicPage.statusCode).toBe(200);
                expect(publicPage.json().automations.every((row: Record<string, unknown>) => !('templateCiphertext' in row)
                    && !('executionRecipe' in row))).toBe(true);
                const invalid = await app.inject({ method: 'POST', url: '/v3/automations/query', headers,
                    payload: { details: true, accountId: foreign.id } });
                expect(invalid.statusCode).toBe(400);
            });
        } finally {
            exact.mockRestore(); pages.mockRestore();
            // Prisma's generated delegate caches method properties; restore the real ports too.
            delegate.findMany = readPage;
            delegate.findFirst = readExact;
            await db.automation.deleteMany({ where: { accountId: { in: [account.id, foreign.id] } } });
            await db.account.deleteMany({ where: { id: { in: [account.id, foreign.id] } } });
        }
    });

    it.each(['plain', 'e2ee'] as const)('retains the exact %s detail projection and refuses a mode mismatch before disclosure', async mode => {
        const account = await db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const recipe = (encrypted: boolean) => {
            const result = serializeAutomationStoredWorkflowDefinitionRecipeV2({ v: 2, templateVersion: 1,
                workflow: encrypted ? { t: 'encrypted', c: 'sealed-fixture' } : { t: 'plain', v: {
                    workspace: { directory: '/repo' }, executionTarget: { kind: 'session' },
                } }, triggerEvidence: null });
            if (result.kind !== 'available') throw new Error('The detail fixture must serialize');
            return result.serialized;
        };
        const row = await db.automation.create({ data: { accountId: account.id, name: 'Mode detail', targetType: null,
            templateVersion: 1, templateCiphertext: recipe(mode === 'e2ee') } });
        try {
            await withAuthenticatedTestApp(automationRoutes, async app => {
                const headers = { 'x-test-user-id': account.id };
                const exact = await app.inject({ method: 'GET', url: `/v3/automations/${row.id}`, headers });
                expect(exact.statusCode).toBe(200);
                const batch = await app.inject({ method: 'POST', url: '/v3/automations/query', headers, payload: { details: true } });
                expect(batch.statusCode).toBe(200);
                expect(AutomationDefinitionDetailsResponseSchema.parse(batch.json()).automations).toEqual([exact.json()]);
                await db.automation.update({ where: { id: row.id }, data: { templateCiphertext: recipe(mode !== 'e2ee') } });
                const mismatch = await app.inject({ method: 'POST', url: '/v3/automations/query', headers, payload: { details: true } });
                expect(mismatch.statusCode).toBe(409);
                expect(mismatch.json()).toEqual({ error: 'automation_stored_content_unavailable' });
            });
        } finally {
            await db.automation.delete({ where: { id: row.id } });
            await db.account.delete({ where: { id: account.id } });
        }
    });
});
