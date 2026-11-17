import React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';

import { BrandWordmark } from './BrandWordmark';

describe('BrandWordmark', () => {
    // C77 (Welcome, 11-17): the wordmark is the only place the brand pane names Happier, and its image had no text.
    it('names Happier for a screen reader', async () => {
        const screen = await renderScreen(<BrandWordmark />);
        const image = screen.findByTestId('brand-wordmark');
        expect(image?.props.accessibilityLabel).toBe(t('welcome.brandWordmarkAccessibilityLabel'));
        expect(image?.props.accessibilityLabel).toBeTruthy();
    });
});
