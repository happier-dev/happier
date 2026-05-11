import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    contentWidthMode: 'compact' as 'compact' | 'medium' | 'full',
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/components/ui/icons/SafeIonicons', () => ({
    SafeIonicons: 'SafeIonicons',
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 56,
}));

vi.mock('@/components/ui/layout/useChromeSafeAreaInsets', () => ({
    useChromeSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('@/components/navigation/desktopWindowChrome/DesktopWindowDragRegion', () => ({
    useDesktopWindowDragMouseProps: () => ({}),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useLocalSetting: ((key: string) => {
                if (key === 'uiContentWidthMode') return shared.contentWidthMode;
                if (key === 'uiFontScale') return 1;
                return undefined;
            }) as typeof import('@/sync/domains/state/storage')['useLocalSetting'],
        },
    });
});

vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => ({
        getState: () => ({
            localSettings: {
                uiContentWidthMode: shared.contentWidthMode,
            },
        }),
    }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') return style as Record<string, unknown>;
    return {};
}

describe('Header content width', () => {
    it('updates the route header max width when the local content width setting changes', async () => {
        shared.contentWidthMode = 'compact';
        const { Header } = await import('./Header');

        const screen = await renderScreen(<Header title={React.createElement('Text', null, 'Appearance')} safeAreaEnabled={false} />);

        const headerContent = screen.findByTestId('desktop-route-header-content');
        expect(flattenStyle(headerContent?.props.style).maxWidth).toBe(850);

        shared.contentWidthMode = 'full';
        await act(async () => {
            screen.tree.update(<Header title={React.createElement('Text', null, 'Appearance')} safeAreaEnabled={false} />);
        });

        expect(flattenStyle(screen.findByTestId('desktop-route-header-content')?.props.style).maxWidth)
            .toBe(Number.POSITIVE_INFINITY);
    });
});
