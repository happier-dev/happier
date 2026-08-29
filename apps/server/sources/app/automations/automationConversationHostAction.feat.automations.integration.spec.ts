import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import tweetnacl from "tweetnacl";

import {
    AutomationConversationActionHttpPathsV1,
    AutomationConversationActionHttpRequestSchemasV1,
    AutomationConversationActionOutputSchemasV1,
    AutomationConversationAdmitResultV1Schema,
    PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1,
    deriveSessionCreationTagV1,
    normalizePluginReleaseFactsV1,
    sealAutomationRunResultStoredEnvelopeV1,
} from "@happier-dev/protocol";

import { registerAutomationConversationRoutes } from "@/app/api/routes/automations/registerAutomationConversationRoutes";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { createSignedPluginInstallationPublisherHeader } from "@/testkit/pluginInstallationPublisherTestkit";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { claimAutomationRun } from "./automationClaimService";
import { createAutomation } from "./automationCrudService";
import { startAutomationRun, succeedAutomationRun } from "./automationRunService";

const ACCOUNT_ID = "account-conversation-host-action";
const MACHINE_ID = "machine-conversation-host-action";
const MACHINE_INSTALLATION_ID = "installation-conversation-host-action";
const MATERIALIZATION_ID = "materialization-conversation-host-action";
const SERVER_IDENTITY_ID = "srv_conversationHostActionCurrent1";
const CALLER_PLUGIN_ID = "com.acme.bridge";
const CALLER_PLUGIN_VERSION = "1.0.0";
const CALLER_CONTRIBUTION_LOCAL_ID = "observation-ingest-v1";
const CALLER_IMMUTABLE_GENERATION = "generation-conversation-host-action";
const RESULT_DELIVERY_ACTION_LOCAL_ID = "automation/result-deliver-v1";

const callerMaterialization = {
    pluginId: CALLER_PLUGIN_ID,
    machineId: MACHINE_ID,
    materializationId: MATERIALIZATION_ID,
} as const;

type DynamicRecord = Readonly<Record<string, unknown>>;
type DynamicExecutor = (args: DynamicRecord) => Promise<unknown>;

/**
 * Loads the current CLI conversation Action executor — the host seam a real
 * plugin caller is dispatched through — as a dynamic current-source boundary.
 * The signed transport is the executor's own canonical seam, so admission
 * flows through the real signed route instead of the unreachable axios
 * default transport.
 */
async function loadConversationHostExecutor(transport: unknown): Promise<DynamicExecutor> {
    const module = await import(
        /* @vite-ignore */
        new URL(
            "../../../../cli/src/plugins/runtime/automations/automationConversationActionExecutor.ts",
            import.meta.url,
        ).href
    ) as DynamicRecord;
    const createExecutor = module.createAutomationConversationActionExecutor;
    if (typeof createExecutor !== "function") {
        throw new Error("current CLI conversation executor is missing its factory export");
    }
    const executor = (createExecutor as (input: DynamicRecord) => DynamicExecutor)({
        credentials: {
            token: "conversation-host-action-token",
            encryption: { type: "legacy", secret: new Uint8Array(32).fill(7) },
        },
        transport,
        revalidateCallerMaterialization: async () => true,
        revalidateCallerImmutableGeneration: async () => true,
        resolveAccountId: async () => ACCOUNT_ID,
        resolveAccountEncryptionCurrentness: async () => {
            const account = await db.account.findUniqueOrThrow({
                where: { id: ACCOUNT_ID },
                select: { seq: true, updatedAt: true },
            });
            return {
                mode: "plain" as const,
                version: Number(account.seq),
                signingKeyFingerprint: null,
                contentKeyFingerprint: null,
                updatedAt: account.updatedAt.getTime(),
            };
        },
        resolveAccountEncryptionMaterial: async () => null,
    });
    return executor;
}

