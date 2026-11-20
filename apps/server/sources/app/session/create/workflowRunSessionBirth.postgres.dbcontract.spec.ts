import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeBase64 } from "privacy-kit";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent,
    serializeAutomationStoredWorkflowDefinitionRecipeV2 } from "@happier-dev/protocol";
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from "@happier-dev/protocol/workflows";

import { db, getDbProviderFromEnv, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { createDbMaintenanceClient, onDbClientQuery } from "@/storage/prisma";
import { fetchAutomationAccountCurrentnessWitnessTx } from "@/app/automations/automationAccountCurrentness";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { admitWorkflowRun } from "@/app/workflows/workflowRunService";
import { materializeWorkflowAcceptedSnapshotFixture } from "@/testkit/workflowAcceptedSnapshot";
import { createOrRejoinLayout1SessionByTag } from "./createOrRejoinLayout1SessionByTag";
import { prepareLayout1SessionCreate } from "./prepareLayout1SessionCreate";

describe.skipIf(getDbProviderFromEnv(process.env, "postgres") !== "postgres")("Workflow Run Session birth publication (PostgreSQL)", () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error("Run with the disposable PostgreSQL DB-contract harness");
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it.each(["private", "shared", "growing"] as const)("retains a child with a %s Workflow audience without sharing the private Session", async audience => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const reader = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, metadata: "{}" } });
        const artifact = await db.artifact.create({ data: {
            id: randomUUID(), accountId: owner.id,
            header: new Uint8Array(decodeBase64(encodePlainArtifactStoredContent({ kind: "workflow-definition.v1" }))),
            body: new Uint8Array(decodeBase64(encodePlainArtifactStoredContent({}))),
            dataEncryptionKey: new Uint8Array(decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)),
        } });
        const grantWorkflowView = () => db.artifactGrant.create({ data: {
            principalKind: "account", artifactId: artifact.id, accountId: reader.id,
            accessLevel: "view", createdByAccountId: owner.id,
        } });
        if (audience === "shared") await grantWorkflowView();
        const definition = { version: 1, inputs: [],
            defaults: { agentTarget: { kind: "agent", identity: { pluginId: "happier.agent.test", localId: "test" } } },
            blocks: [{ kind: "step", id: "review", document: { text: "Review", references: [], attachments: [] },
                input: [], result: { kind: "text" } }] } satisfies Parameters<typeof materializeWorkflowAcceptedSnapshotFixture>[0]["definition"];
        const recipe = serializeAutomationStoredWorkflowDefinitionRecipeV2({ v: 2, templateVersion: 1, triggerEvidence: null,
            workflow: { t: "plain", v: { workspace: { directory: "/repo" }, executionTarget: { kind: "session" },
                inlineDefinition: definition } } });
        if (recipe.kind !== "available") throw new Error("Workflow fixture recipe unavailable");
        const automation = await db.automation.create({ data: { accountId: owner.id, name: "Shared Workflow review",
            workflowDefinitionId: artifact.id, templateCiphertext: recipe.serialized, templateVersion: 1 } });
        const runId = randomUUID();
        const accountCurrentness = await inTx(tx => fetchAutomationAccountCurrentnessWitnessTx(tx, owner.id));
        if (!accountCurrentness) throw new Error("Plain Account currentness unavailable");
        const acceptedEnvelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({
            mode: "plain", binding: { v: 1, purpose: "accepted_snapshot", accountId: owner.id, runId },
            acceptedSnapshot: await materializeWorkflowAcceptedSnapshotFixture({
                definition,
                context: { source: { kind: "inline" }, inputs: {}, machineId: machine.id,
                    executionTarget: { kind: "session" },
                    workspaceTarget: { project: { machineId: machine.id, directory: "/repo", checkoutRootPath: "/repo" } },
                    origin: { kind: "direct" }, authorization: { principal: { kind: "host" } } },
            }),
        }));
        await admitWorkflowRun({ accountId: owner.id, runId, machineId: machine.id,
            sourceArtifactId: artifact.id, origin: { kind: "direct" }, acceptedEnvelope, accountCurrentness });
        await db.automationRun.update({ where: { id: runId }, data: {
            state: "running", claimedByMachineId: machine.id, attempt: 1, workflowCustodyState: "pending",
            automationId: automation.id, originKind: "automation", causeKind: "manual", causeOccurredAt: new Date(),
        } });
        const input = prepareLayout1SessionCreate({
            accountId: owner.id, tag: randomUUID(), metadata: JSON.stringify({ v: 1 }),
            ownerMetadata: { t: "plain", v: { v: 1 } }, agentState: null, dataEncryptionKey: null,
            requestedEncryptionMode: "plain", requestedStorageState: undefined, organizationPlacement: undefined,
            accountEncryptionMode: "plain", storagePolicy: "optional", defaultAccountMode: "plain",
            originKind: "run_step", originRunId: runId,
        });
        if (!input.ok) throw new Error("Invalid Workflow child fixture");
        const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
        const statements: string[] = [];
        const counted = await createDbMaintenanceClient("postgres", undefined, { log: [{ emit: "event", level: "query" }] });
        onDbClientQuery(counted, ({ query }) => statements.push(query));
        const transaction = db.$transaction;
        let grantedDuringBirth = false;
        db.$transaction = new Proxy(transaction, { apply(_target, _receiver, args: unknown[]) {
            const callback = args[0];
            if (audience !== "growing" || typeof callback !== "function") {
                return Reflect.apply(counted.$transaction, counted, args);
            }
            return Reflect.apply(counted.$transaction, counted, [async (tx: Tx) => callback(new Proxy(tx, {
                get(client, property, receiver) {
                    const delegate = Reflect.get(client, property, receiver);
                    if (property !== "automationRun") return delegate;
                    return new Proxy(tx.automationRun, { get(model, method, modelReceiver) {
                        if (method !== "updateMany") return Reflect.get(model, method, modelReceiver);
                        return async (input: Parameters<Tx["automationRun"]["updateMany"]>[0]) => {
                            const updated = await model.updateMany(input);
                            if (!grantedDuringBirth && input?.data.producedSessionId && updated.count === 1) {
                                // A separate transaction changes the Workflow audience after the Run update.
                                await grantWorkflowView();
                                grantedDuringBirth = true;
                            }
                            return updated;
                        };
                    } });
                },
            })), ...args.slice(1)]);
        } });
        let child: Awaited<ReturnType<typeof createOrRejoinLayout1SessionByTag>>;
        try {
            child = await createOrRejoinLayout1SessionByTag(input.prepared, authentication);
        } finally {
            db.$transaction = transaction;
            await counted.$disconnect();
        }
        expect(child.kind).toBe("created");
        if (child.kind !== "created") throw new Error("Workflow child was not created");
        expect(child.session).toMatchObject({ accountId: owner.id, originKind: "run_step", originRunId: runId });
        expect(await db.automationRun.findUniqueOrThrow({ where: { id: runId }, select: { producedSessionId: true } }))
            .toEqual({ producedSessionId: child.session.id });
        expect(await db.sessionGrant.count({ where: { sessionId: child.session.id, accountId: reader.id } })).toBe(0);
        const rejoined = await createOrRejoinLayout1SessionByTag(input.prepared, authentication);
        expect(rejoined).toMatchObject({ kind: "rejoined", session: { id: child.session.id } });
        const sessionInserts = statements.filter(sql => sql.startsWith('INSERT INTO "public"."Session" (')).length;
        if (audience === "growing") {
            expect(grantedDuringBirth).toBe(true);
            expect(sessionInserts).toBe(2);
            expect(await db.session.count({ where: { accountId: owner.id, tag: input.prepared.tag } })).toBe(1);
        } else {
            expect(sessionInserts).toBe(1);
            const costs = {
                parentAudienceReads: statements.filter(sql => sql.startsWith("SELECT") && sql.includes('"AutomationRun"')
                    && sql.includes('"executionInputEnvelope"') && sql.includes('"producedSessionId"') && sql.includes('"sourceArtifactId"')).length,
                watchers: statements.filter(sql => sql.includes('"AutomationTrigger"') && sql.includes('"sourceRunId"')).length,
                followers: statements.filter(sql => sql.includes('"SessionFollowEdge"') && sql.includes('"sourceWorkflowRunId"')).length,
                insertedChildLookups: statements.filter(sql => sql.includes('FROM "public"."Session"')
                    && sql.split(' WHERE ')[1]?.includes('"originRunId"')).length,
            };
            console.info("WORKFLOW_CHILD_BIRTH_SQL", audience, costs);
            expect(costs).toEqual({ parentAudienceReads: 5, watchers: 5, followers: 5, insertedChildLookups: 0 });
        }
    });
});
