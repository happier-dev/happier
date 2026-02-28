import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => ({
    Platform: { OS: 'web', select: (values: any) => values?.web ?? values?.default },
    View: 'View',
    Text: 'Text',
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    Animated: {
        Value: class {
            constructor(_v: any) {}
            setValue(_v: any) {}
            interpolate(_cfg: any) { return 0; }
        },
        timing: () => ({ start: (cb?: any) => cb?.({ finished: true }) }),
        View: ({ children, ...props }: any) => React.createElement('AnimatedView', props, children),
    },
    Easing: {
        bezier: () => (t: number) => t,
        linear: (t: number) => t,
    },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#111',
                textSecondary: '#555',
                surfaceHigh: '#eee',
                surfaceHighest: '#fff',
                surfacePressedOverlay: '#ddd',
            },
        },
    }),
    StyleSheet: {
        create: (input: any) => {
            const theme = {
                colors: {
                    text: '#111',
                    textSecondary: '#555',
                    surfaceHigh: '#eee',
                    surfaceHighest: '#fff',
                    surfacePressedOverlay: '#ddd',
                },
            };
            return typeof input === 'function' ? input(theme, {}) : input;
        },
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {},
}));

vi.mock('@/components/tools/normalization/core/normalizeToolCallForRendering', () => ({
    normalizeToolCallForRendering: (t: any) => t,
}));

let inferred: { normalizedToolName: string; source: string } = { normalizedToolName: 'UnknownTool', source: 'original' };
vi.mock('@/components/tools/normalization/policy/toolNameInference', () => ({
    inferToolNameForRendering: () => inferred,
}));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: (name: string) => name,
    formatMCPSubtitle: () => null,
}));

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/shell/presentation/ToolSectionView', () => ({
    ToolSectionView: ({ children }: any) => React.createElement('ToolSectionView', null, children),
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: (props: any) => React.createElement('CodeView', props),
}));

vi.mock('@/components/tools/shell/presentation/ToolHeaderActionsContext', () => ({
    ToolHeaderActionsContext: { Provider: ({ children }: any) => children },
}));

vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
    StructuredResultView: () => React.createElement('StructuredResultView'),
}));

vi.mock('@/utils/errors/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('@/components/tools/shell/presentation/ToolError', () => ({
    ToolError: () => React.createElement('ToolError'),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/text', () => ({
    t: (_key: string) => _key,
}));

vi.mock('@/agents/catalog/catalog', () => ({
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

let settings: Record<string, any> = {};
vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => settings[key],
}));

function collectRenderedText(tree: renderer.ReactTestRenderer): string {
    return tree.root
        .findAllByType('Text')
        .map((node) => (node.props as any).children)
        .flat()
        .filter((v) => typeof v === 'string')
        .join(' ');
}

describe('ToolTimelineRow (title fallback)', () => {
    beforeEach(() => {
        settings = {
            toolViewDetailLevelDefault: 'summary',
            toolViewDetailLevelDefaultLocalControl: 'summary',
            toolViewDetailLevelByToolName: {},
            toolViewExpandedDetailLevelDefault: 'summary',
            toolViewExpandedDetailLevelByToolName: {},
            toolViewTimelineFeedDefaultExpanded: false,
            toolViewTimelineFeedTapAction: 'expand',
        };
        inferred = { normalizedToolName: 'UnknownTool', source: 'original' };
    });

    it('does not use description as title when inference did not fall back', async () => {
        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            name: 'UnknownTool',
            state: 'completed',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: 'Execute',
            result: {},
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ToolTimelineRow tool={tool} metadata={null} />);
        });

        expect(collectRenderedText(tree!)).toContain('UnknownTool');
        expect(collectRenderedText(tree!)).not.toContain('Execute');
    });

    it('uses description as title when inference fell back and tool is unknown', async () => {
        inferred = { normalizedToolName: 'SomeInferredTool', source: 'description' };
        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            name: 'UnknownTool',
            state: 'completed',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: 'Search files',
            result: {},
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ToolTimelineRow tool={tool} metadata={null} />);
        });

        expect(collectRenderedText(tree!)).toContain('Search files');
    });
});
