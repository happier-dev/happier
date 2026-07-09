import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installToolCallsGroupViewCommonModuleMocks } from '@/components/sessions/transcript/turns/toolCalls/toolCallsGroupViewTestHelpers';
import { createTranscriptSessionCommonPropsFixture, flattenStyleProp } from './toolCallsGroupUnitsTestFixtures';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installToolCallsGroupViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios', select: (values: any) => values?.ios ?? values?.default ?? null },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => (
                params ? `${key}:${JSON.stringify(params)}` : key
            ),
        });
    },
});

const interaction = { canSendMessages: true, canApprovePermissions: true } as const;

async function renderExpandRow(props: Record<string, unknown>) {
    const { ToolCallsGroupUnitExpandRowWithSessionCommon } = await import('./ToolCallsGroupUnitExpandRow');
    return renderScreen(React.createElement(ToolCallsGroupUnitExpandRowWithSessionCommon, {
        sessionId: 's1',
        groupId: 'toolCalls:t1:m1',
        metadata: null,
        interaction,
        hiddenCount: 3,
        setExpanded: vi.fn(),
        ...createTranscriptSessionCommonPropsFixture(),
        ...props,
    } as any));
}

describe('ToolCallsGroupUnitExpandRow', () => {
    it('renders the existing collapsed-preview-more translation with the hidden count', async () => {
        const screen = await renderExpandRow({ hiddenCount: 3 });

        expect(screen.findByTestId('transcript-tool-calls-preview-more')).not.toBeNull();
        expect(screen.getTextContent()).toContain('session.toolCallsCollapsedPreviewMore');
        expect(screen.getTextContent()).toContain('"count":3');
    });

    it('requests expansion via setExpanded(true) when pressed', async () => {
        const setExpanded = vi.fn();
        const screen = await renderExpandRow({ hiddenCount: 2, setExpanded });

        await screen.pressByTestIdAsync('transcript-tool-calls-preview-more');

        expect(setExpanded).toHaveBeenCalledWith(true);
    });

    it('renders nothing when there is no hidden tool', async () => {
        const screen = await renderExpandRow({ hiddenCount: 0 });
        expect(screen.findByTestId('transcript-tool-calls-preview-more')).toBeNull();
    });

    it('renders position-invariant middle chrome with its own gutter-line segment', async () => {
        const screen = await renderExpandRow({
            hiddenCount: 1,
            ...createTranscriptSessionCommonPropsFixture({
                toolChromeCommon: { toolViewTimelineChromeMode: 'cards' },
            }),
        });

        const container = screen.findByTestId('transcript-tool-calls-unit-expand') as any;
        const style = flattenStyleProp(container?.props.style);
        expect(style.marginHorizontal).toBe(16);
        expect(style.borderTopLeftRadius).toBeUndefined();
        expect(style.borderBottomLeftRadius).toBeUndefined();
        expect(style.backgroundColor).toBeTruthy();

        const gutterLine = screen.findByTestId('transcript-tool-calls-unit-gutter-line') as any;
        expect(gutterLine).not.toBeNull();
        const gutterLineStyle = flattenStyleProp(gutterLine?.props.style);
        expect(gutterLineStyle.marginBottom).toBeUndefined();
        expect(gutterLineStyle.width).toBe(2);
    });
});
