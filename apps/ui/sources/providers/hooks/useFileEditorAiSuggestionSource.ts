import { resolveFilesEditorAiSuggestionModelId, type FilesEditorAiSuggestionsV1, type FilesEditorAiSuggestionOperation } from '@happier-dev/protocol/account/settings/accountSettings';
import { useProviderConnectionModels } from './useProviderConnectionModels';
import { isFileEditorAiSuggestionModel } from '../models/fileEditorAiSuggestionModel';

/** One exact connection catalog; never fabricates a coding Agent to admit editor models. */
export function useFileEditorAiSuggestionSource(input: Readonly<{
    settings: FilesEditorAiSuggestionsV1;
    machineId: string | null;
    serverId: string | null;
    active?: boolean;
}>) {
    const catalog = useProviderConnectionModels({
        enabled: input.settings.enabled && Boolean(input.settings.connectionId && input.machineId),
        active: input.active,
        machineId: input.machineId,
        serverId: input.serverId,
        connectionId: input.settings.connectionId ?? '',
    });
    function selectedModel(operation: FilesEditorAiSuggestionOperation) {
        const modelId = resolveFilesEditorAiSuggestionModelId(input.settings, operation);
        const row = catalog.models.find(model => model.id === modelId);
        return row && !row.stale && row.descriptor && isFileEditorAiSuggestionModel(row.descriptor, operation) ? row.descriptor : null;
    }
    return { model: selectedModel('inline'), nextEditModel: selectedModel('nextEdit'), loading: catalog.loading, error: catalog.error };
}
