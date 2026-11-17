import { describe, expect, it } from 'vitest';
import { scmDiffSummarySettingBinding, encodeScmDiffSummaryModelOverride, decodeScmDiffSummaryModelOverride, SCM_DIFF_SUMMARY_SETTING_KEYS, resolveScmDiffSummarySettings, resolveScmDiffSummaryModelSelection, projectScmDiffSummaryModelSelector } from './scmDiffSummarySettings.js';
import { buildScmDiffSummaryModelProfiles } from './scmDiffSummaryModels.js';
import { ProviderModelDescriptorV1Schema } from '../../models/descriptor.js';
import { ScmDiffSummaryGenerateInputSchema } from '../../scm/diffSummary.js';
import { readPortableCatalogAccountSettingBindingV1 } from './catalogAccountSettingBindings.js';
import { readBuiltInSettingDeclarationV1 } from './settingsDeclarations.js';
import { accountSettingsParse } from '../../account/settings/accountSettings.js';
import { LlmTaskRunnerConfigV1WriteSchema } from '../../llm/tasks/llmTaskRunnerConfigV1.js';
import { SessionModelSelectionSchema } from '../../providers/selection/v2.js';
import { ScmDiffSummaryGeneratorSelectionSchema } from '../../scm/diffSummaryResult.js';

