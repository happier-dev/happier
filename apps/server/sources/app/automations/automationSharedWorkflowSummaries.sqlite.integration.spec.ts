import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { AutomationDefinitionListResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { AutomationStoredWorkflowDefinitionRecipeV2Schema } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { deriveAutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerAutomationV3Routes } from '@/app/api/routes/automations/registerAutomationV3Routes';
import { inTx } from '@/storage/inTx';
import { getWorkflowPublicationAudienceInTx } from '@/app/workflows/workflowPublicationAudience';
import { markAutomationChangedTx } from './automationCrudService';
import { applyAutomationRunTerminalEffectsTx } from './automationRunSucceeded';
import { encodeAutomationRunCause } from './automationRunCauseCodec';

describe('Team workflow schedule summaries', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-team-schedules-' }); }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('shows only Team-visible schedules to current Team viewers, retaining private Account details', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const personal = await db.account.create({ data: { encryptionMode: 'plain' } });
        const team = await db.team.create({ data: { name: 'Team workflows' } });
        const member = await db.teamMembership.create({ data: { teamId: team.id, accountId: viewer.id, role: 'member' } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            header: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1' }))),
            body: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({}))),
            dataEncryptionKey: new Uint8Array(privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)) } });
        await db.artifactTeamGrant.create({ data: { artifactId: artifact.id, teamId: team.id, accessLevel: 'edit', createdByAccountId: owner.id } });
        await db.artifactAccountGrant.create({ data: { artifactId: artifact.id, accountId: personal.id, accessLevel: 'edit', createdByAccountId: owner.id } });
        const nextRunAt = new Date('2030-01-01T12:00:00Z');
        const makeSchedule = async (visibleTeamId: string | null) => {
            const recipe = AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({ v: 2, templateVersion: 1,
                workflow: { t: 'plain', v: { workspace: { directory: '/private-owner-workspace' }, executionTarget: { kind: 'session' }, visibleTeamId } }, triggerEvidence: null });
            return db.automation.create({ data: { id: randomUUID(), accountId: owner.id, workflowDefinitionId: artifact.id,
                name: 'Private trigger name', enabled: true, templateCiphertext: JSON.stringify(recipe), templateVersion: 1,
                triggers: { create: { id: randomUUID(), kind: 'schedule', enabled: true, scheduleKind: 'interval', everyMs: 60_000, nextRunAt } } } });
        };
        const shared = await makeSchedule(team.id);
        const sharedTrigger = await db.automationTrigger.findFirstOrThrow({ where: { automationId: shared.id } });
        const privateSchedule = await makeSchedule(null);
        const app = createAuthenticatedTestApp();
        registerAutomationV3Routes(app);
        await app.ready();
        const query = async (accountId: string, details = false) => app.inject({ method: 'POST', url: '/v3/automations/query',
            headers: { 'x-test-user-id': accountId }, payload: { workflowDefinitionIds: [artifact.id], ...(details ? { details: true } : {}) } });
        try {
            const response = await query(viewer.id);
            expect(response.statusCode, response.body).toBe(200);
            const page = AutomationDefinitionListResponseSchema.parse(response.json());
            expect(page).toMatchObject({ automations: [], sharedWorkflowSummaries: [{ workflowDefinitionId: artifact.id,
                nextRunAt: nextRunAt.getTime(), triggers: [{ kind: 'schedule', automationId: shared.id, triggerId: sharedTrigger.id }] }] });
            const serialized = JSON.stringify(page);
            expect(serialized).not.toContain('/private-owner-workspace');
            expect(serialized).not.toContain('Private trigger name');
            expect(serialized).not.toContain(privateSchedule.id);
            expect((await query(viewer.id, true)).json()).toMatchObject({ automations: [] });
            expect((await query(owner.id)).json().automations).toHaveLength(2);
            expect((await query(personal.id)).json().sharedWorkflowSummaries ?? []).toEqual([]);
            const publication = await inTx(tx => getWorkflowPublicationAudienceInTx(tx, {
                accountId: owner.id, automationIds: [shared.id],
            }));
            expect(publication.accountIds).toContain(viewer.id);
            expect(publication.accountIds).not.toContain(personal.id);
            for (const id of [privateSchedule.id, randomUUID()]) {
                const prospective = await inTx(tx => getWorkflowPublicationAudienceInTx(tx, {
                    accountId: owner.id, automationIds: [id], automationDefinitionWrite: { id, accountId: owner.id,
                        workflowDefinitionId: artifact.id, executionRecipe: AutomationStoredWorkflowDefinitionRecipeV2Schema.parse({
                            v: 2, templateVersion: 2, workflow: { t: 'plain', v: { workspace: { directory: '/private' },
                                executionTarget: { kind: 'session' }, visibleTeamId: team.id } }, visibleTeamId: team.id, triggerEvidence: null,
                        }) },
                }));
                expect(prospective.accountIds).toContain(viewer.id);
                expect(prospective.accountIds).not.toContain(personal.id);
            }
            await inTx(tx => markAutomationChangedTx(tx, { accountId: owner.id, automationId: privateSchedule.id }));
            expect(await db.accountChange.count({ where: { accountId: viewer.id, kind: 'artifact', entityId: artifact.id } })).toBe(0);
            await db.account.update({ where: { id: owner.id }, data: { encryptionMode: 'e2ee' } });
            expect((await query(viewer.id)).json().sharedWorkflowSummaries ?? []).toEqual([]);
            // The server reads only the explicit audience metadata, never the encrypted context.
            await db.automation.update({ where: { id: shared.id }, data: { templateCiphertext: JSON.stringify({
                v: 2, templateVersion: 1, workflow: { t: 'encrypted', c: 'opaque-owner-context' },
                visibleTeamId: team.id, triggerEvidence: null,
            }) } });
            expect((await query(viewer.id)).json().sharedWorkflowSummaries).toMatchObject([
                { workflowDefinitionId: artifact.id, nextRunAt: nextRunAt.getTime() },
            ]);
            await inTx(tx => markAutomationChangedTx(tx, { accountId: owner.id, automationId: shared.id }));
            expect(await db.accountChange.count({ where: { accountId: viewer.id, kind: 'artifact', entityId: artifact.id } })).toBe(1);
            expect(await db.accountChange.count({ where: { accountId: personal.id, kind: 'artifact', entityId: artifact.id } })).toBe(0);
            const priorWake = await db.accountChange.findFirstOrThrow({ where: { accountId: viewer.id, kind: 'artifact', entityId: artifact.id } });
            const trigger = await db.automationTrigger.findFirstOrThrow({ where: { automationId: shared.id } });
            const occurrence = await db.automationRun.create({ data: { accountId: owner.id, automationId: shared.id,
                state: 'succeeded', scheduledAt: nextRunAt, dueAt: nextRunAt,
                ...encodeAutomationRunCause({ kind: 'trigger', triggerId: AutomationTriggerIdSchema.parse(trigger.id), triggerKind: 'schedule',
                    triggerRevision: trigger.revision, occurredAt: nextRunAt.getTime(),
                    occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: trigger.id,
                        evidence: { v: 1, kind: 'schedule', scheduledFor: nextRunAt.getTime() } }),
                    evidence: { scheduledFor: nextRunAt.getTime() } }) } });
            await inTx(tx => applyAutomationRunTerminalEffectsTx({ tx, accountId: owner.id, runId: occurrence.id,
                previousState: 'running', state: 'succeeded', now: nextRunAt }));
            const advancedWake = await db.accountChange.findFirstOrThrow({ where: { accountId: viewer.id, kind: 'artifact', entityId: artifact.id } });
            expect(advancedWake.cursor).toBeGreaterThan(priorWake.cursor);
            expect((await query(viewer.id)).json().sharedWorkflowSummaries).toMatchObject([
                { workflowDefinitionId: artifact.id, nextRunAt: nextRunAt.getTime() + 60_000 },
            ]);
            await db.teamMembership.update({ where: { id: member.id }, data: { status: 'suspended' } });
            expect((await query(viewer.id)).json().sharedWorkflowSummaries ?? []).toEqual([]);
            await db.teamMembership.update({ where: { id: member.id }, data: { status: 'active' } });
            await db.artifactTeamGrant.delete({ where: { artifactId_teamId: { artifactId: artifact.id, teamId: team.id } } });
            expect((await query(viewer.id)).json().sharedWorkflowSummaries ?? []).toEqual([]);
        } finally { await app.close(); }
    });
});
