import { renderWithSessionTranscriptSource, createTestSessionTranscriptSource } from '@/dev/testkit';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import {
    createDeferred,
    flushHookEffects,
    standardCleanup,
} from '@/dev/testkit';
import { layoutHitArea, readHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';
import { installToolShellCommonModuleMocks, makeToolCall } from './ToolView.testHelpers';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ensureSidechainMessagesLoadedMock = vi.fn(async (_sessionId: string, _sidechainId: string): Promise<'loaded' | 'not_ready' | 'in_flight'> => 'loaded');

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: ensureSidechainMessagesLoadedMock,
    },
}));

const pushSpy = vi.fn();
const navigateWithBlurOnWebSpy = vi.hoisted(() => vi.fn((action: () => void) => action()));

vi.mock('@/utils/platform/navigateWithBlurOnWeb', () => ({
    navigateWithBlurOnWeb: navigateWithBlurOnWebSpy,
}));

installToolShellCommonModuleMocks({
    expoRouter: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: {
                push: pushSpy,
                back: vi.fn(),
                replace: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: createUseSettingMock({ fallback: (key) => {
                    if (key === 'toolViewDetailLevelDefault') return 'title';
                    if (key === 'toolViewDetailLevelDefaultLocalControl') return 'title';
                    if (key === 'toolViewDetailLevelByToolName') return {};
                    if (key === 'toolViewTapAction') return 'expand';
                    if (key === 'toolViewExpandedDetailLevelDefault') return 'summary';
                    if (key === 'toolViewExpandedDetailLevelByToolName') return {};
                    return null;
                } }),
            },
        });
    },
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('react-native-device-info', () => ({
    getDeviceType: () => 'Handset',
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: [],
    DEFAULT_AGENT_ID: 'claude',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {
        Read: { title: 'Read' },
    },
}));

const renderedToolViewSpy = vi.fn();

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => (props: any) => {
        renderedToolViewSpy(props);
        return React.createElement('SpecificToolView', null);
    },
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/utils/errors/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: (t: string) => t,
    formatMCPSubtitle: () => '',
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('../presentation/ToolSectionView', async (importOriginal) => {
    const { installToolSectionViewModuleMock } = await import('@/dev/testkit/mocks/toolSectionView');
    return installToolSectionViewModuleMock('host')(importOriginal);
});

vi.mock('@/hooks/ui/useElapsedTime', () => ({
    useElapsedTime: () => 0,
}));

// Load the real owner after boundary setup so cold module evaluation is outside a test and its act lifetime.
const { ToolView } = await import('./ToolView');

afterEach(() => {
    standardCleanup();
});

