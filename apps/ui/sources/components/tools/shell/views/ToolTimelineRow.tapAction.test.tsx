import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ensureSidechainMessagesLoadedMock = vi.fn(async () => 'loaded');

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: ensureSidechainMessagesLoadedMock,
    },
}));

vi.mock('react-native', async () => ({
    Platform: { OS: 'web', select: (values: any) => values?.web ?? values?.default },
    View: 'View',
    Text: 'Text',
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props),
    Animated: {
        Value: class {
            constructor(_v: any) {}
            setValue(_v: any) {}
            interpolate(_cfg: any) { return 0; }
        },
        timing: () => ({ start: (cb?: any) => cb?.({ finished: true }) }),
        parallel: (xs: any[]) => ({ start: (cb?: any) => { xs.forEach((x) => x?.start?.()); cb?.({ finished: true }); } }),
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
                divider: '#ccc',
                shadow: { color: '#000', opacity: 0.1 },
                accent: { blue: '#06f' },
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
                    divider: '#ccc',
                    shadow: { color: '#000', opacity: 0.1 },
                    accent: { blue: '#06f' },
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

vi.mock('@/components/tools/normalization/policy/toolNameInference', () => ({
    inferToolNameForRendering: ({ toolName }: any) => ({ normalizedToolName: toolName, source: 'original' }),
}));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: (name: string) => name,
    formatMCPSubtitle: () => null,
}));

const specificToolViewMock = vi.fn((props: any) => React.createElement('SpecificToolView', props));
vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => specificToolViewMock,
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
    TextInput: (props: any) => React.createElement('TextInput', props),
    TextSelectabilityScope: (props: any) => React.createElement('TextSelectabilityScope', props, props.children),
}));

vi.mock('@/text', () => ({
    t: (_key: string) => _key,
}));

vi.mock('@/agents/catalog/catalog', () => ({
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

const pushSpy = vi.fn();
vi.mock('expo-router', () => ({
    useRouter: () => ({ push: pushSpy }),
}));

let settings: Record<string, any> = {};
vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => settings[key],
}));

