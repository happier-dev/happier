import { randomUUID } from "node:crypto";
import { decodeBase64 } from 'privacy-kit';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
    AutomationEventAdmitInputV1Schema,
    AutomationSourceSelectorIdV1Schema,
    AutomationTriggerIdSchema,
    normalizePluginReleaseFactsV1,
    createPackageAssetArchiveV1,
    readDeclaredPackageAssetsV1,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
} from "@happier-dev/protocol";
import { serializeAutomationStoredWorkflowDefinitionRecipeV2 } from "@happier-dev/protocol/automations/automationWorkflowRecipeV2";
import { runCheckpointedPluginEventObserverV1, type BackgroundServiceContext,
    type PluginCheckpointedEventSourceDefinitionV1 } from "@happier-dev/plugin-sdk/background-services";
import type { AccountKvEntry } from "@happier-dev/plugin-sdk/storage";
import type { JsonValue } from "@happier-dev/plugin-sdk";
import { manifest } from "../../../../../packages/plugins/machine-services/src/manifest";
import { createMachinePresenceEventSourceAdapter, machinePresenceEventActions } from "../../../../../packages/plugins/machine-services/src/machinePresenceEvents";
import { readMachinePresenceForAccountInTx } from '@/app/presence/machinePresenceTransitions';
import { recordMachineAlive } from '@/app/presence/presenceRecorder';
import { createMachinePresenceDeadlineOwner, stopLocalMachinePresenceTimeout, resolvePresenceTimeoutConfig } from '@/app/presence/timeout';
import { inReadSnapshot } from '@/storage/inTx';
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { admitAutomationEventV1 } from "./automationEventAdmissionService";

const serverIdentityId = "srv_healthWorkflowComposed1";
let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: "happier-presence-workflow-", initAuth: false,
        env: { HAPPIER_SERVER_IDENTITY_ID: serverIdentityId } });
}, 120_000);
afterAll(async () => { await harness?.close(); });

