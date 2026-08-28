import {
    AUTOMATION_INT_COLUMN_MAX,
    AutomationTriggerDefinitionInputSchema,
    type AutomationAssignmentInput,
    type AutomationStoredDefinitionExecutionRecipeV1,
    type AutomationTriggerDefinitionInput,
} from '@happier-dev/protocol';
import {
    createAutomationEditorAutomationId,
    createAutomationEditorSourceSelectorId,
    type AutomationEditorDraft,
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

const MINUTES_PER_DAY = 24 * 60;

/**
 * The authored interval cadence ceiling, expressed in the unit the interval
 * picker edits: the widest whole-day cadence the Protocol's shared
 * `AutomationTrigger.everyMs` column ceiling can hold. Offering a wider cadence would
 * only produce a save the canonical server schedule admission rejects.
 */
export const MAX_AUTOMATION_INTERVAL_MINUTES =
    Math.floor(AUTOMATION_INT_COLUMN_MAX / 60_000 / MINUTES_PER_DAY) * MINUTES_PER_DAY;

/**
 * The one clamp for an authored interval cadence. The picker, the draft
 * sanitizer, the settings form, and both submit builders share it so a cadence
 * chosen on one surface cannot be silently narrowed by whichever surface holds
 * or saves it next.
 */
export function clampAutomationIntervalMinutes(value: number): number {
    if (!Number.isFinite(value)) return 1;
    return Math.min(Math.max(Math.floor(value), 1), MAX_AUTOMATION_INTERVAL_MINUTES);
}

export const DEFAULT_NEW_SESSION_AUTOMATION_DRAFT: NewSessionAutomationDraft = {
    pendingAutomationId: null,
    enabled: false,
    name: '',
    description: '',
    triggers: [],
};

function sanitizeTriggerRows(input: unknown): ReadonlyArray<NewSessionAutomationTriggerDraft> {
    if (!Array.isArray(input)) return [];
    const seen = new Set<string>();
    const rows: NewSessionAutomationTriggerDraft[] = [];
    for (const candidate of input) {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        const record = candidate as Record<string, unknown>;
        const clientId = typeof record.clientId === 'string' ? record.clientId.trim() : '';
        if (!clientId || seen.has(clientId)) continue;
        const definition = AutomationTriggerDefinitionInputSchema.safeParse(record.definition);
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

/**
 * The sole conversion from Session-inline Automation state into the canonical
 * plural editor/writer draft. Recipe and assignment materialization remain at
 * their incumbent Session authoring owners and are injected here unchanged.
 */
export function materializeNewSessionAutomationEditorDraft(params: Readonly<{
    draft: NewSessionAutomationDraft;
    executionRecipe: AutomationStoredDefinitionExecutionRecipeV1;
    assignments: ReadonlyArray<AutomationAssignmentInput>;
}>): AutomationEditorDraft {
    return {
        automationId: null,
        pendingAutomationId: params.draft.pendingAutomationId ?? createAutomationEditorAutomationId(),
        expectedTemplateVersion: null,
        removedTriggers: [],
        name: params.draft.name.trim(),
        description: params.draft.description.trim() || null,
        enabled: params.draft.enabled,
        recipeDirty: true,
        executionRecipe: params.executionRecipe,
        assignments: params.assignments,
        triggers: params.draft.triggers.map((row) => ({
            clientId: row.clientId,
            persisted: null,
            definition: row.definition,
            ...(row.definition.kind === 'pluginEvent' && 'sourceInstanceId' in row.definition ? {
                eventSourceBinding: {
                    sourceSelectorId: createAutomationEditorSourceSelectorId(row.clientId),
                    sourceInstanceId: row.definition.sourceInstanceId,
                },
            } : {}),
        })),
    };
}
