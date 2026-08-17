import {
    AutomationTriggerDefinitionBindingV1Schema,
    AutomationRunExecutionInputV1Schema,
    AutomationStoredContentEnvelopeV1Schema,
    validateAutomationRunFailureDetailStoredEnvelopeOuterForModeV1,
    normalizeAutomationTemplateEnvelopeStoredRead,
    parseAutomationRunExecutionRecipeV1,
    validateAutomationTriggerDefinitionStoredEnvelopeOuterForModeV1,
    type AutomationRunExecutionInputV1,
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
        input: AutomationRunExecutionInputV1;
    }>
    | Readonly<{ kind: "contentInvalid" | "modeMismatch" }>;

/**
 * Projects the durable public definition identity into the one private
 * trigger-definition binding. A schedule has no private definition; null also
 * means malformed Event/Conversation row so callers must use their trigger
 * kind to distinguish those cases.
 */
export function readAutomationTriggerDefinitionBinding(params: Readonly<{
    automationId: string;
    templateVersion: number;
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
                    templateVersion: params.templateVersion,
                    triggerKind: "pluginEvent" as const,
                    eventRef: {
                        pluginId: params.triggerEventPluginId,
                        localId: params.triggerEventLocalId,
                    },
                    sourceSelectorId: params.triggerSourceSelectorId,
                }
                : null
        )
        : params.triggerKind === "conversation"
            ? {
                v: 1,
                automationId: params.automationId,
                templateVersion: params.templateVersion,
                triggerKind: "conversation" as const,
                eventRef: null,
                sourceSelectorId: null,
            }
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
function parseRetainedAutomationRunExecutionInputV2(params: {
    raw: string;
    originKind?: string;
}) {
    let raw: unknown;
    try {
        raw = JSON.parse(params.raw);
    } catch {
        return null;
    }
    const recipe = AutomationRunExecutionInputV1Schema.safeParse(raw);
    if (!recipe.success) {
        return null;
    }
    if (
        (recipe.data.origin.kind !== "scheduled" && recipe.data.origin.kind !== "manual")
        || (
            params.originKind !== undefined
            && params.originKind !== recipe.data.origin.kind
        )
    ) {
        return null;
    }

    let templateRaw: unknown;
    try {
        templateRaw = JSON.parse(recipe.data.templateCiphertext);
    } catch {
        return null;
    }
    const template = normalizeAutomationTemplateEnvelopeStoredRead(templateRaw);
    if (!template) {
        return null;
    }
    return { recipe: recipe.data, template };
}

/** Read the exact released-V2 frozen Run shape without Account-mode authority. */
export function readRetainedAutomationRunExecutionInputV2(params: {
    raw: string;
    originKind?: string;
}): AutomationRunExecutionInputV1 | null {
    return parseRetainedAutomationRunExecutionInputV2(params)?.recipe ?? null;
}

/**
 * The narrow persisted-V2 read adapter. It delegates shape and durable-origin
 * admission to the canonical frozen-Run predicate, then checks Account mode.
 */
export function validateRetainedAutomationRunExecutionInputV2OuterForMode(params: {
    raw: string;
    mode: "plain" | "e2ee";
    originKind?: string;
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
    originKind?: string;
}): AutomationRunExecutionInputV1 | null {
    const validation = validateRetainedAutomationRunExecutionInputV2OuterForMode(params);
    return validation?.kind === "available" ? validation.input : null;
}

export function assertAutomationExecutionInputEnvelopeOuterForMode(params: {
    raw: string | null;
    mode: "plain" | "e2ee";
    originKind?: string;
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
    const validation = validateRetainedAutomationRunExecutionInputV2OuterForMode({
        raw: params.raw,
        mode: params.mode,
        originKind: params.originKind,
    });
    if (validation?.kind !== "available") {
        throw new AutomationStoredContentReadError(validation?.kind ?? "contentInvalid");
    }
}
