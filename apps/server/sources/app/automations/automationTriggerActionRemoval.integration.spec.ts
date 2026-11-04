import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { createWorkflowActionExecutor } from '@happier-dev/protocol/actions/executor/workflowAccountActions';
import { createWorkflowDefinitionActions } from '@happier-dev/protocol/actions/executor/workflowDefinitions';
import { createAccountWorkflowTriggerActions } from '@happier-dev/protocol/actions/executor/workflowTriggerAccountHost';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAutomationWorkflowRecipeFixture } from '@/testkit/automationWorkflowRecipe';
import { createAutomation, deleteAutomation, getAutomation, listAutomations, listAutomationDefinitionsPage,
    reconcileAutomationDefinition, runAutomationNow, updateAutomation } from './automationCrudService';
import { toAutomationDefinitionDetailApiDto, toAutomationDefinitionListItemApiDto } from './automationApiProjection';

describe('Workflow trigger removal through the Action and retained SQLite owners', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-trigger-action-removal-' });
    }, 120_000);
    afterAll(async () => { await harness.close(); });

    const witness = { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
    function executor(accountId: string, beforeDelete?: () => Promise<void>) {
        // These adapters replace HTTP with the same Account-scoped storage owners.
        // Account crypto, trigger semantics, Action policy and result parsing stay real.
        const triggers = createAccountWorkflowTriggerActions({
            resolveEncryption: async () => ({ kind: 'available', witness }),
            randomBytes, newId: randomUUID,
            resolveWorkflow: async () => { throw new Error('No Artifact reference in this fixture'); },
            automations: {
                listDetails: async input => {
                    const page = await listAutomationDefinitionsPage({ accountId, ...input, details: true });
                    return { automations: page.automations.map(row => toAutomationDefinitionDetailApiDto(row, witness)),
                        nextCursor: page.nextCursor };
                },
                list: async () => ({ automations: (await listAutomations({ accountId }))
                    .map(row => toAutomationDefinitionListItemApiDto(row)), nextCursor: null }),
                get: async (automationId) => {
                    const row = await getAutomation({ accountId, automationId });
                    return row ? toAutomationDefinitionDetailApiDto(row, witness) : null;
                },
                create: async (input) => toAutomationDefinitionDetailApiDto(await createAutomation({ accountId, input }), witness),
                reconcile: async (automationId, input) => {
                    const row = await reconcileAutomationDefinition({ accountId, automationId, input });
                    if (!row) throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
                    return toAutomationDefinitionDetailApiDto(row, witness);
                },
                delete: async (automationId) => {
                    await beforeDelete?.();
                    const deleted = await deleteAutomation({ accountId, automationId });
                    if (!deleted) {
                        throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
                    }
                    return { ok: true, removedRevision: deleted.removedRevision };
                },
            },
        });
        const unusedArtifact = async (): Promise<never> => { throw new Error('Unexpected Artifact transport'); };
        const definitions = createWorkflowDefinitionActions({ artifactStore: {
            read: unusedArtifact, list: unusedArtifact, create: unusedArtifact, update: unusedArtifact, delete: unusedArtifact,
        }, encodeListCursor: row => row.artifactId, assertDefinitionWriteAllowed: unusedArtifact });
        // This fixture binds only Workflow transport; unrelated external host ports are never invoked.
        return createActionExecutor({ workflowAction: createWorkflowActionExecutor({
            isWorkflowFeatureEnabled: () => true, definitions, triggers,
            runs: { execute: async () => { throw new Error('Unexpected Run Action'); } },
        }) } as ActionExecutorDeps);
    }

    async function fixture(withTrigger = false) {
        const account = await db.account.create({ data: { id: randomUUID(), encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: '{}' } });
        const triggerId = AutomationTriggerIdSchema.parse(randomUUID());
        const automation = await createAutomation({ accountId: account.id, input: {
            automationId: randomUUID(), name: 'Retained Manual', enabled: true,
            executionRecipe: createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/tmp', prompt: 'READY' }),
            assignments: [{ machineId: machine.id }],
            triggers: withTrigger ? [{ triggerId, trigger: { kind: 'schedule', enabled: true,
                schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } } }] : [],
        } });
        return { accountId: account.id, automationId: automation.id, triggerId };
    }

    const human = { surface: 'ui' as const, authority: 'present_user' as const };
    it('forwards the actual removed revision when the Action pre-read saw an older set', async () => {
        const f = await fixture();
        await db.automation.update({ where: { id: f.automationId }, data: { templateVersion: 10,
            templateCiphertext: JSON.stringify(createAutomationWorkflowRecipeFixture({ templateVersion: 10, directory: '/tmp', prompt: 'READY' })) } });
        const action = executor(f.accountId, async () => {
            await db.automation.update({ where: { id: f.automationId }, data: { templateVersion: 11,
                templateCiphertext: JSON.stringify(createAutomationWorkflowRecipeFixture({ templateVersion: 11, directory: '/tmp', prompt: 'READY' })) } });
        });
        expect(await action.execute('workflow.trigger.remove', { automationId: f.automationId }, human))
            .toEqual({ ok: true, result: { automationId: f.automationId, deleted: true, removedRevision: 11 } });
        expect(await getAutomation({ accountId: f.accountId, automationId: f.automationId })).toBeNull();
    });
    it('deletes a disabled empty Manual set while keeping its historical Run and unrelated set', async () => {
        const f = await fixture();
        const run = await runAutomationNow({ accountId: f.accountId, automationId: f.automationId });
        if (!run) throw new Error('Expected retained Automation Run');
        const live = await updateAutomation({ accountId: f.accountId, automationId: f.automationId, input: { enabled: false } });
        const before = await db.automationRun.findUniqueOrThrow({ where: { id: run.id } });
        const unrelated = await fixture();
        expect(await executor(f.accountId).execute('workflow.trigger.remove', { automationId: f.automationId }, human))
            .toEqual({ ok: true, result: { automationId: f.automationId, deleted: true, removedRevision: live!.templateVersion } });
        expect(await getAutomation({ accountId: f.accountId, automationId: f.automationId })).toBeNull();
        expect(await listAutomations({ accountId: f.accountId })).toEqual([]);
        expect(await db.automation.findUniqueOrThrow({ where: { id: f.automationId } }))
            .toMatchObject({ enabled: false, deletedAt: expect.any(Date) });
        expect(await db.automationAssignment.count({ where: { automationId: f.automationId } })).toBe(0);
        expect(await db.automationRun.findUniqueOrThrow({ where: { id: run.id } })).toEqual(before);
        expect(await getAutomation({ accountId: unrelated.accountId, automationId: unrelated.automationId })).not.toBeNull();
    });

    it('preserves the last-child removal contract and refuses a foreign Account before whole-set deletion', async () => {
        const f = await fixture(true);
        const stranger = await fixture();
        expect(await executor(stranger.accountId).execute('workflow.trigger.remove', { automationId: f.automationId }, human))
            .toMatchObject({ ok: false, errorCode: 'content_unavailable' });
        expect((await getAutomation({ accountId: f.accountId, automationId: f.automationId }))?.triggers).toHaveLength(1);
        expect(await executor(f.accountId).execute('workflow.trigger.remove', {
            automationId: f.automationId, triggerId: f.triggerId,
        }, human)).toMatchObject({ ok: true, result: { set: { automationId: f.automationId, triggers: [] } } });
        expect(await getAutomation({ accountId: f.accountId, automationId: f.automationId })).not.toBeNull();
    });

    it('keeps whole-set removal behind the existing mandatory Agent approval gate', async () => {
        const f = await fixture();
        expect(await executor(f.accountId).execute('workflow.trigger.remove', { automationId: f.automationId }, {
            surface: 'mcp', actionCaller: { kind: 'session', sessionId: 'driver', starterDepth: 0, turnDepth: 0 },
        })).toMatchObject({ ok: false, errorCode: 'approvals_not_supported' });
        expect(await getAutomation({ accountId: f.accountId, automationId: f.automationId })).not.toBeNull();
    });

    it('refuses a Session-scoped set at the Account removal boundary', async () => {
        const f = await fixture();
        const session = await db.session.create({ data: { id: randomUUID(), tag: randomUUID(),
            accountId: f.accountId, encryptionMode: 'plain', metadata: '{}' } });
        await db.automation.update({ where: { id: f.automationId }, data: { scopeSessionId: session.id } });
        expect(await executor(f.accountId).execute('workflow.trigger.remove', { automationId: f.automationId }, human))
            .toMatchObject({ ok: false, errorCode: 'content_unavailable' });
        expect(await getAutomation({ accountId: f.accountId, automationId: f.automationId })).not.toBeNull();
    });
});
