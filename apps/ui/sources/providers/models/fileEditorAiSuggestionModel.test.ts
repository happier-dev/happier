import { describe, expect, it } from 'vitest';
import type { ProviderModelDescriptorV1 } from '@happier-dev/protocol/models/descriptor';
import { fileEditorAiSuggestionNeedsAllowance, getFileEditorAiSuggestionModelEligibility, isFileEditorAiSuggestionModel } from './fileEditorAiSuggestionModel';
import { DEEPSEEK_PROVIDER_CONTRIBUTION } from '../../../../../packages/plugins/deepseek/src/provider/contribution';
import { OLLAMA_PROVIDER_CONTRIBUTION } from '../../../../../packages/plugins/ollama/src/provider/contribution';
import { ProviderContributionV1Schema } from '@happier-dev/protocol/providers/contributions';
import { projectProviderModelGenerationSettings } from '@happier-dev/protocol/models/descriptor';
import { ProviderConnectionV1Schema } from '@happier-dev/protocol/providers/connections/v1';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { projectAccountProviderConnectionModelsV1 } from '@happier-dev/protocol/providers/catalog/accountModelProjectionV1';

describe('editor suggestion model admission', () => {
    it('excludes a next-edit-only model from ghost text without excluding its declared operation', () => {
        const descriptor = projectProviderModelGenerationSettings(
            OLLAMA_PROVIDER_CONTRIBUTION.catalog.staticModels.find(model => 'nextEdit' in model)!, { maxTokens: 512 });
        const identity = { connectionId: 'pc_local', modelId: descriptor.id };
        expect(getFileEditorAiSuggestionModelEligibility({ ...identity, descriptor, operation: 'inline' }))
            .toEqual({ ...identity, eligible: false, reason: 'unsupported_operation' });
        expect(isFileEditorAiSuggestionModel(descriptor)).toBe(false);
        expect(fileEditorAiSuggestionNeedsAllowance({ ...descriptor, nextEdit: { ...descriptor.nextEdit!, outputTokens: undefined } })).toBe(false);
        expect(getFileEditorAiSuggestionModelEligibility({ ...identity, descriptor, operation: 'nextEdit' }))
            .toEqual({ ...identity, eligible: true });
    });
    it('offers documented DeepSeek FIM from a fresh Account connection without a manual allowance', () => {
        const source = ProviderContributionV1Schema.parse(DEEPSEEK_PROVIDER_CONTRIBUTION);
        const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_fresh',
            source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' },
            role: 'named', displayName: 'Fresh DeepSeek', displayNameMode: 'custom', revision: 0, createdAt: 1, updatedAt: 1 });
        const rows = projectAccountProviderConnectionModelsV1({ source, connection,
            catalog: { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [connection] } });
        expect(rows.filter(row => row.descriptor && isFileEditorAiSuggestionModel(row.descriptor)).map(row => row.id))
            .toEqual(['deepseek-v4-pro']);
        expect(connection.modelSettings).toBeUndefined();
    });

    it.each([
        [OLLAMA_PROVIDER_CONTRIBUTION, 'qwen2.5-coder:1.5b-base', 'inline'],
        [OLLAMA_PROVIDER_CONTRIBUTION, OLLAMA_PROVIDER_CONTRIBUTION.catalog.staticModels.find(model => 'nextEdit' in model)!.id, 'nextEdit'],
    ] as const)('offers the bundled model only with its persisted usable allowance (%#)', (contribution, modelId, operation) => {
        const connection = ProviderConnectionV1Schema.parse({ v: 1, id: 'pc_editor',
            source: { kind: 'contribution', contributionKey: `happier.provider.${contribution.id}/${contribution.id}` },
            role: 'named', displayName: 'Editor', displayNameMode: 'custom', revision: 0, createdAt: 1, updatedAt: 1 });
        const source = ProviderContributionV1Schema.parse(contribution);
        const offered = (maxTokens?: number) => {
            const configured = { ...connection, ...(maxTokens === undefined ? {} : { modelSettings: { [modelId]: { maxTokens } } }) };
            return projectAccountProviderConnectionModelsV1({ source, connection: configured,
                catalog: { ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, connections: [configured] } })
                .filter(row => row.descriptor && isFileEditorAiSuggestionModel(row.descriptor, operation)).map(row => row.id);
        };
        expect(offered()).toEqual([]);
        expect(offered(128)).toEqual([modelId]);
        expect(offered(0)).toEqual([]);
        expect(offered(1_000_001)).toEqual([]);
    });

    it('offers a declared FIM model without coding tools, and refuses guessed chat or unknown budgets', () => {
        const fim: ProviderModelDescriptorV1 = {
            id: 'base', name: 'Local base', contextWindowTokens: 32768,
            capabilities: { toolRoundTrips: 'unsupported' },
            inlineCompletion: { operationId: 'fim', tokenAccounting: 'utf8-bytes', promptOverheadTokens: 0, outputTokens: 128 },
        };
        expect(isFileEditorAiSuggestionModel(fim)).toBe(true);
        expect(isFileEditorAiSuggestionModel({ id: 'chat', name: 'Chat', capabilities: { toolRoundTrips: 'supported' } })).toBe(false);
        expect(isFileEditorAiSuggestionModel({ ...fim, contextWindowTokens: undefined })).toBe(false);
        expect(isFileEditorAiSuggestionModel({ ...fim, inlineCompletion: { ...fim.inlineCompletion!, outputTokens: undefined } })).toBe(false);
    });

    it('explains an unconfigured exact Ollama model and retains its repair destination through admission', () => {
        const model = OLLAMA_PROVIDER_CONTRIBUTION.catalog.staticModels[0];
        const operation = model.inlineCompletion;
        if (!operation) throw new Error('Expected the bundled FIM model');
        const identity = { connectionId: 'pc_local', modelId: model.id };
        expect(getFileEditorAiSuggestionModelEligibility({ ...identity, descriptor: model }))
            .toEqual({ ...identity, eligible: false, reason: 'missing_output_allowance' });
        expect(fileEditorAiSuggestionNeedsAllowance(model)).toBe(true);
        const noRoom = { ...model, contextWindowTokens: operation.promptOverheadTokens + 1 };
        expect(getFileEditorAiSuggestionModelEligibility({ ...identity, descriptor: noRoom }))
            .toEqual({ ...identity, eligible: false, reason: 'invalid_context_budget' });
        expect(fileEditorAiSuggestionNeedsAllowance(noRoom)).toBe(false);
        expect(getFileEditorAiSuggestionModelEligibility({ ...identity, descriptor: { ...model,
            inlineCompletion: { ...operation, outputTokens: 128 } } }))
            .toEqual({ ...identity, eligible: true });
        expect(getFileEditorAiSuggestionModelEligibility({ ...identity, descriptor: { ...model,
            inlineCompletion: { ...operation, outputTokens: 32768 } } }))
            .toEqual({ ...identity, eligible: false, reason: 'invalid_context_budget' });
    });

    it('distinguishes stale, absent descriptor, unsupported operation and missing context from missing allowance', () => {
        const model = OLLAMA_PROVIDER_CONTRIBUTION.catalog.staticModels[0];
        const identity = { connectionId: 'pc_local', modelId: model.id };
        expect(getFileEditorAiSuggestionModelEligibility({ ...identity, descriptor: model, stale: true }))
            .toMatchObject({ eligible: false, reason: 'stale_model' });
        expect(getFileEditorAiSuggestionModelEligibility(identity))
            .toMatchObject({ eligible: false, reason: 'missing_model_descriptor' });
        expect(getFileEditorAiSuggestionModelEligibility({ ...identity, descriptor: { id: model.id, name: model.name } }))
            .toMatchObject({ eligible: false, reason: 'unsupported_operation' });
        expect(getFileEditorAiSuggestionModelEligibility({ ...identity, descriptor: { ...model, contextWindowTokens: undefined } }))
            .toMatchObject({ eligible: false, reason: 'missing_context_window' });
    });
});
