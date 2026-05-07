import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const platformState = vi.hoisted(() => ({
    os: 'web',
}));

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native')>();
    return {
        ...actual,
        Platform: {
            ...actual.Platform,
            get OS() {
                return platformState.os;
            },
        },
    };
});

describe('PetSprite', () => {
    it('preserves stable test ids and transparent bounds without requiring a placeholder bitmap', async () => {
        const { PetSprite } = await import('./PetSprite');

        const screen = await renderScreen(
            <PetSprite
                testID="desktop-pet-overlay-sprite"
                frame={{ row: 8, frame: 2, cellWidth: 192, cellHeight: 208, state: 'review' }}
            />,
        );

        const sprite = screen.findByTestId('desktop-pet-overlay-sprite');
        expect(sprite?.props['data-pet-state']).toBe('review');
        expect(sprite?.props.style).toEqual(expect.objectContaining({
            width: 192,
            height: 208,
        }));
    });

    it('renders a spritesheet source clipped to the selected atlas frame', async () => {
        const { PetSprite } = await import('./PetSprite');

        const screen = await renderScreen(
            <PetSprite
                testID="desktop-pet-overlay-sprite"
                frame={{ row: 8, frame: 2, cellWidth: 192, cellHeight: 208, state: 'review' }}
                spritesheetSource="blink-spritesheet.webp"
            />,
        );

        const sprite = screen.findByTestId('desktop-pet-overlay-sprite');
        expect(sprite?.props.style).toEqual(expect.objectContaining({
            backgroundColor: 'transparent',
            overflow: 'hidden',
        }));

        const image = screen.root.findAllByType('Image')[0];
        expect(image?.props.source).toBe('blink-spritesheet.webp');
        expect(image?.props.style).toEqual(expect.objectContaining({
            width: 1536,
            height: 1872,
            backgroundColor: 'transparent',
        }));
        expect(image?.props.style.transform).toEqual([
            { translateX: -384 },
            { translateY: -1664 },
        ]);
    });

    it('renders a scaled spritesheet frame without changing atlas addressing', async () => {
        const { PetSprite } = await import('./PetSprite');

        const screen = await renderScreen(
            <PetSprite
                testID="settings-pets-preview-sprite"
                frame={{ row: 8, frame: 2, cellWidth: 192, cellHeight: 208, state: 'review' }}
                spritesheetSource="blink-spritesheet.webp"
                scale={0.25}
            />,
        );

        const sprite = screen.findByTestId('settings-pets-preview-sprite');
        expect(sprite?.props.style).toEqual(expect.objectContaining({
            width: 48,
            height: 52,
            backgroundColor: 'transparent',
            overflow: 'hidden',
        }));

        const image = screen.root.findAllByType('Image')[0];
        expect(image?.props.style).toEqual(expect.objectContaining({
            width: 384,
            height: 468,
            backgroundColor: 'transparent',
        }));
        expect(image?.props.style.transform).toEqual([
            { translateX: -96 },
            { translateY: -416 },
        ]);
    });

    it('renders web spritesheets with pixelated sampling', async () => {
        const { PetSprite } = await import('./PetSprite');

        const screen = await renderScreen(
            <PetSprite
                testID="settings-pets-preview-sprite"
                frame={{ row: 4, frame: 1, cellWidth: 192, cellHeight: 208, state: 'jumping' }}
                spritesheetSource="blink-spritesheet.webp"
            />,
        );

        const image = screen.root.findAllByType('Image')[0];
        expect(image?.props.style).toEqual(expect.objectContaining({
            imageRendering: 'pixelated',
        }));
    });
});
