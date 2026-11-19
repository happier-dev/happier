import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, MACHINE_PLAIN_DATA_KEY_MARKER,
    encodePlainArtifactStoredContent, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { AutomationDefinitionListResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { AutomationStoredWorkflowDefinitionRecipeV2Schema } from '@happier-dev/protocol/automations/automationWorkflowRecipeV2';
import { deriveAutomationOccurrenceKeyV1 } from '@happier-dev/protocol/automations/automationOccurrenceV1';
import { AutomationTriggerIdSchema } from '@happier-dev/protocol/automations/automationTriggerIdentity';
import { AutomationActionTriggerSchema, projectAutomationActionTriggerStructuralV1, type AutomationActionTrigger } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { sealAutomationTriggerDefinitionStoredEnvelopeV1 } from '@happier-dev/protocol/automations/automationTriggerDefinitionStoredContent';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerAutomationV3Routes } from '@/app/api/routes/automations/registerAutomationV3Routes';
import { inTx } from '@/storage/inTx';
import { getWorkflowPublicationAudienceInTx } from '@/app/workflows/workflowPublicationAudience';
import { markAutomationChangedTx } from './automationCrudService';
import { applyAutomationRunTerminalEffectsTx } from './automationRunSucceeded';
import { encodeAutomationRunCause } from './automationRunCauseCodec';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { setMachineAccessGrantInTx } from '@/app/machines/machineAccess';
import { makeShareEligibleForTest } from '@/testkit/shareEligibility.testkit';

