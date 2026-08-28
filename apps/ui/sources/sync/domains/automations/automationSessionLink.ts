import { readAutomationDefinitionExistingSessionId } from './automationDefinitionProjection';
import type { AutomationDefinition } from './automationTypes';

function normalizeLinkedExistingSessionId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const sessionId = value.trim();
    return sessionId ? sessionId : null;
}

/**
 * Applies the one direct-detail-only existing-session association to the
 * current store record. Current recipes disclose their target structurally.
 */
export function projectAutomationDefinitionSessionLink(params: Readonly<{
    automation: AutomationDefinition;
}>): AutomationDefinition {
    const { automation } = params;
    if (automation.targetType !== 'existingSession' || automation.detail.kind !== 'available') {
        return {
            ...automation,
            linkedExistingSessionId: null,
        };
    }

    return {
        ...automation,
        linkedExistingSessionId: normalizeLinkedExistingSessionId(
            readAutomationDefinitionExistingSessionId(automation.detail.value),
        ),
    };
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
