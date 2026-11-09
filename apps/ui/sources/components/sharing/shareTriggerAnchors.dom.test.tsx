/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { installModalComponentCommonModuleMocks } from '@/modal/components/modalComponentTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: 1440 });
Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: 900 });
installModalComponentCommonModuleMocks({ reactNative: async () => {
    const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
    const { createRequire } = getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
    return await vi.importActual(createRequire(import.meta.url).resolve('react-native-web'));
}, text: async () => await vi.importActual('@/text') });
vi.mock('@/utils/web/radixCjs', async () => {
    const { createRadixCjsRealModule } = await import('@/dev/testkit/mocks/radixCjs');
    return createRadixCjsRealModule();
});
vi.mock('react-native-keyboard-controller', async () => {
    const { View } = await vi.importActual<typeof import('react-native-web')>('react-native-web');
    return { KeyboardAvoidingView: View };
});

const { ModalProvider } = await import('@/modal/ModalProvider');
const { Item } = await import('@/components/ui/lists/Item');
const { PromptStackEntryRow } = await import('@/components/settings/prompts/stacks/PromptStackEntryRow');
const { resolvePressTriggerAnchor } = await import('@/components/ui/popover/resolvePointerMenuAnchor');
const { presentShareSheet } = await import('./presentShareSheet');

function ShareBody() { return <button data-testid="anchor-share-body">Copy link</button>; }
function openShare(anchor?: import('./presentShareSheet').ShareSheetAnchor) {
    presentShareSheet({ component: ShareBody, props: {}, title: 'Share report', testID: 'anchor-share', anchor });
}

for (const surface of ['item', 'prompt'] as const) {
    it(`opens an anchored share card from the real ${surface} row`, async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
            // Removed menu items really lose their layout; a constant rect masks a stale-item anchor.
            const size = this.isConnected ? { x: 900, y: 320, width: 80, height: 32 } : { x: 0, y: 0, width: 0, height: 0 };
            return { ...size, top: size.y, left: size.x, right: size.x + size.width, bottom: size.y + size.height, toJSON: () => ({}) };
        });
        try {
            await act(async () => root.render(<ModalProvider>{surface === 'item'
                ? <Item testID="audience" title="Shared with" onPress={event => openShare(resolvePressTriggerAnchor(event))} />
                : <PromptStackEntryRow testID="context-entry" title="Report" entry={{ id: 'entry', ref: { kind: 'doc', artifactId: 'report' }, enabled: true, placement: 'system_append' }} onShare={openShare} />
            }</ModalProvider>));
            await act(async () => document.querySelector<HTMLElement>(surface === 'item'
                ? '[data-testid="audience"]' : '[data-testid="context-entry.more"]')!.click());
            const trigger = document.querySelector<HTMLElement>('[data-testid="context-entry.more"]');
            if (surface === 'prompt') {
                await vi.waitFor(() => expect(document.querySelector('[data-testid="share"]')).not.toBeNull());
                await act(async () => document.querySelector<HTMLElement>('[data-testid="share"]')!.click());
            }
            await vi.waitFor(() => expect(document.querySelector('[data-testid="anchor-share-body"]')).not.toBeNull());
            const popover = document.querySelector('[data-testid="anchor-share-body"]')!.closest<HTMLElement>('[id^="popover-"]');
            expect(popover).not.toBeNull();
            // The card settles below the surviving row trigger, rather than at the window's top edge.
            await vi.waitFor(() => expect(Number.parseFloat(popover!.style.top)).toBeGreaterThanOrEqual(352));
            expect(document.querySelector('[data-happy-modal-layer]')).toBeNull();
            if (surface === 'prompt') {
                await vi.waitFor(() => expect(document.querySelector('[data-testid="share"]')).toBeNull());
                expect(trigger?.isConnected).toBe(true);
            }
        } finally {
            await act(async () => root.unmount());
            measure.mockRestore();
            container.remove();
        }
    });
}

