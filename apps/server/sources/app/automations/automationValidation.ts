import { z } from "zod";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";

import { computeNextDueAtForAutomation } from "./automationSchedulingService";

import type {
    AutomationAssignmentInput,
    AutomationPatchInput,
    AutomationUpsertInput,
} from "./automationTypes";

export class AutomationValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AutomationValidationError";
    }
}

const MAX_TEMPLATE_CIPHERTEXT_CHARS = 220_000;
const MAX_TEMPLATE_PAYLOAD_CIPHERTEXT_CHARS = 200_000;

const AssignmentSchema = z.object({
    machineId: z.string().trim().min(1),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(-100).max(100).optional(),
}).strict();

const ScheduleSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("interval"),
        everyMs: z.number().int().min(1_000),
        timezone: z.string().trim().min(1).optional().nullable(),
    }).strict(),
    z.object({
        kind: z.literal("cron"),
        scheduleExpr: z.string().trim().min(1).max(256),
        timezone: z.string().trim().min(1).optional().nullable(),
    }).strict(),
]);

const TemplateEnvelopeSchema = z.object({
    kind: z.literal("happier_automation_template_encrypted_v1"),
    payloadCiphertext: z.string().trim().min(1).max(MAX_TEMPLATE_PAYLOAD_CIPHERTEXT_CHARS),
    existingSessionId: z.string().trim().min(1).max(128).optional(),
}).strict();

const UpsertSchema = z.object({
    name: z.string().trim().min(1).max(128),
    description: z.string().max(2_000).optional().nullable(),
    enabled: z.boolean().default(true),
    schedule: ScheduleSchema,
    targetType: z.enum(["new_session", "existing_session"]),
    templateCiphertext: z.string().trim().min(1).max(MAX_TEMPLATE_CIPHERTEXT_CHARS),
    assignments: z.array(AssignmentSchema).max(50).optional(),
}).strict();

const PatchSchema = z.object({
    name: z.string().trim().min(1).max(128).optional(),
    description: z.string().max(2_000).optional().nullable(),
    enabled: z.boolean().optional(),
    schedule: ScheduleSchema.optional(),
    targetType: z.enum(["new_session", "existing_session"]).optional(),
    templateCiphertext: z.string().trim().min(1).max(MAX_TEMPLATE_CIPHERTEXT_CHARS).optional(),
    assignments: z.array(AssignmentSchema).max(50).optional(),
}).strict();

function toMessage(error: z.ZodError): string {
    const issue = error.issues[0];
    if (!issue) return "Invalid automation payload";
    const path = issue.path.join(".") || "payload";
    return `${path}: ${issue.message}`;
}

function normalizeAssignments(assignments: ReadonlyArray<AutomationAssignmentInput> | undefined): ReadonlyArray<AutomationAssignmentInput> | undefined {
    if (!assignments) return undefined;

    const deduped = new Map<string, AutomationAssignmentInput>();
    for (const item of assignments) {
        deduped.set(item.machineId, item);
    }
    return Array.from(deduped.values());
}

function assertEncryptedTemplateEnvelope(templateCiphertext: string): void {
    let parsed: unknown;
    try {
        parsed = JSON.parse(templateCiphertext);
    } catch {
        throw new AutomationValidationError("templateCiphertext must be valid JSON");
    }

    const envelope = TemplateEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
        throw new AutomationValidationError(`templateCiphertext: ${toMessage(envelope.error)}`);
    }
}

function assertScheduleIsComputable(schedule: { kind: "interval" | "cron"; everyMs?: number; scheduleExpr?: string; timezone?: string | null }): void {
    const now = new Date();
    const due = computeNextDueAtForAutomation({
        now,
        scheduleKind: schedule.kind,
        everyMs: schedule.kind === "interval" ? (schedule.everyMs ?? null) : null,
        scheduleExpr: schedule.kind === "cron" ? (schedule.scheduleExpr ?? null) : null,
        timezone: schedule.timezone ?? null,
    });
    if (!due) {
        throw new AutomationValidationError("schedule: unsupported or invalid schedule");
    }
}

export function parseAutomationUpsertInput(raw: unknown): AutomationUpsertInput {
    const parsed = UpsertSchema.safeParse(raw);
    if (!parsed.success) {
        throw new AutomationValidationError(toMessage(parsed.error));
    }

    if (
        parsed.data.targetType === "existing_session"
        && !isServerFeatureEnabledForRequest("automations.existingSessionTarget", process.env)
    ) {
        throw new AutomationValidationError("targetType existing_session is disabled by server configuration");
    }
    assertEncryptedTemplateEnvelope(parsed.data.templateCiphertext);
    assertScheduleIsComputable(parsed.data.schedule);

    return {
        ...parsed.data,
        assignments: normalizeAssignments(parsed.data.assignments),
    };
}

export function parseAutomationPatchInput(raw: unknown): AutomationPatchInput {
    const parsed = PatchSchema.safeParse(raw);
    if (!parsed.success) {
        throw new AutomationValidationError(toMessage(parsed.error));
    }

    if (
        parsed.data.targetType === "existing_session"
        && !isServerFeatureEnabledForRequest("automations.existingSessionTarget", process.env)
    ) {
        throw new AutomationValidationError("targetType existing_session is disabled by server configuration");
    }
    if (typeof parsed.data.templateCiphertext === "string") {
        assertEncryptedTemplateEnvelope(parsed.data.templateCiphertext);
    }
    if (parsed.data.schedule) {
        assertScheduleIsComputable(parsed.data.schedule);
    }

    return {
        ...parsed.data,
        assignments: normalizeAssignments(parsed.data.assignments),
    };
}
