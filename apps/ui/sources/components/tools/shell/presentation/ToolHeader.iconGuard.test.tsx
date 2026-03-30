import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { installToolShellPresentationCommonModuleMocks } from './toolShellPresentationTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installToolShellPresentationCommonModuleMocks();

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        'test-tool': {
            icon: true,
        },
    },
}));

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/normalization/core/normalizeToolCallForRendering', () => ({
    normalizeToolCallForRendering: (tool: any) => tool,
}));

vi.mock('@/components/tools/shell/presentation/resolveToolHeaderTextPresentation', () => ({
    resolveToolHeaderTextPresentation: () => ({
        normalizedToolName: 'test-tool',
        title: 'Test',
        subtitle: null,
        statusText: null,
    }),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

describe('ToolHeader', () => {
    it('does not crash when knownTool.icon is present but not a function', async () => {
        const { buildToolHeaderModel } = await import('./buildToolHeaderModel');

        let model: any;
        expect(() => {
            model = buildToolHeaderModel({
                tool: {
                    id: 'tool-1',
                    name: 'test-tool',
                    state: 'completed',
                    input: {},
                    result: null,
                } as any,
                metadata: null,
                iconSize: 18,
                iconColorPrimary: '#000',
                iconColorSecondary: '#666',
            });
        }).not.toThrow();

        expect(model).toBeTruthy();
        expect(model.icon).toBeTruthy();
    });
});