describe('Team workflow schedule summaries', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-team-schedules-' }); }, 180_000);
    afterAll(async () => { await harness?.close(); });

    it('retains selected direct/context admission and count privacy on SQLite without a Team', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain', name: 'Shared check author' } });
        const viewer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const subject = { kind: 'machine' as const, serverId: await getOrCreateServerIdentityId(), machineId: randomUUID() };
        await db.machine.create({ data: { id: subject.machineId, accountId: owner.id,
            metadata: encodePlainMachineStoredContent({ host: 'shared-check-host', platform: 'linux',
                happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: new Uint8Array(privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)),
            installationId: randomUUID() } });
        const grantMachine = () => inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: owner.id,
            machineId: subject.machineId, principal: { kind: 'account' as const, accountId: viewer.id }, level: 'view' }));
        expect(await grantMachine()).toEqual({ kind: 'refused', code: 'principal_ineligible' });
        await makeShareEligibleForTest(owner.id, viewer.id);
        expect(await grantMachine()).toMatchObject({ kind: 'saved' });
        const visibleWorkflowId = randomUUID();
        const deniedWorkflowId = randomUUID();
        const visibleTriggerId = randomUUID();
        const triggerRow = (automationId: string, id: string, overrides: Partial<AutomationActionTrigger> = {}) => {
            const { subject: authoredSubject, ...fields } = { kind: 'action', phase: 'after',
                actionIds: ['session.archive'], subject, ...overrides };
            const definition = AutomationActionTriggerSchema.parse({ ...fields,
                ...(authoredSubject === undefined ? {} : { subject: authoredSubject }) });
            const { actionIds, ...structural } = projectAutomationActionTriggerStructuralV1(definition);
            return { ...structural, reachesOthers: definition.subject !== undefined, id,
                actionId: actionIds.length === 1 ? actionIds[0]! : null,
                actionIdsJson: JSON.stringify(actionIds),
                definitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain',
                    binding: { v: 1, automationId, triggerId: AutomationTriggerIdSchema.parse(id), triggerRevision: 0, triggerKind: 'action' },
                    definition })),
            };
        };
        for (const id of [visibleWorkflowId, deniedWorkflowId]) {
            await db.artifact.create({ data: { id, accountId: owner.id,
                header: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1' }))),
                body: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({ privateSteps: 'not summary evidence' }))),
                dataEncryptionKey: new Uint8Array(privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)) } });
            const automationId = randomUUID();
            await db.automation.create({ data: { id: automationId, accountId: owner.id, workflowDefinitionId: id,
                name: 'Private recipe name', templateCiphertext: 'opaque private context',
                triggers: { create: triggerRow(automationId, id === visibleWorkflowId ? visibleTriggerId : randomUUID()) } } });
        }
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: visibleWorkflowId,
            accountId: viewer.id, accessLevel: 'view', createdByAccountId: owner.id } });
        const privateAutomationId = randomUUID();
        await db.automation.create({ data: { id: privateAutomationId, accountId: owner.id,
            workflowDefinitionId: deniedWorkflowId, name: 'Author-only check', templateCiphertext: 'opaque private context',
            triggers: { create: { ...triggerRow(privateAutomationId, randomUUID()), reachesOthers: false } } } });
        const app = createAuthenticatedTestApp();
        registerAutomationV3Routes(app);
        await app.ready();
        const query = (payload: object) => app.inject({ method: 'POST', url: '/v3/automations/query',
            headers: { 'x-test-user-id': viewer.id }, payload });
        try {
            const direct = await query({ subject });
            expect(direct.statusCode, direct.body).toBe(200);
            expect(direct.json()).toMatchObject({ automations: [], attached: [{ triggerId: visibleTriggerId,
                workflowDefinitionId: visibleWorkflowId, relation: 'direct',
                setUpBy: { accountId: owner.id, displayName: owner.name } }], nextCursor: null, skippedNotSharedCount: 1 });
            expect(direct.body).not.toContain(deniedWorkflowId);
            expect(direct.body).not.toContain('Private recipe name');
            expect(direct.body).not.toContain('opaque private context');
            expect(direct.body).not.toContain('not summary evidence');
            const otherHome = { ...subject, serverId: randomUUID() };
            expect((await query({ subject: otherHome })).json()).toMatchObject({
                automations: [], attached: [], nextCursor: null, skippedNotSharedCount: 0 });
            expect((await query({ subject: otherHome, contextSubjects: [subject] })).json()).toMatchObject({
                attached: [{ triggerId: visibleTriggerId, relation: 'context' }], skippedNotSharedCount: 1 });
            expect((await query({ subject, details: true })).statusCode).toBe(400);
            // The Action-detail read has no synthetic resource. A multi-Action row
            // remains attached, including while disabled; phase is selective.
            const shared = await db.automation.findFirstOrThrow({ where: { workflowDefinitionId: visibleWorkflowId } });
            const multiId = randomUUID();
            await db.automationTrigger.create({ data: { ...triggerRow(shared.id, multiId, { actionIds: ['session.title.set', 'session.archive'] }),
                automationId: shared.id, enabled: false, actionId: null } });
            await db.automationTrigger.create({ data: { ...triggerRow(shared.id, randomUUID(), { phase: 'before', mode: 'notify' }),
                automationId: shared.id } });
            const ownAutomationId = randomUUID();
            const ownTriggerId = randomUUID();
            await db.automation.create({ data: { id: ownAutomationId, accountId: viewer.id,
                name: 'Own unscoped check', templateCiphertext: '{}', triggers: { create: {
                    ...triggerRow(ownAutomationId, ownTriggerId, { subject: undefined }) } } } });
            const selected: string[] = [];
            let cursor: string | null = null;
            do {
                const response = await query({ actionId: 'session.archive', phase: 'after', limit: 1, ...(cursor ? { cursor } : {}) });
                expect(response.statusCode, response.body).toBe(200);
                const page = AutomationDefinitionListResponseSchema.parse(response.json());
                expect(page.skippedNotSharedCount).toBe(0);
                expect(page.attached).toHaveLength(1);
                expect(page.attached![0]!.relation).toBe('direct');
                expect(response.body).not.toContain(deniedWorkflowId);
                expect(response.body).not.toContain('opaque private context');
                selected.push(page.attached![0]!.triggerId);
                cursor = page.nextCursor;
            } while (cursor);
            expect(selected).toEqual([visibleTriggerId, multiId, ownTriggerId].sort());
            expect((await query({ actionId: 'session.archive', phase: 'after', subject })).statusCode).toBe(400);
            expect((await query({ actionId: 'session.archive', phase: 'after', details: true })).statusCode).toBe(400);
            expect((await query({ actionId: 'session.archive' })).statusCode).toBe(400);
            expect((await query({ phase: 'after' })).statusCode).toBe(400);
        } finally { await app.close(); }
    });

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
        await db.artifactGrant.create({ data: { principalKind: 'team', artifactId: artifact.id, teamId: team.id, accessLevel: 'edit', createdByAccountId: owner.id } });
        await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: artifact.id, accountId: personal.id, accessLevel: 'edit', createdByAccountId: owner.id } });
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
                nextRunAt: nextRunAt.getTime(), triggers: [{ kind: 'schedule', automationId: shared.id,
                    triggerId: sharedTrigger.id, nextRunAt: nextRunAt.getTime() }] }] });
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
                { workflowDefinitionId: artifact.id, nextRunAt: nextRunAt.getTime(),
                    triggers: [{ triggerId: sharedTrigger.id, nextRunAt: nextRunAt.getTime() }] },
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
                { workflowDefinitionId: artifact.id, nextRunAt: nextRunAt.getTime() + 60_000,
                    triggers: [{ triggerId: sharedTrigger.id, nextRunAt: nextRunAt.getTime() + 60_000 }] },
            ]);
            await db.teamMembership.update({ where: { id: member.id }, data: { status: 'suspended' } });
            expect((await query(viewer.id)).json().sharedWorkflowSummaries ?? []).toEqual([]);
            await db.teamMembership.update({ where: { id: member.id }, data: { status: 'active' } });
            await db.artifactGrant.delete({ where: { principalKind: 'team', artifactId_teamId: { artifactId: artifact.id, teamId: team.id } } });
            expect((await query(viewer.id)).json().sharedWorkflowSummaries ?? []).toEqual([]);
        } finally { await app.close(); }
    });
});
