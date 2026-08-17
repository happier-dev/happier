import type { Tx } from "@/storage/inTx";
import {
    AutomationRunExecutionInputV1Schema,
    normalizeAutomationTemplateEnvelopeStoredRead,
    parseAutomationRunExecutionRecipeV1,
    serializeAutomationRunExecutionRecipeV1,
    type AutomationRunExecutionInputV1,
    type AutomationRunExecutionRecipeOriginV1,
    type AutomationRunExecutionRecipeV1,
} from "@happier-dev/protocol";

import { computeNextDueAtForAutomation } from "./automationSchedulingService";
import { automationRunItemSelect } from "./automationPersistenceSelect";
import {
    AUTOMATION_RUN_TERMINAL_STATES,
    initialAutomationExecutionDispatchStateForRun,
    isAutomationLegacyTargetType,
    type AutomationRunItem,
    type AutomationScheduleKind,
    type AutomationTargetType,
} from "./automationTypes";

type FrozenAutomationRunOrigin =
    | AutomationRunExecutionInputV1["origin"]
    | AutomationRunExecutionRecipeOriginV1;

function requireScheduledRun<T extends { scheduledAt: Date | null }>(run: T): T & AutomationRunItem {
    if (run.scheduledAt === null) {
        throw new Error("Scheduled and immediate Automation runs require scheduledAt");
    }
    return run as T & AutomationRunItem;
}

/**
 * The queue is the sole owner that turns an admitted Definition into an
 * immutable Run input. Current strict recipes retain their exact wire bytes;
 * exact released V2 Definitions are read-compatible only and freeze through
 * the predecessor Run-input envelope. No malformed or strict-like-invalid
 * Definition may fall through to that predecessor reader.
 */
export function freezeAutomationRunExecutionRecipe(params: {
    targetType: AutomationTargetType;
    templateVersion: number;
    templateCiphertext: string;
    origin: FrozenAutomationRunOrigin;
    triggerEvidence?: NonNullable<AutomationRunExecutionRecipeV1["triggerEvidence"]>;
}): string {
    const parsed = parseAutomationRunExecutionRecipeV1(params.templateCiphertext);
    if (parsed.kind === "available") {
        if (parsed.recipe.triggerEvidence !== null) {
            throw new Error("Current Automation Definition recipes cannot carry occurrence evidence");
        }
        if (parsed.recipe.templateVersion !== params.templateVersion) {
            throw new Error("Current Automation definition recipe version does not match its template version");
        }
        const targetType = parsed.recipe.target.kind === "newSession"
            ? "new_session"
            : parsed.recipe.target.kind === "existingSession"
                ? "existing_session"
                : "execution_run";
        if (targetType !== params.targetType) {
            throw new Error("Current Automation definition recipe target does not match its target type");
        }
        if (params.triggerEvidence === undefined) {
            return parsed.serialized;
        }
        const frozen = serializeAutomationRunExecutionRecipeV1({
            ...parsed.recipe,
            triggerEvidence: params.triggerEvidence,
        });
        if (frozen.kind !== "available") {
            throw new Error("Current Automation Definition recipe cannot freeze trigger evidence");
        }
        return frozen.serialized;
    }

    if (!isAutomationLegacyTargetType(params.targetType)) {
        throw new Error("Current Automation definition has no valid strict execution recipe");
    }
    if (params.origin.kind !== "scheduled" && params.origin.kind !== "manual") {
        throw new Error("Released V2 Automation Definitions can only freeze scheduled or manual Runs");
    }
    let legacyDefinition: unknown;
    try {
        legacyDefinition = JSON.parse(params.templateCiphertext);
    } catch {
        throw new Error("Automation definition has neither a valid strict execution recipe nor a released V2 legacy definition");
    }
    if (!normalizeAutomationTemplateEnvelopeStoredRead(legacyDefinition)) {
        throw new Error("Automation definition has neither a valid strict execution recipe nor a released V2 legacy definition");
    }
    if (params.origin.kind === "scheduled") {
        return serializeLegacyAutomationRunExecutionInputV2({
            targetType: params.targetType,
            templateVersion: params.templateVersion,
            templateCiphertext: params.templateCiphertext,
            origin: {
                kind: "scheduled",
                scheduledFor: params.origin.scheduledFor,
            },
        });
    }
    return serializeLegacyAutomationRunExecutionInputV2({
        targetType: params.targetType,
        templateVersion: params.templateVersion,
        templateCiphertext: params.templateCiphertext,
        origin: {
            kind: "manual",
            invokedAt: params.origin.invokedAt,
        },
    });
}

/**
 * Read-only predecessor adapter for durable V2 Definition rows. Current
 * Definition writers remain strict-only; only the queue may materialize this
 * immutable Run snapshot after exact stored-read validation above.
 */
