import {
    AutomationEventSourceStatusReportV1Schema,
    type AutomationEventSourceStatusReportV1,
    type ParsedPluginManifestV2,
} from "@happier-dev/protocol";

import { emitAutomationSourceStatusUpdated } from "@/app/automations/automationChangePublisher";
import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { afterTx, inTx, type Tx } from "@/storage/inTx";

import {
    assertCurrentAutomationEventCallerMaterializationTx,
    readCurrentAutomationEventDurablePushEndpointTargetTxV1,
    readCurrentAutomationEventDurablePushWebhookContributionV1,
    resolveCurrentAutomationEventContributionTx,
    resolveCurrentAutomationEventManifestTx,
    sameAutomationEventDurablePushWebhookContributionV1,
    AutomationEventCurrentnessError,
    type AutomationEventCallerV1,
} from "./automationEventCurrentness";

const MAX_DATABASE_INT = 2_147_483_647;

export type AutomationEventSourceStatusCallerV1 = AutomationEventCallerV1;

export class AutomationEventSourceStatusReportError extends Error {
    readonly code:
        | "caller_materialization_not_current"
        | "event_contribution_not_current"
        | "definition_not_current"
        | "observation_target_changed"
        | "catalog_state_unavailable"
        | "catalog_revision_ahead"
        | "catalog_revision_not_current"
        | "durable_push_endpoint_context_unavailable"
        | "status_counter_exhausted"
        | "invalid_timestamp";

    constructor(code: AutomationEventSourceStatusReportError["code"]) {
        super(code);
        this.name = "AutomationEventSourceStatusReportError";
        this.code = code;
    }
}

function fail(code: AutomationEventSourceStatusReportError["code"]): never {
    throw new AutomationEventSourceStatusReportError(code);
}

function toNullableDate(value: number | null): Date | null {
    if (value === null) return null;
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) fail("invalid_timestamp");
    return date;
}

function addBoundedCounter(current: number, delta: number): number {
    if (current > MAX_DATABASE_INT - delta) fail("status_counter_exhausted");
    return current + delta;
}

async function markAutomationSourceStatusChangedTx(params: Readonly<{
    tx: Tx;
    accountId: string;
}>): Promise<void> {
    const cursor = await markAccountChanged(params.tx, {
        accountId: params.accountId,
        kind: "automation",
        entityId: "automation-source-status",
    });
    afterTx(params.tx, () => {
        emitAutomationSourceStatusUpdated({ accountId: params.accountId, cursor });
    });
}

async function assertCurrentCallerMaterialization(params: Readonly<{
    tx: Tx;
    accountId: string;
    serverIdentityId: string;
    caller: AutomationEventSourceStatusCallerV1;
}>): Promise<Readonly<{ version: string }>> {
    try {
        return await assertCurrentAutomationEventCallerMaterializationTx(params);
    } catch (error) {
        if (error instanceof AutomationEventCurrentnessError) fail(error.code);
        throw error;
    }
}

async function resolveCurrentEventManifest(params: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    version: string;
}>): Promise<ParsedPluginManifestV2> {
    try {
        return await resolveCurrentAutomationEventManifestTx(params);
    } catch (error) {
        if (error instanceof AutomationEventCurrentnessError) fail(error.code);
        throw error;
    }
}

async function assertCurrentEventContribution(params: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    version: string;
    eventLocalId: string;
    sourceContractVersion: number;
}>): Promise<Readonly<{
    supportsCheckpointedPull: boolean;
    durablePushWebhookContribution: Readonly<{ pluginId: string; localId: string }> | null;
}>> {
    let event;
    try {
        event = await resolveCurrentAutomationEventContributionTx(params);
    } catch (error) {
        if (error instanceof AutomationEventCurrentnessError) fail(error.code);
        throw error;
    }
    return {
        supportsCheckpointedPull: event.automation.source.supportedObservationTransports
            .includes("checkpointedPull"),
        durablePushWebhookContribution:
            readCurrentAutomationEventDurablePushWebhookContributionV1(event),
    };
}

async function assertCurrentCheckpointedPullCatalogScope(params: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    version: string;
}>): Promise<void> {
    const manifest = await resolveCurrentEventManifest(params);
    const supported = manifest.contributes.events.some((event) => (
        event.kind === "event"
        && event.automation?.eligible === true
        && event.automation.source.supportedObservationTransports.includes("checkpointedPull")
    ));
    if (!supported) fail("event_contribution_not_current");
}

async function assertCurrentDurablePushCatalogScope(params: Readonly<{
    tx: Tx;
    accountId: string;
    caller: AutomationEventSourceStatusCallerV1;
    callerVersion: string;
    webhookEndpointId: string;
}>): Promise<void> {
    const endpoint = await readCurrentAutomationEventDurablePushEndpointTargetTxV1({
        tx: params.tx,
        accountId: params.accountId,
        webhookEndpointId: params.webhookEndpointId,
        caller: params.caller,
        callerVersion: params.callerVersion,
    });
    if (endpoint === null) fail("observation_target_changed");

    const manifest = await resolveCurrentEventManifest({
        tx: params.tx,
        accountId: params.accountId,
        pluginId: params.caller.pluginId,
        version: params.callerVersion,
    });
    const supported = manifest.contributes.events.some((event) => {
        if (event.kind !== "event" || event.automation?.eligible !== true) return false;
        const contribution = readCurrentAutomationEventDurablePushWebhookContributionV1(event);
        return contribution !== null
            && sameAutomationEventDurablePushWebhookContributionV1(
                contribution,
                endpoint.webhookContribution,
            );
    });
    if (!supported) fail("event_contribution_not_current");
}

