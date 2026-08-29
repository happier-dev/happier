import {
    AutomationTriggerDefinitionBindingV1Schema,
    AutomationStoredContentEnvelopeV1Schema,
    validateAutomationRunFailureDetailStoredEnvelopeOuterForModeV1,
    normalizeAutomationTemplateEnvelopeStoredRead,
    parseAutomationRunExecutionRecipeV1,
    validateAutomationTriggerDefinitionStoredEnvelopeOuterForModeV1,
    openAutomationTriggerDefinitionStoredEnvelopeV1,
    type AutomationTriggerDefinitionBindingV1,
    type AutomationStoredContentEnvelopeV1,
} from "@happier-dev/protocol";

export class AutomationStoredContentReadError extends Error {
    constructor(kind: "contentInvalid" | "modeMismatch") {
        super(kind === "modeMismatch"
            ? "Automation stored content mode does not match the Account"
            : "Automation stored content is invalid");
        this.name = "AutomationStoredContentReadError";
    }
}

export type AutomationStoredContentOuterValidation =
    | Readonly<{
        kind: "available";
        envelope: AutomationStoredContentEnvelopeV1;
    }>
    | Readonly<{ kind: "contentInvalid" }>
    | Readonly<{ kind: "modeMismatch" }>;

export type AutomationExecutionInputOuterValidation =
    | Readonly<{
        kind: "available";
        input: RetainedAutomationRunExecutionInputV2;
    }>
    | Readonly<{ kind: "contentInvalid" | "modeMismatch" }>;

/**
 * Projects the durable public definition identity into the one private
 * trigger-definition binding. A schedule has no private definition; null also
 * means a malformed Event row so callers must use their trigger
 * kind to distinguish those cases.
 */
export function readAutomationTriggerDefinitionBinding(params: Readonly<{
    automationId: string;
    triggerId: string;
    triggerRevision: number;
    triggerKind: string;
    triggerEventPluginId: string | null;
    triggerEventLocalId: string | null;
    triggerSourceSelectorId: string | null;
}>): AutomationTriggerDefinitionBindingV1 | null {
    const candidate = params.triggerKind === "pluginEvent"
        ? (
            params.triggerEventPluginId !== null
            && params.triggerEventLocalId !== null
            && params.triggerSourceSelectorId !== null
                ? {
                    v: 1,
                    automationId: params.automationId,
                    triggerId: params.triggerId,
                    triggerRevision: params.triggerRevision,
                    triggerKind: "pluginEvent" as const,
                    eventRef: {
                        pluginId: params.triggerEventPluginId,
                        localId: params.triggerEventLocalId,
                    },
                    sourceSelectorId: params.triggerSourceSelectorId,
                }
                : null
        )
        : null;
    if (candidate === null) return null;
    const parsed = AutomationTriggerDefinitionBindingV1Schema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
}

/**
 * The trigger-definition-specific ciphertext-blind reader. It delegates
 * purpose and plaintext binding validation to Protocol rather than allowing
 * the generic outer-envelope path to accept a cross-field ciphertext.
 */
export function validateAutomationTriggerDefinitionEnvelopeOuterForMode(params: {
    raw: string;
    mode: "plain" | "e2ee";
    binding: AutomationTriggerDefinitionBindingV1;
}) {
    let raw: unknown;
    try {
        raw = JSON.parse(params.raw);
    } catch {
        return { kind: "contentInvalid" } as const;
    }
    return validateAutomationTriggerDefinitionStoredEnvelopeOuterForModeV1({
        mode: params.mode,
        binding: params.binding,
        envelope: raw,
    });
}

export function assertAutomationTriggerDefinitionEnvelopeOuterForMode(params: {
    raw: string | null;
    mode: "plain" | "e2ee";
    binding: AutomationTriggerDefinitionBindingV1;
}): void {
    if (params.raw === null) return;
    const validation = validateAutomationTriggerDefinitionEnvelopeOuterForMode({
        raw: params.raw,
        mode: params.mode,
        binding: params.binding,
    });
    if (validation.kind !== "available") {
        throw new AutomationStoredContentReadError(
            validation.kind === "modeMismatch" ? "modeMismatch" : "contentInvalid",
        );
    }
}

/**
 * The ciphertext-blind server boundary for generic Automation envelopes.
 * It validates JSON, the strict tagged outer shape, and Account mode without
 * decrypting or interpreting the private inner payload.
 */
