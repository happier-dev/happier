import assert from 'node:assert/strict';
import type { Page } from '@playwright/test';

export async function measureHomeComposerRestingBox(page: Page) {
    return page.getByTestId('hub-composer.intent').evaluate(seat => {
        const entry = seat.querySelector('[data-testid="hub-composer.open"]');
        const surface = seat.querySelector('[data-testid="agent-input-material-surface"]') ?? entry?.firstElementChild;
        const field = entry?.querySelector('[data-testid="agent-input-document-preview-text"] p')
            ?? seat.querySelector('[data-testid="new-session-composer-input"]')
            ?? surface?.firstElementChild;
        if (!surface || !field) throw new Error('Expected a composer surface and its prompt');
        const band = seat.querySelector('[data-testid="new-session-composer-band"]') ?? seat;
        const box = band.getBoundingClientRect();
        const card = surface.getBoundingClientRect();
        const prompt = field.getBoundingClientRect();
        const paint = getComputedStyle(surface);
        const fieldStyle = getComputedStyle(field);
        return {
            geometry: {
                width: box.width,
                height: box.height,
                cardLeft: card.left - box.left,
                cardTop: card.top - box.top,
                cardWidth: card.width,
                cardHeight: card.height,
                promptLeft: prompt.left - card.left + (Number.parseFloat(fieldStyle.paddingLeft) || 0),
                promptTop: prompt.top - card.top + (Number.parseFloat(fieldStyle.paddingTop) || 0),
            },
            paint: {
                width: paint.borderTopWidth,
                color: paint.borderTopColor,
                radius: paint.borderTopLeftRadius,
                fill: getComputedStyle(surface.querySelector(':scope > [data-happy-glass-backdrop]') ?? surface).backgroundColor,
                innerShadow: paint.boxShadow,
                castShadow: surface.parentElement ? getComputedStyle(surface.parentElement).boxShadow : 'none',
            },
        };
    });
}

export function assertSameHomeComposerRestingBox(
    closed: Awaited<ReturnType<typeof measureHomeComposerRestingBox>>,
    open: Awaited<ReturnType<typeof measureHomeComposerRestingBox>>,
): void {
    for (const key of Object.keys(open.geometry) as (keyof typeof open.geometry)[]) {
        const before = closed.geometry[key];
        const after = open.geometry[key];
        assert.ok(Math.abs(before - after) <= 0.5, `Resting Home composer ${key} shifted from ${before}px to ${after}px`);
    }
    assert.deepEqual(closed.paint, open.paint);
}