describe('ToolTimelineRow (tap action)', () => {
    beforeEach(() => {
        pushSpy.mockClear();
        specificToolViewMock.mockClear();
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');
        settings = {
            toolViewDetailLevelDefault: 'title',
            toolViewDetailLevelDefaultLocalControl: 'summary',
            toolViewDetailLevelByToolName: {},
            toolViewExpandedDetailLevelDefault: 'summary',
            toolViewExpandedDetailLevelByToolName: {},
            toolViewTimelineFeedDefaultExpanded: false,
            toolViewTapAction: 'expand',
        };
    });

    it('toggles expand when tap action is expand', async () => {
        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            name: 'read',
            state: 'completed',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: {},
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ToolTimelineRow tool={tool} metadata={null} sessionId="s1" messageId="m1" />);
        });

        expect(tree!.root.findAllByType('SpecificToolView' as any)).toHaveLength(0);
        const pressable = tree!.root.findAllByType('Pressable' as any)[0];
        await act(async () => {
            pressable.props.onPress();
        });
        expect(tree!.root.findAllByType('SpecificToolView' as any)).toHaveLength(1);
    });

    it('keeps the header density stable when toggling expand', async () => {
        const { ToolTimelineRow } = await import('./ToolTimelineRow');

        const tool: any = {
            name: 'read',
            state: 'completed',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: {},
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ToolTimelineRow tool={tool} metadata={null} sessionId="s1" messageId="m1" />);
        });

        const findHeaderTitleFontSize = () => {
            const titleText = tree!.root
                .findAllByType('Text' as any)
                .find((n: any) => n.props?.numberOfLines === 1);
            expect(titleText).toBeTruthy();
            const style = titleText!.props?.style;
            const styleArray = Array.isArray(style) ? style : [style];
            const merged = Object.assign({}, ...styleArray.filter(Boolean));
            return merged.fontSize;
        };

        expect(findHeaderTitleFontSize()).toBe(13);

        const pressable = tree!.root.findAllByType('Pressable' as any)[0];
        await act(async () => {
            pressable.props.onPress();
        });

        expect(findHeaderTitleFontSize()).toBe(13);
    });

    it('prefers a stable server route when tap action is open and the message is already persisted', async () => {
        settings.toolViewTapAction = 'open';
        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            id: 'call_read_1',
            name: 'read',
            state: 'completed',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: {},
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ToolTimelineRow
                    tool={tool}
                    metadata={null}
                    sessionId="s1"
                    messageId="server:server-msg-1"
                />,
            );
        });

        const pressable = tree!.root.findAllByType('Pressable' as any)[0];
        await act(async () => {
            pressable.props.onPress();
        });

        expect(pushSpy).toHaveBeenCalledTimes(1);
        expect(pushSpy).toHaveBeenCalledWith('/session/s1/message/server%3Aserver-msg-1');
        expect(tree!.root.findAllByType('SpecificToolView' as any)).toHaveLength(0);
    });

    it('suppresses open-details routing when tool navigation is disabled, even if the tool has its own id', async () => {
        settings.toolViewTapAction = 'open';
        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            id: 'subagent_run_1',
            name: 'SubAgentRun',
            state: 'completed',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: {},
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ToolTimelineRow
                    tool={tool}
                    metadata={null}
                    sessionId="s1"
                    messageId={undefined}
                    interaction={{ canSendMessages: true, canApprovePermissions: true, disableToolNavigation: true }}
                />,
            );
        });

        const hostText = tree!.root.findAllByType('Text' as any).map((n: any) => String(n.props?.children ?? '')).join(' ');
        expect(hostText).not.toContain('toolView.open');

        const pressable = tree!.root.findAllByType('Pressable' as any)[0];
        await act(async () => {
            pressable.props.onPress();
        });

        expect(pushSpy).not.toHaveBeenCalled();
        expect(tree!.root.findAllByType('SpecificToolView' as any)).toHaveLength(1);
    });

    it('auto-expands and shows action-required status for pending user-action tools', async () => {
        settings.toolViewTapAction = 'expand';
        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            name: 'AskUserQuestion',
            state: 'running',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: null,
            permission: {
                id: 'perm-1',
                status: 'pending',
                kind: 'user_action',
            },
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ToolTimelineRow tool={tool} metadata={null} sessionId="s1" messageId="m1" />);
        });

        expect(tree!.root.findAllByType('SpecificToolView' as any)).toHaveLength(1);
        const hostText = tree!.root.findAllByType('Text' as any).map((n: any) => String(n.props?.children ?? '')).join(' ');
        expect(hostText).toContain('status.actionRequired');
    });

    it('preloads sidechain messages when a Task tool is expanded', async () => {
        settings.toolViewTapAction = 'expand';
        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            id: 'tool_task_1',
            name: 'Task',
            state: 'completed',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            description: null,
            result: {},
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ToolTimelineRow tool={tool} metadata={null} sessionId="s1" messageId="m1" />);
        });

        expect(ensureSidechainMessagesLoadedMock).not.toHaveBeenCalled();

        const pressable = tree!.root.findAllByType('Pressable' as any)[0];
        await act(async () => {
            pressable.props.onPress();
            await Promise.resolve();
        });

        expect(ensureSidechainMessagesLoadedMock).toHaveBeenCalledWith('s1', 'tool_task_1');
    });

    it('shows a running indicator in the header for Task tools', async () => {
        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            name: 'Task',
            state: 'running',
            input: { description: 'Do stuff' },
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: null,
            result: null,
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ToolTimelineRow tool={tool} metadata={null} sessionId="s1" messageId="m1" />);
        });

        const indicators = tree!.root.findAllByType('ActivityIndicator' as any);
        expect(indicators.length).toBeGreaterThan(0);
    });
});
