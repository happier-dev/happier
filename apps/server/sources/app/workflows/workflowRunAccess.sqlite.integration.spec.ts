import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as privacyKit from "privacy-kit";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, sealEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1, type WorkflowDefinitionV1 } from "@happier-dev/protocol/workflows";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { admitWorkflowRun, getWorkflowRun, listWorkflowRuns, pauseWorkflowRun, resolveAutomationWorkflowAcceptedSnapshot, summarizeWorkflowRuns } from "./workflowRunService";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerWorkflowRunStorageRoutes } from "@/app/api/routes/automations/registerWorkflowRunStorageRoutes";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { materializeWorkflowAcceptedSnapshotFixture } from "@/testkit/workflowAcceptedSnapshot";
import { deriveAccountRecipientEnvelopeReadinessFromRow } from "@/app/encryption/accountRecipientEnvelopeReadiness";
import { inTx } from "@/storage/inTx";
import { resolveWorkflowRunAdmissionVisibilityInTx } from "./workflowRunAccess";
import { readTeamSummaryForActorInTx } from "@/app/teams/lifecycle";
import { hashPasswordMaterial } from "@/app/auth/password/passwordMaterialVerifier";
import type { TeamOperationAuthenticationContext } from "@/app/teams/actorContext";

describe("Workflow Run live Team access (real SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: "happier-run-access-", initEncrypt: true }); }, 180_000);
    afterAll(async () => { if (harness) await harness.close(); });

    async function fixture() {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const viewer = await db.account.create({ data: { encryptionMode: "plain" } });
        const team = await db.team.create({ data: { name: "Workflow viewers" } });
        const membership = await db.teamMembership.create({ data: { teamId: team.id, accountId: viewer.id, role: "member" } });
        const artifact = await db.artifact.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            header: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: "workflow-definition.v1" }))),
            body: new Uint8Array(privacyKit.decodeBase64(encodePlainArtifactStoredContent({}))),
            dataEncryptionKey: new Uint8Array(privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)) } });
        await db.artifactTeamGrant.create({ data: { artifactId: artifact.id, teamId: team.id, accessLevel: "view", createdByAccountId: owner.id } });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id, metadata: "test", metadataVersion: 1 } });
        const runId = crypto.randomUUID();
        const definition: WorkflowDefinitionV1 = { version: 1, inputs: [], defaults: {}, blocks: [
            { kind: "wait", id: "answer", document: { text: "Answer", references: [], attachments: [] }, result: { kind: "text" } },
        ] };
        const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: "plain",
            binding: { v: 1, purpose: "accepted_snapshot", accountId: owner.id, runId },
            acceptedSnapshot: await materializeWorkflowAcceptedSnapshotFixture({ definition, context: {
                source: { kind: "inline", sourceArtifactId: artifact.id }, inputs: {}, machineId: machine.id, executionTarget: { kind: "session" },
                workspaceTarget: { project: { machineId: machine.id, directory: "/repo", checkoutRootPath: "/repo" } },
                origin: { kind: "direct" }, authorization: { principal: { kind: "host" } } } }),
        }));
        await db.automationRun.create({ data: { id: runId, accountId: owner.id, originKind: "direct", causeKind: null,
            sourceArtifactId: artifact.id, visibleTeamId: team.id, state: "queued", scheduledAt: new Date(), dueAt: new Date(),
            workflowAcceptedSnapshotEnvelope: acceptedEnvelope, workflowCustodyState: "pending",
            assignments: { create: { machineId: machine.id, priority: 0 } } } });
        return { owner, viewer, team, membership, artifact, runId, machine, acceptedEnvelope };
    }

    it("a Team viewer reads owner-bound content, cannot control it, and immediately loses visibility when membership is removed", async () => {
        const f = await fixture();
        const read = await getWorkflowRun({ accountId: f.viewer.id, runId: f.runId });
        expect(read.run.ownerAccountId).toBe(f.owner.id);
        expect(read.run.visibleTeamId).toBe(f.team.id);
        expect(read.keyCensus).toMatchObject({ ownerAccountId: f.owner.id, encryptionMode: "plain", access: "view" });
        expect(read.acceptedEnvelope).toBeTruthy();
        await expect(pauseWorkflowRun({ accountId: f.viewer.id, runId: f.runId, expectedRevision: 0 })).rejects.toMatchObject({ code: "run_access_denied" });
        await db.teamMembership.update({ where: { id: f.membership.id }, data: { status: "suspended" } });
        await expect(getWorkflowRun({ accountId: f.viewer.id, runId: f.runId })).rejects.toMatchObject({ code: "run_not_found" });
    });

    it("removing the frozen Team grant revokes a Team Run even when the caller retains a personal document grant", async () => {
        const f = await fixture();
        await db.artifactAccountGrant.create({ data: { artifactId: f.artifact.id, accountId: f.viewer.id,
            accessLevel: "edit", createdByAccountId: f.owner.id } });
        const otherTeam = await db.team.create({ data: { name: "Another workflow audience" } });
        await db.teamMembership.create({ data: { teamId: otherTeam.id, accountId: f.viewer.id, role: "member" } });
        await db.artifactTeamGrant.create({ data: { artifactId: f.artifact.id, teamId: otherTeam.id,
            accessLevel: "edit", createdByAccountId: f.owner.id } });
        expect((await getWorkflowRun({ accountId: f.viewer.id, runId: f.runId })).keyCensus.access).toBe("edit");
        await db.artifactTeamGrant.deleteMany({ where: { artifactId: f.artifact.id, teamId: f.team.id } });
        await expect(getWorkflowRun({ accountId: f.viewer.id, runId: f.runId })).rejects.toMatchObject({ code: "run_not_found" });
        expect((await listWorkflowRuns({ accountId: f.viewer.id, sourceArtifactId: f.artifact.id,
            pageByteLimit: 1_000_000 })).runs).toEqual([]);
        expect((await summarizeWorkflowRuns({ accountId: f.viewer.id, sourceArtifactIds: [f.artifact.id],
            recent: 5, pageByteLimit: 1_000_000 })).summaries).toEqual([{ sourceArtifactId: f.artifact.id,
                lastRun: null, recent: [], needsYouCount: 0, needsYouRunId: null }]);
        await withAuthenticatedTestApp(app => registerWorkflowRunStorageRoutes(app), async app => {
            const census = await app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage",
                headers: { "x-test-user-id": f.owner.id }, payload: { operation: "run-key.census", runId: f.runId } });
            expect(census.statusCode).toBe(200);
            expect(census.json().recipients.map((row: { recipientAccountId: string }) => row.recipientAccountId)).toEqual([f.owner.id]);
        });
    });

    it("personal workflow grants cannot reveal starter-private Runs", async () => {
        const f = await fixture();
        await db.automationRun.update({ where: { id: f.runId }, data: { visibleTeamId: null } });
        await db.artifactAccountGrant.create({ data: { artifactId: f.artifact.id, accountId: f.viewer.id,
            accessLevel: "edit", createdByAccountId: f.owner.id } });
        await expect(getWorkflowRun({ accountId: f.viewer.id, runId: f.runId })).rejects.toMatchObject({ code: "run_not_found" });
    });

    it("Team Runs appear in workflow-scoped history while the caller's own collection stays personal", async () => {
        const f = await fixture();
        const personal = await listWorkflowRuns({ accountId: f.viewer.id, pageByteLimit: 1_000_000 });
        expect(personal.runs).toEqual([]);
        const shared = await listWorkflowRuns({ accountId: f.viewer.id, sourceArtifactId: f.artifact.id, pageByteLimit: 1_000_000 });
        expect(shared.runs.map(run => run.id)).toEqual([f.runId]);
        await db.artifactTeamGrant.deleteMany({ where: { artifactId: f.artifact.id, teamId: f.team.id } });
        expect((await listWorkflowRuns({ accountId: f.viewer.id, sourceArtifactId: f.artifact.id, pageByteLimit: 1_000_000 })).runs).toEqual([]);
        expect((await getWorkflowRun({ accountId: f.owner.id, runId: f.runId })).run.ownerAccountId).toBe(f.owner.id);
    });

    it("reviewed inline admission auto-selects one granted Team, requires a choice among several, and refuses ungranted or private audiences", async () => {
        const f = await fixture();
        await db.teamMembership.create({ data: { teamId: f.team.id, accountId: f.owner.id, role: "member" } });
        await db.automationRun.delete({ where: { id: f.runId } });
        const input = { accountId: f.owner.id, runId: f.runId, origin: { kind: "direct" as const }, machineId: f.machine.id,
            sourceArtifactId: f.artifact.id, acceptedEnvelope: f.acceptedEnvelope,
            accountCurrentness: { mode: "plain" as const, version: f.owner.seq, contentKeyFingerprint: null } };
        const privateInput = { ...input, visibleTeamId: null };
        await expect(admitWorkflowRun(privateInput)).rejects.toMatchObject({ code: "visible_team_not_granted" });
        const ungrantedTeam = await db.team.create({ data: { name: "No workflow grant" } });
        await expect(admitWorkflowRun({ ...input, visibleTeamId: ungrantedTeam.id }))
            .rejects.toMatchObject({ code: "visible_team_not_granted" });
        expect(await db.automationRun.findUnique({ where: { id: f.runId } })).toBeNull();
        const admitted = await admitWorkflowRun(input);
        expect(admitted.run).toMatchObject({ visibleTeamId: f.team.id });
        await db.automationRun.delete({ where: { id: f.runId } });
        const secondTeam = await db.team.create({ data: { name: "Second workflow audience" } });
        await db.teamMembership.create({ data: { teamId: secondTeam.id, accountId: f.owner.id, role: "member" } });
        await db.artifactTeamGrant.create({ data: { artifactId: f.artifact.id, teamId: secondTeam.id,
            accessLevel: "view", createdByAccountId: f.owner.id } });
        input.accountCurrentness.version = (await db.account.findUniqueOrThrow({ where: { id: f.owner.id }, select: { seq: true } })).seq;
        await expect(admitWorkflowRun(input)).rejects.toMatchObject({ code: "visible_team_not_granted" });
        const chosen = { ...input, visibleTeamId: secondTeam.id };
        expect((await admitWorkflowRun(chosen)).run).toMatchObject({ visibleTeamId: secondTeam.id });
        expect((await admitWorkflowRun(input))).toMatchObject({ kind: "existing", run: { visibleTeamId: secondTeam.id } });
        expect((await admitWorkflowRun(chosen))).toMatchObject({ kind: "existing", run: { visibleTeamId: secondTeam.id } });
        await expect(admitWorkflowRun({ ...input, visibleTeamId: f.team.id })).rejects.toMatchObject({ code: "currentness_conflict" });
        expect(await db.workflowRunDataKeyEnvelope.count({ where: { runId: f.runId } })).toBe(0);
    });

    it("admission refuses a forged non-member Team despite a direct Artifact grant", async () => {
        const f = await fixture();
        const outsider = await db.account.create({ data: { encryptionMode: "plain" } });
        await db.artifactAccountGrant.create({ data: { artifactId: f.artifact.id, accountId: outsider.id,
            accessLevel: "view", createdByAccountId: f.owner.id } });
        await expect(inTx(tx => resolveWorkflowRunAdmissionVisibilityInTx(tx, {
            actorAccountId: outsider.id, sourceArtifactId: f.artifact.id, visibleTeamId: f.team.id,
        }))).rejects.toMatchObject({ code: "visible_team_not_granted" });
        expect(await inTx(tx => resolveWorkflowRunAdmissionVisibilityInTx(tx, {
            actorAccountId: outsider.id, sourceArtifactId: f.artifact.id,
        }))).toBeNull();
        expect(await inTx(tx => resolveWorkflowRunAdmissionVisibilityInTx(tx, {
            actorAccountId: f.viewer.id, sourceArtifactId: f.artifact.id,
        }))).toBe(f.team.id);
    });

    it("admission preserves the qualified credential of a member of a restricted Team", async () => {
        const f = await fixture();
        await db.team.update({ where: { id: f.team.id }, data: {
            authenticationPolicy: { v: 1, mode: "restricted", accepted: [{ kind: "home_method", methodId: "email_password" }] },
        } });
        await db.accountIdentity.create({ data: { accountId: f.viewer.id, provider: "email", providerUserId: "workflow-member@example.test", profile: {} } });
        await db.accountPasswordCredential.create({ data: { accountId: f.viewer.id, credential: {
            v: 1, kind: "plain_password_hash", hash: await hashPasswordMaterial(new TextEncoder().encode("workflow test password factor")),
        } } });
        const authentication = { env: {
            HAPPIER_FEATURE_AUTH_EMAIL_PASSWORD__ENABLED: "1", HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: "1",
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        }, authenticationAuthority: "present_user", authenticationEvidence: [{ kind: "home_method", methodId: "email_password" }] } satisfies TeamOperationAuthenticationContext;
        expect(await inTx(tx => readTeamSummaryForActorInTx(tx, { teamId: f.team.id, actorAccountId: f.viewer.id, authentication }))).toMatchObject({ ok: true });
        const input = { actorAccountId: f.viewer.id, sourceArtifactId: f.artifact.id, authentication };
        expect(await inTx(tx => resolveWorkflowRunAdmissionVisibilityInTx(tx, input))).toBe(f.team.id);
        await expect(inTx(tx => resolveWorkflowRunAdmissionVisibilityInTx(tx, { ...input,
            authentication: { ...authentication, authenticationEvidence: [] },
        }))).rejects.toMatchObject({ code: "run_access_denied" });
        // The HTTP authentication boundary stamps these verified facts; no body field supplies them.
        for (const [name, value] of Object.entries(authentication.env)) vi.stubEnv(name, value);
        try {
            await withAuthenticatedTestApp(app => registerWorkflowRunStorageRoutes(app), async app => {
                const payload = { operation: "run-key.census", runId: crypto.randomUUID(), sourceArtifactId: f.artifact.id, visibleTeamId: f.team.id };
                const qualified = await app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage", payload,
                    headers: { "x-test-user-id": f.viewer.id, "x-test-authentication-evidence": JSON.stringify(authentication.authenticationEvidence) } });
                expect(qualified.statusCode).toBe(200);
                expect(qualified.json()).toMatchObject({ visibleTeamId: f.team.id, ownerAccountId: f.viewer.id });
                const unqualified = await app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage", payload,
                    headers: { "x-test-user-id": f.viewer.id } });
                expect(unqualified.statusCode).toBe(403);
                expect(unqualified.json()).toEqual({ error: "run_access_denied" });
            });
        } finally { vi.unstubAllEnvs(); }
    });

    it("Automation snapshot rejoin preserves omitted or matching frozen Team choice and refuses another explicit Team", async () => {
        const f = await fixture();
        await db.teamMembership.create({ data: { teamId: f.team.id, accountId: f.owner.id, role: "member" } });
        await db.automationRun.delete({ where: { id: f.runId } });
        const otherTeam = await db.team.create({ data: { name: "Another trigger audience" } });
        await db.artifactTeamGrant.create({ data: { artifactId: f.artifact.id, teamId: otherTeam.id,
            accessLevel: "view", createdByAccountId: f.owner.id } });
        const automation = await db.automation.create({ data: { accountId: f.owner.id, name: "Team workflow trigger",
            targetType: null, templateCiphertext: "{}" } });
        const definitionEnvelope = JSON.stringify({ t: "plain", v: { definition: { version: 1, inputs: [], defaults: {}, blocks: [
            { kind: "wait", id: "answer", document: { text: "Answer", references: [], attachments: [] }, result: { kind: "text" } },
        ] }, source: { definitionId: f.artifact.id, revision: "1" } } });
        await db.automationRun.create({ data: { id: f.runId, accountId: f.owner.id, originKind: "automation",
            automationId: automation.id, state: "claimed", causeKind: "manual", causeOccurredAt: new Date(),
            scheduledAt: new Date(), dueAt: new Date(), claimedByMachineId: f.machine.id,
            executionInputEnvelope: definitionEnvelope, workflowCustodyState: "pending",
            assignments: { create: { machineId: f.machine.id, priority: 0 } } } });
        const request = { accountId: f.owner.id, runId: f.runId, automationId: automation.id, machineId: f.machine.id,
            expectedAttempt: 0, expectedRevision: 0, definitionEnvelope, acceptedEnvelope: f.acceptedEnvelope,
            sourceArtifactId: f.artifact.id, visibleTeamId: f.team.id,
            accountCurrentness: { mode: "plain" as const, version: f.owner.seq, contentKeyFingerprint: null } };
        expect(await resolveAutomationWorkflowAcceptedSnapshot(request)).toMatchObject({ disposition: "created",
            run: { visibleTeamId: f.team.id } });
        const { visibleTeamId, ...withoutTeam } = request;
        expect(await resolveAutomationWorkflowAcceptedSnapshot(withoutTeam)).toMatchObject({ disposition: "existing",
            run: { visibleTeamId } });
        expect(await resolveAutomationWorkflowAcceptedSnapshot(request)).toMatchObject({ disposition: "existing",
            run: { visibleTeamId } });
        await expect(resolveAutomationWorkflowAcceptedSnapshot({ ...request, visibleTeamId: otherTeam.id }))
            .rejects.toMatchObject({ code: "currentness_conflict" });
    });

    it("Account key census keeps Plain Runs keyless and includes only the current live audience", async () => {
        const f = await fixture();
        await withAuthenticatedTestApp(app => registerWorkflowRunStorageRoutes(app), async app => {
            const read = await app.inject({ method: "POST", url: "/v3/automations/runs/workflow-storage",
                headers: { "x-test-user-id": f.viewer.id }, payload: { operation: "run-key.census", runId: f.runId } });
            expect(read.statusCode).toBe(200);
            expect(read.json()).toMatchObject({ runId: f.runId, ownerAccountId: f.owner.id, encryptionMode: "plain",
                access: "view", dataEncryptionKey: null, callerDataEncryptionKey: null });
            expect(read.json().recipients.map((row: { recipientAccountId: string }) => row.recipientAccountId).sort())
                .toEqual([f.owner.id, f.viewer.id].sort());
        });
        expect(await db.workflowRunDataKeyEnvelope.count({ where: { runId: f.runId } })).toBe(0);
    });

    it("a key holder prepares a late joiner, skips changed recipient bindings and loses access on live revocation", async () => {
        const f = await fixture();
        const owner = await db.account.update({ where: { id: f.owner.id }, data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const viewer = await db.account.update({ where: { id: f.viewer.id }, data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const key = tweetnacl.randomBytes(32);
        const envelopeFor = (account: typeof owner) => {
            const readiness = deriveAccountRecipientEnvelopeReadinessFromRow(account);
            if (readiness.status !== "available") throw new Error("fixture recipient binding unavailable");
            return { recipientAccountId: account.id,
                recipientContentPublicKeyFingerprint: readiness.binding.contentPublicKeyFingerprint,
                encryptedDataKey: privacyKit.encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: key,
                    recipientPublicKey: readiness.binding.contentPublicKey, randomBytes: tweetnacl.randomBytes }))) };
        };
        const ownerEnvelope = envelopeFor(owner);
        const viewerEnvelope = envelopeFor(viewer);
        for (const envelope of [ownerEnvelope, viewerEnvelope]) await db.workflowRunDataKeyEnvelope.create({ data: {
            runId: f.runId, ...envelope, encryptedDataKey: new Uint8Array(privacyKit.decodeBase64(envelope.encryptedDataKey)),
        } });
        const late = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" } });
        const lateMembership = await db.teamMembership.create({ data: { teamId: f.team.id, accountId: late.id, role: "member" } });
        const lateEnvelope = envelopeFor(late);
        await withAuthenticatedTestApp(app => registerWorkflowRunStorageRoutes(app), async app => {
            const send = (operation: "run-key.census" | "run-key.commit", fields: Record<string, unknown> = {}) => app.inject({
                method: "POST", url: "/v3/automations/runs/workflow-storage", headers: { "x-test-user-id": viewer.id },
                payload: { operation, runId: f.runId, ...fields },
            });
            const census = await send("run-key.census");
            expect(census.statusCode).toBe(200);
            expect(census.json()).toMatchObject({ dataEncryptionKey: ownerEnvelope.encryptedDataKey,
                callerDataEncryptionKey: viewerEnvelope.encryptedDataKey });
            expect(census.json().recipients).toEqual(expect.arrayContaining([expect.objectContaining({
                recipientAccountId: late.id, encryptedDataKey: null,
            })]));
            const commit = await send("run-key.commit", { expectedDataEncryptionKey: ownerEnvelope.encryptedDataKey,
                recipientKeyEnvelopes: [lateEnvelope] });
            expect(commit.statusCode).toBe(200);
            expect(commit.json()).toEqual({ appliedRecipientAccountIds: [late.id], skippedRecipientAccountIds: [] });
            await db.account.update({ where: { id: late.id }, data: createSignedAccountContentBinding() });
            const stale = await send("run-key.commit", { expectedDataEncryptionKey: ownerEnvelope.encryptedDataKey,
                recipientKeyEnvelopes: [lateEnvelope] });
            expect(stale.json()).toEqual({ appliedRecipientAccountIds: [], skippedRecipientAccountIds: [late.id] });
            await db.teamMembership.update({ where: { id: lateMembership.id }, data: { status: "suspended" } });
            await db.teamMembership.update({ where: { id: f.membership.id }, data: { status: "suspended" } });
            expect((await send("run-key.census")).statusCode).toBe(404);
        });
    });
});
