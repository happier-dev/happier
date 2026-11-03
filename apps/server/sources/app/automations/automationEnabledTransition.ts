import type { Tx } from "@/storage/inTx";
import type { AutomationListItem } from "./automationTypes";

export async function ensureAutomationEventCatalogStateTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    projectionChanged: boolean;
}>): Promise<void> {
    await params.tx.automationEventCatalogState.upsert({
        where: { accountId: params.accountId },
        create: {
            accountId: params.accountId,
            eventSourceDefinitionsRevision: params.projectionChanged ? 1n : 0n,
        },
        update: params.projectionChanged
            ? { eventSourceDefinitionsRevision: { increment: 1n } }
            : {},
    });
}

/** Apply the source and schedule effects of a locked definition's enablement change. */

export async function applyAutomationEnabledTransitionTx(params: Readonly<{
    tx: Tx;
    accountId: string;
    existing: Pick<AutomationListItem, "id" | "enabled" | "triggers">;
    enabled: boolean;
    now: Date;
    /** Other edits in the same definition mutation changed the Event projection. */
    eventProjectionChanged?: boolean;
}>): Promise<void> {
    const { tx, existing } = params;
    if (!existing.enabled && params.enabled) {
        await tx.automationTrigger.updateMany({
            where: {
                automationId: existing.id,
                kind: "pluginEvent",
                enabled: true,
                deletedAt: null,
                observationTransport: "durablePush",
            },
            data: { observationStartsAt: params.now },
        });
    }

    const eventProjectionChanged = params.eventProjectionChanged === true
        || (existing.enabled !== params.enabled
            && existing.triggers.some(trigger => trigger.kind === "pluginEvent"));
    if (eventProjectionChanged) {
        await ensureAutomationEventCatalogStateTx({
            tx,
            accountId: params.accountId,
            projectionChanged: eventProjectionChanged,
        });
    }

    if (existing.enabled && !params.enabled) {
        await tx.automationTrigger.updateMany({
            where: {
                automationId: existing.id,
                kind: "schedule",
                deletedAt: null,
            },
            data: { nextRunAt: null },
        });
    }
}
