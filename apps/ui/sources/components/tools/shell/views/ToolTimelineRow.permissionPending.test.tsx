import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ensureSidechainMessagesLoadedMock = vi.fn();

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
    TouchableOpacity: ({ children, ...props }: any) => React.createElement('TouchableOpacity', props, children),
    ActivityIndicator: 'ActivityIndicator',
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
                warning: '#f90',
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

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        Bash: { title: 'Bash' },
    },
}));

vi.mock('@/components/tools/normalization/core/normalizeToolCallForRendering', () => ({
    normalizeToolCallForRendering: (tool: any) => tool,
}));

vi.mock('@/components/tools/normalization/policy/toolNameInference', () => ({
    inferToolNameForRendering: ({ toolName }: any) => ({ normalizedToolName: toolName, source: 'original' }),
}));

vi.mock('@/components/tools/normalization/policy/resolveToolViewDetailLevel', () => ({
    resolveToolViewDetailLevel: () => 'summary',
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
    TextSelectabilityScope: ({ children }: any) => children,
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: (props: any) => React.createElement('PermissionFooter', props),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/agents/catalog/catalog', () => ({
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptCollapsible', () => ({
    TranscriptCollapsible: ({ expanded, children }: any) =>
        expanded ? React.createElement(React.Fragment, null, children) : null,
}));

let settings: Record<string, any> = {};
vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => settings[key],
}));

describe('ToolTimelineRow (permission pending)', () => {
    beforeEach(() => {
        settings = {
            toolViewDetailLevelDefault: 'summary',
            toolViewDetailLevelDefaultLocalControl: 'summary',
            toolViewDetailLevelByToolName: {},
            toolViewExpandedDetailLevelDefault: 'full',
            toolViewExpandedDetailLevelByToolName: {},
            toolViewTimelineFeedDefaultExpanded: false,
            toolViewTapAction: 'expand',
            permissionPromptSurface: 'transcript',
        };
    });

    it('renders PermissionFooter for pending permission requests in activity-feed rows', async () => {
        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            id: 'tool-1',
            name: 'Bash',
            state: 'running',
            input: { command: 'pwd' },
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: 'pwd',
            result: null,
            permission: { id: 'perm1', kind: 'command', status: 'pending' },
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ToolTimelineRow
                    tool={tool}
                    metadata={null}
                    sessionId="s1"
                    messageId="m1"
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                />,
            );
        });

        expect(tree!.root.findAllByType('PermissionFooter' as any)).toHaveLength(1);
    });

    it('renders PermissionFooter when transcript prompts are forced even if the global setting prefers the composer', async () => {
        settings.permissionPromptSurface = 'composer';

        const { ToolTimelineRow } = await import('./ToolTimelineRow');
        const tool: any = {
            id: 'tool-2',
            name: 'Bash',
            state: 'running',
            input: { command: 'pwd' },
            createdAt: 1,
            startedAt: 1,
            completedAt: null,
            description: 'pwd',
            result: null,
            permission: { id: 'perm2', kind: 'command', status: 'pending' },
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                <ToolTimelineRow
                    tool={tool}
                    metadata={null}
                    sessionId="s1"
                    messageId="m2"
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                    forcePermissionPromptsInTranscript={true}
                />,
            );
        });

        expect(tree!.root.findAllByType('PermissionFooter' as any)).toHaveLength(1);
    });
});