describe("Conversation admission through the real host Action executor (integration)", () => {
    let harness: LightSqliteHarness;
    let keyPair: tweetnacl.SignKeyPair;
    let automationId: string;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-automation-conversation-host-action-",
            initAuth: false,
            env: { HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID },
        });
    }, 120_000);

    afterAll(async () => await harness.close());

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationRunEvent.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automationTrigger.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.pluginMachineMaterialization.deleteMany(),
            () => db.accountPluginIntent.deleteMany(),
            () => db.accountPluginRelease.deleteMany(),
            () => db.session.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function seedCallerPluginFixture(): Promise<void> {
        const release = normalizePluginReleaseFactsV1({
            ref: { pluginId: CALLER_PLUGIN_ID, version: CALLER_PLUGIN_VERSION },
            archiveDigestSha256: `sha256:${"b".repeat(64)}`,
            normalizedManifest: {
                schemaVersion: 2,
                id: CALLER_PLUGIN_ID,
                version: CALLER_PLUGIN_VERSION,
                displayName: "Conversation bridge caller fixture",
                engines: { happier: "^1.0.0" },
                runtime: { apiVersion: 1 },
                entrypoints: { daemon: "./dist/index.js" },
                contributes: {
                    actions: [{
                        id: RESULT_DELIVERY_ACTION_LOCAL_ID,
                        title: "Deliver automation result",
                        scopes: ["global"],
                        surfaces: ["plugin"],
                        dangerLevel: "safe",
                        execution: { target: "daemon" },
                        inputSchema: { type: "object", additionalProperties: true } as const,
                        resultSchema: { type: "object", additionalProperties: true } as const,
                    }],
                },
            },
            collectionContracts: [],
            uiSlots: [],
            packageAssetArchive: {
                archiveDigestSha256: `sha256:${"e".repeat(64)}`,
                resources: [],
            },
        });
        keyPair = tweetnacl.sign.keyPair();
        await db.account.create({ data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" } });
        await db.machine.create({
            data: {
                id: MACHINE_ID,
                accountId: ACCOUNT_ID,
                metadata: "{}",
                installationId: MACHINE_INSTALLATION_ID,
                installationPublicKey: new Uint8Array(keyPair.publicKey),
                pluginMaterializationRevision: 1n,
            },
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: CALLER_PLUGIN_ID,
                desiredVersion: CALLER_PLUGIN_VERSION,
                enabled: true,
                writableCollections: [],
            },
        });
        await db.accountPluginRelease.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: CALLER_PLUGIN_ID,
                version: CALLER_PLUGIN_VERSION,
                archiveDigestSha256: release.archiveDigestSha256,
                normalizedManifest: release.normalizedManifest,
                collectionContracts: [],
                uiSlots: [],
                packageAssetArchive: release.packageAssetArchive,
            },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: MATERIALIZATION_ID,
                pluginId: CALLER_PLUGIN_ID,
                version: CALLER_PLUGIN_VERSION,
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: release.archiveDigestSha256,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date("2026-08-10T00:00:00.000Z"),
            },
        });
    }

    async function seedConversationAutomation(): Promise<void> {
        const created = await createAutomation({
            accountId: ACCOUNT_ID,
            input: {
                automationId: randomUUID(),
                name: "Conversation host action loop",
                enabled: true,
                executionRecipe: {
                    v: 1,
                    templateVersion: 1,
                    template: { t: "plain", v: { v: 1, prompt: "Conversation prompt" } },
                    triggerEvidence: null,
                    target: {
                        kind: "newSession",
                        spawn: {
                            executionTarget: { serverId: SERVER_IDENTITY_ID, machineId: MACHINE_ID },
                            directory: "/tmp/conversation-host-action",
                            agentTarget: {
                                kind: "agent",
                                identity: { pluginId: "happier.agent.codex", localId: "codex" },
                            },
                        },
                    },
                },
                assignments: [{ machineId: MACHINE_ID, enabled: true, priority: 1 }],
                triggers: [],
            },
        });
        automationId = created.id;
    }

    function buildSignedConversationTransport() {
        const app = createAuthenticatedTestApp();
        registerAutomationConversationRoutes(app as never);
        const injectSigned = async (path: string, body: unknown) => await app.inject({
            method: "POST",
            url: path,
            headers: {
                "content-type": "application/json",
                "x-test-user-id": ACCOUNT_ID,
                [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: createSignedPluginInstallationPublisherHeader({
                    keyPair,
                    machineId: MACHINE_ID,
                    installationId: MACHINE_INSTALLATION_ID,
                    path,
                    body,
                }),
            },
            payload: body,
        });
        const close = async () => { await app.close(); };
        return { injectSigned, close };
    }

    /**
     * The executor's canonical transport seam: it performs the exact
     * request-schema parse, publisher signing, and strict output-schema parse
     * of the real CLI default transport, dispatched at the local signed
     * admission app instead of axios.
     */
    function signedConversationActionTransport(
        injectSigned: (path: string, body: unknown) => Promise<{ statusCode: number; json: () => unknown }>,
    ) {
        return {
            async execute(
                actionId: keyof typeof AutomationConversationActionOutputSchemasV1,
                request: unknown,
            ): Promise<unknown> {
                const path = AutomationConversationActionHttpPathsV1[actionId];
                const body = AutomationConversationActionHttpRequestSchemasV1[actionId].parse(request);
                const response = await injectSigned(path, body);
                if (response.statusCode !== 200) {
                    throw new Error(`Conversation Action transport failed (${response.statusCode}) ${path}`);
                }
                return AutomationConversationActionOutputSchemasV1[actionId].parse(response.json());
            },
        };
    }

    function conversationInput(occurrenceId: string) {
        const occurredAt = Date.now() - 1_000;
        return {
            automationId,
            bindingId: "binding-host-action",
            occurrenceId,
            occurredAt,
            sender: { id: "person-1" },
            text: "Run the conversation host action loop",
            resultDelivery: {
                kind: "finalResult" as const,
                actionRef: {
                    pluginId: CALLER_PLUGIN_ID,
                    localId: RESULT_DELIVERY_ACTION_LOCAL_ID,
                },
                opaqueContext: { conversationId: "conversation-host-action-1" },
            },
        };
    }

    function executorArgs(input: ReturnType<typeof conversationInput>) {
        return {
            actionId: "automation.conversation.admit",
            input,
            caller: {
                kind: "plugin",
                pluginId: CALLER_PLUGIN_ID,
                contributionLocalId: CALLER_CONTRIBUTION_LOCAL_ID,
                immutableGenerationId: CALLER_IMMUTABLE_GENERATION,
                materialization: callerMaterialization,
            },
        };
    }

    it("dispatches the host Action executor through the real signed admission route into cause custody and server-side handoff readiness", async () => {
        await seedCallerPluginFixture();
        await seedConversationAutomation();
        const { injectSigned, close } = buildSignedConversationTransport();
        const executor = await loadConversationHostExecutor(
            signedConversationActionTransport(injectSigned),
        );
        try {
            // The executor — not the test — stamps the caller frame, derives the
            // occurrence identity, and seals the reply context. The identical
            // replay deliberately reuses the same input bytes.
            const firstInput = conversationInput("host-action-occurrence-1");
            const admitted = AutomationConversationAdmitResultV1Schema.parse(await executor(
                executorArgs(firstInput),
            ));
            expect(admitted).toMatchObject({ kind: "admitted", checkpointSafe: true });
            if (admitted.kind !== "admitted") throw new Error("host Action admission failed");
            const runId = admitted.runId;

            const run = await db.automationRun.findUniqueOrThrow({
                where: { id: runId },
                select: {
                    automationId: true,
                    triggerId: true,
                    state: true,
                    causeKind: true,
                    causeTriggerKind: true,
                    occurrenceKey: true,
                    replyHandoffState: true,
                    replyHandoffId: true,
                    replyHandoffActionPluginId: true,
                    replyHandoffActionLocalId: true,
                    replyHandoffTargetMachineId: true,
                    replyHandoffTargetMachineInstallationId: true,
                    replyHandoffTargetMaterializationId: true,
                },
            });
            const handoffId = `automation-reply-handoff:${runId}`;
            expect(run).toMatchObject({
                automationId,
                triggerId: null,
                state: "queued",
                causeKind: "conversation",
                causeTriggerKind: null,
                replyHandoffState: "awaitingResult",
                replyHandoffId: handoffId,
                replyHandoffActionPluginId: CALLER_PLUGIN_ID,
                replyHandoffActionLocalId: RESULT_DELIVERY_ACTION_LOCAL_ID,
                // The frozen custody target is the exact host-stamped
                // materialization, not a caller-chosen route.
                replyHandoffTargetMachineId: MACHINE_ID,
                replyHandoffTargetMachineInstallationId: MACHINE_INSTALLATION_ID,
                replyHandoffTargetMaterializationId: MATERIALIZATION_ID,
            });
            expect(run.occurrenceKey).toEqual(expect.any(String));

            // Replaying the same occurrence through the same executor rejoins
            // the same durable Run.
            const replay = AutomationConversationAdmitResultV1Schema.parse(await executor(
                executorArgs(firstInput),
            ));
            expect(replay).toEqual({ kind: "rejoined", runId, checkpointSafe: true });
            await expect(db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(1);

            // A distinct conversation occurrence is its own invocation cause.
            const second = AutomationConversationAdmitResultV1Schema.parse(await executor(
                executorArgs(conversationInput("host-action-occurrence-2")),
            ));
            expect(second).toMatchObject({ kind: "admitted", checkpointSafe: true });
            if (second.kind !== "admitted") throw new Error("second admission failed");
            expect(second.runId).not.toBe(runId);

            // Server Run lifecycle and handoff readiness, exercised directly
            // at the owning server services: canonical claim -> start ->
            // settle with the sealed final result flips the frozen handoff to
            // ready exactly once per Run. Daemon execution and result
            // delivery are not exercised here.
            const claimedRunIds: string[] = [];
            for (let claimIndex = 0; claimIndex < 2; claimIndex += 1) {
                const claim = await claimAutomationRun({
                    accountId: ACCOUNT_ID,
                    machineId: MACHINE_ID,
                    leaseDurationMs: 30_000,
                    claimRequest: {
                        machineInstallationId: MACHINE_INSTALLATION_ID,
                        nonce: `conversation-host-action-${randomUUID()}`,
                        expiresAt: new Date(Date.now() + 300_000),
                    },
                });
                if (!claim.run || !claim.accountCurrentness) break;
                claimedRunIds.push(claim.run.id);
                const started = await startAutomationRun({
                    accountId: ACCOUNT_ID,
                    runId: claim.run.id,
                    machineId: MACHINE_ID,
                    attempt: claim.run.attempt,
                    accountCurrentness: claim.accountCurrentness,
                });
                if (started === null) throw new Error("claimed conversation Run did not start");
                const producedSession = await db.session.create({
                    data: {
                        accountId: ACCOUNT_ID,
                        tag: deriveSessionCreationTagV1({
                            callerCreationNamespace: `automation:${automationId}`,
                            creationKey: `automation-run:${claim.run.id}`,
                        }),
                        metadata: "{}",
                    },
                    select: { id: true },
                });
                const resultEnvelope = JSON.stringify(sealAutomationRunResultStoredEnvelopeV1({
                    mode: "plain",
                    correspondence: {
                        accountId: ACCOUNT_ID,
                        automationId,
                        runId: claim.run.id,
                        handoffId: `automation-reply-handoff:${claim.run.id}`,
                    },
                    result: { v: 1, kind: "text", text: "Conversation custody reply" },
                }));
                await expect(succeedAutomationRun({
                    accountId: ACCOUNT_ID,
                    runId: claim.run.id,
                    machineId: MACHINE_ID,
                    attempt: claim.run.attempt,
                    accountCurrentness: started.accountCurrentness,
                    producedSessionId: producedSession.id,
                    resultEnvelope,
                })).resolves.toMatchObject({ id: claim.run.id, state: "succeeded" });
            }
            expect(claimedRunIds.sort()).toEqual([runId, second.runId].sort());
            const settledRuns = await db.automationRun.findMany({
                where: { accountId: ACCOUNT_ID },
                select: { id: true, state: true, replyHandoffState: true, replyHandoffAttempt: true },
            });
            expect(settledRuns).toHaveLength(2);
            for (const settled of settledRuns) {
                expect(settled).toMatchObject({ state: "succeeded", replyHandoffState: "ready" });
            }
        } finally {
            await close();
        }
    }, 60_000);
});
