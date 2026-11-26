/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';
import { createDefaultCollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { reviewListFilterFieldsV1, type ReviewListFilterV1 } from '@happier-dev/protocol/reviews/reviewListFilterV1';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

const viewport = vi.hoisted(() => ({ width: 1440, height: 1000 }));
const dimensionSubscriptions = vi.hoisted(() => new Set<() => void>());
installPopoverCommonModuleMocks({
    reactNative: async () => ({
        ...await vi.importActual<typeof import('react-native-web')>('react-native-web'),
        // Physical layout is the boundary; the header, form, menus and Popover stay real.
        useWindowDimensions: () => ({ ...viewport, scale: 1, fontScale: 1 }),
        Dimensions: { get: () => ({ ...viewport, scale: 1, fontScale: 1 }), addEventListener: (_event: string, listener: () => void) => {
            dimensionSubscriptions.add(listener);
            return { remove: () => { dimensionSubscriptions.delete(listener); } };
        } },
    }),
});
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { useCollectionSpaceHeader } = await import('./useCollectionSpaceHeader');

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); viewport.width = 1440; viewport.height = 1000; });

it('authors a historical Review Updated range through the shared condition editor', async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(100, 120, 340, 250));
    const base = createDefaultCollectionSpaceV1('review');
    let current: ReviewListFilterV1 = {};
    function Header() {
        const [filters, setFilters] = React.useState<ReviewListFilterV1>({});
        const header = useCollectionSpaceHeader({ entityKind: 'review', testIDPrefix: 'review-time', defaultName: 'Reviews',
            view: { spaces: [base], selectedSpaceId: base.id, selectedSpace: base, activeSpace: base,
                spacesEnabled: true, spacesReady: true, spaceSettingsScope: { serverId: 'home', accountId: 'alice' },
                filters, setFilters: next => { current = next; setFilters(next); return true; } },
            registry: reviewListFilterFieldsV1, bindings: {}, defaultIcon: base.icon });
        return <>{header.titleControl}{header.filterButton}{header.strip}{header.conditionRow}{header.overlays}</>;
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const button = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const click = async (id: string) => { expect(button(id), id).not.toBeNull(); await act(async () => button(id)!.click()); };
    const type = async (id: string, value: string) => {
        const input = button(id) as HTMLInputElement;
        expect(input, id).not.toBeNull();
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    };
    try {
        await act(async () => root.render(<HappierUiPlatformProvider platform={{ platform: 'web', colorScheme: 'light' }}><Header /></HappierUiPlatformProvider>));
        await click('review-time-filter-open');
        await act(async () => { await vi.advanceTimersByTimeAsync(400); });
        await click('collection-filter-field:updated');
        await click('collection-filter-time:updated:operator:between');
        await type('collection-filter-time:updated:from-date-input', '2020-01-02');
        await type('collection-filter-time:updated:from-time-input', '09:00');
        await type('collection-filter-time:updated:to-date-input', '2020-01-03');
        await type('collection-filter-time:updated:to-time-input', '10:00');
        await click('collection-filter-time:updated:apply');
        expect(current).toEqual({ updated: { op: 'between', fromMs: new Date(2020, 0, 2, 9).getTime(), toMs: new Date(2020, 0, 3, 10).getTime() } });
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

it.each([true, false])('keeps the Save as space form visible and interactive with spaces enabled=%s', async spacesEnabled => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        // A hidden strip has no layout. Popover must be anchored to a visible header control.
        return this.childElementCount === 0 && !this.textContent?.trim()
            ? new DOMRect(0, 0, 0, 0) : new DOMRect(100, 120, 340, 250);
    });
    const base = createDefaultCollectionSpaceV1('review');
    function Header() {
        const [filters, setFilters] = React.useState<ReviewListFilterV1>({ needsDecision: true });
        const header = useCollectionSpaceHeader({ entityKind: 'review', testIDPrefix: 'review-space', defaultName: 'Reviews',
            view: { spaces: [base], selectedSpaceId: base.id, selectedSpace: base, activeSpace: spacesEnabled ? base : null,
                spacesEnabled, spacesReady: true, spaceSettingsScope: { serverId: 'home', accountId: 'alice' },
                filters, setFilters: next => { setFilters(next); return true; } },
            registry: reviewListFilterFieldsV1, bindings: {}, defaultIcon: base.icon });
        return <>{header.titleControl}{header.strip}{header.conditionRow}{header.overlays}</>;
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const settled = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(400); }); };
    try {
        await act(async () => root.render(<HappierUiPlatformProvider platform={{ platform: 'web', colorScheme: 'light' }}><Header /></HappierUiPlatformProvider>));
        await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="review-space-filter-tokens-save"]')!.click(); });
        await settled();
        const form = document.querySelector<HTMLElement>('[data-testid="review-space-form"]');
        expect(form).not.toBeNull();
        const popover = form!.closest<HTMLElement>('[data-testid^="popover-"]');
        expect(popover).not.toBeNull();
        expect(getComputedStyle(popover!).opacity).toBe('1');
        expect(getComputedStyle(popover!).pointerEvents).toBe('auto');
        const manual = form!.querySelector<HTMLElement>('[data-testid="review-space-membership:manual_only"]')!;
        await act(async () => { manual.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); manual.click(); });
        await settled();
        expect(document.querySelector('[data-testid="review-space-form"]')).toBe(form);
        expect(manual.getAttribute('aria-checked')).toBe('true');
        const name = document.querySelector<HTMLInputElement>('[data-testid="review-space-name"]')!;
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        await act(async () => { name.focus(); setValue.call(name, 'Retained review space'); name.dispatchEvent(new Event('input', { bubbles: true })); });
        expect(document.activeElement).toBe(name);
        for (const width of [390, 1440]) {
            // Chromium emits focusout(null) when the retained focused host leaves its shell;
            // jsdom removes the host without this native event. Keep the real dismissal owner.
            name.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
            viewport.width = width;
            await act(async () => { for (const listener of [...dimensionSubscriptions]) listener(); });
            await settled();
            expect(document.querySelector('[data-testid="review-space-form"]')).toBe(form);
            expect(document.querySelector<HTMLInputElement>('[data-testid="review-space-name"]')?.value).toBe('Retained review space');
            expect(document.querySelector('[data-testid="review-space-membership:manual_only"]')?.getAttribute('aria-checked')).toBe('true');
            expect(document.activeElement).toBe(name);
        }
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});

