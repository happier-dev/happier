import { PersistedBackendTargetRefV2Schema, type PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { z } from 'zod/mini';
import { LOCAL_ACCOUNT_SETTING_DEFINITIONS, parseLocalAccountSettings } from '@/sync/domains/settings/registry/local/localAccountSettingDefinitions';
import { NewSessionAgentPickerViewV1Schema, NewSessionOrdinaryEntryDraftIdSchema, type NewSessionAgentPickerViewV1 } from './newSessionInteractionSchemas';
import { createPersistentUiState, UiStatePersistenceError, usePersistentUiStateValue } from './persistentUiState';

export type LastUsedBackendSelection = Readonly<{
    lastUsedBackendTarget: PersistedBackendTargetRefV2 | null;
    lastUsedAgent: string | null;
}>;
const EMPTY_SELECTION: LastUsedBackendSelection = { lastUsedBackendTarget: null, lastUsedAgent: null };
const StoredSelectionSchema = z.object({
    lastUsedBackendTarget: z.nullable(PersistedBackendTargetRefV2Schema),
    lastUsedAgent: LOCAL_ACCOUNT_SETTING_DEFINITIONS.lastUsedAgent.schema,
});
const admitSelection = (value: unknown) => StoredSelectionSchema.parse(value);

function parseSelection(value: unknown): LastUsedBackendSelection {
    const { lastUsedBackendTarget, lastUsedAgent } = parseLocalAccountSettings(value);
    return { lastUsedBackendTarget, lastUsedAgent };
}

const selections = createPersistentUiState('new-session-target-v1', parseSelection);
const selectionKey = (scope: ServerAccountScope | null) => scope ? serverAccountScopeKeySuffix(scope) : 'legacy-unscoped';

// Separate keyed values keep focus memory independent of draft custody and target selection.
const pickerViews = createPersistentUiState('new-session-picker-view-v1', value => z.catch(NewSessionAgentPickerViewV1Schema, null).parse(value));
const OrdinaryDraftMemorySchema = z.nullable(NewSessionOrdinaryEntryDraftIdSchema);
const ordinaryDraftIds = createPersistentUiState('new-session-ordinary-draft-v1', value => z.catch(OrdinaryDraftMemorySchema, null).parse(value));

export function readLastNewSessionAgentPickerView(scope: ServerAccountScope | null): NewSessionAgentPickerViewV1 {
    return pickerViews.read(selectionKey(scope)) ?? null;
}

export function rememberLastNewSessionAgentPickerView(scope: ServerAccountScope | null, view: NewSessionAgentPickerViewV1): void {
    try { pickerViews.set(selectionKey(scope), NewSessionAgentPickerViewV1Schema.parse(view)); }
    catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[new-session] Picker focus could not be persisted.');
    }
}

export function readOrdinaryNewSessionDraftId(scope: ServerAccountScope | null): string | null {
    return ordinaryDraftIds.read(selectionKey(scope)) ?? null;
}

export function useOrdinaryNewSessionDraftId(scope: ServerAccountScope | null): string | null {
    return usePersistentUiStateValue(ordinaryDraftIds, selectionKey(scope)) ?? null;
}

export function rememberOrdinaryNewSessionDraftId(scope: ServerAccountScope, draftId: string): void {
    const parsed = NewSessionOrdinaryEntryDraftIdSchema.safeParse(draftId);
    if (!parsed.success) return;
    try { ordinaryDraftIds.set(selectionKey(scope), parsed.data); }
    catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[new-session] Draft entry could not be persisted.');
    }
}

export function clearOrdinaryNewSessionDraftIdExact(scope: ServerAccountScope, draftId: string): void {
    if (readOrdinaryNewSessionDraftId(scope) !== draftId) return;
    // Keep an explicit clear so a retained predecessor cache cannot resurrect it.
    try { ordinaryDraftIds.set(selectionKey(scope), null); }
    catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[new-session] Draft entry could not be cleared.');
    }
}

