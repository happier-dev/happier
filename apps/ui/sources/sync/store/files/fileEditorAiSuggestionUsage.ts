import { getStorage } from '@/sync/domains/state/storageStore';
import { fileEditorAiSuggestionUsageState } from '@/sync/domains/state/filePaneUiState';
import { UiStatePersistenceError } from '@/sync/domains/state/persistentUiState';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { appendFileEditorAiSuggestionUsage, selectFileEditorAiSuggestionUsage, type FileEditorAiSuggestionUsageEvent } from '@/sync/domains/workspaces/languageIntelligence/fileEditorAiSuggestionUsage';

export function recordFileEditorAiSuggestionUsage(scope: ServerAccountScope, event: FileEditorAiSuggestionUsageEvent): void {
    const state = getStorage().getState();
    if (!areServerAccountScopesEqual(scope, state.settingsScope)) return;
    const key = serverAccountScopeKeySuffix(scope);
    const previous = fileEditorAiSuggestionUsageState.read(key);
    const next = appendFileEditorAiSuggestionUsage(previous ? { [key]: previous } : {}, key, event)[key];
    try {
        fileEditorAiSuggestionUsageState.set(key, next);
    } catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[editor-ai-usage] Device usage could not be persisted.');
    }
}

export function readFileEditorAiSuggestionUsage(scope: ServerAccountScope) {
    const key = serverAccountScopeKeySuffix(scope);
    const value = fileEditorAiSuggestionUsageState.read(key);
    return selectFileEditorAiSuggestionUsage(value ? { [key]: value } : {}, key);
}