export function validateAutomationStoredContentEnvelopeOuterForMode(params: {
    raw: string;
    mode: "plain" | "e2ee";
}): AutomationStoredContentOuterValidation {
    let raw: unknown;
    try {
        raw = JSON.parse(params.raw);
    } catch {
        return { kind: "contentInvalid" };
    }
    const parsed = AutomationStoredContentEnvelopeV1Schema.safeParse(raw);
    if (!parsed.success) {
        return { kind: "contentInvalid" };
    }
    if (
        (params.mode === "plain" && parsed.data.t !== "plain")
        || (params.mode === "e2ee" && parsed.data.t !== "encrypted")
    ) {
        return { kind: "modeMismatch" };
    }
    return { kind: "available", envelope: parsed.data };
}

export function assertAutomationStoredContentEnvelopeOuterForMode(params: {
    raw: string | null;
    mode: "plain" | "e2ee";
}): void {
    if (params.raw === null) {
        return;
    }
    const validation = validateAutomationStoredContentEnvelopeOuterForMode({
        raw: params.raw,
        mode: params.mode,
    });
    if (validation.kind !== "available") {
        throw new AutomationStoredContentReadError(validation.kind);
    }
}

/**
 * Failure detail has a distinct Account ciphertext purpose. The server admits
 * only the bounded outer envelope and delegates purpose/mode checks to the
 * Protocol owner without opening private Run detail.
 */
export function validateAutomationRunFailureDetailEnvelopeOuterForMode(params: {
    raw: string;
    mode: "plain" | "e2ee";
}) {
    let raw: unknown;
    try {
        raw = JSON.parse(params.raw);
    } catch {
        return { kind: "contentInvalid" } as const;
    }
    return validateAutomationRunFailureDetailStoredEnvelopeOuterForModeV1({
        mode: params.mode,
        envelope: raw,
    });
}

export function assertAutomationRunFailureDetailEnvelopeOuterForMode(params: {
    raw: string | null;
    mode: "plain" | "e2ee";
}): void {
    const raw = params.raw;
    if (raw === null) return;
    const validation = validateAutomationRunFailureDetailEnvelopeOuterForMode({
        raw,
        mode: params.mode,
    });
    if (validation.kind !== "available") {
        throw new AutomationStoredContentReadError(
            validation.kind === "modeMismatch" ? "modeMismatch" : "contentInvalid",
        );
    }
}

/**
 * Run recipes persist a frozen target/template envelope whose nested template
 * envelope carries the Account-mode boundary. Generic stored-content envelopes
 * remain valid for other retained content fields.
 */
/**
 * The one structural V2 predicate for frozen predecessor Run bytes. It admits
 * only the released schedule/manual recipe shape, and when a durable origin is
 * supplied it binds those bytes to that exact Run arm. Current strict recipes
 * are parsed and validated by Protocol instead.
 */
export type RetainedAutomationRunExecutionInputV2 = Readonly<{
    kind: "happier_automation_run_execution_input_v1";
    targetType: "new_session" | "existing_session";
    templateVersion: number;
    templateCiphertext: string;
    origin:
        | Readonly<{ kind: "scheduled"; scheduledFor: number }>
        | Readonly<{ kind: "manual"; invokedAt: number }>;
}>;

/**
 * Queryable persisted-bytes discriminator for retained V2 frozen input. The
 * sole producer serializes the parsed schema with `JSON.stringify`, whose
 * first field is the `kind` literal; current strict recipes serialize through
 * the canonical-JSON owner with alphabetically sorted keys and can never start
 * with this prefix. Candidate reads may prefilter on it, but the parsed
 * predicate above remains the only admission decision.
 */
export const RETAINED_AUTOMATION_RUN_EXECUTION_INPUT_V2_JSON_PREFIX =
    '{"kind":"happier_automation_run_execution_input_v1"';

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length
        && actual.every((key, index) => key === expected[index]);
}