it('prefills a new space with a glyph no space on the strip already wears', async () => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => new DOMRect(100, 120, 340, 250));
    const base = createDefaultCollectionSpaceV1('review');
    const pinned = { ...base, id: 'pinned', name: 'Pinned', icon: { kind: 'icon', name: 'review' } as const };
    function Header() {
        const [filters, setFilters] = React.useState<ReviewListFilterV1>({ needsDecision: true });
        // The list's own glyph is the default space's: a new space must not repeat it, nor another space's.
        const header = useCollectionSpaceHeader({ entityKind: 'review', testIDPrefix: 'review-space', defaultName: 'Reviews',
            view: { spaces: [base, pinned], selectedSpaceId: base.id, selectedSpace: base, activeSpace: base,
                spacesEnabled: true, spacesReady: true, spaceSettingsScope: { serverId: 'home', accountId: 'alice' },
                filters, setFilters: next => { setFilters(next); return true; } },
            registry: reviewListFilterFieldsV1, bindings: {}, defaultIcon: base.icon });
        return <>{header.titleControl}{header.strip}{header.conditionRow}{header.overlays}</>;
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(<HappierUiPlatformProvider platform={{ platform: 'web', colorScheme: 'light' }}><Header /></HappierUiPlatformProvider>));
        await act(async () => { document.querySelector<HTMLButtonElement>('[data-testid="review-space-filter-tokens-save"]')!.click(); });
        await act(async () => { await vi.advanceTimersByTimeAsync(400); });
        const checked = [...document.querySelectorAll<HTMLElement>('[data-testid^="review-space-icon:"][aria-checked="true"]')]
            .map(tile => tile.getAttribute('data-testid'));
        expect(checked).toHaveLength(1);
        expect(checked).not.toContain('review-space-icon:icon:list');
        expect(checked).not.toContain('review-space-icon:icon:review');
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});
