import { AutomationTriggerDefinitionInputSchema, type AutomationTriggerDefinitionInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import {
    createAutomationEditorAutomationId,
} from './automationEditorDraft';

export type NewSessionAutomationTriggerDraft = Readonly<{
    clientId: string;
    definition: AutomationTriggerDefinitionInput;
}>;

export type NewSessionAutomationDraft = Readonly<{
    /** Stable definition identity retained with the inline draft across save retries. */
    pendingAutomationId?: string | null;
    enabled: boolean;
    name: string;
    description: string;
    triggers: ReadonlyArray<NewSessionAutomationTriggerDraft>;
}>;

export const DEFAULT_NEW_SESSION_AUTOMATION_DRAFT: NewSessionAutomationDraft = {
    pendingAutomationId: null,
    enabled: false,
    name: '',
    description: '',
    triggers: [],
};

export type ExactTurnAutomationRowsReplacement = Readonly<{
    /** Draft with exact-turn rows advanced to the current turns; identity-stable when unchanged. */
    automation: NewSessionAutomationDraft;
    /** True when at least one exact-turn row's source turn moved. */
    changed: boolean;
    /** False when any exact-turn row's source Session has no current active parent turn. */
    canReplace: boolean;
}>;

/**
 * The one exact-turn row replacement for the Session-inline Automation draft.
 * Each exact-turn row adopts the live current parent turn of its own source
 * Session; every other draft field, trigger row, and edit survives untouched.
 * The current-turn reader is injected so this domain owner never depends on
 * the Session UI layer.
 */
export function replaceExactTurnAutomationRowsWithCurrentTurns(params: Readonly<{
    automation: NewSessionAutomationDraft;
    readExactTurn: (sourceSessionId: string) => Readonly<{ sourceTurnId: string }> | null;
}>): ExactTurnAutomationRowsReplacement {
    let canReplace = true;
    let changed = false;
    const triggers = params.automation.triggers.map((trigger) => {
        const definition = trigger.definition;
        if (definition.kind !== 'sessionLifecycle' || definition.policy.kind !== 'currentTurn') return trigger;
        const exact = definition.subject?.kind === 'session'
            ? params.readExactTurn(definition.subject.sessionId) : null;
        if (!exact) {
            canReplace = false;
            return trigger;
        }
        if (exact.sourceTurnId === definition.policy.sourceTurnId) return trigger;
        changed = true;
        return {
            ...trigger,
            definition: {
                ...definition,
                policy: { ...definition.policy, sourceTurnId: exact.sourceTurnId },
            },
        };
    });
    return {
        automation: changed ? { ...params.automation, triggers } : params.automation,
        changed,
        canReplace,
    };
}

function sanitizeTriggerRows(input: unknown): ReadonlyArray<NewSessionAutomationTriggerDraft> {
    if (!Array.isArray(input)) return [];
    const seen = new Set<string>();
    const rows: NewSessionAutomationTriggerDraft[] = [];
    for (const candidate of input) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        const record = candidate as Record<string, unknown>;
        const clientId = typeof record.clientId === 'string' ? record.clientId.trim() : '';
        if (!clientId || seen.has(clientId)) continue;
        const definition = createStoredReadSchema(AutomationTriggerDefinitionInputSchema).safeParse(record.definition);
        if (!definition.success) continue;
        seen.add(clientId);
        rows.push({ clientId, definition: definition.data });
    }
    return rows;
}

export function sanitizeNewSessionAutomationDraft(input: unknown): NewSessionAutomationDraft {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return DEFAULT_NEW_SESSION_AUTOMATION_DRAFT;
    }

    const record = input as Record<string, unknown>;
    const enabled = record.enabled === true;
    const pendingAutomationId = typeof record.pendingAutomationId === 'string'
        ? record.pendingAutomationId.trim() || null
        : null;
    return {
        pendingAutomationId: pendingAutomationId ?? (enabled ? createAutomationEditorAutomationId() : null),
        enabled,
        name: typeof record.name === 'string' ? record.name : '',
        description: typeof record.description === 'string' ? record.description : '',
        triggers: sanitizeTriggerRows(record.triggers),
    };
}
