import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import {
    createUseSettingMock,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import type { ToolCall } from '@/sync/domains/messages/messageTypes';
import {
    installToolShellCommonModuleMocks,
    makeToolCall,
} from './ToolView.testHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/sync/sync', () => ({
    sync: {
        ensureSidechainMessagesLoaded: vi.fn(),
    },
}));

installToolShellCommonModuleMocks({
    expoRouter: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
    text: async () =>
        (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => {
                if (key === 'tools.common.elapsedSeconds') {
                    return `${params?.seconds}s`;
                }
                return key;
            },
        }),
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: createUseSettingMock({
                    values: {
                        toolViewDetailLevelDefault: 'summary',
                        toolViewDetailLevelDefaultLocalControl: 'title',
                        toolViewDetailLevelByToolName: {},
                        toolViewShowDebugByDefault: false,
                        permissionPromptSurface: 'transcript',
                    },
                    fallback: () => null,
                }),
            },
        }),
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

// The row's decision is under test, not the spinner's: ActivitySpinner's own tests already pin
// `animationEnabled={false}` to a still mark with no scheduled animation. The stub exposes the
// prop the row handed down as a findable host element.
vi.mock('@/components/ui/feedback/ActivitySpinner', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/ui/feedback/ActivitySpinner')>();
    return {
        ...actual,
        ActivitySpinner: (props: Record<string, unknown>) =>
            React.createElement('ActivitySpinnerStub', props),
    };
});

// The elapsed readout is a separate contract (and its own shared-clock subscriber in production);
// pinning it keeps the running mark the only live subscriber of the one-second bucket here. The
// bucket's cadence stays the module's real constant — the mark must share the elapsed clock's
// bucket, not invent a second one.
vi.mock('@/hooks/ui/useElapsedTime', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/hooks/ui/useElapsedTime')>()),
    useElapsedTime: () => 123.4,
}));

vi.mock('@/components/tools/renderers/core/_registry', () => ({
    getToolViewComponent: () => null,
}));

vi.mock('@/components/tools/catalog', () => ({
    knownTools: {},
}));

vi.mock('@/components/tools/renderers/system/MCPToolView', () => ({
    formatMCPTitle: () => 'MCP',
    formatMCPSubtitle: () => '',
}));

vi.mock('@/utils/errors/toolErrorParser', () => ({
    parseToolUseError: () => ({ isToolUseError: false }),
}));

vi.mock('@/components/ui/media/CodeView', () => ({
    CodeView: () => null,
}));

vi.mock('../presentation/ToolSectionView', async (importOriginal) => {
    const { installToolSectionViewModuleMock } = await import('@/dev/testkit/mocks/toolSectionView');
    return installToolSectionViewModuleMock('fragment')(importOriginal);
});

vi.mock('../presentation/ToolError', () => ({
    ToolError: () => null,
}));

vi.mock('../permissions/PermissionFooter', () => ({
    PermissionFooter: () => React.createElement('PermissionFooter', null),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['claude', 'codex', 'gemini', 'opencode'],
    DEFAULT_AGENT_ID: 'claude',
    getAgentCore: () => ({ toolRendering: { hideUnknownToolsByDefault: false } }),
    resolveAgentIdFromFlavor: () => null,
}));

/** The stall threshold the row is contracted to degrade at: ten minutes. */
const STALL_DEGRADE_MS = 10 * 60 * 1000;

function runningTool(overrides: Partial<ToolCall> = {}): ToolCall {
    const startedAtMs = Date.now() - 1_000;
    return makeToolCall({
        name: 'execute',
        state: 'running',
        input: { command: 'pwd' },
        result: null,
        completedAt: null,
        permission: undefined,
        startedAt: startedAtMs,
        createdAt: startedAtMs,
        ...overrides,
    });
}

async function renderRunningToolRow(tool: ToolCall) {
    const { ToolView } = await import('./ToolView');
    return renderScreen(
        React.createElement(ToolView, { tool, metadata: null, messages: [], sessionId: 's1', messageId: 'm1' }),
    );
}

function runningMarkProps(screen: Awaited<ReturnType<typeof renderScreen>>): Record<string, unknown> {
    const marks = screen.findAllByType('ActivitySpinnerStub' as never);
    expect(marks).toHaveLength(1);
    return marks[0]!.props as Record<string, unknown>;
}

async function advanceOneSecond() {
    await act(async () => {
        vi.advanceTimersByTime(1_000);
    });
}

describe('ToolView (running spinner stall degrade)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-28T12:00:00.000Z'));
    });

    afterEach(() => {
        standardCleanup();
        vi.useRealTimers();
    });

    it('keeps the running spinner stepping before the threshold and degrades it exactly at the boundary', async () => {
        const screen = await renderRunningToolRow(runningTool({
            startedAt: Date.now() - STALL_DEGRADE_MS + 2_000,
            createdAt: Date.now() - STALL_DEGRADE_MS + 2_000,
        }));

        expect(runningMarkProps(screen).animationEnabled).not.toBe(false);

        await advanceOneSecond();
        // One second before the threshold: the last tick that must still animate.
        expect(runningMarkProps(screen).animationEnabled).not.toBe(false);

        await advanceOneSecond();
        expect(runningMarkProps(screen).animationEnabled).toBe(false);

        // Long past the threshold the mark stays degraded; only the elapsed clock keeps moving.
        await act(async () => {
            vi.advanceTimersByTime(10 * 60 * 1000);
        });
        expect(runningMarkProps(screen).animationEnabled).toBe(false);
    });

    it('degrades from the first render when the row already exceeded the threshold without startedAt', async () => {
        const screen = await renderRunningToolRow(runningTool({
            startedAt: null,
            createdAt: Date.now() - STALL_DEGRADE_MS - 1,
        }));

        expect(runningMarkProps(screen).animationEnabled).toBe(false);
    });

    it('settling the tool unmounts the running mark and stops its clock subscription', async () => {
        const timersBefore = vi.getTimerCount();
        const screen = await renderRunningToolRow(runningTool());
        expect(vi.getTimerCount()).toBeGreaterThan(timersBefore);

        const { ToolView } = await import('./ToolView');
        await screen.update(
            React.createElement(ToolView, {
                tool: runningTool({ state: 'completed', result: { stdout: '' }, completedAt: Date.now() }),
                metadata: null,
                messages: [],
                sessionId: 's1',
                messageId: 'm1',
            }),
        );

        expect(screen.findAllByType('ActivitySpinnerStub' as never)).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(timersBefore);
    });

    it('unmounting the row stops the clock subscription', async () => {
        const timersBefore = vi.getTimerCount();
        const screen = await renderRunningToolRow(runningTool());
        expect(vi.getTimerCount()).toBeGreaterThan(timersBefore);

        await screen.unmount();

        expect(vi.getTimerCount()).toBe(timersBefore);
    });
});
