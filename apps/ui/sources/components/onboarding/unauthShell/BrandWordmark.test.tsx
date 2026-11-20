import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';

import { BrandWordmark } from './BrandWordmark';

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props),
}));
vi.mock('@/assets/images/logotype-dark.png', () => ({ default: 'logotype-dark.png' }));
vi.mock('@/assets/images/logotype-light.png', () => ({ default: 'logotype-light.png' }));

describe('BrandWordmark', () => {
    it('loads both logotypes while exposing only the current one', async () => {
        const screen = await renderScreen(<BrandWordmark />);
        const images = screen.findAllByType('Image' as never);
        expect(images.map(({ props }) => props.source)).toEqual(expect.arrayContaining([
            'logotype-dark.png', 'logotype-light.png',
        ]));
        expect(images.filter(({ props }) => !props['aria-hidden'])).toHaveLength(1);
    });

    // C77 (Welcome, 11-17): the wordmark is the only place the brand pane names Happier, and its image had no text.
    it('names Happier for a screen reader', async () => {
        const screen = await renderScreen(<BrandWordmark />);
        const image = screen.findByTestId('brand-wordmark');
        expect(image?.props.accessibilityLabel).toBe(t('welcome.brandWordmarkAccessibilityLabel'));
        expect(image?.props.accessibilityLabel).toBeTruthy();
    });
});