function parseRetainedAutomationRunExecutionInputV2(params: {
    raw: string;
    retainedV2OriginKind?: "scheduled" | "manual";
}) {
    let raw: unknown;
    try {
        raw = JSON.parse(params.raw);
    } catch {
        return null;
    }
    if (!isExactObject(raw, [
        "kind",
        "targetType",
        "templateVersion",
        "templateCiphertext",
        "origin",
    ])) return null;
    if (
        raw.kind !== "happier_automation_run_execution_input_v1"
        || (raw.targetType !== "new_session" && raw.targetType !== "existing_session")
        || !Number.isSafeInteger(raw.templateVersion)
        || (raw.templateVersion as number) < 0
        || typeof raw.templateCiphertext !== "string"
        || raw.templateCiphertext.length === 0
    ) return null;

    const origin = raw.origin;
    const scheduled = isExactObject(origin, ["kind", "scheduledFor"])
        && origin.kind === "scheduled"
        && Number.isSafeInteger(origin.scheduledFor)
        && (origin.scheduledFor as number) >= 0;
    const manual = isExactObject(origin, ["kind", "invokedAt"])
        && origin.kind === "manual"
        && Number.isSafeInteger(origin.invokedAt)
        && (origin.invokedAt as number) >= 0;
    if (!scheduled && !manual) return null;
    if (
        params.retainedV2OriginKind !== undefined
        && params.retainedV2OriginKind !== origin.kind
    ) return null;

    const recipe = raw as RetainedAutomationRunExecutionInputV2;

    let templateRaw: unknown;
    try {
        templateRaw = JSON.parse(recipe.templateCiphertext);
    } catch {
        return null;
    }
    const template = normalizeAutomationTemplateEnvelopeStoredRead(templateRaw);
    if (!template) {
        return null;
    }
    return { recipe, template };
}

/** Read the exact released-V2 frozen Run shape without Account-mode authority. */
export function readRetainedAutomationRunExecutionInputV2(params: {
    raw: string;
    retainedV2OriginKind?: "scheduled" | "manual";
}): RetainedAutomationRunExecutionInputV2 | null {
    return parseRetainedAutomationRunExecutionInputV2(params)?.recipe ?? null;
}

/**
 * The narrow persisted-V2 read adapter. It delegates shape and durable-origin
 * admission to the canonical frozen-Run predicate, then checks Account mode.
 */
export function validateRetainedAutomationRunExecutionInputV2OuterForMode(params: {
    raw: string;
    mode: "plain" | "e2ee";
    retainedV2OriginKind?: "scheduled" | "manual";
}): AutomationExecutionInputOuterValidation | null {
    const retained = parseRetainedAutomationRunExecutionInputV2(params);
    if (!retained) return null;
    if (
        (
            params.mode === "e2ee"
            && retained.template.envelope.kind !== "happier_automation_template_encrypted_v1"
        )
        || (
            params.mode === "plain"
            && retained.template.envelope.kind === "happier_automation_template_encrypted_v1"
            && retained.recipe.targetType !== "existing_session"
        )
    ) {
        return { kind: "modeMismatch" };
    }
    return { kind: "available", input: retained.recipe };
}

/** Read the exact released-V2 frozen Run shape after Account-mode validation. */
export function readRetainedAutomationRunExecutionInputV2ForMode(params: {
    raw: string;
    mode: "plain" | "e2ee";
    retainedV2OriginKind?: "scheduled" | "manual";
}): RetainedAutomationRunExecutionInputV2 | null {
    const validation = validateRetainedAutomationRunExecutionInputV2OuterForMode(params);
    return validation?.kind === "available" ? validation.input : null;
}

export function assertAutomationExecutionInputEnvelopeOuterForMode(params: {
    raw: string | null;
    mode: "plain" | "e2ee";
    retainedV2OriginKind?: "scheduled" | "manual";
}): void {
    if (params.raw === null) {
        return;
    }
    const strictRecipe = parseAutomationRunExecutionRecipeV1(params.raw);
    if (strictRecipe.kind === "available") {
        const expectedEnvelopeType = params.mode === "plain" ? "plain" : "encrypted";
        if (
            strictRecipe.recipe.template.t !== expectedEnvelopeType
            || (
                strictRecipe.recipe.triggerEvidence !== null
                && strictRecipe.recipe.triggerEvidence.t !== expectedEnvelopeType
            )
        ) {
            throw new AutomationStoredContentReadError("modeMismatch");
        }
        return;
    }
    if (params.retainedV2OriginKind === undefined) {
        throw new AutomationStoredContentReadError("contentInvalid");
    }
    const validation = validateRetainedAutomationRunExecutionInputV2OuterForMode({
        raw: params.raw,
        mode: params.mode,
        retainedV2OriginKind: params.retainedV2OriginKind,
    });
    if (validation?.kind !== "available") {
        throw new AutomationStoredContentReadError(validation?.kind ?? "contentInvalid");
    }
}