for (const triggerState of ['missing', 'removed'] as const) {
    it(`centers Share when the supplied trigger is ${triggerState}`, async () => {
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        const trigger = document.createElement('button');
        if (triggerState === 'removed') {
            container.append(trigger);
            trigger.remove();
        }
        try {
            await act(async () => root.render(<ModalProvider />));
            await act(async () => openShare({ kind: 'view', ref: { current: triggerState === 'missing' ? null : trigger } }));
            await vi.waitFor(() => expect(document.querySelector('[data-testid="anchor-share-body"]')).not.toBeNull());
            expect(document.querySelector('[data-testid="anchor-share-body"]')!.closest('[id^="popover-"]')).toBeNull();
            const layer = document.querySelector<HTMLElement>('[data-happy-modal-layer]');
            expect(layer).not.toBeNull();
            const frame = Array.from(layer!.querySelectorAll<HTMLElement>('*')).find(element => element.style.minHeight === '100%');
            expect(frame?.style.justifyContent).toBe('center');
            expect(frame?.style.alignItems).toBe('center');
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });
}

it('opens the Share card whole above its persistent menu trigger when only that side holds it', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const card = this.querySelector<HTMLElement>('[data-testid="anchor-share"]');
        // JSDOM has no CSS layout. Model the browser's max-height constraint on the card and its portal gutter.
        const cardHeight = Math.min(450, Number.parseFloat(card?.style.maxHeight ?? '') || 450);
        const gutter = (Number.parseFloat(this.style.paddingTop) || 0) + (Number.parseFloat(this.style.paddingBottom) || 0);
        const size = !this.isConnected ? { x: 0, y: 0, width: 0, height: 0 }
            : this.id.startsWith('popover-') ? { x: 619, y: 8, width: 559, height: cardHeight + gutter }
                : this.matches('[data-testid="share"]') ? { x: 1000, y: 600, width: 160, height: 32 }
                    : { x: 1173, y: 482, width: 32, height: 32 };
        return { ...size, top: size.y, left: size.x, right: size.x + size.width, bottom: size.y + size.height, toJSON: () => ({}) };
    });
    try {
        await act(async () => root.render(<ModalProvider>
            <PromptStackEntryRow testID="geometry-entry" title="Journey" entry={{ id: 'entry', ref: { kind: 'doc', artifactId: 'journey' }, enabled: true, placement: 'system_append' }} onShare={openShare} />
        </ModalProvider>));
        const trigger = document.querySelector<HTMLElement>('[data-testid="geometry-entry.more"]')!;
        await act(async () => trigger.click());
        await vi.waitFor(() => expect(document.querySelector('[data-testid="share"]')).not.toBeNull());
        await act(async () => document.querySelector<HTMLElement>('[data-testid="share"]')!.click());
        await vi.waitFor(() => expect(document.querySelector('[data-testid="anchor-share-body"]')).not.toBeNull());
        await vi.waitFor(() => expect(document.querySelector('[data-testid="share"]')).toBeNull());
        expect(trigger.isConnected).toBe(true);
        const popover = document.querySelector('[data-testid="anchor-share-body"]')!.closest<HTMLElement>('[id^="popover-"]')!;
        // In this 900 window the 450 card ends at 972 below the trigger (482-514) and starts at 24 above it.
        await vi.waitFor(() => expect(popover.style.bottom).not.toBe(''));
        const cardBottom = 900 - Number.parseFloat(popover.style.bottom) - (Number.parseFloat(popover.style.paddingBottom) || 0);
        expect(cardBottom).toBeLessThanOrEqual(482);
        expect(cardBottom - 450).toBeGreaterThanOrEqual(8);
        const card = document.querySelector<HTMLElement>('[data-testid="anchor-share"]')!;
        expect(Number.parseFloat(card.style.maxHeight)).toBeGreaterThanOrEqual(450);
    } finally {
        await act(async () => root.unmount());
        measure.mockRestore();
        container.remove();
    }
});
