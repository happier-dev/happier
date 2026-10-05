/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { installFormsCommonModuleMocks } from './formsTestHelpers';

installFormsCommonModuleMocks({ reactNative: async () => await import('react-native-web') });

const { Slider } = await import('./Slider');
let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = null;
    container = null;
});

describe('Slider web value semantics', () => {
    it('announces its range and updates its current value after keyboard input', async () => {
        function TextSizeControl() {
            const [value, setValue] = React.useState(3);
            return <Slider value={value} min={0} max={6} step={1} onValueChange={setValue}
                accessibilityLabel="Text size" formatValueText={(next) => `${100 + (next - 3) * 10}%`} />;
        }
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        await act(async () => root!.render(<TextSizeControl />));
        const slider = container.querySelector<HTMLElement>('[role="slider"]');
        expect(slider).not.toBeNull();
        expect(slider!.getAttribute('aria-valuemin')).toBe('0');
        expect(slider!.getAttribute('aria-valuemax')).toBe('6');
        expect(slider!.getAttribute('aria-valuenow')).toBe('3');
        expect(slider!.getAttribute('aria-valuetext')).toBe('100%');

        await act(async () => slider!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
        expect(slider!.getAttribute('aria-valuenow')).toBe('6');
        expect(slider!.getAttribute('aria-valuetext')).toBe('130%');
    });
});
