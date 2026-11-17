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
        expect(image?.props.style).toEqual(expect.objectContaining({ width: 1536, height: 1872 }));
        expect(atlasOffset(screen.root)).toEqual({ x: -384, y: -1664 });
    });

    it('renders a scaled v2 spritesheet frame without changing atlas addressing', async () => {
        const { PetSprite } = await import('./PetSprite');

        const screen = await renderScreen(
            <PetSprite
                testID="settings-pets-preview-sprite"
                spriteVersionNumber={2}
                frame={{ row: 8, frame: 2, cellWidth: 192, cellHeight: 208, state: 'review' }}
                spritesheetSource="blink-spritesheet.webp"
                scale={0.25}
            />,
        );

        const sprite = screen.findByTestId('settings-pets-preview-sprite');
        expect(sprite?.props.style).toEqual(expect.objectContaining({
            width: 48,
            height: 52,
            overflow: 'hidden',
        }));
        const image = screen.root.findAllByType('Image')[0];
        expect(image?.props.style).toEqual(expect.objectContaining({ width: 384, height: 572 }));
        expect(atlasOffset(screen.root)).toEqual({ x: -96, y: -416 });
    });

    it('fits a face box to the opaque bounds, whole and centred, the same box for every frame', async () => {
        const { PetSprite } = await import('./PetSprite');
        const bounds = { x: 5, y: 5, width: 186, height: 202 };
        const render = (frame: number) => renderScreen(
            <PetSprite
                testID="face"
                frame={{ row: 7, frame, cellWidth: 192, cellHeight: 208, state: 'running' }}
                spritesheetSource="blink-spritesheet.webp"
                fit={{ box: 32, bounds }}
            />,
        );

        const first = await render(0);
        expect(first.findByTestId('face')?.props.style).toEqual(expect.objectContaining({ width: 32, height: 32 }));
        const window = clipWindow(first.root);
        // Bound by its height: the whole pet fills the box's height and is centred across it.
        expect(window.height).toBeCloseTo(32);
        expect(window.width).toBeCloseTo(186 * (32 / 202));
        expect(window.left).toBeGreaterThan(0);
        expect(window.left + window.width).toBeLessThanOrEqual(32.5);
        const second = await render(3);
        expect(clipWindow(second.root)).toEqual(window);
        // The atlas moves by exactly three scaled cells between frame 0 and frame 3.
        expect(atlasOffset(first.root).x - atlasOffset(second.root).x).toBeCloseTo(3 * 192 * (32 / 202), 0);
    });

    it('samples spritesheets smoothly', async () => {
        const { PetSprite } = await import('./PetSprite');

        const screen = await renderScreen(
            <PetSprite
                testID="settings-pets-preview-sprite"
                frame={{ row: 4, frame: 1, cellWidth: 192, cellHeight: 208, state: 'jumping' }}
                spritesheetSource="blink-spritesheet.webp"
            />,
        );

        const image = screen.root.findAllByType('Image')[0];
        expect(image?.props.style.imageRendering).toBeUndefined();
    });
});

type Node = { props: Record<string, any>; findAll: (predicate: (node: any) => boolean) => any[] };
function flatStyle(node: any): Record<string, any> {
    const style = node?.props?.style;
    return Array.isArray(style) ? Object.assign({}, ...style.flat()) : style ?? {};
}
function atlasOffset(root: Node): { x: number; y: number } {
    const atlas = root.findAll(node => Array.isArray(flatStyle(node).transform) && typeof node.type === 'string')[0];
    const transform = flatStyle(atlas).transform as { translateX?: number; translateY?: number }[];
    return { x: transform.find(t => 'translateX' in t)!.translateX!, y: transform.find(t => 'translateY' in t)!.translateY! };
}
function clipWindow(root: Node): { left: number; top: number; width: number; height: number } {
    const clip = root.findAll(node => typeof node.type === 'string' && flatStyle(node).position === 'absolute' && flatStyle(node).overflow === 'hidden')[0];
    const { left, top, width, height } = flatStyle(clip);
    return { left, top, width, height };
}

describe('PetSprite atlas versions', () => {
    it('lays out a v2 sheet (1536 × 2288, 11 rows) with 192 × 208 cells', async () => {
        const { PetSprite } = await import('./PetSprite');
        const screen = await renderScreen(
            <PetSprite
                frame={{ row: 10, frame: 3, cellWidth: 192, cellHeight: 208, state: 'idle' }}
                spritesheetSource="boba-spritesheet.webp"
                spriteVersionNumber={2}
            />,
        );
        const image = screen.root.findAllByType('Image')[0];
        expect(image?.props.style).toEqual(expect.objectContaining({ width: 1536, height: 2288 }));
        expect(atlasOffset(screen.root)).toEqual({ x: -576, y: -2080 });
    });
});
