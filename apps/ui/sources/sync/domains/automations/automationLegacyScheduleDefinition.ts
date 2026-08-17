import type { Automation, AutomationDefinition } from './automationTypes';

/**
 * Narrow predecessor adapter for the incumbent schedule editor. It is fed only
 * from a direct V3 definition record and deliberately refuses current strict
 * recipes: those rows are not V2-representable and must not fall back to the
 * legacy writer.
 */
export function readLegacyScheduleAutomationDefinition(
    definition: AutomationDefinition | null | undefined,
): Automation | null {
    if (
        !definition
        || definition.trigger.kind !== 'schedule'
        || definition.detail.kind !== 'available'
    ) {
        return null;
    }

    const detail = definition.detail.value;
    if (
        detail.trigger.kind !== 'schedule'
        || typeof detail.templateCiphertext !== 'string'
        || detail.targetType === 'executionRun'
    ) {
        return null;
    }

    return {
        id: detail.id,
        name: detail.name,
        description: detail.description,
        enabled: detail.enabled,
        schedule: detail.trigger.schedule,
        targetType: detail.targetType === 'existingSession' ? 'existing_session' : 'new_session',
        templateCiphertext: detail.templateCiphertext,
        linkedExistingSessionId: definition.linkedExistingSessionId,
        templateVersion: detail.templateVersion,
        nextRunAt: detail.nextRunAt,
        lastRunAt: detail.lastRunAt,
        createdAt: detail.createdAt,
        updatedAt: detail.updatedAt,
        assignments: detail.assignments,
    };
}