function sourceTargetMatchesCaller(
    trigger: Readonly<{
        watcherMachineId: string | null;
        watcherMachineInstallationId: string | null;
        watcherPluginId: string | null;
        watcherMaterializationId: string | null;
    }>,
    caller: AutomationEventSourceStatusCallerV1,
): boolean {
    return trigger.watcherMachineId === caller.machineId
        && trigger.watcherMachineInstallationId === caller.machineInstallationId
        && trigger.watcherPluginId === caller.pluginId
        && trigger.watcherMaterializationId === caller.materializationId;
}

async function reportSourceStatus(params: Readonly<{
    tx: Tx;
    accountId: string;
    caller: AutomationEventSourceStatusCallerV1;
    callerVersion: string;
    input: Extract<AutomationEventSourceStatusReportV1, { kind: "source" }>;
}>): Promise<void> {
    const trigger = await params.tx.automationTrigger.findFirst({
        where: {
            id: params.input.triggerId,
            automationId: params.input.automationId,
            automation: { accountId: params.accountId },
        },
        select: {
            automation: { select: { enabled: true, deletedAt: true } },
            enabled: true,
            deletedAt: true,
            revision: true,
            kind: true,
            eventPluginId: true,
            eventLocalId: true,
            sourceSelectorId: true,
            sourceContractVersion: true,
            observationTransport: true,
            webhookEndpointId: true,
            watcherMachineId: true,
            watcherMachineInstallationId: true,
            watcherPluginId: true,
            watcherMaterializationId: true,
        },
    });
    if (
        !trigger
        || !trigger.automation.enabled
        || trigger.automation.deletedAt
        || !trigger.enabled
        || trigger.deletedAt
        || trigger.kind !== "pluginEvent"
        || trigger.revision !== params.input.triggerRevision
        || trigger.eventPluginId !== params.input.eventRef.pluginId
        || trigger.eventLocalId !== params.input.eventRef.localId
        || trigger.sourceSelectorId !== params.input.sourceSelectorId
        || trigger.sourceContractVersion === null
        || params.input.eventRef.pluginId !== params.caller.pluginId
    ) fail("definition_not_current");

    const eventContribution = await assertCurrentEventContribution({
        tx: params.tx,
        accountId: params.accountId,
        pluginId: params.caller.pluginId,
        version: params.callerVersion,
        eventLocalId: params.input.eventRef.localId,
        sourceContractVersion: trigger.sourceContractVersion,
    });

    if (trigger.observationTransport === "durablePush") {
        if (trigger.webhookEndpointId === null) fail("definition_not_current");
        if (!eventContribution.durablePushWebhookContribution) {
            fail("event_contribution_not_current");
        }
        const endpoint = await readCurrentAutomationEventDurablePushEndpointTargetTxV1({
            tx: params.tx,
            accountId: params.accountId,
            webhookEndpointId: trigger.webhookEndpointId,
            caller: params.caller,
            callerVersion: params.callerVersion,
        });
        if (
            endpoint === null
            || !sameAutomationEventDurablePushWebhookContributionV1(
                endpoint.webhookContribution,
                eventContribution.durablePushWebhookContribution,
            )
        ) fail("observation_target_changed");
    } else {
        if (!eventContribution.supportsCheckpointedPull) {
            fail("event_contribution_not_current");
        }
        if (
            trigger.observationTransport !== "checkpointedPull"
            || !sourceTargetMatchesCaller(trigger, params.caller)
        ) fail("observation_target_changed");
    }

    const key = { triggerId: params.input.triggerId };
    const existing = await params.tx.automationEventSourceStatus.findUnique({
        where: key,
        select: {
            triggerRevision: true,
            observedCount: true,
            admittedCount: true,
            skippedCount: true,
            revision: true,
        },
    });
    const currentRevisionStatus = existing?.triggerRevision === params.input.triggerRevision
        ? existing
        : null;
    const values = {
        eventPluginId: params.input.eventRef.pluginId,
        eventLocalId: params.input.eventRef.localId,
        sourceSelectorId: params.input.sourceSelectorId,
        triggerRevision: params.input.triggerRevision,
        reporterMachineId: params.caller.machineId,
        reporterMachineInstallationId: params.caller.machineInstallationId,
        reporterMaterializationId: params.caller.materializationId,
        // The materialization release still owns manifest currentness. Recovery
        // provenance instead records the exact host-stamped contributor bytes.
        reporterImmutableGenerationId: params.caller.immutableGenerationId,
        state: params.input.state,
        code: params.input.code === "none" ? null : params.input.code,
        lastObservedAt: toNullableDate(params.input.lastObservedAt),
        lastDispositionAt: toNullableDate(params.input.lastDispositionAt),
        nextRetryAt: toNullableDate(params.input.nextRetryAt),
        observedCount: addBoundedCounter(
            currentRevisionStatus?.observedCount ?? 0,
            params.input.observedDelta,
        ),
        admittedCount: addBoundedCounter(
            currentRevisionStatus?.admittedCount ?? 0,
            params.input.admittedDelta,
        ),
        skippedCount: addBoundedCounter(
            currentRevisionStatus?.skippedCount ?? 0,
            params.input.skippedDelta,
        ),
        revision: addBoundedCounter(existing?.revision ?? 0, 1),
    };
    await params.tx.automationEventSourceStatus.upsert({
        where: key,
        create: { ...key, ...values },
        update: values,
    });
    await markAutomationSourceStatusChangedTx({
        tx: params.tx,
        accountId: params.accountId,
    });
}