it("admits retained Machine presence through ordinary Workflow admission once across server and observer restart", async () => {
    const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: "plain" } });
    const machineId = randomUUID();
    const installationId = randomUUID();
    const materialization = { pluginId: manifest.id, machineId, materializationId: randomUUID() };
    const sourceCustody = { kind: "managed" as const, immutableGenerationId: randomUUID(), installSource: "archive" as const };
    const sourceInstanceBase = "presence:composed:target";
    const targetMachineId = randomUUID();
    const source = { v: 1, serverId: serverIdentityId, machineId: targetMachineId, afterRevision: 0 };
    const assets = createPackageAssetArchiveV1({ manifest, files: (readDeclaredPackageAssetsV1(manifest) ?? [])
        .map(asset => ({ path: asset.path, bytes: new TextEncoder().encode("{}") })) });
    if (!assets) throw new Error("plugin_asset_fixture_invalid");
    const release = normalizePluginReleaseFactsV1({ ref: { pluginId: manifest.id, version: manifest.version },
        archiveDigestSha256: `sha256:${"a".repeat(64)}`, normalizedManifest: manifest,
        collectionContracts: [], uiSlots: [], packageAssetArchive: assets.descriptor });
    await db.automationEventCatalogState.create({ data: { accountId: account.id, eventSourceDefinitionsRevision: 0n } });
    await db.machine.create({ data: { id: machineId, accountId: account.id, metadata: "{}", installationId,
        pluginMaterializationRevision: 1n } });
    await db.machine.create({ data: { id: targetMachineId, accountId: account.id, metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER), active: false } });
    await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId: manifest.id,
        desiredVersion: manifest.version, enabled: true, writableCollections: [] } });
    await db.accountPluginRelease.create({ data: { accountId: account.id, pluginId: manifest.id, version: manifest.version,
        archiveDigestSha256: release.archiveDigestSha256, normalizedManifest: release.normalizedManifest,
        collectionContracts: [], uiSlots: [], packageAssetArchive: release.packageAssetArchive } });
    await db.pluginMachineMaterialization.create({ data: { accountId: account.id, serverIdentityId, machineId,
        materializationId: materialization.materializationId, pluginId: manifest.id, version: manifest.version,
        sourceClass: "registryPackage", portableRelease: true, archiveDigestSha256: release.archiveDigestSha256,
        uiArtifacts: [], enabled: true, trustState: "trusted", observedAt: new Date() } });
    const recipe = serializeAutomationStoredWorkflowDefinitionRecipeV2({ v: 2, templateVersion: 1, triggerEvidence: null,
        workflow: { t: "plain", v: { workspace: { directory: "/repo" }, executionTarget: { kind: "session" } } } });
    if (recipe.kind !== "available") throw new Error("workflow_recipe_invalid");
    const automation = await db.automation.create({ data: { accountId: account.id, name: "Investigate health",
        enabled: true, templateCiphertext: recipe.serialized, templateVersion: 1, workflowDefinitionId: "builtin:keep-going" } });
    await db.automationAssignment.create({ data: { automationId: automation.id, machineId, enabled: true } });
    const definitions: PluginCheckpointedEventSourceDefinitionV1[] = [];
    for (const localId of ["machine-offline", "machine-online"]) {
        const sourceInstanceId = `${sourceInstanceBase}:${localId}`;
        const triggerId = AutomationTriggerIdSchema.parse(randomUUID());
        const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(randomUUID());
        const eventRef = { pluginId: manifest.id, localId };
        await db.automationTrigger.create({ data: { id: triggerId, automationId: automation.id, kind: "pluginEvent",
            enabled: true, revision: 1, eventPluginId: manifest.id, eventLocalId: localId,
            sourceSelectorId, sourceContractVersion: 1, observationTransport: "checkpointedPull",
            watcherMachineId: machineId, watcherMachineInstallationId: installationId,
            watcherPluginId: manifest.id, watcherMaterializationId: materialization.materializationId,
            definitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({ mode: "plain",
                binding: { v: 1, automationId: automation.id, triggerId, triggerRevision: 1, triggerKind: "pluginEvent", eventRef, sourceSelectorId },
                definition: { v: 1, sourceInstanceId, sourceConfig: source, displayLabel: "Web health", filter: null, maximumObservationAgeMs: null } })) } });
        definitions.push({ automationId: automation.id, triggerId, triggerRevision: 1, sourceSelectorId, eventRef,
            sourceInstanceId, sourceContractVersion: 1, sourceConfig: source,
            observationTransport: { kind: "checkpointedPull", watcherMaterializationRef: materialization },
            filter: null, maximumObservationAgeMs: null });
    }
    let now = Date.now();
    let loseAcknowledgement = true;
    const rows = new Map<string, AccountKvEntry>();
    const admissions: Awaited<ReturnType<typeof admitAutomationEventV1>>[] = [];
    // Host transport and KV are plugin boundaries. Presence, access, Event
    // admission, occurrence deduplication and Workflow persistence stay real.
    const context = { plugin: { id: manifest.id, version: manifest.version }, materialization,
        contribution: { id: "health-observer", qualifiedId: `${manifest.id}/backgroundServices/health-observer` },
        surface: "background", invokedAtMs: now, signal: new AbortController().signal,
        services: { events: { host: { subscribe: () => ({ dispose() {} }) } },
            storage: { account: { kv: {
                async get(key: string) { return rows.get(key) ?? null; },
                async set(key: string, value: JsonValue, options: { expectedVersion: number | "absent" }) {
                    const previous = rows.get(key);
                    if ((previous?.version ?? "absent") !== options.expectedVersion) throw new Error("cas_conflict");
                    const version = (previous?.version ?? 0) + 1;
                    rows.set(key, { version, value });
                    return { version };
                },
            } } },
            actions: { async execute(id: string, input: unknown) {
                if (id === "automation.event.sources.list") return { kind: "page", revision: "1", definitions, nextCursor: null };
                if (id === "automation.event.source.status.report") return { kind: "reported" };
                if (id === 'machines.presence.read') return inReadSnapshot(tx => readMachinePresenceForAccountInTx(tx,
                    { actorAccountId: account.id, machineId: targetMachineId }));
                if (id !== "automation.event.admit") throw new Error(`unexpected_action:${id}`);
                const request = AutomationEventAdmitInputV1Schema.parse(input);
                const current = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
                const result = await admitAutomationEventV1({ accountId: account.id,
                    caller: { ...materialization, machineInstallationId: installationId, sourceCustody },
                    request: { v: 1, caller: { pluginId: manifest.id, occurrenceId: request.occurrenceId, sourceCustody, materialization },
                        input: request, hostEvidence: { v: 1, t: "plain", accountCurrentness: {
                            mode: "plain", version: current.seq, contentKeyFingerprint: null } } } });
                admissions.push(result);
                if (loseAcknowledgement) { loseAcknowledgement = false; throw new Error("network_reply_lost_after_commit"); }
                return { results: result.results };
            } },
        },
    } as unknown as BackgroundServiceContext;
    // Each finite pass reconstructs the observer against the retained database.
    const cycle = async () => {
        for (const eventId of ['machine-offline', 'machine-online'] as const) {
            const adapter = createMachinePresenceEventSourceAdapter(context.services.events.host, eventId, () => now);
            await runCheckpointedPluginEventObserverV1({ context, source: adapter, mode: 'once', now: () => now });
        }
    };
    const beat = () => recordMachineAlive({ accountId: account.id, machineId: targetMachineId, timestamp: Date.now() }, async (_, row) => {
        return { recipientAccountIds: [account.id], wasOffline: !row.active, lastActiveAt: row.lastActiveAt };
    });
    let deadline = createMachinePresenceDeadlineOwner();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
        await beat();
        await cycle();
        expect(await db.automationRun.count({ where: { automationId: automation.id } })).toBe(0);
        await deadline.start();
        await vi.advanceTimersByTimeAsync(resolvePresenceTimeoutConfig().machineTimeoutMs);
        await deadline.stop();
        await stopLocalMachinePresenceTimeout();
        now = Date.now();
        await cycle();
        const failed = await db.automationRun.findFirstOrThrow({ where: { automationId: automation.id } });
        expect(failed).toMatchObject({ state: 'queued', originKind: 'automation', workflowCustodyState: 'pending',
            causeKind: 'trigger', causeTriggerKind: 'pluginEvent', causeEventLocalId: 'machine-offline' });
        expect(JSON.parse(failed.triggerEvidenceEnvelope!).v.payload).toEqual({ serverId: serverIdentityId,
            machineId: targetMachineId, transition: 'offline', revision: 1, observedAt: now });
        await deadline.stop();
        deadline = createMachinePresenceDeadlineOwner();
        await deadline.start();
        await cycle();
        expect(await db.automationRun.count({ where: { automationId: automation.id } })).toBe(1);
        expect(admissions.at(-1)?.results[0]).toMatchObject({ kind: 'rejoined', runId: failed.id, checkpointSafe: true });
        await beat();
        await cycle();
        expect(await db.automationRun.count({ where: { automationId: automation.id } })).toBe(2);
        expect(await db.automationRun.count({ where: { automationId: automation.id, causeEventLocalId: 'machine-online' } })).toBe(1);
        // A disconnected observer still sees both polarities after recovery.
        await vi.advanceTimersByTimeAsync(resolvePresenceTimeoutConfig().machineTimeoutMs);
        await stopLocalMachinePresenceTimeout();
        await beat();
        now = Date.now();
        await cycle();
        expect(await db.automationRun.count({ where: { automationId: automation.id } })).toBe(4);
        await cycle();
        expect(await db.automationRun.count({ where: { automationId: automation.id } })).toBe(4);
        const enrollment = await machinePresenceEventActions['machine-offline/setup']!.run(
            { v: 1, serverId: serverIdentityId, machineId: targetMachineId }, context);
        expect(enrollment.sourceConfig).toMatchObject({ afterRevision: 4 });
        definitions.splice(0, definitions.length, ...definitions.map(definition => ({ ...definition, sourceConfig: enrollment.sourceConfig })));
        await cycle();
        expect(await db.automationRun.count({ where: { automationId: automation.id } })).toBe(4);
    } finally { await deadline.stop(); await stopLocalMachinePresenceTimeout(); vi.useRealTimers(); }
});
