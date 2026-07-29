import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

describe('StatusPill', () => {
    it('maps onboarding status states to green live, amber needs-attention, and neutral otherwise', async () => {
        const { StatusPill, resolveStatusPillVariantForState } = await import('./StatusPill');

        const live = await renderScreen(
            <StatusPill
                variant={resolveStatusPillVariantForState('live')}
                label="Connected"
                testID="status-live"
            />,
        );
        const needsAttention = await renderScreen(
            <StatusPill
                variant={resolveStatusPillVariantForState('needsAttention')}
                label="Needs attention"
                testID="status-needs-attention"
            />,
        );
        const neutral = await renderScreen(
            <StatusPill
                variant={resolveStatusPillVariantForState('neutral')}
                label="Waiting"
                testID="status-neutral"
            />,
        );

        expect(live.findByTestId('status-live:variant:success')).not.toBeNull();
        expect(live.findByTestId('status-live:dot')).not.toBeNull();
        expect(live.findByTestId('status-live:label')).not.toBeNull();
        expect(needsAttention.findByTestId('status-needs-attention:variant:warning')).not.toBeNull();
        expect(neutral.findByTestId('status-neutral:variant:neutral')).not.toBeNull();
    });

    it('renders a semantic status pill with a stable variant marker', async () => {
        const { StatusPill } = await import('./StatusPill');

        const screen = await renderScreen(<StatusPill variant="success" label="Online" testID="status-online" />);

        expect(screen.findByTestId('status-online')).not.toBeNull();
        expect(screen.findByTestId('status-online:variant:success')).not.toBeNull();
        expect(screen.getTextContent()).toContain('Online');
    });

    it('keeps the variant marker out of flex layout', async () => {
        const { StatusPill } = await import('./StatusPill');

        const screen = await renderScreen(<StatusPill variant="success" label="Online" testID="status-online" />);
        const variantMarker = screen.findByTestId('status-online:variant:success');
        const flat = flattenStyle(variantMarker?.props.style);

        expect(flat.position).toBe('absolute');
        expect(flat.width).toBe(0);
        expect(flat.height).toBe(0);
    });

    it('can hide the leading dot without hiding the label', async () => {
        const { StatusPill } = await import('./StatusPill');

        const screen = await renderScreen(<StatusPill variant="neutral" label="Clean" hideDot testID="status-clean" />);

        expect(screen.findByTestId('status-clean:dot')).toBeNull();
        expect(screen.getTextContent()).toContain('Clean');
    });

    it('can render without badge chrome for inline status rows', async () => {
        const { StatusPill } = await import('./StatusPill');

        const screen = await renderScreen(
            <StatusPill
                variant="success"
                label="online"
                chrome="plain"
                foregroundColor="#34C759"
                dotColor="#22AA44"
                testID="status-online"
            />,
        );
        const container = screen.findByTestId('status-online');
        const dot = screen.findByTestId('status-online:dot');
        const label = screen.findByTestId('status-online:label');
        const flat = flattenStyle(container?.props.style);
        const flatDot = flattenStyle(dot?.props.style);
        const flatLabel = flattenStyle(label?.props.style);

        expect(flat.borderWidth).toBe(0);
        expect(flat.backgroundColor).toBe('transparent');
        expect(screen.findByTestId('status-online:variant:success')).not.toBeNull();
        expect(flatDot.backgroundColor).toBe('#22AA44');
        expect(flatLabel.color).toBe('#34C759');
    });

    it('uses compact pill typography for the label', async () => {
        const { StatusPill } = await import('./StatusPill');

        const screen = await renderScreen(<StatusPill variant="info" label="Syncing" testID="status-sync" />);
        const textNode = screen.findByTestId('status-sync:label');
        const flat = flattenStyle(textNode?.props.style);

        expect(Number(flat.fontSize)).toBeGreaterThan(0);
        expect(Number(flat.lineHeight)).toBeGreaterThanOrEqual(Number(flat.fontSize));
    });
});

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}
