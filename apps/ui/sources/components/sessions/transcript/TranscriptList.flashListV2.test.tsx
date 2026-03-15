import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let capturedFlashListProps: any = null;
let renderedFlatListCount = 0;
let transcriptListImplementationSetting: 'flash_v2' | 'flatlist_legacy' = 'flash_v2';

vi.mock('@shopify/flash-list', () => ({
    FlashList: (props: any) => {
        capturedFlashListProps = props;
        const data = Array.isArray(props.data) ? props.data : [];
        const header =
            props.ListHeaderComponent
                ? (typeof props.ListHeaderComponent === 'function'
                    ? props.ListHeaderComponent()
                    : props.ListHeaderComponent)
                : null;
        const footer =
            props.ListFooterComponent
                ? (typeof props.ListFooterComponent === 'function'
                    ? props.ListFooterComponent()
                    : props.ListFooterComponent)
                : null;
        return React.createElement(
            'FlashList',
            props,
            header,
            data.map((item: any, index: number) => {
                const key =
                    typeof props.keyExtractor === 'function'
                        ? props.keyExtractor(item, index)
                        : (item?.id ?? String(index));
                const child = typeof props.renderItem === 'function' ? props.renderItem({ item, index }) : null;
                return React.createElement('FlashListItem', { key }, child);
            }),
            footer,
        );
    },
}));

vi.mock('react-native', async (importOriginal) => {
    const ReactMod = await import('react');
    const actual = await importOriginal<any>();
    return {
        ...actual,
        Platform: {
            OS: 'web',
            select: (values: any) => values?.web ?? values?.default,
        },
        View: (props: any) => ReactMod.createElement('View', props, props.children),
        ActivityIndicator: () => ReactMod.createElement('ActivityIndicator'),
        FlatList: (_props: any) => {
            renderedFlatListCount++;
            return ReactMod.createElement('FlatList');
        },
    };
});

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 0,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSetting: (key: string) => (key === 'transcriptListImplementation' ? transcriptListImplementationSetting : undefined),
}));

vi.mock('./MessageView', () => ({
    MessageView: () => React.createElement('MessageView'),
}));

vi.mock('./ChatFooter', () => ({
    ChatFooter: () => React.createElement('ChatFooter'),
}));

describe('TranscriptList (FlashList v2)', () => {
    beforeEach(() => {
        capturedFlashListProps = null;
        renderedFlatListCount = 0;
        transcriptListImplementationSetting = 'flash_v2';
    });

    it('renders FlashList with startRenderingFromBottom enabled when selected', async () => {
        const { TranscriptList } = await import('./TranscriptList');
        await act(async () => {
            renderer.create(
                <TranscriptList
                    sessionId="s1"
                    metadata={null}
                    messages={[{ kind: 'user-text', id: 'u1', localId: null, createdAt: 1, text: 'hi' } as any]}
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                />,
            );
        });

        expect(renderedFlatListCount).toBe(0);
        expect(capturedFlashListProps).not.toBeNull();
        expect(capturedFlashListProps.maintainVisibleContentPosition?.startRenderingFromBottom).toBe(true);
    });
});
