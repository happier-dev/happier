// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { installWebLayoutBridge, measureWebLayout } from './measureWebLayout';

installWebLayoutBridge();

afterEach(() => document.body.replaceChildren());

function createChangingLayout() {
    const container = document.createElement('div');
    const field = document.createElement('div');
    field.dataset.testid = 'field';
    field.style.height = '10px';
    container.append(field);
    document.body.append(container);
    return { container, field };
}

describe('real browser layout convergence', () => {
    it('distinguishes visible touch reach from an overflowing child cut by its host', async () => {
        const { container, field } = createChangingLayout();
        Object.assign(field.style, { position: 'relative', width: '80px', height: '32px' });
        const reach = document.createElement('div');
        reach.setAttribute('aria-hidden', 'true');
        Object.assign(reach.style, { position: 'absolute', top: '-6px', bottom: '-6px', left: '0', right: '0' });
        field.append(reach, document.createTextNode('Overview'));

        const visible = await measureWebLayout(container, { viewport: { width: 390, height: 300 } });
        expect(visible.rect('field').clipped).toBe(false);

        field.style.overflow = 'hidden';
        const hidden = await measureWebLayout(container, { viewport: { width: 390, height: 300 } });
        expect(hidden.rect('field').clipped).toBe(true);
    });

    it('preserves the document input modality and theme variables for the loaded global keyboard ring', async () => {
        const { container, field } = createChangingLayout();
        field.tabIndex = 0;
        const html = document.documentElement;
        const previousModality = html.getAttribute('data-happier-input-modality');
        const previousStyle = html.getAttribute('style');
        const theme = document.createElement('style');
        theme.textContent = readFileSync(resolve(process.cwd(), 'sources/theme.css'), 'utf8');
        document.head.append(theme);
        html.style.setProperty('--colors-border-focus', '#0a84ff');
        try {
            html.setAttribute('data-happier-input-modality', 'pointer');
            const pointer = await measureWebLayout(container, {
                viewport: { width: 390, height: 300 }, focusedTestId: 'field',
            });
            expect(pointer.rect('field').outlineStyle).toBe('none');
            html.setAttribute('data-happier-input-modality', 'keyboard');
            const keyboard = await measureWebLayout(container, {
                viewport: { width: 390, height: 300 }, focusedTestId: 'field',
            });
            expect(keyboard.rect('field').outlineStyle).toBe('solid');
            expect(keyboard.rect('field').outlineWidth).toBe(2);
        } finally {
            theme.remove();
            if (previousModality === null) html.removeAttribute('data-happier-input-modality');
            else html.setAttribute('data-happier-input-modality', previousModality);
            if (previousStyle === null) html.removeAttribute('style');
            else html.setAttribute('style', previousStyle);
        }
    });

    it('measures the final browser geometry after the layout feedback settles', async () => {
        const { container, field } = createChangingLayout();
        let pass = 0;
        const measurement = await measureWebLayout(container, {
            viewport: { width: 390, height: 300 },
            settle: async (replay) => {
                await replay();
                pass += 1;
                if (pass <= 3) field.style.height = `${10 + pass}px`;
                // A single unchanged pass is insufficient: a later layout effect can still resize it.
                if (pass === 5) field.style.height = '14px';
            },
        });
        expect(measurement.rect('field').height).toBe(14);
        expect(field.getBoundingClientRect().height).toBe(14);
    });

    it('refuses a measurement when layout feedback is still changing at exhaustion', async () => {
        const { container, field } = createChangingLayout();
        let changes = 0;
        await expect(measureWebLayout(container, {
            viewport: { width: 390, height: 300 },
            settle: async (replay) => {
                await replay();
                // This layout does settle, but only after the helper's current resource boundary.
                if (changes < 9) field.style.height = `${10 + ++changes}px`;
            },
        })).rejects.toThrow(/measureWebLayout.*did not settle/u);
    });

    it('replays an existing platform observer after the harness module is reloaded', async () => {
        const { container, field } = createChangingLayout();
        // RNW caches its ResizeObserver independently of the test module's lifetime.
        const observer = new window.ResizeObserver(() => {
            field.textContent = String(field.getBoundingClientRect().height);
        });
        observer.observe(field);
        try {
            vi.resetModules();
            const refreshed = await import('./measureWebLayout');
            refreshed.installWebLayoutBridge();
            await refreshed.measureWebLayout(container, {
                viewport: { width: 390, height: 300 }, settle: (replay) => replay(),
            });
            expect(field.textContent).toBe('10');
        } finally {
            observer.disconnect();
        }
    });
});
