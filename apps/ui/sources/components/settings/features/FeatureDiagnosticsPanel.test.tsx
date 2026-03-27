import * as React from 'react';
import { ReactTestRenderer } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import type { FeatureDecision, FeatureId } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const useFeatureDecisionMock = vi.fn<(featureId: FeatureId, scope?: unknown) => FeatureDecision | null>();

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: FeatureId, scope?: unknown) => useFeatureDecisionMock(featureId, scope),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

describe('FeatureDiagnosticsPanel', () => {
    it('renders one row per feature id', async () => {
        const { FeatureDiagnosticsPanel } = await import('./FeatureDiagnosticsPanel');

        const featureIds: FeatureId[] = ['voice', 'automations'];

        const decisionsById = new Map<FeatureId, FeatureDecision>([
            ['voice', {
                featureId: 'voice',
                state: 'enabled',
                blockedBy: null,
                blockerCode: 'none',
                diagnostics: [],
                evaluatedAt: 0,
                scope: { scopeKind: 'main_selection' },
            }],
            ['automations', {
                featureId: 'automations',
                state: 'disabled',
                blockedBy: 'server',
                blockerCode: 'endpoint_missing',
                diagnostics: ['missing /v2 endpoint'],
                evaluatedAt: 0,
                scope: { scopeKind: 'main_selection' },
            }],
        ]);

        useFeatureDecisionMock.mockImplementation((featureId: FeatureId) => {
            return decisionsById.get(featureId) ?? null;
        });

        let tree!: ReactTestRenderer;
        tree = (await renderScreen(React.createElement(FeatureDiagnosticsPanel, { featureIds }))).tree;

        const items = tree.findAllByType('Item' as any);
        expect(items).toHaveLength(featureIds.length);
        expect(items.map((item) => item.props.title)).toEqual(featureIds);
    });

    it('forwards scope to useFeatureDecision', async () => {
        const { FeatureDiagnosticsPanel } = await import('./FeatureDiagnosticsPanel');

        const featureIds: FeatureId[] = ['voice', 'automations'];
        useFeatureDecisionMock.mockReturnValue(null);

        await renderScreen(React.createElement(FeatureDiagnosticsPanel, { featureIds, scope: { scopeKind: 'runtime' } }));

        expect(useFeatureDecisionMock).toHaveBeenCalledWith('voice', { scopeKind: 'runtime' });
        expect(useFeatureDecisionMock).toHaveBeenCalledWith('automations', { scopeKind: 'runtime' });
    });
});
