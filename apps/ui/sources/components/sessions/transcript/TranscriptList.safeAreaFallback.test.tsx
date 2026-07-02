import * as React from 'react';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installTranscriptCommonModuleMocks, resetTranscriptCommonModuleMockState } from './transcriptTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedHeaderSpacerHeight: number | null = null;
let transcriptListImplementationSetting: 'flash_v2' | 'flatlist_legacy' = 'flash_v2';

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

vi.mock('@shopify/flash-list', () => ({
    FlashList: (props: any) => {
        const headerCandidate = props.ListHeaderComponent ?? null;
        const header =
            typeof headerCandidate === 'function'
                ? headerCandidate()
                : (headerCandidate && typeof headerCandidate === 'object' && typeof (headerCandidate as any).type === 'function')
                    ? (headerCandidate as any).type((headerCandidate as any).props)
                    : (headerCandidate
                        && typeof headerCandidate === 'object'
                        && typeof (headerCandidate as any).type === 'object'
                        && typeof (headerCandidate as any).type.type === 'function')
                        ? (headerCandidate as any).type.type((headerCandidate as any).props)
                    : headerCandidate;
        capturedHeaderSpacerHeight = extractFirstNumericHeight(header);
        return React.createElement('FlashList', props, header);
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
        return createStorageModuleStub({
            useSetting: (key: string) =>
                key === 'transcriptListImplementation' ? transcriptListImplementationSetting : undefined,
        });
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
        transcriptListImplementationSetting = 'flash_v2';
    });

    it('uses a compact transcript gutter instead of chrome-safe area inside the list header', async () => {
        const { TranscriptList } = await import('./TranscriptList');
        await renderScreen(
            <TranscriptList
                sessionId="s1"
                metadata={null}
                messages={[{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' } as any]}
                interaction={{ canSendMessages: true, canApprovePermissions: true }}
            />,
        );

        expect(capturedHeaderSpacerHeight).toBe(12);
    });
});
