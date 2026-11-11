import React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installToolCallsGroupViewCommonModuleMocks } from '@/components/sessions/transcript/turns/toolCalls/toolCallsGroupViewTestHelpers';
import { createTranscriptSessionCommonPropsFixture, flattenStyleProp } from './toolCallsGroupUnitsTestFixtures';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installToolCallsGroupViewCommonModuleMocks({
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({ theme: { borderRadius: { xl: 37 } } });
    },
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios', select: (values: any) => values?.ios ?? values?.default ?? null },
        });
    },
});

const interaction = { canSendMessages: true, canApprovePermissions: true } as const;
const { ToolCallsGroupUnitFooterRowWithSessionCommon } = await import('./ToolCallsGroupUnitFooterRow');

async function renderFooterRow(props: Record<string, unknown>) {
    return renderScreen(React.createElement(ToolCallsGroupUnitFooterRowWithSessionCommon, {
        sessionId: 's1',
        groupId: 'toolCalls:t1:m1',
        hasVisibleTools: false,
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
        expect(style.borderBottomLeftRadius).toBe(37);
        expect(style.borderBottomRightRadius).toBe(37);
        expect(style.borderTopLeftRadius).toBeUndefined();
        expect(style.backgroundColor).toBeTruthy();
    });

    it('renders a transparent feed bottom cap that still carries the group bottom margin', async () => {
        const screen = await renderFooterRow({});

        const container = screen.findByTestId('transcript-tool-calls-unit-footer') as any;
        const style = flattenStyleProp(container?.props.style);
        expect(style.marginBottom).toBe(8);
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
        expect(style.borderBottomLeftRadius).toBe(37);
        expect(style.borderTopLeftRadius).toBeUndefined();
        expect(style.backgroundColor).toBeTruthy();
    });

    it('closes a collapsed header-only card with the expanded card bottom cap and gap, without an empty body', async () => {
        // Owner 11-11 (item 10): the collapsed card lost its bottom corners and gap, so the next text touched it.
        const frameOf = (screen: Awaited<ReturnType<typeof renderFooterRow>>) => {
            const frame = screen.findAllHostsByTestId('transcript-tool-calls-unit-footer')[0]!;
            const body = frame.findAll((node) => typeof node.type === 'string' && node !== frame)[0]!;
            return { frame: flattenStyleProp(frame.props.style), bodyHeight: flattenStyleProp(body.props.style).height };
        };
        for (const toolChromeCommon of [{ transcriptToolCallsGroupShowBackground: true }, { toolViewTimelineChromeMode: 'cards' }] as const) {
            const chrome = createTranscriptSessionCommonPropsFixture({ toolChromeCommon });
            const collapsed = frameOf(await renderFooterRow({ ...chrome, hasVisibleTools: false }));
            const expanded = frameOf(await renderFooterRow({ ...chrome, hasVisibleTools: true }));

            expect(collapsed.frame.borderBottomLeftRadius).toBe(37);
            expect(collapsed.frame.borderBottomRightRadius).toBe(37);
            expect(collapsed.frame.marginBottom).toBe(expanded.frame.marginBottom);
            expect(collapsed.frame.paddingBottom).toBe(expanded.frame.paddingBottom);
            expect(collapsed.bodyHeight).toBe(0);
            expect(expanded.bodyHeight).toBeGreaterThan(0);
        }
    });

    it('does not render a gutter-line segment so the line terminates at the footer boundary', async () => {
        const screen = await renderFooterRow({});
        expect(screen.findByTestId('transcript-tool-calls-unit-gutter-line')).toBeNull();
    });
});
