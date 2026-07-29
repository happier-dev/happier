import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { installUiListsCommonModuleMocks } from './uiListsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installUiListsCommonModuleMocks({
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    accent: { blue: '#0000ff' },
                    border: { strong: '#111111' },
                    surface: {
                        pressedOverlay: 'rgba(17,17,17,0.05)',
                        selected: '#ddeeff',
                    },
                    text: {
                        primary: '#111111',
                        secondary: '#666666',
                    },
                },
            },
        });
    },
});

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

describe('SelectableRow selected styling', () => {
    it('uses the global neutral selected treatment for default rows', async () => {
        const { SelectableRow } = await import('./SelectableRow');

        const screen = await renderScreen(
            <SelectableRow testID="selectable-row" title="Row" selected onPress={() => {}} />,
        );

        const style = resolvePressableStyle(screen, 'selectable-row');

        expect(style.backgroundColor).toBe('rgba(17,17,17,0.05)');
        expect(style.borderColor).toBe('#111111');
        expect(style.borderColor).not.toBe('#0000ff');
    });

    it('uses the same neutral selected treatment for command-palette rows', async () => {
        const { SelectableRow } = await import('./SelectableRow');

        const screen = await renderScreen(
            <SelectableRow testID="selectable-row" title="Row" variant="selectable" selected onPress={() => {}} />,
        );

        const style = resolvePressableStyle(screen, 'selectable-row');

        expect(style.backgroundColor).toBe('rgba(17,17,17,0.05)');
        expect(style.borderColor).toBe('#111111');
        expect(style.borderColor).not.toBe('#0000ff');
    });
});

function resolvePressableStyle(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string): Record<string, unknown> {
    const root = screen.findAll((node) => (
        node.props?.testID === testID && typeof node.props?.style === 'function'
    ))[0];
    expect(root).toBeTruthy();

    const resolved = root.props.style({ pressed: false });
    return flattenStyle(resolved);
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((acc, entry) => ({ ...acc, ...flattenStyle(entry) }), {});
    }
    if (typeof style === 'object') return style as Record<string, unknown>;
    return {};
}
