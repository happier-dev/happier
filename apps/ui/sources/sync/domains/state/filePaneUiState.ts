import { z } from 'zod/mini';
import { createPersistentUiState } from './persistentUiState';
import { createWorkspaceLayoutStore } from '@/components/appShell/workspace/workspaceLayoutStore';
import { PersistedPaneScopeSchema } from '@/components/appShell/panes/model/paneScopePersistenceSchema';
import { parseRecentWorkspaceFiles } from '@/sync/domains/workspaces/files/recentWorkspaceFiles';
import { FileEditorAiSuggestionDailyUsageSchema, EMPTY_FILE_EDITOR_AI_SUGGESTION_USAGE } from '@/sync/domains/workspaces/languageIntelligence/fileEditorAiSuggestionUsage';

export const paneUiState = createPersistentUiState('pane-scopes-v1', value => PersistedPaneScopeSchema.parse(value));
// Stored in parts so a save writes only what changed; values are the unparsed layouts the
// workspace owner's reader admits. A removed destination still restores as its tombstone.
export const workspaceLayoutsState = createWorkspaceLayoutStore();
export const recentWorkspaceFilesState = createPersistentUiState('recent-workspace-files-v1', value => parseRecentWorkspaceFiles({ paths: value }).paths ?? []);
export const fileEditorAiSuggestionUsageState = createPersistentUiState('editor-ai-usage-v1', value => z.catch(FileEditorAiSuggestionDailyUsageSchema, EMPTY_FILE_EDITOR_AI_SUGGESTION_USAGE).parse(value));
