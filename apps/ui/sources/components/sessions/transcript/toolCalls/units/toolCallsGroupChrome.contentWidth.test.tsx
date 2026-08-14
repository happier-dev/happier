import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installToolCallsGroupViewCommonModuleMocks } from '@/components/sessions/transcript/turns/toolCalls/toolCallsGroupViewTestHelpers';
import { flattenStyleProp } from './toolCallsGroupUnitsTestFixtures';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    contentWidthMode: 'compact' as 'compact' | 'medium' | 'full',
}));

installToolCallsGroupViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'web', select: (values: any) => values?.web ?? values?.default ?? null },
        });
    },
    storage: async (importOriginal) => {
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
    },
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

function findRowFrameMaxWidth(screen: Awaited<ReturnType<typeof renderScreen>>): unknown {
    const matchingNode = screen.findAllByType('View' as never).find((node: any) => {
        const style = flattenStyleProp(node.props.style);
        return style.flexGrow === 1 && style.flexBasis === 0 && style.maxWidth !== undefined;
    });
    return matchingNode ? flattenStyleProp((matchingNode as any).props.style).maxWidth : undefined;
}

describe('ToolCallsGroupUnitRowFrame content width', () => {
    it('updates the row width cap when the local content width setting changes', async () => {
        shared.contentWidthMode = 'compact';
        const { ToolCallsGroupUnitRowFrame } = await import('./toolCallsGroupChrome');

        const renderElement = () => (
            <ToolCallsGroupUnitRowFrame variant="cards" position="middle" unitTestID="unit.row">
                {null}
            </ToolCallsGroupUnitRowFrame>
        );
        const screen = await renderScreen(renderElement());

        expect(findRowFrameMaxWidth(screen)).toBe(850);

        shared.contentWidthMode = 'full';
        await act(async () => {
            screen.tree.update(renderElement());
        });

        expect(findRowFrameMaxWidth(screen)).toBe(Number.POSITIVE_INFINITY);
    });
});