describe('ToolView (tap action: expand)', () => {
    it('toggles inline expansion even without navigation params', async () => {
        pushSpy.mockReset();
        navigateWithBlurOnWebSpy.mockClear();
        renderedToolViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');


        const tool = makeToolCall({
            name: 'Read',
            input: { file_path: '/tmp/a.txt' },
            result: { file: { content: 'hello' } },
        });

        const screen = await renderWithSessionTranscriptSource(React.createElement(ToolView, { tool, metadata: null }), createTestSessionTranscriptSource({ navigate: pushSpy, loadSidechain: (sidechainId) => ensureSidechainMessagesLoadedMock('s1', sidechainId) }));

        expect(screen.findAllByType('SpecificToolView' as any)).toHaveLength(0);

        await act(async () => {
            screen.pressByTestId('tool-view-header-primary');
        });

        expect(screen.findAllByType('SpecificToolView' as any)).toHaveLength(1);
    });

    it('preloads sidechain messages when expanding Task tools', async () => {
        pushSpy.mockReset();
        navigateWithBlurOnWebSpy.mockClear();
        renderedToolViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');


        const tool = makeToolCall({
            id: 'tool_task_1',
            name: 'Task',
            input: { operation: 'run', description: 'Do stuff' },
            result: null,
        });

        const screen = await renderWithSessionTranscriptSource(
            React.createElement(ToolView, { tool, metadata: null, sessionId: 's1', messageId: 'm1' }), createTestSessionTranscriptSource({ navigate: pushSpy, loadSidechain: (sidechainId) => ensureSidechainMessagesLoadedMock('s1', sidechainId) }),);

        expect(ensureSidechainMessagesLoadedMock).not.toHaveBeenCalled();

        await act(async () => {
            screen.pressByTestId('tool-view-header-primary');
        });
        await flushHookEffects();

        expect(ensureSidechainMessagesLoadedMock).toHaveBeenCalledWith('s1', 'tool_task_1');
    });

    it('shows sidechain loading only while an expanded Task transcript request is in flight', async () => {
        pushSpy.mockReset();
        navigateWithBlurOnWebSpy.mockClear();
        renderedToolViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();
        const request = createDeferred<'loaded' | 'not_ready' | 'in_flight'>();
        ensureSidechainMessagesLoadedMock.mockReturnValueOnce(request.promise);


        const tool = makeToolCall({
            id: 'tool_task_1',
            name: 'Task',
            input: { operation: 'run', description: 'Do stuff' },
            result: null,
        });

        const screen = await renderWithSessionTranscriptSource(
            React.createElement(ToolView, { tool, metadata: null, sessionId: 's1', messageId: 'm1', messages: [] }), createTestSessionTranscriptSource({ navigate: pushSpy, loadSidechain: (sidechainId) => ensureSidechainMessagesLoadedMock('s1', sidechainId) }),);

        await act(async () => {
            screen.pressByTestId('tool-view-header-primary');
        });
        await flushHookEffects();

        expect(screen.findByTestId('tool-view-sidechain-hydration-status')).not.toBeNull();

        await act(async () => {
            request.resolve('loaded');
            await request.promise;
        });
        await flushHookEffects();

        expect(screen.findByTestId('tool-view-sidechain-hydration-status')).toBeNull();
    });

    it('surfaces an unavailable affordance (not a perpetual spinner) when expanded sidechain hydration fails terminally', async () => {
        pushSpy.mockReset();
        navigateWithBlurOnWebSpy.mockClear();
        renderedToolViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();
        const previousMaxRetries = process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_MAX_RETRIES;
        process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_MAX_RETRIES = '0';
        try {
            ensureSidechainMessagesLoadedMock.mockResolvedValue('not_ready');

            const tool = makeToolCall({
                id: 'tool_task_1',
                name: 'Task',
                input: { operation: 'run', description: 'Do stuff' },
                result: null,
            });

            const screen = await renderWithSessionTranscriptSource(
                React.createElement(ToolView, { tool, metadata: null, sessionId: 's1', messageId: 'm1', messages: [] }), createTestSessionTranscriptSource({ navigate: pushSpy, loadSidechain: (sidechainId) => ensureSidechainMessagesLoadedMock('s1', sidechainId) }),);

            await act(async () => {
                screen.pressByTestId('tool-view-header-primary');
            });
            await flushHookEffects();

            const statusNode = screen.findByTestId('tool-view-sidechain-hydration-status');
            expect(statusNode).not.toBeNull();
            expect(screen.getTextContent()).toContain('common.unavailable');
            expect(statusNode?.findAllByProps({ accessibilityRole: 'progressbar' })).toHaveLength(0);
        } finally {
            if (previousMaxRetries === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_MAX_RETRIES;
            } else {
                process.env.EXPO_PUBLIC_HAPPIER_ENSURE_SIDECHAIN_MAX_RETRIES = previousMaxRetries;
            }
        }
    });

    it('preloads sidechain messages when expanding SubAgentRun tools (prefers result.sidechainId when present)', async () => {
        pushSpy.mockReset();
        navigateWithBlurOnWebSpy.mockClear();
        renderedToolViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');


        const tool = makeToolCall({
            id: 'tool_subagent_1',
            name: 'SubAgentRun',
            input: { intent: 'delegate', backendId: 'claude' },
            result: { sidechainId: 'sidechain_run_123' },
        });

        const screen = await renderWithSessionTranscriptSource(
            React.createElement(ToolView, { tool, metadata: null, sessionId: 's1', messageId: 'm1' }), createTestSessionTranscriptSource({ navigate: pushSpy, loadSidechain: (sidechainId) => ensureSidechainMessagesLoadedMock('s1', sidechainId) }),);

        expect(ensureSidechainMessagesLoadedMock).not.toHaveBeenCalled();

        await act(async () => {
            screen.pressByTestId('tool-view-header-primary');
        });
        await flushHookEffects();

        expect(ensureSidechainMessagesLoadedMock).toHaveBeenCalledWith('s1', 'sidechain_run_123');
    });

    it('reaches a finger on the secondary action icon through the shared hit area without growing it', async () => {
        pushSpy.mockReset();
        navigateWithBlurOnWebSpy.mockClear();
        renderedToolViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');


        const tool = makeToolCall({
            name: 'Read',
            input: { file_path: '/tmp/a.txt' },
            result: { file: { content: 'hello' } },
        });

        const screen = await renderWithSessionTranscriptSource(
            React.createElement(HappierUiPlatformProvider, { platform: { platform: 'ios', colorScheme: 'light' } },
                React.createElement(ToolView, { tool, metadata: null, sessionId: 's1', messageId: 'm1' })), createTestSessionTranscriptSource({ navigate: pushSpy, loadSidechain: (sidechainId) => ensureSidechainMessagesLoadedMock('s1', sidechainId) }),);

        // The control declares its drawn 34 px box itself; the layout engine reports the same box.
        expect(readHitArea(screen.findByTestId('tool-view-header-secondary')!).drawn).toEqual({ width: 34, height: 34 });
        const area = await layoutHitArea(() => screen.findByTestId('tool-view-header-secondary'), { width: 34, height: 34 });
        expect(area.width).toBe(44);
        expect(area.height).toBe(44);
    });

    it('uses the stable server route for the secondary open action when the message is already persisted', async () => {
        pushSpy.mockReset();
        navigateWithBlurOnWebSpy.mockClear();
        renderedToolViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');

        const tool = makeToolCall({
            id: 'call_read_1',
            name: 'Read',
            input: { file_path: '/tmp/a.txt' },
            result: { file: { content: 'hello' } },
        });

        const screen = await renderWithSessionTranscriptSource(
            React.createElement(ToolView, {
                tool,
                metadata: null,
                sessionId: 's1',
                serverId: 'home-b',
                messageId: 'server:server-msg-1',
            }), createTestSessionTranscriptSource({ navigate: pushSpy, loadSidechain: (sidechainId) => ensureSidechainMessagesLoadedMock('s1', sidechainId) }),);

        const secondaryAction = screen.findByTestId('tool-view-header-secondary');
        expect(secondaryAction).toBeTruthy();

        await act(async () => {
            screen.pressByTestId('tool-view-header-secondary');
        });

        expect(navigateWithBlurOnWebSpy).toHaveBeenCalledTimes(1);
        expect(pushSpy).toHaveBeenCalledWith('/session/s1/message/server%3Aserver-msg-1?serverId=home-b');
    });

    it('expands without hydrating the sidechain when tool navigation is disabled', async () => {
        pushSpy.mockReset();
        navigateWithBlurOnWebSpy.mockClear();
        renderedToolViewSpy.mockReset();
        ensureSidechainMessagesLoadedMock.mockReset();
        ensureSidechainMessagesLoadedMock.mockResolvedValue('loaded');

        const tool = makeToolCall({
            id: 'subagent_run_1',
            name: 'SubAgentRun',
            input: { intent: 'delegate' },
            result: { sidechainId: 'sidechain_run_1' },
        });

        const screen = await renderWithSessionTranscriptSource(
            React.createElement(ToolView, {
                tool,
                metadata: null,
                sessionId: 's1',
                interaction: { canSendMessages: true, canApprovePermissions: true },
            }), createTestSessionTranscriptSource({ navigate: null, loadSidechain: null }));

        expect(screen.findByTestId('tool-view-header-secondary')).toBeNull();

        await act(async () => {
            screen.pressByTestId('tool-view-header-primary');
        });
        await flushHookEffects();

        expect(screen.findAllByType('SpecificToolView' as React.ElementType)).toHaveLength(1);
        expect(ensureSidechainMessagesLoadedMock).not.toHaveBeenCalled();
    });
});
