import { describe, expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { listWorkflowStepActionSpecs } from './workflowActionCatalog';

describe('workflow executing-machine Action catalog', () => {
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
            title: 'Summarize', inputHints: { fields: [{ path: 'topic', required: true }] },
        });
        expect(specs.some((spec) => ['example.tools/actions/missing', 'example.tools/actions/ui-only',
            'example.tools/actions/client-only'].includes(spec.id))).toBe(false);
        expect(specs.some((spec) => spec.id === 'review.start')).toBe(true);
        expect(specs.some((spec) => spec.id.startsWith('workflow.run.'))).toBe(false);
    });
});
