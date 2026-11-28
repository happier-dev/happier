import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';

vi.mock('@/components/qr', () => ({ QRCode: () => null }));

describe('SupporterPassStylePicker', () => {
    it('offers the seven pass arts in a dark or light finish, starts on dark glyphs, and keeps both picks on this device', async () => {
        const { SupporterPassStylePicker } = await import('./SupporterPassStylePicker');
        const screen = await renderScreen(<SupporterPassStylePicker />);
        const radios = () => screen.root.findAll((node) => node.props.accessibilityRole === 'radio' && typeof node.props.onPress === 'function');
        const options = () => radios().filter((node) => String(node.props.testID).startsWith('supporter-pass-style:'));
        const finishes = () => radios().filter((node) => String(node.props.testID).startsWith('supporter-pass-finish:'));
        const selectedFinish = () => finishes().filter((node) => node.props.accessibilityState?.selected).map((node) => node.props.testID);

        // Dark is the default finish whatever the app theme.
        expect(selectedFinish()).toEqual(['supporter-pass-finish:dark']);
        await act(async () => finishes().find((node) => node.props.testID === 'supporter-pass-finish:light')!.props.onPress());
        expect(storage.getState().localSettings.supporterPassFinish).toBe('light');
        expect(selectedFinish()).toEqual(['supporter-pass-finish:light']);

        expect(options().map((node) => node.props.testID)).toEqual([
            'supporter-pass-style:glyph-number',
            'supporter-pass-style:glyph-sunrise',
            'supporter-pass-style:smile-planet',
            'supporter-pass-style:dawn-halftone',
            'supporter-pass-style:holo-foil',
            'supporter-pass-style:star-chart',
            'supporter-pass-style:embossed-number',
        ]);
        const selected = () => options().filter((node) => node.props.accessibilityState?.selected).map((node) => node.props.testID);
        expect(selected()).toEqual(['supporter-pass-style:glyph-number']);

        await act(async () => options().find((node) => node.props.testID === 'supporter-pass-style:holo-foil')!.props.onPress());

        expect(storage.getState().localSettings.supporterPassStyle).toBe('holo-foil');
        expect(selected()).toEqual(['supporter-pass-style:holo-foil']);
    });
});
