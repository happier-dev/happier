import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({
            ...acc,
            ...flattenStyle(entry),
        }), {});
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('AgentInputStatusBadge', () => {
    it('keeps required disclosure text fully visible in the composer status row', async () => {
        const { AgentInputStatusBadge } = await import('./AgentInputStatusBadge');
        const label = 'Full requester sign-in and computer administrator visibility';
        const screen = await renderScreen(<AgentInputStatusBadge key="disclosure" label={label} labelNumberOfLines={0} emphasis="quiet" />);
        // The pill's label Text carries the optional detail as a sibling child, so match the label among its children.
        expect(screen.find(node => React.Children.toArray(node.props.children).includes(label) && node.props.numberOfLines === 0)).toBeTruthy();
    });
    it('keeps quiet badges pressable while removing persistent border and background chrome', async () => {
        const onPress = vi.fn();
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { AgentInputStatusBadge } = await import('./AgentInputStatusBadge');

        try {
            const screen = await renderScreen(
                <AgentInputStatusBadge
                    key="work-state"
                    label="Goal: Ship the release"
                    testID="quiet-work-state-badge"
                    tone="active"
                    emphasis="quiet"
                    onPress={onPress}
                />,
            );

            const badge = screen.findByTestId('quiet-work-state-badge');
            expect(badge?.type).toBe('Pressable');
            expect(typeof badge?.props.style).toBe('function');

            const badgeSurface = flattenStyle(badge?.props.style({ pressed: false }));

            expect(badgeSurface).not.toEqual(expect.objectContaining({
                backgroundColor: expect.anything(),
                borderColor: expect.anything(),
            }));
            const painted = screen.findAllByType('View').map(node => flattenStyle(node.props.style).backgroundColor)
                .filter(color => typeof color === 'string' && color !== 'transparent');
            expect(painted).toEqual([]);

            badge?.props.onPress?.();
            expect(onPress).toHaveBeenCalledTimes(1);
        } finally {
            consoleError.mockRestore();
        }
    });
    it('shows the popover caret only on a prominent badge that opens one', async () => {
        const { AgentInputStatusBadge } = await import('./AgentInputStatusBadge');
        const renderPopover = () => null;
        const cases = [
            { emphasis: 'prominent' as const, renderPopover, caret: true },
            { emphasis: 'quiet' as const, renderPopover, caret: false },
            { emphasis: 'prominent' as const, renderPopover: undefined, caret: false },
        ];
        for (const entry of cases) {
            const screen = await renderScreen(
                <AgentInputStatusBadge key="usage" label="Usage limit reached" testID="usage-badge" tone="warning"
                    emphasis={entry.emphasis} renderPopover={entry.renderPopover} onPress={() => {}} />,
            );
            expect(Boolean(screen.findByTestId('usage-badge:caret')), `${entry.emphasis} ${entry.renderPopover ? 'popover' : 'plain'}`).toBe(entry.caret);
        }
    });
    it('keeps a warning badge amber on a glass composer, as it is on an opaque one', async () => {
        const { AgentInputStatusBadge } = await import('./AgentInputStatusBadge');
        const { HappierMaterialRoleProvider } = await import('@happier-dev/plugin-ui/presentation');
        const { useUnistyles } = await import('react-native-unistyles');
        const { theme } = useUnistyles();
        const fills = [];
        for (const glass of [false, true]) {
            const badge = <AgentInputStatusBadge key="connected-services" label="Connected services · Unavailable" tone="warning" />;
            const screen = await renderScreen(glass
                ? <HappierMaterialRoleProvider role="content" translucentColor="transparent">{badge}</HappierMaterialRoleProvider>
                : badge);
            fills.push(screen.findAllByType('View').map(node => flattenStyle(node.props.style).backgroundColor)
                .find(color => typeof color === 'string' && color !== 'transparent'));
        }
        // The state tint is the badge's meaning, not a surface fill: a glass plane must not repaint it as
        // its neutral inner coat (the light amber turned grey on the glass New Session composer).
        expect(fills).toEqual([theme.colors.state.warning.background, theme.colors.state.warning.background]);
    });
});
