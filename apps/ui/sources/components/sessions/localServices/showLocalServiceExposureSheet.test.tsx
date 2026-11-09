import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import type { IModal } from '@/modal/types';
import { t } from '@/text';

const modalSpies = vi.hoisted(() => ({
    show: vi.fn<IModal['show']>(() => 'modal-id'),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { show: modalSpies.show } }).module;
});

import { showLocalServiceExposureSheet } from './showLocalServiceExposureSheet';

type ShownSheet = Readonly<{
    component: React.ComponentType<Record<string, unknown>>;
    props: Record<string, unknown>;
}>;

/** Open the sheet the way the Services row does and hand back what `Modal.show` was asked to draw. */
function openSheet(input: Readonly<{
    modes: readonly ('secret_link' | 'people')[];
    ttls: readonly number[];
    onDecision?: (decision: unknown) => void;
}>): ShownSheet {
    void showLocalServiceExposureSheet({
        serviceTitle: 'web',
        modeChoices: input.modes.map((mode) => ({ mode, label: mode === 'secret_link' ? 'Secret link' : 'Specific people' })),
        ttlChoices: input.ttls.map((ttlMs) => ({ ttlMs, label: `${ttlMs / 60_000} min` })),
        testIDPrefix: 'sheet',
    }).then((decision) => input.onDecision?.(decision));
    const config = modalSpies.show.mock.calls.at(-1)?.[0] as unknown as ShownSheet | undefined;
    if (!config) throw new Error('the exposure sheet was never shown');
    return config;
}

async function renderSheet(sheet: ShownSheet) {
    return await renderScreen(React.createElement(sheet.component, {
        ...sheet.props,
        onClose: () => {},
    }));
}

describe('showLocalServiceExposureSheet', () => {
    beforeEach(() => {
        modalSpies.show.mockClear();
    });

    it('says who can open the link for the link type the person has chosen', async () => {
        const screen = await renderSheet(openSheet({ modes: ['secret_link', 'people'], ttls: [600_000, 3_600_000] }));
        const anyoneCanOpen = t('localServices.publicPreview.consequenceReach');

        expect(screen.getTextContent()).toContain(anyoneCanOpen);

        await pressTestInstanceAsync(screen.findByTestId('sheet-mode:people'), 'specific people segment');

        // One sentence per mode: a people share never claims that anyone can open it.
        expect(screen.getTextContent()).not.toContain(anyoneCanOpen);
        expect(screen.findByTestId('sheet-consequence-reach')).not.toBeNull();
    });

    it('opens on the secret link, first, whatever order the server lists its allowed link types in', async () => {
        const decisions: unknown[] = [];
        const screen = await renderSheet(openSheet({ modes: ['people', 'secret_link'], ttls: [600_000], onDecision: (decision) => decisions.push(decision) }));

        expect(screen.getTextContent()).toContain(t('localServices.publicPreview.consequenceReach'));
        expect(screen.getTextContent().indexOf('Secret link')).toBeLessThan(screen.getTextContent().indexOf('Specific people'));
        await pressTestInstanceAsync(screen.findByTestId('sheet-commit'), 'create link');
        await Promise.resolve();
        expect(decisions).toEqual([{ mode: 'secret_link', ttlMs: 600_000 }]);
    });

    it('creates no people share until someone is chosen to open it', async () => {
        const decisions: unknown[] = [];
        const screen = await renderSheet(openSheet({ modes: ['people'], ttls: [600_000], onDecision: (decision) => decisions.push(decision) }));

        expect(screen.getTextContent()).toContain(t('localServices.publicPreview.consequenceReachPeople'));
        await pressTestInstanceAsync(screen.findByTestId('sheet-commit'), 'create link').catch(() => undefined);
        await Promise.resolve();
        expect(decisions).toEqual([]);
    });

    it('shows the one allowed lifetime as a fact instead of hiding it when there is nothing to choose', async () => {
        const screen = await renderSheet(openSheet({ modes: ['secret_link'], ttls: [600_000] }));

        // The expiry consequence promises "the lifetime below": it must be there to read.
        expect(screen.findByTestId('sheet-ttl-fixed')).not.toBeNull();
        expect(screen.getTextContent()).toContain('10 min');
        // Not a control: a single option is not a decision.
        expect(screen.findByTestId('sheet-ttl:600000')).toBeNull();
    });

    it('offers the lifetime as a choice when the server allows more than one', async () => {
        const screen = await renderSheet(openSheet({ modes: ['secret_link'], ttls: [600_000, 3_600_000] }));

        expect(screen.findByTestId('sheet-ttl:600000')).not.toBeNull();
        expect(screen.findByTestId('sheet-ttl-fixed')).toBeNull();
    });
});