async function reportCatalogStatus(params: Readonly<{
    tx: Tx;
    accountId: string;
    caller: AutomationEventSourceStatusCallerV1;
    callerVersion: string;
    input: Extract<AutomationEventSourceStatusReportV1, { kind: "catalogReconciliation" }>;
}>): Promise<void> {
    let scopeKey: "checkpointedPull" | `durablePush:${string}`;
    if (params.input.scope.kind === "checkpointedPull") {
        scopeKey = "checkpointedPull";
        await assertCurrentCheckpointedPullCatalogScope({
            tx: params.tx,
            accountId: params.accountId,
            pluginId: params.caller.pluginId,
            version: params.callerVersion,
        });
    } else {
        scopeKey = `durablePush:${params.input.scope.webhookEndpointId}`;
        await assertCurrentDurablePushCatalogScope({
            tx: params.tx,
            accountId: params.accountId,
            caller: params.caller,
            callerVersion: params.callerVersion,
            webhookEndpointId: params.input.scope.webhookEndpointId,
        });
    }
    const catalog = await params.tx.automationEventCatalogState.findUnique({
        where: { accountId: params.accountId },
        select: { eventSourceDefinitionsRevision: true },
    });
    if (!catalog) fail("catalog_state_unavailable");
    const currentRevision = catalog.eventSourceDefinitionsRevision;
    const observedRevision = BigInt(params.input.observedRevision);
    const adoptedRevision = params.input.adoptedRevision === null
        ? null
        : BigInt(params.input.adoptedRevision);
    if (observedRevision > currentRevision || (adoptedRevision !== null && adoptedRevision > currentRevision)) {
        fail("catalog_revision_ahead");
    }
    if (params.input.state === "current" && observedRevision !== currentRevision) {
        fail("catalog_revision_not_current");
    }

    const key = {
        accountId: params.accountId,
        eventPluginId: params.caller.pluginId,
        reporterMaterializationId: params.caller.materializationId,
        scopeKey,
    };
    const existing = await params.tx.automationEventSourceCatalogStatus.findUnique({
        where: {
            accountId_eventPluginId_reporterMaterializationId_scopeKey:
                key,
        },
        select: { revision: true },
    });
    const values = {
        reporterMachineId: params.caller.machineId,
        reporterMachineInstallationId: params.caller.machineInstallationId,
        // Runtime currentness stays with the exact-generation CLI owner. The
        // server persists the generation that authored this report as bounded
        // immutable provenance beside the materialization facts it can verify.
        reporterImmutableGenerationId: params.caller.immutableGenerationId,
        observedRevision,
        adoptedRevision,
        state: params.input.state,
        scanStartedAt: toNullableDate(params.input.scanStartedAt),
        nextRetryAt: toNullableDate(params.input.nextRetryAt),
        reportedAt: new Date(),
        revision: addBoundedCounter(existing?.revision ?? 0, 1),
    };
    await params.tx.automationEventSourceCatalogStatus.upsert({
        where: {
            accountId_eventPluginId_reporterMaterializationId_scopeKey:
                key,
        },
        create: { ...key, ...values },
        update: values,
    });
    await markAutomationSourceStatusChangedTx({
        tx: params.tx,
        accountId: params.accountId,
    });
}

/** Sole writer for Automation-owned source and watcher-catalog summaries. */
export async function reportAutomationEventSourceStatusV1(params: Readonly<{
    accountId: string;
    caller: AutomationEventSourceStatusCallerV1;
    input: unknown;
}>): Promise<Record<string, never>> {
    const input = AutomationEventSourceStatusReportV1Schema.parse(params.input);
    const serverIdentityId = await getOrCreateServerIdentityId(process.env);
    await inTx(async (tx) => {
        const caller = await assertCurrentCallerMaterialization({
            tx,
            accountId: params.accountId,
            serverIdentityId,
            caller: params.caller,
        });
        if (input.kind === "source") {
            await reportSourceStatus({
                tx,
                accountId: params.accountId,
                caller: params.caller,
                callerVersion: caller.version,
                input,
            });
            return;
        }
        await reportCatalogStatus({
            tx,
            accountId: params.accountId,
            caller: params.caller,
            callerVersion: caller.version,
            input,
        });
    });
    return {};
}