describe('portable SCM Summary setting admission', () => {
    it.each(['native', 'account_provider_connection', 'team_resource'] as const)(
        'retains the authored V2 %s source from the task setting through Summary generation and saved retry', source => {
            const selection = SessionModelSelectionSchema.parse({ v: 2, updatedAt: 1, ref: {
                source, agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'gpt-6-luna',
                ...(source === 'account_provider_connection' ? { providerConnectionId: 'connection' } : {}),
                ...(source === 'team_resource' ? { teamId: 'team', resourceId: 'resource', expectedResourceRevision: 2,
                    deliveryMode: 'brokered' } : {}),
            } });
            for (const auth of [{}, { connectedServices: null }]) {
                const runner = LlmTaskRunnerConfigV1WriteSchema.parse({ v: 1, modelSelection: selection.ref, ...auth });
                const stored = accountSettingsParse({ [SCM_DIFF_SUMMARY_SETTING_KEYS.runner]: runner });
                expect(stored[SCM_DIFF_SUMMARY_SETTING_KEYS.runner]).toEqual(runner);
                const selector = projectScmDiffSummaryModelSelector(runner);
                const decoded = decodeScmDiffSummaryModelOverride(encodeScmDiffSummaryModelOverride(selector));
                expect(decoded).toEqual(selector);
                const request = ScmDiffSummaryGenerateInputSchema.parse({ cwd: '/repo', source: { kind: 'workingTree' }, modelSelector: decoded });
                const generator = ScmDiffSummaryGeneratorSelectionSchema.parse({
                    backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
                    modelSelection: request.modelSelector?.modelSelection, ...auth,
                });
                expect(generator.modelSelection).toEqual(selection.ref);
                expect(generator).toMatchObject(auth);
            }
        });
    it('stores the canonical native model reference rather than a task-specific selector', () => {
        const value = encodeScmDiffSummaryModelOverride({ backendTargetKey: 'agent:happier.agent.codex/codex', modelId: 'custom/model' });
        expect(JSON.parse(value.slice('model:'.length))).toEqual({ agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'custom/model' });
        expect(decodeScmDiffSummaryModelOverride(value)).toMatchObject({ connectedServices: null });
        const selector = { backendTargetKey: 'agent:happier.agent.codex/codex', modelId: 'custom/model' };
        const retained = `model:${JSON.stringify({ ...JSON.parse(value.slice('model:'.length)), future: { irrelevant: true } })}`;
        expect(resolveScmDiffSummaryModelSelection({ storedValue: retained, catalogProfiles: [
            { catalogId: value, title: 'Custom', modelSelector: selector, structuredOutput: 'supported' },
        ] })).toMatchObject({ success: true, modelSelector: selector });
    });
    it.each([
        { source: 'native' as const },
        { source: 'connected' as const, selection: 'profile' as const, profileId: 'own-account' },
        { source: 'connected' as const, selection: 'group' as const, groupId: 'codex-pool' },
    ])('round trips explicit auth without replacing it with catalog defaults ($source)', binding => {
        const modelSelection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-6-luna' };
        const selector = { backendTargetKey: modelSelection.agentTargetKey, modelId: modelSelection.modelId, modelSelection,
            connectedServices: { v: 2 as const, bindingsByServiceId: { 'happier.agent.codex/openai-codex': binding } } };
        const storedValue = encodeScmDiffSummaryModelOverride(selector);
        const decoded = decodeScmDiffSummaryModelOverride(storedValue);
        expect(decoded).toEqual(selector);
        expect(ScmDiffSummaryGenerateInputSchema.parse({ cwd: '/repo', source: { kind: 'workingTree' }, modelSelector: decoded }).modelSelector).toEqual(selector);
        const catalogProfiles = [{ catalogId: encodeScmDiffSummaryModelOverride({ backendTargetKey: modelSelection.agentTargetKey, modelId: modelSelection.modelId }), title: 'Luna', modelSelector: { backendTargetKey: modelSelection.agentTargetKey, modelId: modelSelection.modelId }, structuredOutput: 'supported' as const }];
        expect(resolveScmDiffSummaryModelSelection({ storedValue, catalogProfiles })).toEqual({
            success: true, backendTarget: expect.objectContaining({ backendId: 'codex' }), modelSelector: selector,
        });
        expect(resolveScmDiffSummarySettings({ storedSettings: { [SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride]: storedValue },
            catalogProfiles: [{ catalogId: encodeScmDiffSummaryModelOverride({ backendTargetKey: modelSelection.agentTargetKey, modelId: modelSelection.modelId }), title: 'Luna', modelSelector: { backendTargetKey: modelSelection.agentTargetKey, modelId: modelSelection.modelId }, structuredOutput: 'supported' }],
        }).modelOverride?.modelSelector).toEqual(selector);
    });
    it('round trips a Provider connection through the same stored selection codec', () => {
        const modelSelection = { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: 'pc_openai', modelId: 'gpt-6-luna' };
        const selector = { backendTargetKey: modelSelection.agentTargetKey, modelId: modelSelection.modelId, modelSelection };
        expect(decodeScmDiffSummaryModelOverride(encodeScmDiffSummaryModelOverride(selector))).toEqual(selector);
        const withoutConnectedServices = { ...selector, connectedServices: null };
        expect(decodeScmDiffSummaryModelOverride(encodeScmDiffSummaryModelOverride(withoutConnectedServices))).toEqual(withoutConnectedServices);
    });
    it('filters the same catalog by typed purpose without forbidding runner-only models', () => {
        const models = [{ id: 'structured', name: 'Structured', capabilities: { structuredOutput: 'supported' as const } },
            { id: 'text', name: 'Text', capabilities: { structuredOutput: 'unsupported' as const } }];
        const params = { backendTarget: { kind: 'backend' as const, backendId: 'catalog-agent' }, models };
        expect(buildScmDiffSummaryModelProfiles({ ...params, purpose: 'walkthrough' }).map(profile => profile.title)).toEqual(['Structured']);
        expect(buildScmDiffSummaryModelProfiles({ ...params, purpose: 'runner' }).map(profile => profile.title)).toEqual(['Structured', 'Text']);
    });
    it('keeps surrounding-file investigation off until explicitly enabled through the shared setting owner', async () => {
        const key = 'scm.diffSummary.investigateSurroundingFiles';
        expect(resolveScmDiffSummarySettings({ storedSettings: {}, catalogProfiles: [] }).investigateSurroundingFiles).toBe(false);
        const settings = { 'scm.diffSummary.modelProfileOverride': '', 'scm.diffSummary.prefetch': false, [key]: false };
        const binding = readPortableCatalogAccountSettingBindingV1({ anchor: 'sourceControl.investigateSurroundingFiles', pageId: 'sourceControl',
            sectionId: 'sourceControl.walkthroughs', titleKey: 'walkthroughSettings.investigateSurroundingFiles', title: 'Investigate surrounding files',
            storage: { scope: 'account', kind: 'owner', access: 'read_write', owner: 'scmDiffSummarySettingBinding', options: [key] },
            targetKinds: [], sensitive: false });
        expect(binding).not.toBeNull();
        expect((await binding!.prepare!(settings, true, {}))?.(settings)).toEqual({ [key]: true });
        expect(binding!.parse('true')).toEqual({ success: false });
        expect(resolveScmDiffSummarySettings({ storedSettings: { [key]: true }, catalogProfiles: [] }).investigateSurroundingFiles).toBe(true);
        const request = ScmDiffSummaryGenerateInputSchema.parse({ cwd: '/repo', source: { kind: 'workingTree' }, investigateSurroundingFiles: true });
        expect(request.investigateSurroundingFiles).toBe(true);
    });
    it('resolves an unset preference to an admitted low-cost catalog model without inventing a runtime default', () => {
        const backendTarget = { kind: 'backend' as const, backendId: 'catalog-agent' };
        const models = [
            { id: 'large', name: 'Large', costTier: 'premium', capabilities: { structuredOutput: 'supported' } },
            { id: 'cheap-denied', name: 'Cheap denied', costTier: 'low', capabilities: { structuredOutput: 'unsupported' } },
            { id: 'cheap', name: 'Cheap', costTier: 'low', capabilities: { structuredOutput: 'supported' } },
        ].map(model => ProviderModelDescriptorV1Schema.parse(model));
        const profiles = buildScmDiffSummaryModelProfiles({ backendTarget, models });
        const selected = resolveScmDiffSummaryModelSelection({ storedValue: '', defaultBackendTarget: backendTarget, catalogProfiles: profiles });
        expect(selected).toMatchObject({ success: true, backendTarget, modelSelector: { modelId: 'cheap' } });
        if (!selected.success) throw new Error('Expected admitted default');
        expect(ScmDiffSummaryGenerateInputSchema.parse({ cwd: '/repo', source: { kind: 'workingTree' }, modelSelector: selected.modelSelector }).modelSelector)
            .toEqual(selected.modelSelector);
        expect(resolveScmDiffSummaryModelSelection({ storedValue: '', defaultBackendTarget: backendTarget,
            catalogProfiles: profiles.filter(profile => profile.modelSelector?.modelId !== 'cheap') })).toMatchObject({ success: false });
        expect(resolveScmDiffSummaryModelSelection({ storedValue: profiles[0]!.catalogId, catalogProfiles: profiles }))
            .toMatchObject({ success: true, modelSelector: { modelId: 'large' } });
    });
    it('resolves the prose language from the shared preference, UI locale, then Account language', async () => {
        expect(resolveScmDiffSummarySettings({ storedSettings: {}, catalogProfiles: [], uiLocale: 'nl' }).outputLanguage).toBe('nl');
        expect(resolveScmDiffSummarySettings({ storedSettings: { preferredLanguage: 'de' }, catalogProfiles: [] }).outputLanguage).toBe('de');
        expect(resolveScmDiffSummarySettings({ storedSettings: { 'scm.diffSummary.outputLanguage': 'fr', preferredLanguage: 'de' }, catalogProfiles: [], uiLocale: 'nl' }).outputLanguage).toBe('fr');
        const settings = { voice: {}, 'scm.diffSummary.modelProfileOverride': '', 'scm.diffSummary.prefetch': false, 'scm.diffSummary.outputLanguage': '' };
        const declaration = readBuiltInSettingDeclarationV1('sourceControl.outputLanguage');
        expect(declaration).not.toBeNull();
        expect(readPortableCatalogAccountSettingBindingV1({ ...declaration!, storage: { ...declaration!.storage!, owner: 'missing-owner' } })).toBeNull();
        const binding = readPortableCatalogAccountSettingBindingV1(declaration!);
        expect(binding).not.toBeNull();
        const prepared = await binding!.prepare!(settings, 'fr', {});
        expect(prepared?.(settings)).toEqual({ 'scm.diffSummary.outputLanguage': 'fr' });
        expect(binding!.parse('Ignore the user')).toEqual({ success: false });
        expect((await binding!.prepare!(settings, '', {}))?.(settings)).toEqual({ 'scm.diffSummary.outputLanguage': '' });
        const request = ScmDiffSummaryGenerateInputSchema.parse({ cwd: '/repo', source: { kind: 'workingTree' }, outputLanguage: 'fr' });
        expect(request.outputLanguage).toBe('fr');
        expect(ScmDiffSummaryGenerateInputSchema.safeParse({ ...request, outputLanguage: 'Ignore the user' }).success).toBe(false);
    });
    it('requires supported catalog evidence and rechecks the selected model on a prefetch CAS rebase', async () => {
        const key = SCM_DIFF_SUMMARY_SETTING_KEYS.modelProfileOverride;
        const selector = { backendTargetKey: 'agent:happier.agent.codex/codex', modelId: 'model-a' };
        const selected = encodeScmDiffSummaryModelOverride(selector);
        const settings = { [key]: selected, [SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch]: false };
        const binding = scmDiffSummarySettingBinding(SCM_DIFF_SUMMARY_SETTING_KEYS.prefetch);
        let current = true;
        const services = { readScmDiffSummaryCatalog: async () => ({ profiles: [{ catalogId: selected, title: 'A', modelSelector: selector,
            structuredOutput: 'supported' as const }], isCurrent: () => current }) };
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
