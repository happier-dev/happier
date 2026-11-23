import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER,
    encodePlainArtifactStoredContent, ARTIFACT_PLAIN_DATA_KEY_MARKER, AutomationDefinitionCreateRequestSchema } from '@happier-dev/protocol';
import { AutomationActionAdmitRequestV1Schema } from '@happier-dev/protocol/automations/automationActionOccurrenceV1';
import { PROJECT_PREPARE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/projectActionIdsV1';
import { decodeBase64 } from 'privacy-kit';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows';
import { db, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { initEncrypt } from '@/modules/encrypt';
import { createAutomationWorkflowRecipeFixture } from '@/testkit/automationWorkflowRecipe';
import { materializeWorkflowAcceptedSnapshotFixture } from '@/testkit/workflowAcceptedSnapshot';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { resolveWorkflowRunAdmissionVisibilityInTx, resolveWorkflowRunAdmissionRecipientAccountIdsInTx,
    resolveWorkflowRunAccessInTx, readWorkflowRunRecipientCensusInTx } from '@/app/workflows/workflowRunAccess';
import { admitAutomationRunTx } from './automationRunAdmissionService';
import { admitAutomationActionOccurrencesV1 } from './automationActionAdmissionService';
import { createAutomation } from './automationCrudService';
import { readAutomationActorConsentReferencesInTx } from './automationSharedWorkflowSummaries';

describe('Consent Run admission (real database)', () => {
    let harness: LightSqliteHarness | undefined;
    beforeAll(async () => {
        if (process.env.HAPPIER_DB_PROVIDER === 'sqlite') {
            harness = await createLightSqliteHarness({ tempDirPrefix: 'consent-run-', initEncrypt: true });
        } else {
            if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
                || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
                throw new Error('Use the disposable PostgreSQL DB-contract harness');
            }
            initDbPostgres();
            await db.$connect();
            const previousSecret = process.env.HANDY_MASTER_SECRET;
            process.env.HANDY_MASTER_SECRET = 'consent-run-dbcontract-test-secret';
            try { await initEncrypt(); }
            finally {
                if (previousSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
                else process.env.HANDY_MASTER_SECRET = previousSecret;
            }
        }
    }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); else await db.$disconnect(); });

    it('uses the invocation Machine for a projectless saved Action Link', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const otherAccount = await db.account.create({ data: { encryptionMode: 'plain' } });
        const makeMachine = (accountId: string) => db.machine.create({ data: { id: randomUUID(), accountId,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        const [machine, foreignMachine] = await Promise.all([makeMachine(account.id), makeMachine(otherAccount.id)]);
        const automationId = randomUUID();
        const triggerId = randomUUID();
        const executionRecipe = { v: 2 as const, templateVersion: 1, triggerEvidence: null,
            placement: 'action_invocation' as const,
            workflow: { t: 'plain' as const, v: { executionTarget: { kind: 'session' as const } } } };
        const created = await createAutomation({ accountId: account.id, input: AutomationDefinitionCreateRequestSchema.parse({
            automationId, name: 'Action Link', enabled: true, workflowDefinitionId: 'builtin:review-and-converge',
            executionRecipe, assignments: [], triggers: [{ triggerId, trigger: {
                kind: 'action', enabled: true, actionIds: ['deployments.deploy', PROJECT_PREPARE_ACTION_ID_V1], phase: 'after',
            } }],
        }) });
        const ref = { automationId, triggerId, triggerRevision: created.triggers[0]!.revision };
        const evidence = { v: 1 as const, kind: 'action' as const, actionId: 'deployments.deploy',
            requestId: randomUUID(), phase: 'after' as const, occurredAt: Date.now(), subjects: [],
            status: 'succeeded' as const };
        const admit = (machineId?: string) => admitAutomationActionOccurrencesV1({ accountId: account.id,
            input: AutomationActionAdmitRequestV1Schema.parse({ triggers: [ref], evidence: { ...evidence, ...(machineId ? { machineId } : {}) } }) });

        expect(await admit()).toMatchObject({ results: [{ kind: 'skipped', reason: 'machineRequired' }] });
        expect(await admit(foreignMachine.id)).toMatchObject({ results: [{ kind: 'skipped', reason: 'machineRequired' }] });
        expect(await db.automationRun.count({ where: { automationId } })).toBe(0);
        const admitted = (await admit(machine.id)).results[0]!;
        expect(admitted.kind).toBe('admitted');
        if (admitted.kind !== 'admitted') throw new Error(JSON.stringify(admitted));
        expect(await db.automationRunAssignment.findMany({ where: { runId: admitted.runId },
            select: { machineId: true, admittedMachineInstallationId: true } })).toEqual([
            { machineId: machine.id, admittedMachineInstallationId: machine.installationId },
        ]);
        expect(await db.automationAssignment.count({ where: { automationId } })).toBe(0);

        // A producer can complete two Actions that both use the same trigger.
        const batch = AutomationActionAdmitRequestV1Schema.parse({
            evidence: { ...evidence, machineId: machine.id, requestId: randomUUID() },
            triggers: [ref, { ...ref, actionId: PROJECT_PREPARE_ACTION_ID_V1 }, ref],
        });
        const replay = () => admitAutomationActionOccurrencesV1({ accountId: account.id, input: batch });
        const first = (await replay()).results;
        const [deploy, setup, duplicate] = first;
        if (deploy?.kind !== 'admitted' || setup?.kind !== 'admitted') throw new Error(JSON.stringify(first));
        expect(deploy.runId).not.toBe(setup.runId);
        expect(duplicate).toEqual(deploy);
        expect((await replay()).results).toEqual(first.map(result => ({ ...result, kind: 'rejoined' })));
        expect(await db.automationRun.count({ where: { automationId } })).toBe(3);
    });

    it('admits a check Run under the actor\'s own consent row privately, reading consent only from that row', async () => {
        const author = await db.account.create({ data: { encryptionMode: 'plain' } });
        const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: author.id,
            header: decodeBase64(encodePlainArtifactStoredContent({ kind: 'workflow-definition.v1' })),
            body: decodeBase64(encodePlainArtifactStoredContent({})),
            dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        const teamIds: string[] = [];
        for (const name of ['First readers', 'Second readers']) {
            const team = await db.team.create({ data: { name } });
            teamIds.push(team.id);
            await db.teamMembership.create({ data: { teamId: team.id, accountId: actor.id, role: 'member' } });
            await db.teamMembership.create({ data: { teamId: team.id, accountId: reader.id, role: 'member' } });
            await db.artifactGrant.create({ data: { artifactId: artifact.id, principalKind: 'team',
                teamId: team.id, accessLevel: 'view', createdByAccountId: author.id } });
        }
        // Ordinary control: two granted Teams need an explicit choice.
        await expect(inTx(tx => resolveWorkflowRunAdmissionVisibilityInTx(tx, {
            actorAccountId: actor.id, sourceArtifactId: artifact.id,
        }))).rejects.toThrow('visible_team_not_granted');
        const selectedTeamId = teamIds[0];
        if (!selectedTeamId) throw new Error('Missing shared Team fixture');
        expect(await inTx(tx => resolveWorkflowRunAdmissionVisibilityInTx(tx, {
            actorAccountId: actor.id, sourceArtifactId: artifact.id, visibleTeamId: selectedTeamId,
        }))).toBe(selectedTeamId);
        // An ordinary Run under the chosen Team reaches that Team's readers; the consent Run below does not.
        expect(await inTx(tx => resolveWorkflowRunAdmissionRecipientAccountIdsInTx(tx, {
            accountId: actor.id, sourceArtifactId: artifact.id, visibleTeamId: selectedTeamId,
        }))).toEqual(expect.arrayContaining([actor.id, reader.id]));
        const recipe = createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/repo', prompt: 'Check' });
        const createRunFor = async (consent: boolean) => {
            const automation = await db.automation.create({ data: { accountId: actor.id, name: 'Check',
                enabled: true, workflowDefinitionId: artifact.id, templateVersion: 1, templateCiphertext: JSON.stringify(recipe),
                targetType: null, ...(consent ? { triggers: { create: { kind: 'action', enabled: true, revision: 1,
                    consentForAutomationId: randomUUID(), consentForTriggerId: randomUUID(),
                    consentedWorkflowRevision: 1 } } } : {}) } });
            const now = new Date();
            return db.automationRun.create({ data: { id: randomUUID(), accountId: actor.id, automationId: automation.id,
                originKind: 'automation', causeKind: 'manual', causeOccurredAt: now, sourceArtifactId: artifact.id, workflowCustodyState: 'pending',
                scheduledAt: now, dueAt: now } });
        };
        const ordinaryRun = await createRunFor(false);
        await expect(inTx(tx => readWorkflowRunRecipientCensusInTx(tx, { actorAccountId: actor.id,
            runId: ordinaryRun.id, sourceArtifactId: artifact.id }))).rejects.toThrow('visible_team_not_granted');
        const consentRun = await createRunFor(true);
        // The caller cannot name consent; the Run's own Automation row carries it.
        const census = await inTx(tx => readWorkflowRunRecipientCensusInTx(tx, { actorAccountId: actor.id,
            runId: consentRun.id, sourceArtifactId: artifact.id, visibleTeamId: selectedTeamId }));
        expect(census.visibleTeamId).toBeNull();
        expect(await inTx(tx => resolveWorkflowRunAdmissionRecipientAccountIdsInTx(tx, {
            accountId: actor.id, sourceArtifactId: artifact.id, visibleTeamId: census.visibleTeamId,
        }))).toEqual([actor.id]);
        await expect(inTx(tx => readWorkflowRunRecipientCensusInTx(tx, { actorAccountId: reader.id,
            runId: consentRun.id, sourceArtifactId: artifact.id }))).rejects.toThrow('run_not_found');
        const visibleTeamId = census.visibleTeamId;
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: actor.id,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        const runId = randomUUID();
        const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: 'plain', binding: { v: 1, purpose: 'accepted_snapshot', accountId: actor.id, runId },
            acceptedSnapshot: await materializeWorkflowAcceptedSnapshotFixture({
                definition: { version: 1, inputs: [], defaults: {}, blocks: [{ kind: 'wait', id: 'review',
                    document: { text: 'Review', references: [], attachments: [] }, result: { kind: 'text' } }] },
                context: { source: { kind: 'inline', sourceArtifactId: artifact.id }, inputs: {}, machineId: machine.id,
                    executionTarget: { kind: 'session' },
                    workspaceTarget: { project: { machineId: machine.id, directory: '/repo', checkoutRootPath: '/repo' } },
                    origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
            }),
        }));
        const now = new Date();
        const run = await db.automationRun.create({ data: { id: runId, accountId: actor.id, originKind: 'direct',
            causeKind: null, sourceArtifactId: artifact.id, visibleTeamId, workflowCustodyState: 'pending',
            workflowAcceptedSnapshotEnvelope: acceptedEnvelope,
            scheduledAt: now, dueAt: now } });
        expect(await inTx(tx => resolveWorkflowRunAccessInTx(tx, { actorAccountId: actor.id, runId: run.id })))
            .toMatchObject({ level: 'owner' });
        for (const outsider of [author, reader]) {
            expect(await inTx(tx => resolveWorkflowRunAccessInTx(tx, { actorAccountId: outsider.id, runId: run.id })))
                .toBeNull();
        }
    });

    it('freezes the invocation Machine on each Run without assigning it to the definition', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const makeMachine = () => db.machine.create({ data: { id: randomUUID(), accountId: account.id,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        const [first, second] = await Promise.all([makeMachine(), makeMachine()]);
        const automation = await db.automation.create({ data: { accountId: account.id, name: 'Actor consent',
            enabled: true, templateVersion: 1, templateCiphertext: JSON.stringify(createAutomationWorkflowRecipeFixture({
                templateVersion: 1, directory: '/repo', prompt: 'Check' })), targetType: null } });
        for (const machine of [first, second]) {
            const now = new Date();
            const result = await inTx(tx => admitAutomationRunTx({ tx, accountId: account.id,
                automationId: automation.id, runTargetMachineId: machine.id, now,
                recipeFeaturePolicy: { workflowsEnabled: true }, cause: { kind: 'manual', invokedAt: now.getTime() } }));
            expect(result.kind).toBe('admitted');
            if (result.kind !== 'admitted') throw new Error(JSON.stringify(result));
            expect(await db.automationRunAssignment.findMany({ where: { runId: result.run.id },
                select: { machineId: true, admittedMachineInstallationId: true } })).toEqual([
                { machineId: machine.id, admittedMachineInstallationId: machine.installationId },
            ]);
        }
        expect(await db.automationAssignment.count({ where: { automationId: automation.id } })).toBe(0);
        const foreign = await db.account.create({ data: { encryptionMode: 'plain' } });
        const foreignMachine = await db.machine.create({ data: { id: randomUUID(), accountId: foreign.id,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
        const now = new Date();
        expect(await inTx(tx => admitAutomationRunTx({ tx, accountId: account.id, automationId: automation.id,
            runTargetMachineId: foreignMachine.id, now, recipeFeaturePolicy: { workflowsEnabled: true },
            cause: { kind: 'manual', invokedAt: now.getTime() } })))
            .toEqual({ kind: 'ineligible', reason: 'noEnabledAssignment' });
    });

    it('reads all selected actor consent Trigger references, including paused and deleted-definition history', async () => {
        const actor = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const source = { automationId: randomUUID(), triggerId: randomUUID() };
        const makeReference = async (accountId: string, consentFor: typeof source, state: 'active' | 'paused' | 'deleted' = 'active') => {
            const automationId = randomUUID();
            const triggerId = randomUUID();
            await db.automation.create({ data: { id: automationId, accountId, name: 'Actor consent history',
                enabled: state === 'active', deletedAt: state === 'deleted' ? new Date() : null,
                templateVersion: 1, templateCiphertext: JSON.stringify(createAutomationWorkflowRecipeFixture({
                    templateVersion: 1, directory: '/repo', prompt: 'Review' })), targetType: null,
                triggers: { create: { id: triggerId, kind: 'action', enabled: state === 'active', revision: 1,
                    consentForAutomationId: consentFor.automationId, consentForTriggerId: consentFor.triggerId,
                    consentedWorkflowRevision: 1 } } } });
            return { automationId, triggerId, consentFor };
        };
        const active = await makeReference(actor.id, source);
        const paused = await makeReference(actor.id, source, 'paused');
        const deleted = await makeReference(actor.id, source, 'deleted');
        await makeReference(other.id, source);
        await makeReference(actor.id, { automationId: source.automationId, triggerId: randomUUID() });
        const references = await inTx(tx => readAutomationActorConsentReferencesInTx(tx, {
            accountId: actor.id, sourceTriggers: [source],
        }));
        expect([...references].sort((a, b) => a.triggerId.localeCompare(b.triggerId)))
            .toEqual([active, paused, deleted].sort((a, b) => a.triggerId.localeCompare(b.triggerId)));
        expect(await inTx(tx => readAutomationActorConsentReferencesInTx(tx, {
            accountId: actor.id, sourceTriggers: [],
        }))).toEqual([]);
    });
});
