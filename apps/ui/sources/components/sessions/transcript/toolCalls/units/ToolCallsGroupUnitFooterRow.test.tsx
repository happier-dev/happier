import React from 'react';
import { describe, expect, it } from 'vitest';

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
});

const interaction = { canSendMessages: true, canApprovePermissions: true } as const;

async function renderFooterRow(props: Record<string, unknown>) {
    const { ToolCallsGroupUnitFooterRowWithSessionCommon } = await import('./ToolCallsGroupUnitFooterRow');
    return renderScreen(React.createElement(ToolCallsGroupUnitFooterRowWithSessionCommon, {
        sessionId: 's1',
        groupId: 'toolCalls:t1:m1',
        metadata: null,
        interaction,
        ...createTranscriptSessionCommonPropsFixture(),
        ...props,
    } as any));
}

describe('ToolCallsGroupUnitFooterRow', () => {
    it('renders the cards bottom cap with bottom radii, background, and the group bottom margin', async () => {
        const screen = await renderFooterRow({
            ...createTranscriptSessionCommonPropsFixture({
                toolChromeCommon: { toolViewTimelineChromeMode: 'cards' },
            }),
        });

        const container = screen.findByTestId('transcript-tool-calls-unit-footer') as any;
        const style = flattenStyleProp(container?.props.style);
        expect(style.marginHorizontal).toBe(16);
        expect(style.marginBottom).toBe(22);
        expect(style.borderBottomLeftRadius).toBe(14);
        expect(style.borderBottomRightRadius).toBe(14);
        expect(style.borderTopLeftRadius).toBeUndefined();
        expect(style.backgroundColor).toBeTruthy();
    });

    it('renders a transparent feed bottom cap that still carries the group bottom margin', async () => {
        const screen = await renderFooterRow({});

        const container = screen.findByTestId('transcript-tool-calls-unit-footer') as any;
        const style = flattenStyleProp(container?.props.style);
        expect(style.marginBottom).toBe(22);
        expect(style.borderBottomLeftRadius).toBeUndefined();
        expect(style.backgroundColor ?? 'transparent').toBe('transparent');
    });

    it('renders the feed-background bottom cap with horizontal padding and bottom vertical padding', async () => {
        const screen = await renderFooterRow({
            ...createTranscriptSessionCommonPropsFixture({
                toolChromeCommon: { transcriptToolCallsGroupShowBackground: true },
            }),
        });

        const container = screen.findByTestId('transcript-tool-calls-unit-footer') as any;
        const style = flattenStyleProp(container?.props.style);
        expect(style.paddingHorizontal).toBe(10);
        expect(style.paddingBottom).toBe(6);
        expect(style.paddingTop).toBeUndefined();
        expect(style.borderBottomLeftRadius).toBe(14);
        expect(style.borderTopLeftRadius).toBeUndefined();
        expect(style.backgroundColor).toBeTruthy();
    });

    it('does not render a gutter-line segment so the line terminates at the footer boundary', async () => {
        const screen = await renderFooterRow({});
        expect(screen.findByTestId('transcript-tool-calls-unit-gutter-line')).toBeNull();
    });
});
