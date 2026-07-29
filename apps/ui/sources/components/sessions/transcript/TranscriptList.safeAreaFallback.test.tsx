import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installTranscriptCommonModuleMocks, resetTranscriptCommonModuleMockState } from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// The Legend renderer (default transcript renderer) schedules landing verification through
// requestAnimationFrame; this suite's bare environment does not provide one.
if (typeof (globalThis as any).requestAnimationFrame !== 'function') {
    (globalThis as any).requestAnimationFrame = (callback: (time: number) => void) => (
        setTimeout(() => callback(Date.now()), 0) as unknown as number
    );
    (globalThis as any).cancelAnimationFrame = (handle: number) => {
        clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
    };
}

let capturedHeaderSpacerHeight: number | null = null;

function unwrapStyle(style: unknown): Record<string, unknown> | null {
    if (!style) return null;
    if (Array.isArray(style)) {
        for (const entry of style) {
            const resolved = unwrapStyle(entry);
            if (resolved) return resolved;
        }
        return null;
    }
    return typeof style === 'object' ? (style as Record<string, unknown>) : null;
}

function extractFirstNumericHeight(node: unknown): number | null {
    if (!node || typeof node !== 'object') return null;
    const element = node as { type?: unknown; props?: any };
    const style = unwrapStyle(element.props?.style);
    const height = style?.height;
    if (typeof height === 'number') return height;
    const children = React.Children.toArray(element.props?.children ?? []);
    for (const child of children) {
        const found = extractFirstNumericHeight(child);
        if (typeof found === 'number') return found;
    }
    return null;
}

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: (props: any) => {
        const unwrapSlot = (candidate: any): any => {
            if (!candidate) return null;
            if (typeof candidate === 'function') return unwrapSlot(candidate());
            if (typeof candidate === 'object' && typeof candidate.type === 'function') {
                return unwrapSlot(candidate.type(candidate.props));
            }
            if (typeof candidate === 'object' && typeof candidate.type === 'object' && typeof candidate.type?.type === 'function') {
                return unwrapSlot(candidate.type.type(candidate.props));
            }
            return candidate;
        };
        const collectSlotHeight = (candidate: any): number | null => {
            const unwrapped = unwrapSlot(candidate);
            if (!unwrapped) return null;
            const direct = extractFirstNumericHeight(unwrapped);
            if (typeof direct === 'number') return direct;
            const children = React.Children.toArray(unwrapped.props?.children ?? []);
            for (const child of children) {
                const fromChild = collectSlotHeight(child);
                if (typeof fromChild === 'number') return fromChild;
            }
            return null;
        };
        // The Legend adapter re-projects the shell header slot to the visual bottom
        // (ListFooterComponent) on newest-first native frames; check both slots.
        capturedHeaderSpacerHeight =
            collectSlotHeight(props.ListHeaderComponent) ?? collectSlotHeight(props.ListFooterComponent);
        return React.createElement('LegendList', props);
    },
}));

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (values: any) => values?.ios ?? values?.default,
            },
            View: (props: any) => React.createElement('View', props, props.children),
            ActivityIndicator: () => React.createElement('ActivityIndicator'),
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({});
    },
});

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 40,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: { insets: { top: 22, bottom: 0, left: 0, right: 0 } },
}));

vi.mock('./MessageView', () => ({
    MessageView: () => React.createElement('MessageView'),
    MessageViewWithSessionCommon: () => React.createElement('MessageView'),
}));

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter'),
}));

describe('TranscriptList safe area', () => {
    beforeEach(() => {
        resetTranscriptCommonModuleMockState();
        capturedHeaderSpacerHeight = null;
    });

    it('uses a compact transcript gutter instead of chrome-safe area inside the list header', async () => {
        const { TranscriptList } = await import('./TranscriptList');
        await renderScreen(
            <TranscriptList
                sessionId="s1"
                datasetKey="public:s1:1"
                metadata={null}
                messages={[{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' } as any]}
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        expect(capturedHeaderSpacerHeight).toBe(12);
    });
});
