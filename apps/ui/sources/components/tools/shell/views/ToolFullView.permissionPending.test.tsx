import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import {
    installToolShellCommonModuleMocks,
    makeToolCall,
} from './ToolView.testHelpers';
import type { Message } from '@/sync/domains/messages/messageTypes';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hoisted = vi.hoisted(() => ({
    ensureSidechainMessagesLoadedMock: vi.fn(),
    chainTranscriptListSpy: vi.fn(),
}));

const ensureSidechainMessagesLoadedMock = hoisted.ensureSidechainMessagesLoadedMock;
const chainTranscriptListSpy = hoisted.chainTranscriptListSpy;

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: hoisted.ensureSidechainMessagesLoadedMock,
    },
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptCollapsible', () => ({
    TranscriptCollapsible: ({ expanded, children }: any) =>
        expanded ? React.createElement(React.Fragment, null, children) : null,
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

installToolShellCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            ScrollView: 'ScrollView',
            Pressable: 'Pressable',
            AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
            Dimensions: { get: () => ({ width: 800, height: 600, scale: 2, fontScale: 2 }) },
            Platform: { OS: 'ios', select: (value: any) => value?.ios ?? value?.default ?? value?.web ?? null },
            useWindowDimensions: () => ({ width: 800, height: 600 }),
        }),
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'permissionPromptSurface') return 'transcript';
                    if (key === 'toolViewShowDebugByDefault') return false;
                    return false;
                },
            },
        }),
});

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        edit: { title: 'Edit' },
    },
}));

vi.mock('@/components/tools/renderers/system/StructuredResultView', () => ({
    StructuredResultView: () => null,
}));

vi.mock('@/components/sessions/transcript/ChainTranscriptList', () => ({
    ChainTranscriptList: (props: any) => {
        hoisted.chainTranscriptListSpy(props);
        return React.createElement('ChainTranscriptList', props, props.footer);
    },
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: (props: any) => React.createElement('PermissionFooter', props),
}));

describe('ToolFullView (permission pending)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('renders PermissionFooter so users can approve/deny from the full view', async () => {
        const { ToolFullView } = await import('./ToolFullView');

        const tool = makeToolCall({
            name: 'edit',
            state: 'running',
            input: {},
            result: null,
            completedAt: null,
            description: 'edit',
            permission: { id: 'perm1', status: 'pending' },
        });

        const screen = await renderScreen(
            React.createElement(ToolFullView, { tool, metadata: null, messages: [], sessionId: 's1' }),
        );

        expect(screen.findAllByType('PermissionFooter' as any)).toHaveLength(1);
    });

    it('does not render PermissionFooter for tools that have custom permission UIs', async () => {
        const { ToolFullView } = await import('./ToolFullView');

        const tool = makeToolCall({
            name: 'AskUserQuestion',
            state: 'running',
            input: {},
            result: null,
            completedAt: null,
            description: 'question',
            permission: { id: 'perm1', status: 'pending' },
        });

        const screen = await renderScreen(
            React.createElement(ToolFullView, { tool, metadata: null, messages: [], sessionId: 's1' }),
        );

        expect(screen.findAllByType('PermissionFooter' as any)).toHaveLength(0);
    });

    it('renders PermissionFooter when transcript fallback is forced for details-only views', async () => {
        const { ToolFullView } = await import('./ToolFullView');

        const tool = makeToolCall({
            name: 'edit',
            state: 'running',
            input: {},
            result: null,
            completedAt: null,
            description: 'edit',
            permission: { id: 'perm1', status: 'pending' },
        });

        const screen = await renderScreen(
            React.createElement(ToolFullView, {
                tool,
                metadata: null,
                messages: [],
                sessionId: 's1',
                forcePermissionFooterInTranscript: true,
            }),
        );

        expect(screen.findAllByType('PermissionFooter' as any)).toHaveLength(1);
    });

    it('forces transcript permission prompts through the child transcript list when details-only fallback is active', async () => {
        const { ToolFullView } = await import('./ToolFullView');

        const tool = makeToolCall({
            name: 'SubAgent',
            state: 'running',
            input: {},
            result: null,
            completedAt: null,
            description: 'Subagent',
        });

        const childToolMessage: Message = {
            kind: 'tool-call',
            id: 'child-1',
            localId: null,
            createdAt: 2,
            tool: makeToolCall({
                id: 'child-tool-1',
                name: 'Bash',
                state: 'running',
                input: { command: 'pwd' },
                result: null,
                completedAt: null,
                description: 'pwd',
                permission: { id: 'perm-1', kind: 'command', status: 'pending' },
            }),
            children: [],
        };

        const screen = await renderScreen(
            React.createElement(ToolFullView, {
                tool,
                metadata: null,
                messages: [childToolMessage],
                sessionId: 's1',
                forcePermissionFooterInTranscript: true,
            }),
        );

        expect(screen).toBeDefined();
        expect(chainTranscriptListSpy).toHaveBeenCalledWith(expect.objectContaining({
            forcePermissionPromptsInTranscript: true,
        }));
    });

    it('renders an error (not an approval prompt) when the session is inactive and a permission was pending', async () => {
        const { ToolFullView } = await import('./ToolFullView');
        const { ToolError } = await import('@/components/tools/shell/presentation/ToolError');

        const tool = makeToolCall({
            name: 'edit',
            state: 'running',
            input: {},
            result: null,
            completedAt: null,
            description: 'edit',
            permission: { id: 'perm1', status: 'pending' },
        });

        const screen = await renderScreen(
            React.createElement(ToolFullView, {
                tool,
                metadata: null,
                messages: [],
                sessionId: 's1',
                interaction: {
                    canSendMessages: true,
                    canApprovePermissions: false,
                    permissionDisabledReason: 'inactive',
                },
            }),
        );

        expect(screen.findAllByType('PermissionFooter' as any)).toHaveLength(0);
        expect(screen.findAllByType(ToolError as any)).toHaveLength(1);
    });
});
