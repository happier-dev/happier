import { isDeepStrictEqual } from "node:util";

import { AutomationEventSourceStatusReportV1Schema, automationEventSourceCatalogScopeKeyV1, type AutomationEventSourceStatusReportV1 } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { type ParsedPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import { PluginSourceCustodyV1Schema, pluginSourceCustodyV1Equal, type PluginSourceCustodyV1 } from '@happier-dev/protocol/plugins/runtime/sourceCustody';

import { emitAutomationSourceStatusUpdated } from "@/app/automations/automationChangePublisher";
import { beforeAccountChangePublication, markAccountChanged } from "@/app/changes/markAccountChanged";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { afterTx, inTx, TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/prisma";

import {
    assertCurrentAutomationEventCallerMaterializationTx,
    readCurrentAutomationEventDurablePushEndpointTargetTxV1,
    readCurrentAutomationEventDurablePushWebhookContributionV1,
    resolveCurrentAutomationEventContributionFromManifest,
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

function sameReporterSourceCustody(stored: unknown, current: PluginSourceCustodyV1): boolean {
    // JSON storage and HTTP admission can produce different object prototypes.
    // Custody equality belongs to its protocol owner, including nested variants.
    const parsed = PluginSourceCustodyV1Schema.safeParse(stored);
    return parsed.success && pluginSourceCustodyV1Equal(parsed.data, current);
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
        emitAutomationSourceStatusUpdated({ accountId: params.accountId, cursor: cursor.resolveCursor() });
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

/**
 * The plugin declaration this report admitted, keyed by its caller identity. One report attempt
 * resolves each declaration once (`automationEventCurrentness`: "once at the shared boundary");
 * the publication-time recheck reuses it instead of re-reading manifests under the Account lock.
 */
type AdmittedManifests = Map<string, Promise<ParsedPluginManifestV2>>;

async function resolveCurrentEventManifest(params: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    version: string;
    machineId: string;
    machineInstallationId: string;
    manifests: AdmittedManifests;
}>): Promise<ParsedPluginManifestV2> {
    const key = [params.pluginId, params.version, params.machineId, params.machineInstallationId].join("\0");
    let manifest = params.manifests.get(key);
    if (!manifest) {
        const { manifests: _manifests, ...read } = params;
        manifest = resolveCurrentAutomationEventManifestTx(read);
        params.manifests.set(key, manifest);
    }
    try {
        return await manifest;
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
    machineId: string;
    machineInstallationId: string;
    eventLocalId: string;
    sourceContractVersion: number;
    manifests: AdmittedManifests;
}>): Promise<Readonly<{
    supportsCheckpointedPull: boolean;
    supportsSocket: boolean;
    durablePushWebhookContribution: Readonly<{ pluginId: string; localId: string }> | null;
}>> {
    const { eventLocalId, sourceContractVersion, ...manifestRead } = params;
    const manifest = await resolveCurrentEventManifest(manifestRead);
    let event;
    try {
        event = resolveCurrentAutomationEventContributionFromManifest({ manifest, eventLocalId, sourceContractVersion });
    } catch (error) {
        if (error instanceof AutomationEventCurrentnessError) fail(error.code);
        throw error;
    }
    return {
        supportsCheckpointedPull: event.automation.source.supportedObservationTransports
            .includes("checkpointedPull"),
        supportsSocket: event.automation.source.supportedObservationTransports
            .includes("socket"),
        durablePushWebhookContribution:
            readCurrentAutomationEventDurablePushWebhookContributionV1(event),
    };
}

async function assertCurrentCheckpointedPullCatalogScope(params: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    version: string;
    machineId: string;
    machineInstallationId: string;
    manifests: AdmittedManifests;
}>): Promise<void> {
    await assertCurrentCatalogScopeSupports({ ...params, transport: "checkpointedPull" });
}

async function assertCurrentSocketCatalogScope(params: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    version: string;
    machineId: string;
    machineInstallationId: string;
    manifests: AdmittedManifests;
}>): Promise<void> {
    await assertCurrentCatalogScopeSupports({ ...params, transport: "socket" });
}

async function assertCurrentCatalogScopeSupports(params: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId: string;
    version: string;
    machineId: string;
    machineInstallationId: string;
    transport: "checkpointedPull" | "socket";
    manifests: AdmittedManifests;
}>): Promise<void> {
    const manifest = await resolveCurrentEventManifest({
        tx: params.tx,
        accountId: params.accountId,
        pluginId: params.pluginId,
        version: params.version,
        machineId: params.machineId,
        machineInstallationId: params.machineInstallationId,
        manifests: params.manifests,
    });
    const supported = manifest.contributes.events.some((event) => (
        event.kind === "event"
        && event.automation?.eligible === true
        && event.automation.source.supportedObservationTransports.includes(params.transport)
    ));
    if (!supported) fail("event_contribution_not_current");
}

