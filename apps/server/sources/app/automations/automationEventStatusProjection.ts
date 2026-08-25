import {
    AutomationEventSourceStatusV1Schema,
    AutomationEventSourceCatalogStatusSchema,
    type AutomationEventSourceStatusV1,
    type AutomationEventSourceCatalogStatus,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";

import type { AutomationListItem } from "./automationTypes";

export type AutomationEventStatusProjection = Readonly<{
    sourceStatus: AutomationEventSourceStatusV1 | null;
    sourceCatalogStatus: AutomationEventSourceCatalogStatus | null;
}>;

type PluginEventAutomation = AutomationListItem & Readonly<{
    triggerKind: "pluginEvent";
}>;

type CatalogStatusLookup = Readonly<{
    automationId: string;
    accountId: string;
    eventPluginId: string;
    reporterMachineId: string;
    reporterMachineInstallationId: string;
    reporterMaterializationId: string;
    scopeKey: "checkpointedPull" | `durablePush:${string}`;
}>;

/**
 * The one reporter identity an Event Automation's current observation can carry:
 * its current watcher for `checkpointedPull`, or its current durable-push
 * endpoint target. Resolved once and reused by both summaries.
 */
type CurrentSourceReporter = Pick<
    CatalogStatusLookup,
    "reporterMachineId" | "reporterMachineInstallationId" | "reporterMaterializationId"
>;

function catalogStatusLookupKey(lookup: Omit<CatalogStatusLookup, "automationId">): string {
    return JSON.stringify([
        lookup.accountId,
        lookup.eventPluginId,
        lookup.reporterMachineId,
        lookup.reporterMachineInstallationId,
        lookup.reporterMaterializationId,
        lookup.scopeKey,
    ]);
}

function sourceStatusFromRow(row: Readonly<{
    automationId: string;
    eventPluginId: string;
    eventLocalId: string;
    sourceSelectorId: string;
    templateVersion: number;
    reporterMachineId: string;
    reporterMaterializationId: string;
    reporterImmutableGenerationId: string | null;
    state: "uninitialized" | "baselined" | "observing" | "backingOff" | "attention";
    code: string | null;
    lastObservedAt: Date | null;
    lastDispositionAt: Date | null;
    nextRetryAt: Date | null;
    observedCount: number;
    admittedCount: number;
    skippedCount: number;
    revision: number;
}>): AutomationEventSourceStatusV1 {
    return AutomationEventSourceStatusV1Schema.parse({
        automationId: row.automationId,
        eventRef: { pluginId: row.eventPluginId, localId: row.eventLocalId },
        sourceSelectorId: row.sourceSelectorId,
        templateVersion: row.templateVersion,
        reporterMaterializationRef: {
            machineId: row.reporterMachineId,
            materializationId: row.reporterMaterializationId,
            pluginId: row.eventPluginId,
        },
        ...(row.reporterImmutableGenerationId === null
            ? {}
            : { reporterImmutableGenerationId: row.reporterImmutableGenerationId }),
        state: row.state,
        code: row.code,
        lastObservedAt: row.lastObservedAt?.getTime() ?? null,
        lastDispositionAt: row.lastDispositionAt?.getTime() ?? null,
        nextRetryAt: row.nextRetryAt?.getTime() ?? null,
        observedCount: row.observedCount,
        admittedCount: row.admittedCount,
        skippedCount: row.skippedCount,
        revision: row.revision,
    });
}

function catalogStatusFromRow(row: Readonly<{
    observedRevision: bigint;
    adoptedRevision: bigint | null;
    state: "current" | "reconciling" | "reconciliationLate";
    scanStartedAt: Date | null;
    nextRetryAt: Date | null;
}>): AutomationEventSourceCatalogStatus {
    return AutomationEventSourceCatalogStatusSchema.parse({
        observedRevision: row.observedRevision.toString(),
        adoptedRevision: row.adoptedRevision?.toString() ?? null,
        state: row.state,
        scanStartedAt: row.scanStartedAt?.getTime() ?? null,
        nextRetryAt: row.nextRetryAt?.getTime() ?? null,
    });
}

function checkpointedPullCatalogLookup(automation: PluginEventAutomation): CatalogStatusLookup | null {
    if (
        automation.triggerObservationTransport !== "checkpointedPull"
        || automation.triggerEventPluginId === null
        || automation.watcherMachineId === null
        || automation.watcherMachineInstallationId === null
        || automation.watcherPluginId !== automation.triggerEventPluginId
        || automation.watcherMaterializationId === null
    ) return null;
    return {
        automationId: automation.id,
        accountId: automation.accountId,
        eventPluginId: automation.triggerEventPluginId,
        reporterMachineId: automation.watcherMachineId,
        reporterMachineInstallationId: automation.watcherMachineInstallationId,
        reporterMaterializationId: automation.watcherMaterializationId,
        scopeKey: "checkpointedPull",
    };
}

/**
 * Batch definition reader for the one current Event source row and catalog status.
 * The persisted catalog key is never exposed: every row is joined back to the
 * current Automation watcher or durable-push endpoint target before it is
 * projected into the list/detail-safe DTO.
 */
export async function loadAutomationEventStatusProjections(params: Readonly<{
    automations: readonly AutomationListItem[];
}>): Promise<ReadonlyMap<string, AutomationEventStatusProjection>> {
    const projections = new Map<string, AutomationEventStatusProjection>();
    for (const automation of params.automations) {
        projections.set(automation.id, { sourceStatus: null, sourceCatalogStatus: null });
    }

    const eventAutomations = params.automations.filter(
        (automation): automation is PluginEventAutomation => automation.triggerKind === "pluginEvent",
    );
    if (eventAutomations.length === 0) return projections;
    const eventAutomationById = new Map(eventAutomations.map((automation) => [automation.id, automation]));

    const sourceStatusQueries = eventAutomations.flatMap((automation) => (
        automation.triggerEventPluginId === null
        || automation.triggerEventLocalId === null
        || automation.triggerSourceSelectorId === null
            ? []
            : [{
                automationId: automation.id,
                eventPluginId: automation.triggerEventPluginId,
                eventLocalId: automation.triggerEventLocalId,
                sourceSelectorId: automation.triggerSourceSelectorId,
            }]
    ));
    const durablePushAutomations = eventAutomations.flatMap((automation) => (
        automation.triggerObservationTransport !== "durablePush"
        || automation.triggerEventPluginId === null
        || automation.triggerWebhookEndpointId === null
            ? []
            : [automation]
    ));

    const [sourceStatusRows, durablePushEndpoints] = await Promise.all([
        sourceStatusQueries.length === 0
            ? Promise.resolve([])
            : db.automationEventSourceStatus.findMany({
                where: { OR: sourceStatusQueries },
                select: {
                    automationId: true,
                    eventPluginId: true,
                    eventLocalId: true,
                    sourceSelectorId: true,
                    templateVersion: true,
                    reporterMachineId: true,
                    reporterMachineInstallationId: true,
                    reporterMaterializationId: true,
                    reporterImmutableGenerationId: true,
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
            }),
        durablePushAutomations.length === 0
            ? Promise.resolve([])
            : db.pluginWebhookEndpoint.findMany({
                where: {
                    OR: durablePushAutomations.map((automation) => ({
                        id: automation.triggerWebhookEndpointId!,
                        accountId: automation.accountId,
                        pluginId: automation.triggerEventPluginId!,
                        enabled: true,
                        revokedAt: null,
                        releasedAt: null,
                        route: { enabled: true, revokedAt: null },
                    })),
                },
                select: {
                    id: true,
                    accountId: true,
                    pluginId: true,
                    targetMachineId: true,
                    targetMachineInstallationId: true,
                    targetMaterializationId: true,
                },
            }),
    ]);

    const endpointById = new Map(durablePushEndpoints.map((endpoint) => [endpoint.id, endpoint]));
    const catalogLookups = new Map<string, Omit<CatalogStatusLookup, "automationId">>();
    const catalogLookupKeysByAutomationId = new Map<string, string>();
    const currentReporterByAutomationId = new Map<string, CurrentSourceReporter>();
    const registerCatalogLookup = (lookup: CatalogStatusLookup): void => {
        const key = catalogStatusLookupKey(lookup);
        catalogLookups.set(key, lookup);
        catalogLookupKeysByAutomationId.set(lookup.automationId, key);
        currentReporterByAutomationId.set(lookup.automationId, {
            reporterMachineId: lookup.reporterMachineId,
            reporterMachineInstallationId: lookup.reporterMachineInstallationId,
            reporterMaterializationId: lookup.reporterMaterializationId,
        });
    };
    for (const automation of eventAutomations) {
        const checkpointedPull = checkpointedPullCatalogLookup(automation);
        if (checkpointedPull !== null) {
            registerCatalogLookup(checkpointedPull);
            continue;
        }
        if (
            automation.triggerObservationTransport !== "durablePush"
            || automation.triggerWebhookEndpointId === null
            || automation.triggerEventPluginId === null
        ) continue;
        const endpoint = endpointById.get(automation.triggerWebhookEndpointId);
        if (
            endpoint === undefined
            || endpoint.accountId !== automation.accountId
            || endpoint.pluginId !== automation.triggerEventPluginId
            || endpoint.targetMachineId === null
            || endpoint.targetMachineInstallationId === null
            || endpoint.targetMaterializationId === null
        ) continue;
        const durablePush: CatalogStatusLookup = {
            automationId: automation.id,
            accountId: automation.accountId,
            eventPluginId: automation.triggerEventPluginId,
            reporterMachineId: endpoint.targetMachineId,
            reporterMachineInstallationId: endpoint.targetMachineInstallationId,
            reporterMaterializationId: endpoint.targetMaterializationId,
            scopeKey: `durablePush:${endpoint.id}`,
        };
        registerCatalogLookup(durablePush);
    }

    // The retained summary row keeps whichever reporter wrote it last. The
    // status writer only accepts the Automation's current watcher or current
    // durable-push endpoint target, so a row whose reporter no longer matches
    // the resolved current one belongs to a reporter that can no longer
    // observe or report at all. Presenting its last `observing` state would
    // claim a settled observer is still healthy, so it is not projected.
    const sourceStatusByAutomationId = new Map<string, AutomationEventSourceStatusV1>();
    for (const row of sourceStatusRows) {
        const automation = eventAutomationById.get(row.automationId);
        const currentReporter = currentReporterByAutomationId.get(row.automationId);
        if (
            !automation
            || automation.triggerEventPluginId !== row.eventPluginId
            || automation.triggerEventLocalId !== row.eventLocalId
            || automation.triggerSourceSelectorId !== row.sourceSelectorId
            || automation.templateVersion !== row.templateVersion
            || currentReporter === undefined
            || currentReporter.reporterMachineId !== row.reporterMachineId
            || currentReporter.reporterMachineInstallationId !== row.reporterMachineInstallationId
            || currentReporter.reporterMaterializationId !== row.reporterMaterializationId
        ) continue;
        sourceStatusByAutomationId.set(row.automationId, sourceStatusFromRow(row));
    }

    const catalogRows = catalogLookups.size === 0
        ? []
        : await db.automationEventSourceCatalogStatus.findMany({
            where: {
                OR: Array.from(catalogLookups.values()).map((lookup) => ({
                    accountId: lookup.accountId,
                    eventPluginId: lookup.eventPluginId,
                    reporterMachineId: lookup.reporterMachineId,
                    reporterMachineInstallationId: lookup.reporterMachineInstallationId,
                    reporterMaterializationId: lookup.reporterMaterializationId,
                    scopeKey: lookup.scopeKey,
                })),
            },
            select: {
                accountId: true,
                eventPluginId: true,
                reporterMachineId: true,
                reporterMachineInstallationId: true,
                reporterMaterializationId: true,
                scopeKey: true,
                observedRevision: true,
                adoptedRevision: true,
                state: true,
                scanStartedAt: true,
                nextRetryAt: true,
            },
        });
    const catalogStatusByLookupKey = new Map<string, AutomationEventSourceCatalogStatus>();
    for (const row of catalogRows) {
        catalogStatusByLookupKey.set(catalogStatusLookupKey({
            accountId: row.accountId,
            eventPluginId: row.eventPluginId,
            reporterMachineId: row.reporterMachineId,
            reporterMachineInstallationId: row.reporterMachineInstallationId,
            reporterMaterializationId: row.reporterMaterializationId,
            scopeKey: row.scopeKey as CatalogStatusLookup["scopeKey"],
        }), catalogStatusFromRow(row));
    }

    for (const automation of eventAutomations) {
        const current = projections.get(automation.id);
        if (current === undefined) continue;
        const catalogLookupKey = catalogLookupKeysByAutomationId.get(automation.id);
        projections.set(automation.id, {
            sourceStatus: sourceStatusByAutomationId.get(automation.id) ?? null,
            sourceCatalogStatus: catalogLookupKey === undefined
                ? null
                : catalogStatusByLookupKey.get(catalogLookupKey) ?? null,
        });
    }
    return projections;
}
