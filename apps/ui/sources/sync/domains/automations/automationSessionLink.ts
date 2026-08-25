import { decodeAutomationTemplate } from './automationTemplateCodec';
import { readAutomationDefinitionExistingSessionId } from './automationDefinitionProjection';
import type { Automation, AutomationDefinition } from './automationTypes';
import { resolveAutomationTemplatePayload } from './automationTemplateTransport';

function normalizeLinkedExistingSessionId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const sessionId = value.trim();
    return sessionId ? sessionId : null;
}

function decodeLinkedExistingSessionId(payload: unknown): string | null {
    try {
        const encoded = JSON.stringify(payload);
        if (typeof encoded !== 'string') return null;
        const template = decodeAutomationTemplate(encoded);
        return normalizeLinkedExistingSessionId(template?.existingSessionId);
    } catch {
        return null;
    }
}

/**
 * Resolves the one client-only association projection when an Automation
 * enters the in-memory store. The content-capable template reader validates
 * any predecessor outer identifier against the decrypted payload before this
 * link is exposed to synchronous consumers.
 */
export async function projectAutomationSessionLink(params: Readonly<{
    automation: Automation;
    decryptRaw?: (payloadCiphertext: string) => Promise<unknown | null>;
}>): Promise<Automation> {
    const { automation } = params;
    if (automation.targetType !== 'existing_session') {
        return {
            ...automation,
            linkedExistingSessionId: null,
        };
    }

    const resolved = await resolveAutomationTemplatePayload({
        templateCiphertext: automation.templateCiphertext,
        ...(params.decryptRaw ? { decryptRaw: params.decryptRaw } : {}),
    });
    const linkedExistingSessionId = resolved.kind === 'ready'
        ? decodeLinkedExistingSessionId(resolved.payload)
        : null;
    return {
        ...automation,
        linkedExistingSessionId,
    };
}

/**
 * Applies the same one direct-detail-only existing-session association to the
 * current store record. Current recipes disclose their target structurally; a
 * retained V2 template still goes through the established envelope reader.
 */
export async function projectAutomationDefinitionSessionLink(params: Readonly<{
    automation: AutomationDefinition;
    decryptRaw?: (payloadCiphertext: string) => Promise<unknown | null>;
}>): Promise<AutomationDefinition> {
    const { automation } = params;
    if (automation.targetType !== 'existingSession' || automation.detail.kind !== 'available') {
        return {
            ...automation,
            linkedExistingSessionId: null,
        };
    }

    const detail = automation.detail.value;
    if (detail.executionRecipe) {
        return {
            ...automation,
            linkedExistingSessionId: normalizeLinkedExistingSessionId(
                readAutomationDefinitionExistingSessionId(detail),
            ),
        };
    }

    const templateCiphertext = detail.templateCiphertext;
    if (typeof templateCiphertext !== 'string') {
        return {
            ...automation,
            linkedExistingSessionId: null,
        };
    }
    const resolved = await resolveAutomationTemplatePayload({
        templateCiphertext,
        ...(params.decryptRaw ? { decryptRaw: params.decryptRaw } : {}),
    });
    const linkedExistingSessionId = resolved.kind === 'ready'
        ? decodeLinkedExistingSessionId(resolved.payload)
        : null;
    return {
        ...automation,
        linkedExistingSessionId,
    };
}

export function tryGetAutomationLinkedExistingSessionId(automation: Pick<Automation, 'targetType' | 'linkedExistingSessionId'>): string | null {
    if (automation.targetType !== 'existing_session') return null;
    return normalizeLinkedExistingSessionId(automation.linkedExistingSessionId);
}

export function isAutomationLinkedToSession(automation: Pick<Automation, 'targetType' | 'linkedExistingSessionId'>, sessionId: string): boolean {
    const linkedId = tryGetAutomationLinkedExistingSessionId(automation);
    return typeof linkedId === 'string' && linkedId === sessionId;
}

export function filterAutomationsLinkedToSession(automations: ReadonlyArray<Automation>, sessionId: string): Automation[] {
    return automations.filter((automation) => isAutomationLinkedToSession(automation, sessionId));
}

export function countEnabledAutomationsLinkedToSession(automations: ReadonlyArray<Pick<Automation, 'enabled' | 'targetType' | 'linkedExistingSessionId'>>, sessionId: string): number {
    let count = 0;
    for (const automation of automations) {
        if (!automation.enabled) continue;
        if (isAutomationLinkedToSession(automation, sessionId)) {
            count += 1;
        }
    }
    return count;
}

/**
 * Current list summaries never guess at the private target. A link exists only
 * after the incumbent direct-detail projection supplied it to this same record.
 */
export function tryGetAutomationDefinitionLinkedExistingSessionId(
    automation: Pick<AutomationDefinition, 'targetType' | 'linkedExistingSessionId'>,
): string | null {
    if (automation.targetType !== 'existingSession') return null;
    return normalizeLinkedExistingSessionId(automation.linkedExistingSessionId);
}

export function isAutomationDefinitionLinkedToSession(
    automation: Pick<AutomationDefinition, 'targetType' | 'linkedExistingSessionId'>,
    sessionId: string,
): boolean {
    return tryGetAutomationDefinitionLinkedExistingSessionId(automation) === sessionId;
}

export function filterAutomationDefinitionsLinkedToSession(
    automations: ReadonlyArray<AutomationDefinition>,
    sessionId: string,
): AutomationDefinition[] {
    return automations.filter((automation) => isAutomationDefinitionLinkedToSession(automation, sessionId));
}

export function countEnabledAutomationDefinitionsLinkedToSession(
    automations: ReadonlyArray<Pick<AutomationDefinition, 'enabled' | 'targetType' | 'linkedExistingSessionId'>>,
    sessionId: string,
): number {
    let count = 0;
    for (const automation of automations) {
        if (automation.enabled && isAutomationDefinitionLinkedToSession(automation, sessionId)) {
            count += 1;
        }
    }
    return count;
}