export function serializeLegacyAutomationRunExecutionInputV2(params: {
    targetType: AutomationTargetType;
    templateVersion: number;
    templateCiphertext: string;
    origin: AutomationRunExecutionInputV1["origin"];
}): string {
    return JSON.stringify(AutomationRunExecutionInputV1Schema.parse({
        kind: "happier_automation_run_execution_input_v1",
        targetType: params.targetType,
        templateVersion: params.templateVersion,
        templateCiphertext: params.templateCiphertext,
        origin: params.origin,
    }));
}

export function resolveScheduledRunDueAt(params: {
    now: Date;
    scheduleKind: AutomationScheduleKind;
    everyMs: number | null;
    scheduleExpr: string | null;
    timezone: string | null;
    nextRunAt: Date | null;
}): Date | null {
    const computedDueAt = computeNextDueAtForAutomation({
        now: params.now,
        scheduleKind: params.scheduleKind,
        everyMs: params.everyMs,
        scheduleExpr: params.scheduleExpr,
        timezone: params.timezone,
    });
    if (!computedDueAt) {
        return null;
    }

    return computedDueAt;
}

export async function enqueueImmediateRunTx(params: {
    tx: Tx;
    automationId: string;
    accountId: string;
    now: Date;
    occurrenceKey?: string | null;
}) {
    const automation = await params.tx.automation.findFirst({
        where: {
            id: params.automationId,
            accountId: params.accountId,
            deletedAt: null,
        },
        select: {
            targetType: true,
            templateVersion: true,
            templateCiphertext: true,
            assignments: {
                where: { enabled: true },
                select: { id: true },
                take: 1,
            },
        },
    });
    if (!automation) {
        throw new Error("Cannot enqueue an Automation Run for a missing Automation");
    }

    const executionInputEnvelope = freezeAutomationRunExecutionRecipe({
        ...automation,
        origin: { kind: "manual", invokedAt: params.now.getTime() },
    });
    const run = await params.tx.automationRun.create({
        data: {
            automationId: params.automationId,
            accountId: params.accountId,
            state: "queued",
            originKind: "manual",
            originOccurredAt: null,
            occurrenceKey: params.occurrenceKey ?? null,
            scheduledAt: params.now,
            dueAt: params.now,
            executionInputEnvelope,
            executionDispatchState: initialAutomationExecutionDispatchStateForRun(executionInputEnvelope),
        },
        select: automationRunItemSelect,
    });
    return requireScheduledRun(run);
}

export async function enqueueNextScheduledRunIfMissingTx(params: {
    tx: Tx;
    automationId: string;
    now: Date;
}) {
    const automation = await params.tx.automation.findUnique({
        where: { id: params.automationId },
        select: {
            id: true,
            accountId: true,
            enabled: true,
            deletedAt: true,
            triggerKind: true,
            scheduleKind: true,
            scheduleExpr: true,
            everyMs: true,
            timezone: true,
            nextRunAt: true,
            targetType: true,
            templateVersion: true,
            templateCiphertext: true,
        },
    });

    if (
        !automation
        || !automation.enabled
        || automation.deletedAt !== null
        || automation.triggerKind !== "schedule"
        || automation.scheduleKind === null
    ) {
        return null;
    }

    // Without a current claimant, a successor would be durable work with no
    // reachable worker. Assignment replacement re-enters here after its
    // canonical write, so this does not suppress reassignment wakes.
    const currentAssignment = await params.tx.automationAssignment.findFirst({
        where: { automationId: automation.id, enabled: true },
        select: { id: true },
    });
    if (!currentAssignment) return null;

    const existingOpenRun = await params.tx.automationRun.findFirst({
        where: {
            automationId: automation.id,
            originKind: "scheduled",
            state: { notIn: [...AUTOMATION_RUN_TERMINAL_STATES] },
        },
        select: { id: true },
    });
    if (existingOpenRun) {
        return null;
    }

    const dueAt = resolveScheduledRunDueAt({
        now: params.now,
        scheduleKind: automation.scheduleKind,
        everyMs: automation.everyMs,
        scheduleExpr: automation.scheduleExpr,
        timezone: automation.timezone,
        nextRunAt: automation.nextRunAt,
    });
    if (!dueAt) {
        await params.tx.automation.update({
            where: { id: automation.id },
            data: { nextRunAt: null },
        });
        return null;
    }

    const executionInputEnvelope = freezeAutomationRunExecutionRecipe({
        targetType: automation.targetType,
        templateVersion: automation.templateVersion,
        templateCiphertext: automation.templateCiphertext,
        origin: { kind: "scheduled", scheduledFor: dueAt.getTime() },
    });
    const run = await params.tx.automationRun.create({
        data: {
            automationId: automation.id,
            accountId: automation.accountId,
            state: "queued",
            originKind: "scheduled",
            originOccurredAt: null,
            scheduledAt: params.now,
            dueAt,
            executionInputEnvelope,
            executionDispatchState: initialAutomationExecutionDispatchStateForRun(executionInputEnvelope),
        },
        select: automationRunItemSelect,
    });

    await params.tx.automation.update({
        where: { id: automation.id },
        data: {
            nextRunAt: dueAt,
        },
    });

    return requireScheduledRun(run);
}