async function assertCurrentDurablePushCatalogScope(params: Readonly<{
    tx: Tx;
    accountId: string;
    caller: AutomationEventSourceStatusCallerV1;
    callerVersion: string;
    webhookEndpointId: string;
    manifests: AdmittedManifests;
}>): Promise<void> {
    const endpoint = await readCurrentAutomationEventDurablePushEndpointTargetTxV1({
        tx: params.tx,
        accountId: params.accountId,
        webhookEndpointId: params.webhookEndpointId,
        caller: params.caller,
        callerVersion: params.callerVersion,
        purpose: "observation",
    });
    if (endpoint === null) fail("observation_target_changed");

    const manifest = await resolveCurrentEventManifest({
        tx: params.tx,
        accountId: params.caller.materializationAccountId ?? params.accountId,
        pluginId: params.caller.pluginId,
        version: params.callerVersion,
        machineId: params.caller.machineId,
        machineInstallationId: params.caller.machineInstallationId,
        manifests: params.manifests,
    });
    const supported = manifest.contributes.events.some((event) => {
        if (event.kind !== "event") return false;
        const { automation } = event;
        if (automation?.eligible !== true) return false;
        const contribution = readCurrentAutomationEventDurablePushWebhookContributionV1({ ...event, automation });
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

type SourceStatusParams = Readonly<{
    tx: Tx;
    accountId: string;
    caller: AutomationEventSourceStatusCallerV1;
    callerVersion: string;
    input: Extract<AutomationEventSourceStatusReportV1, { kind: "source" }>;
    manifests: AdmittedManifests;
}>;

async function assertCurrentSourceStatusTarget(params: SourceStatusParams): Promise<void> {
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
        accountId: params.caller.materializationAccountId ?? params.accountId,
        pluginId: params.caller.pluginId,
        version: params.callerVersion,
        machineId: params.caller.machineId,
        machineInstallationId: params.caller.machineInstallationId,
        eventLocalId: params.input.eventRef.localId,
        sourceContractVersion: trigger.sourceContractVersion,
        manifests: params.manifests,
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
            purpose: "observation",
        });
        if (
            endpoint === null
            || !sameAutomationEventDurablePushWebhookContributionV1(
                endpoint.webhookContribution,
                eventContribution.durablePushWebhookContribution,
            )
        ) fail("observation_target_changed");
    } else {
        const requiredSupport = trigger.observationTransport === "socket"
            ? eventContribution.supportsSocket
            : eventContribution.supportsCheckpointedPull;
        if (!requiredSupport) {
            fail("event_contribution_not_current");
        }
        if (
            (trigger.observationTransport !== "checkpointedPull"
                && trigger.observationTransport !== "socket")
            || !sourceTargetMatchesCaller(trigger, params.caller)
        ) fail("observation_target_changed");
    }

}

