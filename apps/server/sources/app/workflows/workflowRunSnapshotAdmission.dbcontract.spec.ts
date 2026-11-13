import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as privacyKit from "privacy-kit";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, AutomationRunCauseSchema, deriveAutomationOccurrenceKeyV1, encodePlainArtifactStoredContent } from "@happier-dev/protocol";
import {
    openWorkflowAcceptedSnapshotStoredEnvelopeV1,
    sealWorkflowAcceptedSnapshotStoredEnvelopeV1,
    serializeWorkflowStoredContentEnvelopeV1,
    type WorkflowDefinitionV1,
} from "@happier-dev/protocol/workflows";
import { WorkflowRunSummaryV1Schema } from "@happier-dev/protocol/workflows/workflowProgressV1";
import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { encodeAutomationRunCause } from "@/app/automations/automationRunCauseCodec";
import { materializeWorkflowAcceptedSnapshotFixture } from "@/testkit/workflowAcceptedSnapshot";
import { hashPasswordMaterial } from "@/app/auth/password/passwordMaterialVerifier";
import type { TeamOperationAuthenticationContext } from "@/app/teams/actorContext";
import { getWorkflowPublicationAudienceInTx } from "./workflowPublicationAudience";
import { cancelWorkflowRun, getWorkflowRun, resolveAutomationWorkflowAcceptedSnapshot } from "./workflowRunService";

const provider = process.env.HAPPIER_DB_PROVIDER;

