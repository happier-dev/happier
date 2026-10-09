import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToolCallMessageFixture, flattenTestStyle, renderStatefulToolCallsGroupView,
    renderToolCallsGroupView, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { getStorage } from '@/sync/domains/state/storageStore';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { ToolView } from '@/components/tools/shell/views/ToolView';
import { ToolTimelineRow } from '@/components/tools/shell/views/ToolTimelineRow';
import { TranscriptEnterWrapper } from '@/components/sessions/transcript/motion/TranscriptEnterWrapper';
import { TranscriptCollapsible } from '@/components/sessions/transcript/motion/TranscriptCollapsible';
import { Icon } from '@/components/ui/icons/Icon';
import { ToolCallsGroupView } from './ToolCallsGroupView';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'ios' } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: key => key });
});
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

describe('ToolCallsGroupView (real motion and row owners)', () => {
    beforeEach(() => getStorage().setState({ settings: { ...settingsDefaults,
        toolViewTimelineChromeMode: 'activity_feed', transcriptToolCallsCollapsedPreviewCount: 0,
        transcriptToolCallsGroupShowBackground: false } }));
    afterEach(standardCleanup);

    it('mounts real motion-wrapped rows on expansion and removes them on collapse', async () => {
        const screen = await renderStatefulToolCallsGroupView({ toolMessages: [
            createToolCallMessageFixture({ id: 'm1', createdAt: 1 }),
            createToolCallMessageFixture({ id: 'm2', createdAt: 2 }),
        ] });
        expect(screen.findAllByType(TranscriptEnterWrapper)).toHaveLength(0);
        expect(screen.findAllByType(TranscriptCollapsible)).toHaveLength(0);
        expect(screen.findByTestId('transcript-tool-calls-preview-more')).toBeNull();
        await screen.pressByTestIdAsync('transcript-tool-calls-header');
        expect(screen.findAllByType(TranscriptEnterWrapper)).toHaveLength(2);
        expect(screen.findByType(TranscriptCollapsible).props.expanded).toBe(true);
        expect(screen.findAllByType(ToolTimelineRow)).toHaveLength(2);
        await screen.pressByTestIdAsync('transcript-tool-calls-header');
        expect(screen.findAllByType(ToolTimelineRow)).toHaveLength(0);
        expect(screen.findAllByType(TranscriptEnterWrapper)).toHaveLength(0);
        expect(screen.findByTestId('transcript-tool-calls-preview-more')).toBeNull();
    });

    it('shows the real stack and collapse icon with an actionable expanded header', async () => {
        const screen = await renderStatefulToolCallsGroupView({ status: 'completed',
            toolMessages: [createToolCallMessageFixture({ id: 'm1', createdAt: 1 })] });
        const iconNames = () => screen.findAllByType(Icon).map(node => node.props.name);
        expect(iconNames()).toContain('stack-simple');
        expect(iconNames()).not.toContain('caret-up');
        expect(screen.findByTestId('transcript-tool-calls-header')?.props.accessibilityState).toEqual({ expanded: false });
        await screen.pressByTestIdAsync('transcript-tool-calls-header');
        expect(iconNames()).toContain('caret-up');
        expect(screen.findByTestId('transcript-tool-calls-header')?.props.accessibilityState).toEqual({ expanded: true });
        await screen.pressByTestIdAsync('transcript-tool-calls-header');
        expect(iconNames()).not.toContain('caret-up');
        expect(screen.findAllByType(ToolTimelineRow)).toHaveLength(0);
    });

    it('applies a group background only when enabled in tool feed mode', async () => {
        getStorage().setState(state => ({ settings: { ...state.settings, transcriptToolCallsGroupShowBackground: true } }));
        const toolMessages = [createToolCallMessageFixture({ id: 'm1', createdAt: 1 })];
        const screen = await renderToolCallsGroupView({ status: 'completed', toolMessages });
        const background = flattenTestStyle(screen.findByTestId('transcript-tool-calls-group')?.props.style).backgroundColor;
        expect(background).toBeTruthy();
        await act(async () => {
            getStorage().setState(state => ({ settings: { ...state.settings, toolViewTimelineChromeMode: 'cards' } }));
            await screen.update(<ToolCallsGroupView id="toolCalls:1" status="completed"
                toolMessages={toolMessages} metadata={null} sessionId="s1" expanded={false}
                setExpanded={() => {}} interaction={{ canSendMessages: false, canApprovePermissions: false }} />);
        });
        expect(flattenTestStyle(screen.findByTestId('transcript-tool-calls-group')?.props.style).backgroundColor ?? null)
            .not.toBe(background);
    });

    it('renders the real cards row rather than a timeline row when no structured view is needed', async () => {
        getStorage().setState(state => ({ settings: { ...state.settings, toolViewTimelineChromeMode: 'cards' } }));
        const screen = await renderToolCallsGroupView({ status: 'completed', expanded: true,
            toolMessages: [createToolCallMessageFixture({ id: 'm1', createdAt: 1 })] });
        expect(screen.findAllByType(ToolView)).toHaveLength(1);
        expect(screen.findAllByType(ToolTimelineRow)).toHaveLength(0);
    });
});
