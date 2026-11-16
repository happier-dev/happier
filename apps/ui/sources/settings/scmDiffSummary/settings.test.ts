import { describe, expect, it } from 'vitest';

import {
    SCM_DIFF_SUMMARY_SETTING_KEYS,
    resolveScmDiffSummarySettings,
    encodeScmDiffSummaryModelOverride,
    resolveScmDiffSummaryModelSelection,
} from './settings';
import { settingsParse } from '@/sync/domains/settings/settings';

const CODEX_MODEL = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-model' };

describe('SCM diff-summary settings', () => {
    it('resolves the stored runner through the protocol target reader', () => {
        const catalogId = encodeScmDiffSummaryModelOverride({ backendTargetKey: CODEX_MODEL.agentTargetKey, modelId: CODEX_MODEL.modelId });
        expect(resolveScmDiffSummaryModelSelection({ runner: { v: 1, modelSelection: CODEX_MODEL }, catalogProfiles: [{ catalogId, title: 'Offered model',
            modelSelector: { backendTargetKey: CODEX_MODEL.agentTargetKey, modelId: CODEX_MODEL.modelId }, structuredOutput: 'supported' }] })).toMatchObject({
            success: true, backendTarget: { kind: 'backend', backendId: 'codex' },
            modelSelector: { backendTargetKey: CODEX_MODEL.agentTargetKey, modelId: CODEX_MODEL.modelId },
        });
    });
    it('refuses a stored runner whose catalog model has unsupported structured output instead of using it', () => {
        const catalogId = encodeScmDiffSummaryModelOverride({ backendTargetKey: CODEX_MODEL.agentTargetKey, modelId: CODEX_MODEL.modelId });
        expect(resolveScmDiffSummarySettings({
            storedSettings: { [SCM_DIFF_SUMMARY_SETTING_KEYS.runner]: { v: 1, modelSelection: CODEX_MODEL } },
            catalogProfiles: [{ catalogId, title: 'Unsupported model', structuredOutput: 'unsupported' }],
        })).toMatchObject({ modelOverride: null, modelOverrideError: 'SCM_DIFF_SUMMARY_MODEL_UNSUPPORTED' });
    });
    it('keeps an explicit runner the catalog cannot vouch for visible as a choice rather than silently using Auto', () => {
        expect(resolveScmDiffSummarySettings({
            storedSettings: { [SCM_DIFF_SUMMARY_SETTING_KEYS.runner]: { v: 1, modelSelection: CODEX_MODEL } }, catalogProfiles: [],
        }).modelOverride?.modelSelector).toMatchObject({ modelSelection: CODEX_MODEL });
    });
    it('defaults the runner to Auto and prefetch off behind an explicit preference gate', () => {
        const parsed = settingsParse({});

        expect(parsed[SCM_DIFF_SUMMARY_SETTING_KEYS.enabled]).toBe(true);
        expect(parsed[SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch]).toBe(false);
        expect(parsed[SCM_DIFF_SUMMARY_SETTING_KEYS.investigateSurroundingFiles]).toBe(false);
        expect(parsed[SCM_DIFF_SUMMARY_SETTING_KEYS.runner]).toBeNull();
        expect(resolveScmDiffSummarySettings({ storedSettings: parsed, catalogProfiles: [] })).toEqual({
            enabled: true,
            prefetch: false,
            investigateSurroundingFiles: false,
            outputLanguage: null,
            modelOverride: null,
        });
    });
});
