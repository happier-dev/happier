import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks();

const { AttentionBanner } = await import('./AttentionBanner');

type Screen = Awaited<ReturnType<typeof renderScreen>>;

function hostTexts(screen: Screen): string[] {
    return screen.root
        .findAll((node) => typeof node.type === 'string' && typeof node.props.children === 'string')
        .map((node) => node.props.children as string);
}

describe('AttentionBanner', () => {
    it('preserves a domain-owned status glyph with its recovery actions', async () => {
        const retry = vi.fn();
        const screen = await renderScreen(<AttentionBanner testID="offline" title="Machine offline"
            tone="neutral" icon={<View testID="machine-offline-mark" />}
            action={{ label: 'Retry', onPress: retry }} />);
        expect(screen.findByTestId('machine-offline-mark')).toBeTruthy();
        await screen.pressByTestIdAsync('offline.action');
        expect(retry).toHaveBeenCalledOnce();
    });
    it('keeps diagnostic details behind a disclosure and preserves dismiss and secondary actions', async () => {
        const dismiss = vi.fn();
        const secondary = vi.fn();
        const screen = await renderScreen(<AttentionBanner testID="notice" title="Unavailable"
            details={['Diagnostic 42']} secondaryAction={{ label: 'Open settings', onPress: secondary }} onDismiss={dismiss} />);
        expect(screen.getTextContent()).not.toContain('Diagnostic 42');
        await screen.pressByTestIdAsync('notice.details');
        expect(screen.getTextContent()).toContain('Diagnostic 42');
        await screen.pressByTestIdAsync('notice.secondaryAction');
        await screen.pressByTestIdAsync('notice.dismiss');
        expect(secondary).toHaveBeenCalledOnce();
        expect(dismiss).toHaveBeenCalledOnce();
    });
    it('names the state and carries its next action', async () => {
        const onPress = vi.fn();
        const screen = await renderScreen(
            <AttentionBanner
                testID="plugins.readOnly"
                title="Unavailable"
                description="Plugins could not be read from this machine."
                action={{ label: 'Retry', onPress, testID: 'plugins.readOnly-retry' }}
            />,
        );
        expect(hostTexts(screen)).toEqual(expect.arrayContaining(['Unavailable', 'Plugins could not be read from this machine.', 'Retry']));
        await screen.pressByTestIdAsync('plugins.readOnly-retry');
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('is a statement, not a control, when there is nothing to do', async () => {
        const screen = await renderScreen(
            <AttentionBanner testID="actions.retained" tone="neutral" title="Removed targets" description="Kept for history." />,
        );
        expect(screen.findHostByTestId('actions.retained')).not.toBeNull();
        expect(screen.findByTestId('actions.retained.action')).toBeNull();
        expect(screen.findHostByTestId('actions.retained')?.props.onPress).toBeUndefined();
    });

    it('draws its whole outline, top edge included, on a configuration page', async () => {
        const { ListPresentationProvider } = await import('./listPresentation');
        const { flattenTestStyle } = await import('@/dev/testkit');
        for (const tone of ['warning', 'neutral'] as const) {
            const screen = await renderScreen(
                <ListPresentationProvider value="page">
                    <AttentionBanner testID={`home.${tone}`} tone={tone} title="Can't reach this Home" description="Check that it is running." />
                </ListPresentationProvider>,
            );
            // Every rounded, bordered box the banner draws: its surface and anything outlining it.
            const outlines = screen.root
                .findAll((node) => typeof node.type === 'string')
                .map((node) => flattenTestStyle(node.props.style))
                .filter((style) => (style.borderRadius as number | undefined ?? 0) > 0
                    && [style.borderWidth, style.borderTopWidth].some((width) => typeof width === 'number' && width > 0));
            expect(outlines.length, tone).toBeGreaterThan(0);
            for (const style of outlines) {
                const edges = (['Top', 'Right', 'Bottom', 'Left'] as const).map((edge) => ({
                    width: (style[`border${edge}Width`] ?? style.borderWidth) as number | undefined,
                    color: (style[`border${edge}Color`] ?? style.borderColor) as string | undefined,
                }));
                for (const edge of edges) expect(edge.width, tone).toBeGreaterThan(0);
                expect(new Set(edges.map((edge) => edge.color)).size, `${tone}: one colour on all four edges`).toBe(1);
            }
        }
    });

    it('announces a failure the reader must hear now as an alert', async () => {
        const screen = await renderScreen(
            <AttentionBanner testID="refresh.failed" title="Refresh failed" announce="alert" />,
        );
        const host = screen.findHostByTestId('refresh.failed');
        expect(host?.props.role ?? host?.props.accessibilityRole).toBe('alert');
    });
});
