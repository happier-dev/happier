import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { AutomationDefinitionCreateRequestSchema, AutomationTriggerIdSchema } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { createAutomationWorkflowRecipeFixture } from '@/testkit/automationWorkflowRecipe';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAutomation, reconcileAutomationDefinition, updateAutomation } from './automationCrudService';
import { AutomationValidationError } from './automationValidation';

let harness: LightSqliteHarness;
beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'consent-definition-', initEncrypt: true }); }, 180_000);
afterAll(async () => { await harness?.close(); });

it('persists enabled consent without Machine assignments across create, pause/resume and editor save', async () => {
    const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
    const triggerId = AutomationTriggerIdSchema.parse(randomUUID());
    const consentFor = { automationId: randomUUID(), triggerId: AutomationTriggerIdSchema.parse(randomUUID()) };
    const input = AutomationDefinitionCreateRequestSchema.parse({
        automationId: randomUUID(), name: 'Actor consent', enabled: true,
        executionRecipe: createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/repo', prompt: 'Check' }),
        assignments: [], triggers: [{ triggerId, trigger: {
            kind: 'action', enabled: true, consentFor, consentedWorkflowRevision: 1,
        } }],
    });
    const created = await createAutomation({ accountId: actor.id, input });
    expect(created).toMatchObject({ enabled: true, assignments: [] });
    expect(await updateAutomation({ accountId: actor.id, automationId: created.id, input: { enabled: false } }))
        .toMatchObject({ enabled: false, assignments: [] });
    const resumed = await updateAutomation({ accountId: actor.id, automationId: created.id, input: { enabled: true } });
    expect(resumed).toMatchObject({ enabled: true, assignments: [] });
    if (!resumed) throw new Error('Consent definition unavailable');
    const trigger = resumed.triggers.find(row => row.id === triggerId);
    if (!trigger) throw new Error('Consent trigger unavailable');
    expect(await reconcileAutomationDefinition({ accountId: actor.id, automationId: created.id, input: {
        expectedTemplateVersion: resumed.templateVersion, name: resumed.name, description: resumed.description,
        enabled: true, assignments: [], triggers: [{ kind: 'existing', triggerId, expectedRevision: trigger.revision }],
        removedTriggers: [],
    } })).toMatchObject({ enabled: true, assignments: [] });
    const persisted = await db.automation.findUniqueOrThrow({ where: { id: created.id },
        include: { assignments: true, triggers: true } });
    expect(persisted).toMatchObject({ enabled: true, assignments: [], triggers: [{
        consentForAutomationId: consentFor.automationId, consentForTriggerId: consentFor.triggerId,
    }] });
    // A consent reference cannot exempt an ordinary sibling from execution placement.
    await expect(createAutomation({ accountId: actor.id, input: AutomationDefinitionCreateRequestSchema.parse({
        ...input, automationId: randomUUID(), triggers: [...input.triggers.map(row => ({ ...row, triggerId: randomUUID() })), {
            triggerId: randomUUID(), trigger: { kind: 'action', enabled: true, phase: 'before', mode: 'wait',
                onFailure: 'ask', actionIds: ['machines.command.run'] },
        }],
    }) })).rejects.toBeInstanceOf(AutomationValidationError);
});
