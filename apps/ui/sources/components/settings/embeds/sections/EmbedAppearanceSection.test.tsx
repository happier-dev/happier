import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { DEFAULT_EMBED_DRAFT, type EmbedDraft } from '../embedDraft';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-gesture-handler', async () => {
    const { createGestureHandlerMock } = await import('@/dev/testkit/mocks/gestureHandler');
    return createGestureHandlerMock();
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('reanimated-color-picker', async () => {
    const { createReanimatedColorPickerMock } = await import('@/dev/testkit/mocks/reanimatedColorPicker');
    return createReanimatedColorPickerMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

describe('EmbedAppearanceSection colours', () => {
    it('edits dark colours while the embed follows the system mode', async () => {
        const { EmbedAppearanceSection } = await import('./EmbedAppearanceSection');
        const onChange = vi.fn<(next: EmbedDraft) => void>();
        const draft: EmbedDraft = { ...DEFAULT_EMBED_DRAFT, config: { ...DEFAULT_EMBED_DRAFT.config, style: { v: 1, mode: 'system' } } };

        const screen = await renderScreen(<EmbedAppearanceSection draft={draft} onChange={onChange} />);
        await screen.pressByTestIdAsync('settings-embed-colors-header');
        await screen.pressByTestIdAsync('settings-embed-colors-mode:dark');

        // The colour rows are the theme editor's own `ThemeColorTokenRow`s (memoized, so found by their props).
        const rows = screen.findAll((node) => typeof node.type !== 'string' && node.props.token?.id !== undefined && typeof node.props.onReset === 'function');
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.props.mode === 'dark')).toBe(true);
        const tokenId = String(rows[0]!.props.token.id);
        act(() => { rows[0]!.props.onChange(tokenId, '#123456'); });

        const next = onChange.mock.calls.at(-1)?.[0];
        expect(next?.config.style?.colors?.dark).toEqual({ [tokenId]: '#123456' });
        expect(next?.config.style?.colors?.light ?? {}).toEqual({});
        expect(next?.config.style?.mode).toBe('system');
    });

    it('shows each colour row its value in the edited mode', async () => {
        const { EmbedAppearanceSection } = await import('./EmbedAppearanceSection');
        const draft: EmbedDraft = { ...DEFAULT_EMBED_DRAFT, config: { ...DEFAULT_EMBED_DRAFT.config,
            style: { v: 1, mode: 'dark', colors: { dark: { 'background.canvas': '#123456' } } } } };

        const screen = await renderScreen(<EmbedAppearanceSection draft={draft} onChange={vi.fn()} />);
        await screen.pressByTestIdAsync('settings-embed-colors-header');

        const rows = screen.findAll((node) => typeof node.type !== 'string' && node.props.token?.id !== undefined && typeof node.props.onReset === 'function');
        expect(rows.map((row) => row.props.token.id)).toContain('background.canvas');
        const canvas = rows.find((row) => row.props.token.id === 'background.canvas');
        expect(canvas?.props).toMatchObject({ value: '#123456', changed: true });
        expect(rows.every((row) => typeof row.props.value === 'string' && row.props.value.length > 0)).toBe(true);
    });
});
