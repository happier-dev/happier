import { AutomationEventSourceStatusV1Schema, explainAutomationEventSourceStatusV1, type AutomationEventSourceStatusV1 } from '@happier-dev/protocol/automations/automationEventSourceStatusV1';
import { AutomationEventSourceCatalogStatusSchema, type AutomationEventSourceCatalogStatus } from '@happier-dev/protocol/automations/automationTriggerProjectionV1';
import { automationEventSourceCatalogScopeKeyV1, type AutomationEventSourceCatalogScopeKeyV1 } from '@happier-dev/protocol/automations/automationActionSpecsV1';
import { type PluginMachineMaterializationRefV1 } from '@happier-dev/protocol/plugins/availability/materializationRefV1';

import { db } from "@/storage/db";

import { portableQueryChunks as automationPortableQueryChunks } from "@/storage/portableQueryChunks";
import type { AutomationListItem, AutomationTriggerItem } from "./automationTypes";

import { loadAutomationEventPayloadSchemas } from './automationEventPayloadSchemaProjection';
import type { PluginJsonSchemaV2 } from '@happier-dev/protocol/plugins/contributions/publicTypes';

export type AutomationEventStatusProjection = Readonly<{
    payloadSchema?: PluginJsonSchemaV2 | null;
    sourceStatus: AutomationEventSourceStatusV1 | null;
    sourceCatalogStatus: AutomationEventSourceCatalogStatus | null;
    durablePushEndpointMaterializationRef: PluginMachineMaterializationRefV1 | null;
}>;

type PluginEventTrigger = AutomationTriggerItem & Readonly<{ kind: "pluginEvent" }>;

type CatalogStatusLookup = Readonly<{
    triggerId: string;
    accountId: string;
    eventPluginId: string;
    reporterMachineId: string;
    reporterMachineInstallationId: string;
    reporterMaterializationId: string;
    // Protocol owns the durable scope-key grammar for the canonical scope
    // union; this reader never restates it.
    scopeKey: AutomationEventSourceCatalogScopeKeyV1;
}>;

/**
 * The one reporter identity an Event Automation's current observation can carry:
 * its current watcher for `checkpointedPull`/`socket`, or its current durable-push
 * endpoint target. Resolved once and reused by both summaries.
 */
type CurrentSourceReporter = Pick<
    CatalogStatusLookup,
    "reporterMachineId" | "reporterMachineInstallationId" | "reporterMaterializationId"
>;

function catalogStatusLookupKey(lookup: Omit<CatalogStatusLookup, "triggerId">): string {
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
    triggerId: string;
    automationId: string;
    triggerRevision: number;
    eventPluginId: string;
    eventLocalId: string;
    sourceSelectorId: string;
    reporterMachineId: string;
    reporterMachineInstallationId: string;
    reporterMaterializationId: string;
    reporterSourceCustody: unknown;
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
    const status = AutomationEventSourceStatusV1Schema.parse({
        automationId: row.automationId,
        triggerId: row.triggerId,
        triggerRevision: row.triggerRevision,
        eventRef: { pluginId: row.eventPluginId, localId: row.eventLocalId },
        sourceSelectorId: row.sourceSelectorId,
        reporterMaterializationRef: {
            machineId: row.reporterMachineId,
            materializationId: row.reporterMaterializationId,
            pluginId: row.eventPluginId,
        },
        reporterSourceCustody: row.reporterSourceCustody,
        // Historical generic failures without a deadline were already parked.
        // Expose that fact without rewriting the row or claiming admission recovered.
        state: row.state === "backingOff" && row.code === "admissionUnavailable" && row.nextRetryAt === null
            ? "attention" : row.state,
        code: row.code,
        lastObservedAt: row.lastObservedAt?.getTime() ?? null,
        lastDispositionAt: row.lastDispositionAt?.getTime() ?? null,
        nextRetryAt: row.nextRetryAt?.getTime() ?? null,
        observedCount: row.observedCount,
        admittedCount: row.admittedCount,
        skippedCount: row.skippedCount,
        revision: row.revision,
    });
    const explanation = explainAutomationEventSourceStatusV1(status.code);
    return explanation === undefined ? status : { ...status, explanation };
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
        // Retained 0.3 development rows may carry the removed diagnostic
        // threshold's state. Its underlying fact is still reconciliation.
        state: row.state === "reconciliationLate" ? "reconciling" : row.state,
        scanStartedAt: row.scanStartedAt?.getTime() ?? null,
        nextRetryAt: row.nextRetryAt?.getTime() ?? null,
    });
}

