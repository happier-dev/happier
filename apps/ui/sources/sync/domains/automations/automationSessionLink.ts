import type { Automation } from './automationTypes';
import { tryReadAutomationTemplateEnvelopeExistingSessionId } from './automationTemplateTransport';

export function tryGetAutomationLinkedExistingSessionId(automation: Pick<Automation, 'targetType' | 'templateCiphertext'>): string | null {
    if (automation.targetType !== 'existing_session') return null;
    return tryReadAutomationTemplateEnvelopeExistingSessionId(automation.templateCiphertext);
}

export function isAutomationLinkedToSession(automation: Pick<Automation, 'targetType' | 'templateCiphertext'>, sessionId: string): boolean {
    const linkedId = tryGetAutomationLinkedExistingSessionId(automation);
    return typeof linkedId === 'string' && linkedId === sessionId;
}

export function filterAutomationsLinkedToSession(automations: ReadonlyArray<Automation>, sessionId: string): Automation[] {
    return automations.filter((automation) => isAutomationLinkedToSession(automation, sessionId));
}

export function countEnabledAutomationsLinkedToSession(automations: ReadonlyArray<Pick<Automation, 'enabled' | 'targetType' | 'templateCiphertext'>>, sessionId: string): number {
    let count = 0;
    for (const automation of automations) {
        if (!automation.enabled) continue;
        if (isAutomationLinkedToSession(automation, sessionId)) {
            count += 1;
        }
    }
    return count;
}

