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
                surface: '#fff',
                text: '#111',
                textSecondary: '#555',
                textLink: '#09f',
                textDestructive: '#c00',
                divider: '#ddd',
                shadow: { color: '#000' },
                surfaceHigh: '#eee',
                surfaceHighest: '#fff',
                surfacePressedOverlay: '#ddd',
                warning: '#f90',
            },
        },
    }),
    StyleSheet: {
        create: (input: any) => {
            const theme = {
                colors: {
                    surface: '#fff',
                    text: '#111',
                    textSecondary: '#555',
                    textLink: '#09f',
                    textDestructive: '#c00',
                    divider: '#ddd',
                    shadow: { color: '#000' },
                    surfaceHigh: '#eee',
                    surfaceHighest: '#fff',
                    surfacePressedOverlay: '#ddd',
                    warning: '#f90',
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

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {},
}));

vi.mock('@/components/tools/normalization/core/normalizeToolCallForRendering', () => ({
    normalizeToolCallForRendering: (t: any) => t,
}));

vi.mock('@/components/tools/normalization/policy/toolNameInference', () => ({
    inferToolNameForRendering: ({ toolName }: any) => ({ normalizedToolName: toolName, source: 'original' }),
}));

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/normalization/policy/resolveToolViewDetailLevel', () => ({
    resolveToolViewDetailLevel: () => 'summary',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/components/tools/shell/views/ToolInlineBody', () => ({
    ToolInlineBody: () => React.createElement('ToolInlineBody'),
}));

vi.mock('@/agents/catalog/catalog', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/agents/catalog/catalog')>();
    return {
        ...actual,
        resolveAgentIdFromFlavor: () => null,
        getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
    };
});

let settings: Record<string, any> = {};
vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => settings[key],
}));

describe('ToolTimelineRow (unknown tool collapse)', () => {
    beforeEach(() => {
        settings = {
            toolViewDetailLevelDefault: 'summary',
            toolViewDetailLevelDefaultLocalControl: 'summary',
            toolViewDetailLevelByToolName: {},
            toolViewExpandedDetailLevelDefault: 'full',
            toolViewExpandedDetailLevelByToolName: {},
            toolViewTimelineFeedDefaultExpanded: false,
            toolViewTimelineFeedTapAction: 'expand',
        };
    });

    it('collapses completed unknown tools to title-only by default', async () => {
        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            name: 'TotallyUnknownTool',
            state: 'completed',
            input: { a: 1 },
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: { ok: true },
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ToolTimelineRow tool={tool} metadata={null} />);
        });

        const bodies = tree!.root.findAll((node) => (node.props as any).testID === 'tool-timeline-body');
        expect(bodies).toHaveLength(0);
    });
});
