import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { CONTENT_WIDTH_PX_BY_MODE } from '@/components/ui/layout/contentWidthMode';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Reactive stand-in for the persisted `uiContentWidthMode` local setting. Surfaces
 * that bake `layout.maxWidth` into a module-scope `StyleSheet.create` factory keep
 * reporting the first-evaluated width no matter how this store changes, which is
 * exactly the regression these cases guard.
 */
const contentWidthSetting = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    const state = { mode: 'compact' as 'compact' | 'medium' | 'full' };
    return {
        state,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        emit: () => {
            for (const listener of listeners) listener();
        },
    };
});

const mountCounts = vi.hoisted(() => ({ constrainedViews: 0 }));

vi.mock('react-native', async () => {
    const ReactModule = await import('react');
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
            ReactModule.useEffect(() => {
                mountCounts.constrainedViews += 1;
            }, []);
            return ReactModule.createElement('View', props, props.children);
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const ReactModule = await import('react');
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useLocalSetting: ((key: string) => {
                const mode = ReactModule.useSyncExternalStore(
                    contentWidthSetting.subscribe,
                    () => contentWidthSetting.state.mode,
                    () => contentWidthSetting.state.mode,
                );
                if (key === 'uiContentWidthMode') return mode;
                if (key === 'uiFontScale') return 1;
                return undefined;
            }) as typeof import('@/sync/domains/state/storage')['useLocalSetting'],
        },
    });
});

vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => ({
        getState: () => ({ localSettings: { uiContentWidthMode: contentWidthSetting.state.mode } }),
    }),
}));

vi.mock('@/components/ui/forms/SplitActionButtons', () => ({
    SplitActionButtons: (props: Record<string, unknown>) => React.createElement('SplitActionButtons', props),
}));

vi.mock('@/components/ui/navigation/SegmentedTabBar', () => ({
    SegmentedTabBar: (props: Record<string, unknown>) => React.createElement('SegmentedTabBar', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

function readConstrainedMaxWidths(screen: Awaited<ReturnType<typeof renderScreen>>): unknown[] {
    return screen
        .findAllByType('View' as never)
        .map((node) => flattenStyle(node.props.style).maxWidth)
        .filter((maxWidth) => maxWidth !== undefined);
}

async function setContentWidthMode(mode: 'compact' | 'medium' | 'full'): Promise<void> {
    await act(async () => {
        contentWidthSetting.state.mode = mode;
        contentWidthSetting.emit();
    });
}

describe('surfaces follow the content-width setting without a reload', () => {
    beforeEach(() => {
        contentWidthSetting.state.mode = 'compact';
        mountCounts.constrainedViews = 0;
    });

    it('re-applies the setting to the shared settings action footer in place', async () => {
        const { SettingsActionFooter } = await import('@/components/ui/settingsSurface/SettingsActionFooter');

        const screen = await renderScreen(
            <SettingsActionFooter primaryLabel="Save" onPrimaryPress={() => {}} />,
        );
        expect(readConstrainedMaxWidths(screen)).toContain(CONTENT_WIDTH_PX_BY_MODE.compact);
        const mountsAfterFirstPaint = mountCounts.constrainedViews;

        await setContentWidthMode('medium');
        expect(readConstrainedMaxWidths(screen)).toContain(CONTENT_WIDTH_PX_BY_MODE.medium);
        expect(readConstrainedMaxWidths(screen)).not.toContain(CONTENT_WIDTH_PX_BY_MODE.compact);

        await setContentWidthMode('full');
        expect(readConstrainedMaxWidths(screen)).toContain(Number.POSITIVE_INFINITY);

        // The width must reach the constrained node in place, not by replacing it.
        expect(mountCounts.constrainedViews).toBe(mountsAfterFirstPaint);
    });

    it('re-applies the setting to a transcript tool-calls unit row in place', async () => {
        const { ToolCallsGroupUnitRowFrame } = await import(
            '@/components/sessions/transcript/toolCalls/units/toolCallsGroupChrome'
        );

        const screen = await renderScreen(
            <ToolCallsGroupUnitRowFrame variant="cards" position="header" unitTestID="unit">
                <></>
            </ToolCallsGroupUnitRowFrame>,
        );
        expect(readConstrainedMaxWidths(screen)).toContain(CONTENT_WIDTH_PX_BY_MODE.compact);
        const mountsAfterFirstPaint = mountCounts.constrainedViews;

        await setContentWidthMode('medium');
        expect(readConstrainedMaxWidths(screen)).toContain(CONTENT_WIDTH_PX_BY_MODE.medium);
        expect(readConstrainedMaxWidths(screen)).not.toContain(CONTENT_WIDTH_PX_BY_MODE.compact);

        expect(mountCounts.constrainedViews).toBe(mountsAfterFirstPaint);
    });

    it('re-applies the setting to the MCP segmented header in place', async () => {
        const { McpSegmentedHeader } = await import('@/components/settings/mcpServers/McpSegmentedHeader');

        const screen = await renderScreen(
            <McpSegmentedHeader
                title="Servers"
                subtitle="Manage"
                tabs={[{ id: 'a', label: 'A' }]}
                activeTabId="a"
                onSelectTab={() => {}}
                testIDPrefix="mcp"
            />,
        );
        expect(readConstrainedMaxWidths(screen)).toContain(CONTENT_WIDTH_PX_BY_MODE.compact);
        const mountsAfterFirstPaint = mountCounts.constrainedViews;

        await setContentWidthMode('full');
        expect(readConstrainedMaxWidths(screen)).toContain(Number.POSITIVE_INFINITY);

        expect(mountCounts.constrainedViews).toBe(mountsAfterFirstPaint);
    });
});
