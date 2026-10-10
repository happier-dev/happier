// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

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