async function reportSourceStatus(params: SourceStatusParams): Promise<void> {
    await assertCurrentSourceStatusTarget(params);
    const key = { triggerId: params.input.triggerId };
    const existing = await params.tx.automationEventSourceStatus.findUnique({
        where: key,
        select: {
            eventPluginId: true,
            eventLocalId: true,
            sourceSelectorId: true,
            triggerRevision: true,
            reporterMachineId: true,
            reporterMachineInstallationId: true,
            reporterMaterializationId: true,
            reporterSourceCustody: true,
            state: true,
            code: true,
            lastObservedAt: true,
            lastDispositionAt: true,
            nextRetryAt: true,
            observedCount: true,
            admittedCount: true,
            skippedCount: true,
            revision: true,
        },
    });
    const currentRevisionStatus = existing?.triggerRevision === params.input.triggerRevision
        ? existing
        : null;
    const semanticValues = {
        eventPluginId: params.input.eventRef.pluginId,
        eventLocalId: params.input.eventRef.localId,
        sourceSelectorId: params.input.sourceSelectorId,
        triggerRevision: params.input.triggerRevision,
        reporterMachineId: params.caller.machineId,
        reporterMachineInstallationId: params.caller.machineInstallationId,
        reporterMaterializationId: params.caller.materializationId,
        reporterSourceCustody: params.caller.sourceCustody,
        state: params.input.state,
        code: params.input.code === "none" ? null : params.input.code,
        lastObservedAt: params.input.lastObservedAt === undefined
            ? currentRevisionStatus?.lastObservedAt ?? null
            : toNullableDate(params.input.lastObservedAt),
        lastDispositionAt: params.input.lastDispositionAt === undefined
            ? currentRevisionStatus?.lastDispositionAt ?? null
            : toNullableDate(params.input.lastDispositionAt),
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
    };
    const { revision, reporterSourceCustody: existingCustody, ...existingValues } = existing ?? {};
    const { reporterSourceCustody, ...semanticFacts } = semanticValues;
    // A receipt has no independent freshness clock. Keep currentness admission
    // above, but advance its projection only when a source fact actually changes.
    if (existing && sameReporterSourceCustody(existingCustody, reporterSourceCustody)
        && isDeepStrictEqual(existingValues, semanticFacts)) return;
    const values = { ...semanticValues, revision: addBoundedCounter(revision ?? 0, 1) };
    if (existing) {
        const updated = await params.tx.automationEventSourceStatus.updateMany({
            where: { ...key, revision: existing.revision, triggerRevision: existing.triggerRevision },
            data: values,
        });
        if (updated.count !== 1) throw new TransactionReplayRequiredError("automation-event-source-status-conflict");
    } else {
        try {
            await params.tx.automationEventSourceStatus.create({ data: { ...key, ...values } });
        } catch (error) {
            if (isPrismaErrorCode(error, "P2002")) throw new TransactionReplayRequiredError("automation-event-source-status-conflict");
            throw error;
        }
    }
    await markAutomationSourceStatusChangedTx({
        tx: params.tx,
        accountId: params.accountId,
    });
}

type CatalogStatusParams = Readonly<{
    tx: Tx;
    accountId: string;
    caller: AutomationEventSourceStatusCallerV1;
    callerVersion: string;
    input: Extract<AutomationEventSourceStatusReportV1, { kind: "catalogReconciliation" }>;
    manifests: AdmittedManifests;
}>;

