import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { FilesystemBrowserNode } from './filesystemBrowserTypes';
import { t } from '@/text';

// Loaded at the assertion, not at the top: an eager import would evaluate the spinner's module
// graph before this file's mocks and per-test setup have run.
const loadActivitySpinner = async () => (await import('@/components/ui/feedback/ActivitySpinner')).ActivitySpinner;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'web',
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        ActivityIndicator: 'ActivityIndicator',
        FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent }: any) => {
            const header = ListHeaderComponent
                ? (React.isValidElement(ListHeaderComponent) ? ListHeaderComponent : React.createElement(ListHeaderComponent))
                : null;
            const rows = (data ?? []).map((item: any, index: number) => {
                const key = keyExtractor ? keyExtractor(item, index) : String(item?.path ?? index);
                return React.createElement(React.Fragment, { key }, renderItem({ item, index }));
            });
            return React.createElement('FlatList', null, header, ...rows);
        },
        Platform: {
            get OS() {
                return platformState.os;
            },
            select: (options: any) => options?.[platformState.os] ?? options?.default ?? options?.native,
        },
    });
});

vi.mock('@legendapp/list/react-native', () => ({
    LegendList: ({ data, renderItem, keyExtractor, ListHeaderComponent, estimatedItemSize }: any) => {
        const header = ListHeaderComponent
            ? (React.isValidElement(ListHeaderComponent) ? ListHeaderComponent : React.createElement(ListHeaderComponent))
            : null;
        const rows = (data ?? []).map((item: any, index: number) => {
            const key = keyExtractor ? keyExtractor(item, index) : String(item?.path ?? index);
            return React.createElement(React.Fragment, { key }, renderItem({ item, index }));
        });
        return React.createElement('LegendList', { estimatedItemSize }, header, ...rows);
    },
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                textSecondary: '#888',
                textLink: '#08f',
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

describe('FilesystemBrowserList', () => {
    const nodes = [
        { path: 'src/index.ts', name: 'index.ts', type: 'file', depth: 0, isExpanded: false, isLoadingChildren: false },
    ] satisfies FilesystemBrowserNode[];

    beforeEach(() => {
        platformState.os = 'web';
    });

    it('names a root listing failure, explains its cause and keeps diagnostics behind Details', async () => {
        const { FilesystemBrowser } = await import('./FilesystemBrowser');
        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        const retry = vi.fn();
        const screen = await renderScreen(<FilesystemBrowser
            nodes={[]}
            rootLoading={false}
            rootError="EACCES"
            errorTestID="filesystem-root-error"
            emptyLabel="Empty"
            loadingLabel="Loading"
            inlineRetryLabel="Retry"
            retryRoot={retry}
            renderRow={() => <React.Fragment />}
        />);
        const state = screen.findByType(SurfaceStateCard);
        expect(state.props).toMatchObject({
            kind: 'error',
            title: t('files.pane.rootErrorTitleUnnamed'),
            reason: t('errors.permissionDenied'),
            diagnosticCode: 'EACCES',
        });
        expect(screen.getTextContent()).not.toContain('EACCES');
        await React.act(async () => { state.props.action.onPress(); });
        expect(retry).toHaveBeenCalledOnce();
    });

    it('retains listed rows when a refresh fails and offers one cause with one retry', async () => {
        const { FilesystemBrowserList } = await import('./FilesystemBrowserList');
        const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
        const retry = vi.fn();
        const screen = await renderScreen(<FilesystemBrowserList
            nodes={nodes}
            rootLoading={false}
            rootError="RPC method not available"
            listHeaderTestID="filesystem-refresh-error"
            loadingLabel="Loading"
            inlineRetryLabel="Retry"
            retryRoot={retry}
            renderRow={({ node }) => React.createElement('View', { testID: `row-${node.path}` })}
        />);
        expect(screen.findByTestId('row-src/index.ts')).toBeTruthy();
        const state = screen.findByType(SurfaceStateCard);
        expect(state.props).toMatchObject({ size: 'line', reason: t('errors.daemonUnavailableBody') });
        await React.act(async () => { state.props.action.onPress(); });
        expect(retry).toHaveBeenCalledOnce();
    });

    it('keeps rows mounted without an inline root loading header when loading is surfaced elsewhere', async () => {
        const { FilesystemBrowserList } = await import('./FilesystemBrowserList');

        const screen = await renderScreen(
            <FilesystemBrowserList
                nodes={nodes}
                rootLoading={true}
                showInlineLoadingHeader={false}
                rootError={null}
                loadingLabel="Loading"
                inlineRetryLabel="Retry"
                retryRoot={() => {}}
                renderRow={({ node }) => React.createElement('View', { testID: `row-${node.path}` })}
            />,
        );

        expect(screen.findByTestId('row-src/index.ts')).toBeTruthy();
        expect(screen.findAllByType(await loadActivitySpinner())).toHaveLength(0);
    });

    it('uses LegendList on native file browsers', async () => {
        platformState.os = 'ios';
        const { FilesystemBrowserList } = await import('./FilesystemBrowserList');

        const screen = await renderScreen(
            <FilesystemBrowserList
                nodes={nodes}
                rootLoading={false}
                showInlineLoadingHeader={false}
                rootError={null}
                loadingLabel="Loading"
                inlineRetryLabel="Retry"
                retryRoot={() => {}}
                renderRow={({ node }) => React.createElement('View', { testID: `row-${node.path}` })}
            />,
        );

        const legendLists = screen.findAllByType('LegendList' as any);
        expect(legendLists).toHaveLength(1);
        expect(legendLists[0]?.props?.estimatedItemSize).toBeGreaterThan(0);
        expect(screen.findAllByType('FlatList' as any)).toHaveLength(0);
    });
});