describe.skipIf(provider !== "postgres" && provider !== "mysql")("Scheduled Workflow prospective Team publication", () => {
    const accountIds: string[] = [];
    const teamIds: string[] = [];
    let connected = false;

    beforeAll(async () => {
        const disposableUrl = provider === "mysql"
            ? process.env.HAPPIER_TEST_MYSQL_DATABASE_URL : process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!disposableUrl || process.env.DATABASE_URL !== disposableUrl) {
            throw new Error("Use the disposable provider DB-contract harness");
        }
        if (provider === "mysql") await initDbMysql(); else initDbPostgres();
        await db.$connect();
        connected = true;
    });
    afterEach(async () => {
        if (!connected) return;
        await db.automationRun.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.automation.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.artifact.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.team.deleteMany({ where: { id: { in: teamIds } } });
        await db.machine.deleteMany({ where: { accountId: { in: accountIds } } });
        await db.account.deleteMany({ where: { id: { in: accountIds } } });
        accountIds.length = 0;
        teamIds.length = 0;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    async function fixture() {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const viewer = await db.account.create({ data: { encryptionMode: "plain" } });
        accountIds.push(owner.id, viewer.id);
        const team = await db.team.create({ data: { name: "Scheduled Workflow audience" } });
        teamIds.push(team.id);
        await db.teamMembership.createMany({ data: [owner, viewer].map(account => ({
            teamId: team.id, accountId: account.id, role: "member" as const,
        })) });
        const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
            { kind: "wait", id: "answer", document: { text: "Answer", references: [], attachments: [] }, result: { kind: "text" } },
        ] };
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            header: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: "workflow-definition.v1" }))),
            body: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({ definition }))),
            dataEncryptionKey: new Uint8Array(privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)),
        } });
        await db.artifactGrant.create({ data: { principalKind: 'team', artifactId: artifact.id, teamId: team.id,
            accessLevel: "view", createdByAccountId: owner.id } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: "{}" } });
        const automation = await db.automation.create({ data: { accountId: owner.id, name: "Scheduled Team workflow",
            workflowDefinitionId: artifact.id, targetType: null, templateCiphertext: "{}" } });
        const trigger = await db.automationTrigger.create({ data: { automationId: automation.id, kind: "schedule",
            scheduleKind: "interval", everyMs: 60_000 } });
        const occurredAt = Date.now();
        const runId = randomUUID();
        const definitionEnvelope = JSON.stringify({ t: "plain", v: { definition, source: { definitionId: artifact.id, revision: "1" } } });
        await db.automationRun.create({ data: { id: runId, accountId: owner.id, originKind: "automation", automationId: automation.id,
            ...encodeAutomationRunCause(AutomationRunCauseSchema.parse({ kind: "trigger", triggerId: trigger.id, triggerKind: "schedule", triggerRevision: 0,
                occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: trigger.id,
                    evidence: { v: 1, kind: "schedule", scheduledFor: occurredAt } }),
                occurredAt, evidence: { scheduledFor: occurredAt } })),
            state: "claimed", scheduledAt: new Date(occurredAt), dueAt: new Date(occurredAt),
            claimedByMachineId: machine.id, attempt: 1, workflowCustodyState: "pending", executionInputEnvelope: definitionEnvelope,
            assignments: { create: { machineId: machine.id, priority: 0 } },
        } });
        const snapshot = await materializeWorkflowAcceptedSnapshotFixture({ definition, context: {
            source: { kind: "automation", automationId: automation.id }, inputs: {}, machineId: machine.id,
            executionTarget: { kind: "session" }, workspaceTarget: { project: { machineId: machine.id, directory: "/repo", checkoutRootPath: "/repo" } },
            authorization: { principal: { kind: "host" } },
        } });
        const binding = { v: 1 as const, purpose: "accepted_snapshot" as const, accountId: owner.id, runId };
        const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: "plain", binding, acceptedSnapshot: snapshot,
        }));
        const request = { accountId: owner.id, runId, automationId: automation.id, machineId: machine.id,
            expectedAttempt: 1, expectedRevision: 0, definitionEnvelope, acceptedEnvelope, sourceArtifactId: artifact.id,
            authentication: { authenticationAuthority: "present_user" as const },
            accountCurrentness: { mode: "plain" as const, version: owner.seq, contentKeyFingerprint: null },
        };
        return { owner, viewer, team, artifact, binding, snapshot, request };
    }

    it.each(["explicit", "omitted", "private"] as const)("resolves and publishes a scheduled snapshot with %s Team choice", async choice => {
        const f = await fixture();
        if (choice === "private") await db.artifactGrant.delete({ where: { principalKind: 'team',
            artifactId_teamId: { artifactId: f.artifact.id, teamId: f.team.id },
        } });
        // No Session share, wake or retained Run already admits this recipient.
        expect((await inTx(tx => getWorkflowPublicationAudienceInTx(tx, {
            accountId: f.owner.id, runIds: [f.request.runId],
        }))).accountIds).toEqual([f.owner.id]);
        const request = { ...f.request, ...(choice === "omitted" ? {} : { visibleTeamId: choice === "private" ? null : f.team.id }) };
        const created = await resolveAutomationWorkflowAcceptedSnapshot(request);
        expect(created).toMatchObject({ disposition: "created", run: { visibleTeamId: choice === "private" ? null : f.team.id } });
        expect(WorkflowRunSummaryV1Schema.parse(created.run)).toEqual(created.run);
        const stored = await getWorkflowRun({ accountId: f.owner.id, runId: request.runId });
        expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: "plain", binding: f.binding,
            envelope: JSON.parse(stored.acceptedEnvelope!) })).toMatchObject({ kind: "available", content: f.snapshot });
        // The exact consumer rejects a mis-bound producer envelope.
        expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: "plain", binding: { ...f.binding, runId: randomUUID() },
            envelope: JSON.parse(stored.acceptedEnvelope!) })).not.toMatchObject({ kind: "available" });
        if (choice === "explicit") {
            const otherTeam = await db.team.create({ data: { name: "Another viewable Team" } });
            teamIds.push(otherTeam.id);
            await db.teamMembership.create({ data: { teamId: otherTeam.id, accountId: f.owner.id, role: "member" } });
            await db.artifactGrant.create({ data: { principalKind: 'team', artifactId: f.artifact.id, teamId: otherTeam.id,
                accessLevel: "view", createdByAccountId: f.owner.id } });
            // A lost-response rejoin keeps its frozen Team even if current
            // grants would now require an explicit choice for a new Run.
            expect(await resolveAutomationWorkflowAcceptedSnapshot(f.request))
                .toMatchObject({ disposition: "existing", run: { visibleTeamId: f.team.id } });
            await expect(resolveAutomationWorkflowAcceptedSnapshot({ ...request, visibleTeamId: otherTeam.id }))
                .rejects.toMatchObject({ code: "currentness_conflict" });
        }
        expect(await resolveAutomationWorkflowAcceptedSnapshot(request)).toMatchObject({ disposition: "existing" });
        const cursor = () => db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: f.viewer.id, kind: "account", entityId: `workflow-run:${request.runId}`,
        } } });
        const acceptedChange = await cursor();
        if (choice === "private") expect(acceptedChange).toBeNull(); else expect(acceptedChange).not.toBeNull();
        expect(await cancelWorkflowRun({ accountId: f.owner.id, runId: request.runId, expectedRevision: created.run.revision }))
            .toMatchObject({ run: { state: "cancelled", workflowCustodyState: "settled" } });
        if (choice === "private") expect(await cursor()).toBeNull();
        else {
            expect((await cursor())!.cursor).toBeGreaterThan(acceptedChange!.cursor);
            expect(await getWorkflowRun({ accountId: f.viewer.id, runId: request.runId })).toMatchObject({ run: { state: "cancelled" } });
        }
    });

    it("carries qualified authentication into the first prospective Team census", async () => {
        const f = await fixture();
        await db.team.update({ where: { id: f.team.id }, data: { authenticationPolicy: {
            v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "email_password" }],
        } } });
        await db.accountIdentity.create({ data: { accountId: f.owner.id, provider: "email",
            providerUserId: `${randomUUID()}@example.test`, profile: {} } });
        await db.accountPasswordCredential.create({ data: { accountId: f.owner.id, credential: {
            v: 1, kind: "plain_password_hash", hash: await hashPasswordMaterial(new TextEncoder().encode("workflow fixture password")),
        } } });
        const authentication = { env: {
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1", HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        }, authenticationAuthority: "present_user", authenticationEvidence: [{ kind: "home_method", methodId: "email_password" }] } satisfies TeamOperationAuthenticationContext;
        await expect(resolveAutomationWorkflowAcceptedSnapshot({ ...f.request, visibleTeamId: f.team.id,
            authentication: { ...authentication, authenticationEvidence: [] } })).rejects.toMatchObject({ code: "run_access_denied" });
        expect(await resolveAutomationWorkflowAcceptedSnapshot({ ...f.request, visibleTeamId: f.team.id, authentication }))
            .toMatchObject({ disposition: "created", run: { visibleTeamId: f.team.id } });
    });

    it("refuses a revoked prospective Team grant without freezing or publishing the snapshot", async () => {
        const f = await fixture();
        await db.artifactGrant.delete({ where: { principalKind: 'team', artifactId_teamId: { artifactId: f.artifact.id, teamId: f.team.id } } });
        await expect(resolveAutomationWorkflowAcceptedSnapshot({ ...f.request, visibleTeamId: f.team.id }))
            .rejects.toMatchObject({ code: "visible_team_not_granted" });
        expect(await db.automationRun.findUniqueOrThrow({ where: { id: f.request.runId } }))
            .toMatchObject({ workflowAcceptedSnapshotEnvelope: null, sourceArtifactId: null, visibleTeamId: null, revision: 0 });
        expect(await db.accountChange.count({ where: { entityId: `workflow-run:${f.request.runId}` } })).toBe(0);
    });
});
