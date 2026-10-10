import { describe, expect, it } from 'vitest';
import { scmDiffSummarySettingBinding, encodeScmDiffSummaryModelOverride, SCM_DIFF_SUMMARY_SETTING_KEYS } from './scmDiffSummarySettings.js';

describe('portable SCM Summary setting admission', () => {
    it('requires supported catalog evidence and rechecks the selected model on a prefetch CAS rebase', async () => {
        const key = SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride;
        const selected = encodeScmDiffSummaryModelOverride({ backendTargetKey: 'agent:happier.agent.codex/codex', modelId: 'model-a' });
        const settings = { [key]: selected, [SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch]: false };
        const binding = scmDiffSummarySettingBinding(SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch);
        let current = true;
        const services = { readScmDiffSummaryCatalog: async () => ({ profiles: [{ catalogId: selected, title: 'A', structuredOutput: 'supported' as const }], isCurrent: () => current }) };
        const prepared = await binding.prepare!(settings, true, services);
        expect(prepared?.(settings)).toEqual({ [SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch]: true });
        expect(await binding.prepare(settings, 'false', services)).toBeNull();
        expect(prepared?.({ ...settings, [key]: '' })).toBeNull();
        current = false;
        expect(prepared?.(settings)).toBeNull();
        expect(await binding.prepare!(settings, true, { readScmDiffSummaryCatalog: async () => ({ profiles: [{ catalogId: selected, title: 'A', structuredOutput: 'unknown' }], isCurrent: () => true }) })).toBeNull();
    });
    it('allows disabling prefetch without a catalog but refuses arbitrary values', async () => {
        const binding = scmDiffSummarySettingBinding(SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch);
        const settings = { [SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]: '', [SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch]: true };
        expect(binding.parse('false')).toEqual({ success: false });
        expect((await binding.prepare!(settings, false, {}))?.(settings)).toEqual({ [SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch]: false });
        expect(await binding.prepare(settings, 'false', {})).toBeNull();
        const model = scmDiffSummarySettingBinding(SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride);
        expect(await model.prepare(settings, { arbitrary: 'model' }, {})).toBeNull();
    });
    it('clears the explicit model override without requiring evidence for the removed model', async () => {
        const key = SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride;
        const settings = { [key]: 'model:unavailable', [SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch]: false };
        const binding = scmDiffSummarySettingBinding(key);
        const prepared = await binding.prepare(settings, '', {});
        expect(prepared?.(settings)).toEqual({ [key]: '' });
        const controller = new AbortController();
        const canceled = await binding.prepare(settings, '', {}, { signal: controller.signal, isCurrent: () => true });
        controller.abort();
        expect(canceled?.(settings)).toBeNull();
    });
});
