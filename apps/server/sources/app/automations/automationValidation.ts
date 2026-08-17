import { z } from "zod";
import { isServerFeatureEnabledForRequest } from "@/app/features/catalog/serverFeatureGate";
import {
    AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND,
    AUTOMATION_TEMPLATE_PLAIN_V1_KIND,
    AutomationTemplateEnvelopeSchema,
    LegacyEncryptedAutomationTemplateEnvelopeSchema,
    LegacyPlainAutomationTemplateEnvelopeSchema,
    type AutomationEventFilterPayloadSchemaValidationIssueV1,
} from "@happier-dev/protocol";

import { computeNextDueAtForAutomation } from "./automationSchedulingService";

import type {
    AutomationAssignmentInput,
    AutomationLegacyTemplateEnvelopeAdmission,
    AutomationLegacyUpsertInput,
    AutomationPatchInput,
    AutomationScheduleInput,
} from "./automationTypes";

export class AutomationValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AutomationValidationError";
    }
}

/**
 * The Event declaration owns the payload schema; this carries its precise
 * authoring rejection through the server's existing validation boundary.
 */
export class AutomationEventFilterValidationError extends AutomationValidationError {
    readonly code: AutomationEventFilterPayloadSchemaValidationIssueV1["code"];
    readonly issue: AutomationEventFilterPayloadSchemaValidationIssueV1;

    constructor(issue: AutomationEventFilterPayloadSchemaValidationIssueV1) {
        super("Automation Event filter does not match the current payload schema");
        this.name = "AutomationEventFilterValidationError";
        this.code = issue.code;
        this.issue = issue;
    }
}

const MAX_TEMPLATE_CIPHERTEXT_CHARS = 220_000;

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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function readLegacyExistingSessionTemplateAdmission(
    templateCiphertext: string,
    targetType: "new_session" | "existing_session" | null,
): AutomationLegacyTemplateEnvelopeAdmission | undefined {
    if (targetType !== "existing_session") {
        return undefined;
    }

    try {
        const parsed = JSON.parse(templateCiphertext);
        const encrypted = LegacyEncryptedAutomationTemplateEnvelopeSchema.safeParse(parsed);
        if (encrypted.success && encrypted.data.existingSessionId) {
            return {
                kind: "legacy-encrypted-existing-session-v1",
                existingSessionId: encrypted.data.existingSessionId,
            };
        }
        const plain = LegacyPlainAutomationTemplateEnvelopeSchema.safeParse(parsed);
        if (!plain.success || !plain.data.existingSessionId || !isPlainRecord(plain.data.payload)) {
            return undefined;
        }
        const payloadExistingSessionId = typeof plain.data.payload.existingSessionId === "string"
            ? plain.data.payload.existingSessionId.trim()
            : "";
        if (payloadExistingSessionId !== plain.data.existingSessionId) return undefined;
        return {
            kind: "legacy-plain-existing-session-v1",
            existingSessionId: plain.data.existingSessionId,
        };
    } catch {
        return undefined;
    }
}