export function readLastUsedBackendSelection(scope: ServerAccountScope | null): LastUsedBackendSelection {
    return selections.read(selectionKey(scope)) ?? EMPTY_SELECTION;
}

export function useLastUsedBackendSelectionForScope(scope: ServerAccountScope | null, enabled = true): LastUsedBackendSelection {
    return usePersistentUiStateValue(selections, enabled ? selectionKey(scope) : null) ?? EMPTY_SELECTION;
}

export function rememberLastUsedBackendSelection(scope: ServerAccountScope | null, selection: Readonly<{
    lastUsedBackendTarget: PersistedBackendTargetRefV2 | null;
    lastUsedAgent?: string | null;
}>): void {
    try {
        selections.set(selectionKey(scope), parseSelection({ ...readLastUsedBackendSelection(scope), ...selection }));
    } catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[new-session] Last-used Agent could not be persisted.');
    }
}

/** A predecessor Settings cache is an import source, never a competing writer. */
export function migrateNewSessionUiState(scope: ServerAccountScope | null, settings: unknown): unknown {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return settings;
    const record = settings as Record<string, unknown>;
    if (!['lastUsedBackendTarget', 'lastUsedAgent', 'lastNewSessionAgentPickerViewV1', 'newSessionOrdinaryEntryDraftId']
        .some(key => Object.hasOwn(record, key))) return settings;
    const key = selectionKey(scope);
    const seed = parseSelection(record);
    if (Object.hasOwn(record, 'lastUsedAgent')) LOCAL_ACCOUNT_SETTING_DEFINITIONS.lastUsedAgent.schema.parse(record.lastUsedAgent);
    if (record.lastUsedBackendTarget != null && seed.lastUsedBackendTarget === null) {
        throw new UiStatePersistenceError(new Error('Retained New Session target could not be admitted'));
    }
    if ((seed.lastUsedBackendTarget !== null || seed.lastUsedAgent !== null) && selections.readStrict(key, admitSelection) === undefined) {
        selections.set(key, seed);
    }
    if (Object.hasOwn(record, 'lastNewSessionAgentPickerViewV1')) {
        const view = NewSessionAgentPickerViewV1Schema.parse(record.lastNewSessionAgentPickerViewV1);
        if (pickerViews.readStrict(key, value => NewSessionAgentPickerViewV1Schema.parse(value)) === undefined) pickerViews.set(key, view);
    }
    if (Object.hasOwn(record, 'newSessionOrdinaryEntryDraftId')) {
        const draftId = OrdinaryDraftMemorySchema.parse(record.newSessionOrdinaryEntryDraftId);
        if (ordinaryDraftIds.readStrict(key, value => OrdinaryDraftMemorySchema.parse(value)) === undefined) ordinaryDraftIds.set(key, draftId);
    }
    const { lastUsedBackendTarget: _target, lastUsedAgent: _agent,
        lastNewSessionAgentPickerViewV1: _view, newSessionOrdinaryEntryDraftId: _draft, ...retained } = record;
    return retained;
}

/** Preserve the same local observation when the existing scope migration adopts a Home identity. */
export function migrateNewSessionUiStateScope(from: ServerAccountScope | null, to: ServerAccountScope): void {
    const fromKey = selectionKey(from);
    const toKey = selectionKey(to);
    const previous = selections.readStrict(fromKey, admitSelection);
    if (previous && selections.readStrict(toKey, admitSelection) === undefined) selections.set(toKey, previous);
    const admitView = (value: unknown) => NewSessionAgentPickerViewV1Schema.parse(value);
    const view = pickerViews.readStrict(fromKey, admitView);
    if (view !== undefined && pickerViews.readStrict(toKey, admitView) === undefined) pickerViews.set(toKey, view);
    const admitDraftId = (value: unknown) => OrdinaryDraftMemorySchema.parse(value);
    const draftId = ordinaryDraftIds.readStrict(fromKey, admitDraftId);
    if (draftId !== undefined && ordinaryDraftIds.readStrict(toKey, admitDraftId) === undefined) ordinaryDraftIds.set(toKey, draftId);
}
