import { randomUUID } from "node:crypto";
import axios from "axios";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { serializeAutomationStoredWorkflowDefinitionRecipeV2 } from "@happier-dev/protocol/automations/automationWorkflowRecipeV2";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { registerSessionArchiveRoutes } from "@/app/api/routes/session/registerSessionArchiveRoutes";
import { db } from "@/storage/db";
import { createAutomationSessionLifecycleFixtureFields } from "@/testkit/automationSessionLifecycleFixture";
import { decodeAutomationRunCause } from "./automationRunCauseCodec";
import { createCliActionDeps } from "../../../../cli/src/session/actions/createCliActionDeps";
import { createSessionRecordFixture } from "../../../../cli/src/testkit/backends/sessionFixtures";
import { readOrCreateInstallationIdentity } from "../../../../cli/src/daemon/identity/store";
import { updateSettings } from "../../../../cli/src/persistence";
import { configuration } from "../../../../cli/src/configuration";
import { eventRouter } from "@/app/events/eventRouter";
import * as archivePublication from "@/app/session/archive/publishSessionArchiveTransition";

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: "happier-archive-origin-", initAuth: true,
        initEncrypt: false, initFiles: false });
}, 120_000);
afterAll(async () => { await harness?.close(); });

it("retains the real CLI Workflow archive origin through the strict HTTP consumer and rejects a misbound body", async () => {
    const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
    const session = await db.session.create({ data: { accountId: account.id, tag: randomUUID(),
        encryptionMode: "plain", metadata: "{}", active: false } });
    const identity = await readOrCreateInstallationIdentity();
    const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id, metadata: "{}",
        installationId: identity.installationId, installationPublicKey: new Uint8Array(Buffer.from(identity.publicKey, "base64url")) } });
    await updateSettings(settings => ({ ...settings, machineIdByServerId: {
        ...settings.machineIdByServerId, [configuration.activeServerId]: machine.id,
    } }));
    const recipe = serializeAutomationStoredWorkflowDefinitionRecipeV2({ v: 2, templateVersion: 1, triggerEvidence: null,
        workflow: { t: "plain", v: { workspace: { directory: "/tmp/archive-origin" }, executionTarget: { kind: "session" } } } });
    if (recipe.kind !== "available") throw new Error("Canonical recipe unavailable");
    const automation = await db.automation.create({ data: { accountId: account.id, name: "Archive origin",
        enabled: true, templateCiphertext: recipe.serialized, templateVersion: 1, workflowDefinitionId: "builtin:keep-going" } });
    await db.automationAssignment.create({ data: { automationId: automation.id, machineId: machine.id, enabled: true } });
    const trigger = await db.automationTrigger.create({ data: { automationId: automation.id, kind: "sessionLifecycle",
        revision: 1, enabled: true, ...await createAutomationSessionLifecycleFixtureFields({ automationId: automation.id, kind: "sessionLifecycle",
            sourceSessionId: session.id, events: ["sessionArchived"], policy: { kind: "everyMatch" } }) } });
    const run = await db.automationRun.create({ data: { accountId: account.id, originKind: "direct", causeKind: null,
        state: "running", scheduledAt: new Date(), dueAt: new Date(), workflowCustodyState: "pending",
        workflowAcceptedSnapshotEnvelope: "{}" } });
    await db.automationRunAssignment.create({ data: { runId: run.id, machineId: machine.id } });

    await withAuthenticatedTestApp(registerSessionArchiveRoutes, async app => {
        // Only the network boundary is substituted. The actual producer's
        // signed bytes enter Fastify validation, publisher verification and DB.
        const get = vi.spyOn(axios, "get").mockResolvedValue({ status: 200, data: {
            session: createSessionRecordFixture({ id: session.id, active: false, encryptionMode: "plain", metadata: "{}" }),
        } });
        let misbind = true;
        const post = vi.spyOn(axios, "post").mockImplementation(async (address, payload, options) => {
            const response = await app.inject({ method: "POST", url: new URL(String(address)).pathname,
                payload: misbind ? { originRunId: randomUUID() } : payload,
                headers: { ...options?.headers, "x-test-user-id": account.id } });
            return { status: response.statusCode, data: response.json() };
        });
        // Observe the real publisher: the HTTP receipt precedes its completion.
        const publication = vi.spyOn(archivePublication, "publishSessionArchiveTransition");
        try {
            const credentials = { token: "archive-fixture", encryption: null };
            const deps = createCliActionDeps({ credentials, token: credentials.token, sessionId: "", mode: "plain", ctx: null });
            const archive = () => deps.sessionArchiveSet!({ sessionId: session.id, archived: true,
                context: { surface: "cli", actionCaller: { kind: "workflowRun", runId: run.id,
                    authorization: { principal: { kind: "host" }, admittedPermissionCeiling: "default" } } } });
            await expect(archive()).rejects.toMatchObject({ response: { status: 403 } });
            expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).archivedAt).toBeNull();
            expect(await db.automationRun.count({ where: { triggerId: trigger.id } })).toBe(0);
            misbind = false;
            await expect(archive()).resolves.toMatchObject({ ok: true });
            await Promise.all(publication.mock.results.map(result => result.value));
            const occurrence = await db.automationRun.findFirstOrThrow({ where: { triggerId: trigger.id } });
            expect(decodeAutomationRunCause(occurrence)).toMatchObject({ kind: "trigger", triggerKind: "sessionLifecycle",
                evidence: { event: "sessionArchived", sourceSessionId: session.id, originRunId: run.id } });
            const archived = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            const accountAfterArchive = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
            const changesAfterArchive = await db.accountChange.findMany({ where: { accountId: account.id } });
            const publications = vi.spyOn(eventRouter, "emitUpdate");
            await expect(archive()).resolves.toMatchObject({ ok: true });
            expect(await db.automationRun.count({ where: { triggerId: trigger.id } })).toBe(1);
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toEqual(archived);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual(accountAfterArchive);
            expect(await db.accountChange.findMany({ where: { accountId: account.id } })).toEqual(changesAfterArchive);
            expect(publications.mock.calls).toHaveLength(0);
            const unarchive = () => app.inject({ method: "POST", url: `/v2/sessions/${session.id}/unarchive`,
                headers: { "x-test-user-id": account.id } });
            expect((await unarchive()).statusCode).toBe(200);
            await Promise.all(publication.mock.results.map(result => result.value));
            expect(publications.mock.calls.length).toBeGreaterThan(0);
            const unarchived = await db.session.findUniqueOrThrow({ where: { id: session.id } });
            const accountAfterUnarchive = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
            publications.mockClear();
            expect((await unarchive()).statusCode).toBe(200);
            expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toEqual(unarchived);
            expect(await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } })).toEqual(accountAfterUnarchive);
            expect(publications.mock.calls).toHaveLength(0);
            publications.mockRestore();
        } finally { get.mockRestore(); post.mockRestore(); publication.mockRestore(); }
    });
});

