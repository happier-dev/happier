import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-svg', () => ({
    SvgXml: (props: Record<string, unknown>) => React.createElement('SvgXml', props, null),
}));

vi.mock('@/components/ui/media/SafeExpoImage', () => ({
    SafeExpoImage: (props: Record<string, unknown>) => React.createElement('SafeExpoImage', props, null),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentIconSvgXml: (agentId: string) => (
        agentId === 'claude' ? '<svg viewBox="0 0 10 10" fill="#000"><path d="M0 0h10v10H0z"/></svg>' : null
    ),
    getAgentIconSource: () => null,
    getAgentIconTintColor: () => undefined,
}));

/**
 * The Agent mark has to be a laid-out box, not a bare SVG.
 *
 * `SvgXml` renders a raw DOM `<svg>` on web — the one leaf in this app that is not a
 * React-Native-Web view, and therefore the only one that is statically positioned. CSS
 * paints static content beneath positioned siblings, so a mark dropped straight into a
 * filled control whose background is an absolutely positioned layer (`GradientSurface`
 * inside `PrimaryCircleIconButton` / `RoundButton`) is painted over by that background:
 * the composer's armed "Continue with {Agent}" send control rendered as an empty black
 * circle with the mark underneath it.
 */
describe('AgentIcon', () => {
    it('renders its mark inside a laid-out box, so a control background cannot paint over it', async () => {
        const { AgentIcon } = await import('./AgentIcon');

        const screen = await renderScreen(
            <AgentIcon agentId={'claude' as never} size={20} color="#FFFFFF" testID="mark" />,
        );

        const mark = screen.root.findByType('SvgXml' as never);
        // A bare `SvgXml` at the root has no view above it; the box is what puts the mark
        // in the same painting layer as every other icon in the app.
        const boxes = screen.root.findAllByType('View' as never);
        expect(boxes.length).toBeGreaterThan(0);
        expect(boxes.some((box: any) => box.findAllByType('SvgXml' as never).includes(mark))).toBe(true);

        await screen.unmount();
    });

    it('sizes the box to the mark, and leaves the caller\u2019s own style on the mark', async () => {
        // The box exists to position, nothing else: callers style the icon, and a
        // box that swallowed their style would change what every existing call site
        // is asking for.
        const { AgentIcon } = await import('./AgentIcon');

        const screen = await renderScreen(
            <AgentIcon
                agentId={'claude' as never}
                size={16}
                color="#FFFFFF"
                style={{ transform: [{ scale: 1.1 }] } as never}
                testID="mark"
            />,
        );

        const box = screen.root.findAllByType('View' as never)
            .find((node: any) => node.findAllByType('SvgXml' as never).length > 0);
        expect(box).toBeTruthy();
        const boxStyle = ([] as any[]).concat(box!.props.style ?? []).filter(Boolean);
        expect(boxStyle.some((entry: any) => entry?.width === 16 && entry?.height === 16)).toBe(true);

        const mark = screen.root.findByType('SvgXml' as never);
        expect(mark.props.width).toBe(16);
        expect(mark.props.testID).toBe('mark');
        expect(mark.props.style.transform).toContainEqual({ scale: 1.1 });

        await screen.unmount();
    });
});