async function assertCurrentCatalogStatusTarget(params: CatalogStatusParams) {
    // Protocol owns the durable scope-key grammar for the canonical scope
    // union; this reporter only proves the scope is current.
    const scopeKey = automationEventSourceCatalogScopeKeyV1(params.input.scope);
    if (params.input.scope.kind === "checkpointedPull") {
        await assertCurrentCheckpointedPullCatalogScope({
            tx: params.tx,
            accountId: params.caller.materializationAccountId ?? params.accountId,
            pluginId: params.caller.pluginId,
            version: params.callerVersion,
            machineId: params.caller.machineId,
            machineInstallationId: params.caller.machineInstallationId,
            manifests: params.manifests,
        });
    } else if (params.input.scope.kind === "socket") {
        await assertCurrentSocketCatalogScope({
            tx: params.tx,
            accountId: params.caller.materializationAccountId ?? params.accountId,
            pluginId: params.caller.pluginId,
            version: params.callerVersion,
            machineId: params.caller.machineId,
            machineInstallationId: params.caller.machineInstallationId,
            manifests: params.manifests,
        });
    } else {
        await assertCurrentDurablePushCatalogScope({
            tx: params.tx,
            accountId: params.accountId,
            caller: params.caller,
            callerVersion: params.callerVersion,
            webhookEndpointId: params.input.scope.webhookEndpointId,
            manifests: params.manifests,
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

    return { scopeKey, observedRevision, adoptedRevision };
}

async function reportCatalogStatus(params: CatalogStatusParams): Promise<void> {
    const { scopeKey, observedRevision, adoptedRevision } = await assertCurrentCatalogStatusTarget(params);
    const key = {
        accountId: params.accountId,
        eventPluginId: params.caller.pluginId,
        // Materialization ids are Machine-local (including daemon-selected ids).
        reporterMachineId: params.caller.machineId,
        reporterMaterializationId: params.caller.materializationId,
        scopeKey,
    };
    const existing = await params.tx.automationEventSourceCatalogStatus.findUnique({
        where: {
            accountId_eventPluginId_reporterMachineId_reporterMaterializationId_scopeKey:
                key,
        },
        select: {
            reporterMachineId: true,
            reporterMachineInstallationId: true,
            reporterSourceCustody: true,
            observedRevision: true,
            adoptedRevision: true,
            state: true,
            scanStartedAt: true,
            nextRetryAt: true,
            revision: true,
        },
    });
    const semanticValues = {
        reporterMachineId: params.caller.machineId,
        reporterMachineInstallationId: params.caller.machineInstallationId,
        reporterSourceCustody: params.caller.sourceCustody,
        observedRevision,
        adoptedRevision,
        state: params.input.state,
        scanStartedAt: toNullableDate(params.input.scanStartedAt),
        nextRetryAt: toNullableDate(params.input.nextRetryAt),
    };
    if (
        existing
        && existing.reporterMachineId === semanticValues.reporterMachineId
        && existing.reporterMachineInstallationId === semanticValues.reporterMachineInstallationId
        && sameReporterSourceCustody(existing.reporterSourceCustody, semanticValues.reporterSourceCustody)
        && existing.observedRevision === semanticValues.observedRevision
        && existing.adoptedRevision === semanticValues.adoptedRevision
        && existing.state === semanticValues.state
        && existing.nextRetryAt?.getTime() === semanticValues.nextRetryAt?.getTime()
    ) return;
    const values = {
        ...semanticValues,
        reportedAt: new Date(),
        revision: addBoundedCounter(existing?.revision ?? 0, 1),
    };
    if (existing) {
        const updated = await params.tx.automationEventSourceCatalogStatus.updateMany({
            where: { ...key, revision: existing.revision },
            data: values,
        });
        if (updated.count !== 1) throw new TransactionReplayRequiredError("automation-event-source-status-conflict");
    } else {
        try {
            await params.tx.automationEventSourceCatalogStatus.create({ data: { ...key, ...values } });
        } catch (error) {
            if (isPrismaErrorCode(error, "P2002")) throw new TransactionReplayRequiredError("automation-event-source-status-conflict");
            throw error;
        }
    }
    await markAutomationSourceStatusChangedTx({
        tx: params.tx,
        accountId: params.accountId,
    });
}

async function readPluginMaterializationRevision(tx: Tx, machineId: string): Promise<bigint | null> {
    const machine = await tx.machine.findUnique({ where: { id: machineId }, select: { pluginMaterializationRevision: true } });
    return machine?.pluginMaterializationRevision ?? null;
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
        // Materialization replacement deletes this reporter's status rows in the same transaction
        // that advances this revision. Read it before admission so publication can refuse to
        // recreate a row the replacement already removed.
        const admittedMaterializationRevision = await readPluginMaterializationRevision(tx, params.caller.machineId);
        const caller = await assertCurrentCallerMaterialization({
            tx,
            accountId: params.accountId,
            serverIdentityId,
            caller: params.caller,
        });
        const manifests: AdmittedManifests = new Map();
        // Caller, declaration and target admission settle before the Account fence.
        // Compare only the revision that retires this reporter's persisted status.
        beforeAccountChangePublication(tx, [params.accountId], async currentTx => {
            if (await readPluginMaterializationRevision(currentTx, params.caller.machineId) !== admittedMaterializationRevision) {
                throw new TransactionReplayRequiredError("automation-event-source-status-materialization-changed");
            }
        });
        if (input.kind === "source") {
            await reportSourceStatus({
                tx,
                accountId: params.accountId,
                caller: params.caller,
                callerVersion: caller.version,
                input,
                manifests,
            });
            return;
        }
        await reportCatalogStatus({
            tx,
            accountId: params.accountId,
            caller: params.caller,
            callerVersion: caller.version,
            input,
            manifests,
        });
    }, {
        // Revision CAS preserves concurrent deltas; the publication revision comparison
        // prevents recreating status retired by materialization replacement.
        isolationLevel: "ReadCommitted",
        transactionClass: "automation-event-source-status-report",
    });
    return {};
}
