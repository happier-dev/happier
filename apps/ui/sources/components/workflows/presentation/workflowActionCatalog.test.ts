import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod/mini';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { getActionSpec, listActionSpecs } from '@happier-dev/protocol/actions/actionSpecs';
import { isWorkflowRunSummaryActionIdV1 } from '@happier-dev/protocol/actions/actionIds';
import { resolveEffectiveActionInputFields } from '@happier-dev/protocol/actions/actionInputHintsRuntime';
import { createDailyHealthDigestWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/backupExamples';
import { walkWorkflowBlocks } from '@happier-dev/protocol/workflows/workflowDefinitionEditV1';
import { listWorkflowStepActionSpecs, projectWorkflowHostActionSpecs } from './workflowActionCatalog';
import { zodSchemaToJsonSchemaObject } from '@happier-dev/protocol/actions/actionInputJsonSchema';
import { getPreferredLanguage, preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { createPluginLocalizedTextResolver, createPluginUiTranslationRuntime } from '@/sync/domains/plugins/ui/i18n';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

describe('workflow executing-machine Action catalog', () => {
    it('offers every Daily health digest Action while excluding Run composition controls', () => {
        const specs = listWorkflowStepActionSpecs();
        walkWorkflowBlocks(createDailyHealthDigestWorkflowV1().blocks).forEach(block => {
            if (block.kind !== 'action') return;
            expect(specs.find(spec => spec.id === block.actionId), block.actionId).toBeDefined();
        });
        const summary = specs.find(spec => spec.id === 'workflow.run.summaries');
        expect(summary?.inputHints?.fields.some(field => field.path === 'automationIds')).toBe(true);
        expect(specs.some(spec => spec.id === 'workflow.run.start')).toBe(false);
        expect(specs.some(spec => spec.id === 'workflow.run.cancel')).toBe(false);
    });
    it('retains a typed unavailable host Action beside healthy choices when its schema contains an undefined node', () => {
        const healthy = getActionSpec('review.start');
        // Malformed declaration boundary: reproduces the live undefined _zod child.
        const inputSchema = z.object({ value: undefined });
        const broken = { ...getActionSpec('teams.archive'), inputSchema,
            get inputHints() { zodSchemaToJsonSchemaObject(inputSchema); return undefined; } };
        // Console is the diagnostic boundary; the real lazy schema/projector still throws.
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const result = projectWorkflowHostActionSpecs([healthy, broken, getActionSpec('notifications.notify_me')]);
            expect(result.map(spec => spec.id)).toEqual([healthy.id, broken.id, 'notifications.notify_me']);
            expect(result[1]).toMatchObject({ projectionError: 'action_schema_unrepresentable' });
            expect(result[1]?.inputHints).toBeUndefined();
            expect(warning).not.toHaveBeenCalled();
        } finally { warning.mockRestore(); }
    });

    it('retains a typed unavailable contributed Action beside healthy host and plugin choices', () => {
        const action = { id: 'example.tools/healthy', pluginId: 'example.tools', occurrenceId: 'occurrence-a',
            title: 'Healthy', scopes: ['global'], surfaces: ['agent'], execution: { target: 'daemon' },
            dangerLevel: 'safe', available: true };
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {}, actionsById: {
            [action.id]: action, 'example.tools/broken': { ...action, id: 'example.tools/broken' },
        } });
        const inputSchema = z.lazy(() => { throw new Error('Malformed declaration schema'); });
        Object.defineProperty(projection.actionsById['example.tools/broken'], 'inputHints', {
            get() { zodSchemaToJsonSchemaObject(inputSchema); return undefined; },
        });
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const result = listWorkflowStepActionSpecs(projection);
            expect(result.some(spec => spec.id === 'review.start')).toBe(true);
            expect(result.some(spec => spec.id === 'example.tools/actions/healthy')).toBe(true);
            expect(result.find(spec => spec.id === 'example.tools/actions/broken'))
                .toMatchObject({ projectionError: 'action_schema_unrepresentable', title: 'Healthy' });
            expect(warning).not.toHaveBeenCalled();
        } finally { warning.mockRestore(); }
    });
    it('resolves contributed Action titles and form prompts through the demanded locale Resources', async () => {
        const pluginId = 'example.tools';
        const presentation: PluginUiProjectionModel = { ...EMPTY_PLUGIN_UI_PROJECTION, translationsByPluginId: {
            [pluginId]: { id: `translations:${pluginId}`, pluginId, contributionKind: 'translations', locales: ['en', 'fr'],
                resourceIdsByLocale: { en: 'copy-en', fr: 'copy-fr' } },
        } };
        const runtime = createPluginUiTranslationRuntime({ projection: presentation, readResourceBytes: async (_projection, _plugin, resourceId) => (
            new TextEncoder().encode(JSON.stringify(resourceId === 'copy-fr'
                ? { title: 'Résumer', prompt: 'Quel sujet ?' } : { title: 'Summarize', prompt: 'Which topic?' }))
        ) });
        await runtime.demand(pluginId, 'fr');
        const action = { id: `${pluginId}/summarize`, pluginId, occurrenceId: 'occurrence-a',
            title: { key: 'title', fallback: 'Summarize' }, scopes: ['global'], surfaces: ['agent'], execution: { target: 'daemon' },
            dangerLevel: 'safe', available: true,
            inputHints: { fields: [{ path: 'topic', title: 'Topic', prompt: { key: 'prompt', fallback: 'Which topic?' }, widget: 'text' }] } };
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {}, actionsById: { [action.id]: action } });
        const specs = listWorkflowStepActionSpecs(projection, presentation,
            createPluginLocalizedTextResolver({ projection: presentation, runtime, locale: 'fr' }));
        expect(specs.find(spec => spec.id === `${pluginId}/actions/summarize`)).toMatchObject({
            title: 'Résumer', inputHints: { fields: [{ prompt: 'Quel sujet ?' }] },
        });
        runtime.dispose();
    });

    it('carries the shared trigger-list union fields into Action steps without losing required inputs', () => {
        const step = listWorkflowStepActionSpecs().find(spec => spec.id === 'workflow.trigger.list');
        expect(step).toBeDefined();
        const input = { workflow: 'builtin:keep-going' };
        const fields = resolveEffectiveActionInputFields(step!, input);
        expect(fields.find(field => field.path === 'workflow'))
            .toMatchObject({ required: true, optionsSourceId: 'workflows.references.available' });
        const candidate = Object.fromEntries(fields.flatMap(field => field.path in input
            ? [[field.path, input[field.path as keyof typeof input]]] : []));
        expect(getActionSpec('workflow.trigger.list').inputSchema.parse(candidate)).toEqual(input);
        expect(resolveEffectiveActionInputFields(step!, { scope: 'account_all' })
            .find(field => field.path === 'workflow')?.required).toBe(false);
    });
    it('localizes declared host setup prompts without rewriting plugin-authored questions or noun titles', async () => {
        const previousLanguage = getPreferredLanguage();
        await preloadTranslations('fr');
        setPreferredLanguageFromSettings('fr');
        try {
            const action = { id: 'example.tools/select', pluginId: 'example.tools', occurrenceId: 'occurrence-a',
                title: 'Select', scopes: ['global'], surfaces: ['agent'], execution: { target: 'daemon' },
                dangerLevel: 'safe', available: true,
                inputHints: { fields: [{ path: 'project', title: 'Plugin project', prompt: 'Which project?', widget: 'text' }] } };
            const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {}, actionsById: { [action.id]: action } });
            const specs = listWorkflowStepActionSpecs(projection);
            expect(specs.find(spec => spec.id === 'projects.context.update')?.inputHints?.fields.find(field => field.path === 'target'))
                .toMatchObject({ title: 'Qualified Project', prompt: t('widgetAdd.prompts.project') });
            expect(specs.find(spec => spec.id === 'example.tools/actions/select')?.inputHints?.fields[0])
                .toMatchObject({ title: 'Plugin project', prompt: 'Which project?' });
        } finally {
            setPreferredLanguageFromSettings(previousLanguage);
        }
    });
    it('offers host Actions by their execution-placement metadata, excluding client UI and composition controls', () => {
        const specs = listWorkflowStepActionSpecs();
        const eligible = listActionSpecs().filter((spec) => spec.surfaces.agent
            && spec.executionPlacement !== 'client'
            && (!spec.id.startsWith('workflow.run.') || isWorkflowRunSummaryActionIdV1(spec.id)));
        expect(specs.map((spec) => spec.id).sort()).toEqual(eligible.map((spec) => spec.id).sort());
        expect(specs.slice(0, 2).map(spec => spec.id)).toEqual(['notifications.notify_me', 'review.start']);
        expect(specs.some((spec) => spec.id === 'notifications.notify_me')).toBe(true);
        expect(specs.some((spec) => spec.id === 'session.terminals.open')).toBe(false);
        expect(specs.find((spec) => spec.id === 'artifact.create')?.title).toBe('Create a document');
        expect(specs.find((spec) => spec.id === 'session.role.set')?.title).toBe('Set a session’s role');
        expect(specs.filter((spec) => spec.title === 'Action').map((spec) => spec.id),
            'Every offered Action needs a human catalog title').toEqual([]);
    });

    it('includes daemon plugin Actions with canonical qualified ids and excludes unavailable/client-only Actions', () => {
        const action = { id: 'example.tools/summarize', pluginId: 'example.tools', occurrenceId: 'occurrence-a',
            title: 'Summarize', scopes: ['global'], surfaces: ['agent'], execution: { target: 'daemon' },
            dangerLevel: 'safe', available: true,
            inputHints: { fields: [{ path: 'topic', title: 'Topic', widget: 'text', required: true }] } };
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, familiesById: {}, actionsById: {
            [action.id]: action,
            'example.tools/missing': { ...action, id: 'example.tools/missing', available: false },
            'example.tools/ui-only': { ...action, id: 'example.tools/ui-only', surfaces: ['ui'] },
            'example.tools/client-only': { ...action, id: 'example.tools/client-only',
                execution: { target: 'client', client: { artifactId: 'client', exportName: 'activate' }, platforms: ['web'] } },
        } });
        const specs = listWorkflowStepActionSpecs(projection);
        expect(specs.find((spec) => spec.id === 'example.tools/actions/summarize')).toMatchObject({
            title: 'Summarize', plugin: { id: 'example.tools' }, inputHints: { fields: [{ path: 'topic', required: true }] },
        });
        expect(specs.some((spec) => ['example.tools/actions/missing', 'example.tools/actions/ui-only',
            'example.tools/actions/client-only'].includes(spec.id))).toBe(false);
        expect(specs.some((spec) => spec.id === 'review.start')).toBe(true);
        expect(specs.filter(spec => spec.id.startsWith('workflow.run.')).map(spec => spec.id)).toEqual(['workflow.run.summaries']);
    });
});