export function assertAutomationTemplateEnvelopeForAccountMode(
    templateCiphertext: string,
    accountMode: "e2ee" | "plain",
    targetType: "new_session" | "existing_session" | null,
    legacyTemplateEnvelopeAdmission?: AutomationLegacyTemplateEnvelopeAdmission,
): void {
    let parsed: unknown;
    try {
        parsed = JSON.parse(templateCiphertext);
    } catch {
        throw new AutomationValidationError("templateCiphertext must be valid JSON");
    }

    const currentEnvelope = AutomationTemplateEnvelopeSchema.safeParse(parsed);
    let envelope = currentEnvelope.success ? currentEnvelope.data : null;
    const canReadLegacyEnvelope = targetType === "existing_session"
        || legacyTemplateEnvelopeAdmission?.kind
            === "legacy-encrypted-existing-session-v1";
    if (!envelope && legacyTemplateEnvelopeAdmission && canReadLegacyEnvelope) {
        if (legacyTemplateEnvelopeAdmission.kind === "legacy-encrypted-existing-session-v1") {
            const legacy = LegacyEncryptedAutomationTemplateEnvelopeSchema.safeParse(parsed);
            if (
                legacy.success
                && legacy.data.existingSessionId === legacyTemplateEnvelopeAdmission.existingSessionId
            ) {
                envelope = {
                    kind: legacy.data.kind,
                    payloadCiphertext: legacy.data.payloadCiphertext,
                };
            }
        } else {
            const legacy = LegacyPlainAutomationTemplateEnvelopeSchema.safeParse(parsed);
            if (
                legacy.success
                && legacy.data.existingSessionId === legacyTemplateEnvelopeAdmission.existingSessionId
                && isPlainRecord(legacy.data.payload)
                && typeof legacy.data.payload.existingSessionId === "string"
                && legacy.data.payload.existingSessionId.trim()
                === legacyTemplateEnvelopeAdmission.existingSessionId
            ) {
                envelope = {
                    kind: legacy.data.kind,
                    payload: legacy.data.payload,
                };
            }
        }
    }
    if (!envelope) {
        if (currentEnvelope.success) {
            throw new AutomationValidationError("templateCiphertext: invalid template envelope");
        }
        throw new AutomationValidationError(`templateCiphertext: ${toMessage(currentEnvelope.error)}`);
    }

    if (accountMode === "e2ee") {
        if (envelope.kind !== AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND) {
            throw new AutomationValidationError("templateCiphertext: expected encrypted template envelope");
        }
        return;
    }

    if (
        envelope.kind === AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND
        && targetType === "existing_session"
    ) {
        return;
    }
    if (envelope.kind === AUTOMATION_TEMPLATE_ENCRYPTED_V1_KIND) {
        throw new AutomationValidationError(
            "templateCiphertext: encrypted templates in a plain account are reserved for existing_session targets",
        );
    }
    if (envelope.kind !== AUTOMATION_TEMPLATE_PLAIN_V1_KIND) {
        throw new AutomationValidationError("templateCiphertext: expected plaintext or encrypted template envelope");
    }

    const sessionDekCandidate = isPlainRecord(envelope.payload)
        ? envelope.payload["sessionEncryptionKeyBase64"]
        : null;
    if (typeof sessionDekCandidate === "string" && sessionDekCandidate.trim().length > 0) {
        throw new AutomationValidationError("templateCiphertext: plaintext templates must not include sessionEncryptionKeyBase64");
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

/**
 * Canonical Automation schedule admission for every API generation and the
 * persistence owner. Keeping cadence limits and cron computability here
 * prevents V3's discriminated wire shape from becoming a second validator.
 */
export function parseAutomationScheduleInput(raw: unknown): AutomationScheduleInput {
    const parsed = ScheduleSchema.safeParse(raw);
    if (!parsed.success) {
        throw new AutomationValidationError(toMessage(parsed.error));
    }
    assertScheduleIsComputable(parsed.data);
    return parsed.data;
}

export function parseAutomationUpsertInput(
    raw: unknown,
    opts?: Readonly<{
        accountMode?: "e2ee" | "plain";
        allowLegacyEncryptedExistingSessionTemplate?: boolean;
    }>,
): AutomationLegacyUpsertInput {
    const parsed = UpsertSchema.safeParse(raw);
    if (!parsed.success) {
        throw new AutomationValidationError(toMessage(parsed.error));
    }
    const schedule = parseAutomationScheduleInput(parsed.data.schedule);

    const accountMode = opts?.accountMode === "plain" ? "plain" : "e2ee";
    const legacyTemplateEnvelopeAdmission =
        opts?.allowLegacyEncryptedExistingSessionTemplate
            ? readLegacyExistingSessionTemplateAdmission(
                parsed.data.templateCiphertext,
                parsed.data.targetType,
            )
            : undefined;
    assertAutomationTemplateEnvelopeForAccountMode(
        parsed.data.templateCiphertext,
        accountMode,
        parsed.data.targetType,
        legacyTemplateEnvelopeAdmission,
    );

    return {
        ...parsed.data,
        schedule,
        assignments: normalizeAssignments(parsed.data.assignments),
        ...(legacyTemplateEnvelopeAdmission
            ? { legacyTemplateEnvelopeAdmission }
            : {}),
    };
}

export function parseAutomationPatchInput(
    raw: unknown,
    opts?: Readonly<{
        accountMode?: "e2ee" | "plain";
        allowLegacyEncryptedExistingSessionTemplate?: boolean;
        effectiveTargetType?: "new_session" | "existing_session";
    }>,
): AutomationPatchInput {
    const parsed = PatchSchema.safeParse(raw);
    if (!parsed.success) {
        throw new AutomationValidationError(toMessage(parsed.error));
    }
    if (!Object.values(parsed.data).some((value) => value !== undefined)) {
        throw new AutomationValidationError("Automation patch must include at least one field");
    }
    const schedule = parsed.data.schedule === undefined
        ? undefined
        : parseAutomationScheduleInput(parsed.data.schedule);

    if (typeof parsed.data.templateCiphertext === "string") {
        const accountMode = opts?.accountMode === "plain" ? "plain" : "e2ee";
        const targetType = parsed.data.targetType
            ?? opts?.effectiveTargetType
            ?? null;
        const legacyTemplateEnvelopeAdmission =
            opts?.allowLegacyEncryptedExistingSessionTemplate
                ? readLegacyExistingSessionTemplateAdmission(
                    parsed.data.templateCiphertext,
                    targetType,
                )
                : undefined;
        assertAutomationTemplateEnvelopeForAccountMode(
            parsed.data.templateCiphertext,
            accountMode,
            targetType,
            legacyTemplateEnvelopeAdmission,
        );
        return {
            ...parsed.data,
            ...(schedule ? { schedule } : {}),
            assignments: normalizeAssignments(parsed.data.assignments),
            ...(legacyTemplateEnvelopeAdmission
                ? { legacyTemplateEnvelopeAdmission }
                : {}),
        };
    }
    return {
        ...parsed.data,
        ...(schedule ? { schedule } : {}),
        assignments: normalizeAssignments(parsed.data.assignments),
    };
}
