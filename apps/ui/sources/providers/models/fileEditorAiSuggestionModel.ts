import {
    budgetInlineCompletionContext,
    fitsNextEditContext,
    projectProviderModelGenerationSettings,
    type ProviderModelDescriptorV1,
} from '@happier-dev/protocol/models/descriptor';
import type { FilesEditorAiSuggestionOperation } from '@happier-dev/protocol/account/settings/accountSettings';

/** Editor operations use their exact model facts, independently of coding-Agent requirements. */
export function isFileEditorAiSuggestionModel(model: ProviderModelDescriptorV1, operation: FilesEditorAiSuggestionOperation = 'inline'): boolean {
    return operation === 'nextEdit' ? fitsNextEditContext(model, '') : budgetInlineCompletionContext(model, { prefix: '', suffix: '' }) !== null;
}

export type FileEditorAiSuggestionModelExclusionReason = 'stale_model' | 'missing_model_descriptor'
    | 'unsupported_operation' | 'missing_context_window' | 'missing_output_allowance' | 'invalid_context_budget';

export type FileEditorAiSuggestionModelEligibility = Readonly<{ connectionId: string; modelId: string }> & (
    Readonly<{ eligible: true }> | Readonly<{ eligible: false; reason: FileEditorAiSuggestionModelExclusionReason }>
);

function modelExclusionReason(model: ProviderModelDescriptorV1, operation: FilesEditorAiSuggestionOperation): FileEditorAiSuggestionModelExclusionReason | null {
    const spec = operation === 'nextEdit' ? model.nextEdit : model.inlineCompletion;
    if (!spec) return 'unsupported_operation';
    if (!model.contextWindowTokens) return 'missing_context_window';
    if (spec.outputTokens === undefined) {
        // One is the smallest positive allowance, used only to ask the allocator
        // whether this exclusion is repairable. It is never stored or dispatched.
        return isFileEditorAiSuggestionModel(projectProviderModelGenerationSettings(model, { maxTokens: 1 }), operation)
            ? 'missing_output_allowance' : 'invalid_context_budget';
    }
    return isFileEditorAiSuggestionModel(model, operation) ? null : 'invalid_context_budget';
}

export function getFileEditorAiSuggestionModelEligibility(input: Readonly<{
    connectionId: string;
    modelId: string;
    descriptor?: ProviderModelDescriptorV1 | null;
    stale?: boolean;
    operation?: FilesEditorAiSuggestionOperation;
}>): FileEditorAiSuggestionModelEligibility {
    const identity = { connectionId: input.connectionId, modelId: input.modelId };
    const excluded = (reason: FileEditorAiSuggestionModelExclusionReason): FileEditorAiSuggestionModelEligibility => (
        { ...identity, eligible: false, reason }
    );
    if (input.stale) return excluded('stale_model');
    const model = input.descriptor;
    if (!model) return excluded('missing_model_descriptor');
    // The canonical allocator remains the only budget decision-maker.
    const reason = modelExclusionReason(model, input.operation ?? 'inline');
    return reason ? excluded(reason) : { ...identity, eligible: true };
}

/**
 * A model the editor would offer if the person set an output allowance: it declares an editor
 * operation with room for context, and only the allowance is missing. Any other exclusion (no
 * operation, no context window, a stored allowance the model cannot honour) stays a plain exclusion.
 */
export function fileEditorAiSuggestionNeedsAllowance(model: ProviderModelDescriptorV1, operation: FilesEditorAiSuggestionOperation = 'inline'): boolean {
    return modelExclusionReason(model, operation) === 'missing_output_allowance';
}