function assignedWatcherCatalogLookup(accountId: string, trigger: PluginEventTrigger): CatalogStatusLookup | null {
    // Checkpointed-pull and session-socket triggers both report through one
    // exact assigned watcher materialization; the scope key is the transport.
    if (
        (trigger.observationTransport !== "checkpointedPull"
            && trigger.observationTransport !== "socket")
        || trigger.eventPluginId === null
        || trigger.watcherMachineId === null
        || trigger.watcherMachineInstallationId === null
        || trigger.watcherPluginId !== trigger.eventPluginId
        || trigger.watcherMaterializationId === null
    ) return null;
    return {
        triggerId: trigger.id,
        accountId,
        eventPluginId: trigger.eventPluginId,
        reporterMachineId: trigger.watcherMachineId,
        reporterMachineInstallationId: trigger.watcherMachineInstallationId,
        reporterMaterializationId: trigger.watcherMaterializationId,
        scopeKey: automationEventSourceCatalogScopeKeyV1({ kind: trigger.observationTransport }),
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
    includePayloadSchemas?: true;
}>): Promise<ReadonlyMap<string, AutomationEventStatusProjection>> {
    const projections = new Map<string, AutomationEventStatusProjection>();
    const eventEntries = params.automations.flatMap((automation) => automation.triggers.flatMap((trigger) => {
        projections.set(trigger.id, {
            sourceStatus: null,
            sourceCatalogStatus: null,
            durablePushEndpointMaterializationRef: null,
        });
        return trigger.kind === "pluginEvent"
            ? [{ automation, trigger: trigger as PluginEventTrigger }]
            : [];
    }));
    if (eventEntries.length === 0) return projections;
    const eventEntryByTriggerId = new Map(eventEntries.map((entry) => [entry.trigger.id, entry]));
    const durablePushEntries = eventEntries.flatMap(({ automation, trigger }) => {
        if (
            trigger.observationTransport !== "durablePush"
            || trigger.eventPluginId === null
            || trigger.webhookEndpointId === null
        ) return [];
        return [{
            automation,
            trigger,
            eventPluginId: trigger.eventPluginId,
            webhookEndpointId: trigger.webhookEndpointId,
        }];
    });

    const [sourceStatusRows, durablePushEndpoints] = await Promise.all([
        Promise.all(automationPortableQueryChunks({
            values: eventEntries.map(({ trigger }) => trigger.id),
            bindingsPerValue: 1,
        }).map((chunk) => db.automationEventSourceStatus.findMany({
            where: { triggerId: { in: [...chunk] } },
            select: {
                triggerId: true,
                triggerRevision: true,
                eventPluginId: true,
                eventLocalId: true,
                sourceSelectorId: true,
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
        }))).then((chunks) => chunks.flat()),
        durablePushEntries.length === 0
            ? Promise.resolve([])
            : Promise.all(automationPortableQueryChunks({
                values: durablePushEntries,
                bindingsPerValue: 4,
            }).map((chunk) => db.pluginWebhookEndpoint.findMany({
                where: {
                    OR: chunk.map(({ automation, eventPluginId, webhookEndpointId }) => ({
                        id: webhookEndpointId,
                        accountId: automation.accountId,
                        pluginId: eventPluginId,
                        releasedAt: null,
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
            }))).then((chunks) => chunks.flat()),
    ]);

    const endpointById = new Map(durablePushEndpoints.map((endpoint) => [endpoint.id, endpoint]));
    const catalogLookups = new Map<string, Omit<CatalogStatusLookup, "triggerId">>();
    const catalogLookupKeysByTriggerId = new Map<string, string>();
    const currentReporterByTriggerId = new Map<string, CurrentSourceReporter>();
    const durablePushEndpointMaterializationRefByTriggerId = new Map<
        string,
        PluginMachineMaterializationRefV1
    >();
    const registerCatalogLookup = (lookup: CatalogStatusLookup): void => {
        const key = catalogStatusLookupKey(lookup);
        catalogLookups.set(key, lookup);
        catalogLookupKeysByTriggerId.set(lookup.triggerId, key);
        currentReporterByTriggerId.set(lookup.triggerId, {
            reporterMachineId: lookup.reporterMachineId,
            reporterMachineInstallationId: lookup.reporterMachineInstallationId,
            reporterMaterializationId: lookup.reporterMaterializationId,
        });
    };
    for (const { automation, trigger } of eventEntries) {
        const assignedWatcher = assignedWatcherCatalogLookup(automation.accountId, trigger);
        if (assignedWatcher !== null) {
            registerCatalogLookup(assignedWatcher);
            continue;
        }
        if (
            trigger.observationTransport !== "durablePush"
            || trigger.webhookEndpointId === null
            || trigger.eventPluginId === null
        ) continue;
        const endpoint = endpointById.get(trigger.webhookEndpointId);
        if (
            endpoint === undefined
            || endpoint.accountId !== automation.accountId
            || endpoint.pluginId !== trigger.eventPluginId
            || endpoint.targetMachineId === null
            || endpoint.targetMachineInstallationId === null
            || endpoint.targetMaterializationId === null
        ) continue;
        const durablePush: CatalogStatusLookup = {
            triggerId: trigger.id,
            accountId: automation.accountId,
            eventPluginId: trigger.eventPluginId,
            reporterMachineId: endpoint.targetMachineId,
            reporterMachineInstallationId: endpoint.targetMachineInstallationId,
            reporterMaterializationId: endpoint.targetMaterializationId,
            scopeKey: automationEventSourceCatalogScopeKeyV1({
                kind: "durablePush",
                webhookEndpointId: endpoint.id,
            }),
        };
        durablePushEndpointMaterializationRefByTriggerId.set(trigger.id, {
            machineId: endpoint.targetMachineId,
            materializationId: endpoint.targetMaterializationId,
            pluginId: endpoint.pluginId,
        });
        registerCatalogLookup(durablePush);
    }

    const payloadSchemas = params.includePayloadSchemas ? await loadAutomationEventPayloadSchemas(eventEntries.flatMap(({ automation, trigger }) => {
        const reporter = currentReporterByTriggerId.get(trigger.id);
        if (!reporter || trigger.eventPluginId === null || trigger.eventLocalId === null || trigger.sourceContractVersion === null) return [];
        return [{ triggerId: trigger.id, accountId: automation.accountId, pluginId: trigger.eventPluginId,
            eventLocalId: trigger.eventLocalId, sourceContractVersion: trigger.sourceContractVersion,
            machineId: reporter.reporterMachineId, machineInstallationId: reporter.reporterMachineInstallationId,
            materializationId: reporter.reporterMaterializationId }];
    })) : null;

    // The retained summary row keeps whichever reporter wrote it last. The
    // status writer only accepts the Automation's current watcher or current
    // durable-push endpoint target, so a row whose reporter no longer matches
    // the resolved current one belongs to a reporter that can no longer
    // observe or report at all. Presenting its last `observing` state would
    // claim a settled observer is still healthy, so it is not projected.
    const sourceStatusByTriggerId = new Map<string, AutomationEventSourceStatusV1>();
    for (const row of sourceStatusRows) {
        const entry = eventEntryByTriggerId.get(row.triggerId);
        const currentReporter = currentReporterByTriggerId.get(row.triggerId);
        if (
            !entry
            || entry.trigger.eventPluginId !== row.eventPluginId
            || entry.trigger.eventLocalId !== row.eventLocalId
            || entry.trigger.sourceSelectorId !== row.sourceSelectorId
            || entry.trigger.revision !== row.triggerRevision
            || currentReporter === undefined
            || currentReporter.reporterMachineId !== row.reporterMachineId
            || currentReporter.reporterMachineInstallationId !== row.reporterMachineInstallationId
            || currentReporter.reporterMaterializationId !== row.reporterMaterializationId
        ) continue;
        sourceStatusByTriggerId.set(row.triggerId, sourceStatusFromRow({
            ...row,
            automationId: entry.automation.id,
            triggerRevision: row.triggerRevision,
            reporterSourceCustody: row.reporterSourceCustody,
        }));
    }

    const catalogRows = catalogLookups.size === 0
        ? []
        : (await Promise.all(automationPortableQueryChunks({
            values: [...catalogLookups.values()],
            bindingsPerValue: 6,
        }).map((chunk) => db.automationEventSourceCatalogStatus.findMany({
            where: {
                OR: chunk.map((lookup) => ({
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
        })))).flat();
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

    for (const { trigger } of eventEntries) {
        const current = projections.get(trigger.id);
        if (current === undefined) continue;
        const catalogLookupKey = catalogLookupKeysByTriggerId.get(trigger.id);
        projections.set(trigger.id, {
            ...(payloadSchemas ? { payloadSchema: payloadSchemas.get(trigger.id) ?? null } : {}),
            sourceStatus: sourceStatusByTriggerId.get(trigger.id) ?? null,
            sourceCatalogStatus: catalogLookupKey === undefined
                ? null
                : catalogStatusByLookupKey.get(catalogLookupKey) ?? null,
            durablePushEndpointMaterializationRef:
                durablePushEndpointMaterializationRefByTriggerId.get(trigger.id) ?? null,
        });
    }
    return projections;
}
