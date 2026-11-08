import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import {
    resolveSessionCompanionHeaderAccessibilityLabel,
    resolveSessionCompanionHeaderIntent,
    shouldOpenFullCompanionAfterShow,
} from './sessionCompanionHeaderIntent';
import { normalizeSessionCompanionPreference } from './state/sessionCompanionPreference';
import { resolveSessionCompanionPlacement, type SessionCompanionPlacementInput } from './layout/resolveSessionCompanionPlacement';

describe('resolveSessionCompanionHeaderIntent', () => {
    it.each([
        {
            name: 'direct visible rail hides it',
            input: {
                visible: true,
                itemCount: 2,
                placement: { kind: 'reserved_rail' as const, edge: 'trailing' as const, widthPx: 312 },
            },
            expected: { operation: 'hide', expanded: true, checked: true, accessibility: 'hide' },
        },
        {
            name: 'direct preference collapse expands in place',
            input: {
                visible: true,
                itemCount: 2,
                placement: { kind: 'collapsed_control' as const, edge: 'trailing' as const, reason: 'preference' as const },
            },
            expected: { operation: 'expand', expanded: false, checked: true, accessibility: 'expand' },
        },
        {
            name: 'direct geometry collapse opens the full surface',
            input: {
                visible: true,
                itemCount: 2,
                placement: { kind: 'collapsed_control' as const, edge: 'trailing' as const, reason: 'geometry' as const },
            },
            expected: { operation: 'open_full', expanded: false, checked: true, accessibility: 'open_full' },
        },
        {
            name: 'persisted visible but unmeasured state stays reachable without mount-driven navigation',
            input: {
                visible: true,
                itemCount: 2,
                placement: { kind: 'collapsed_control' as const, edge: 'trailing' as const, reason: 'unmeasured' as const },
            },
            expected: { operation: 'open_full', expanded: false, checked: true, accessibility: 'open_full' },
        },
        {
            name: 'direct phone control opens the full surface',
            input: {
                visible: true,
                itemCount: 2,
                placement: { kind: 'mobile_control' as const },
                isPhone: true,
            },
            expected: { operation: 'open_full', expanded: false, checked: true, accessibility: 'open_full' },
        },
        {
            name: 'direct first show remains local until placement resolves',
            input: {
                visible: false,
                itemCount: 0,
                placement: { kind: 'hidden' as const },
            },
            expected: { operation: 'show', expanded: false, checked: false, accessibility: 'show' },
        },
        {
            name: 'direct first show on phone opens the full destination',
            input: {
                visible: false,
                itemCount: 0,
                placement: { kind: 'hidden' as const },
                isPhone: true,
            },
            expected: { operation: 'show_and_open_full', expanded: false, checked: false, accessibility: 'open_full' },
        },
    ])('$name', ({ input, expected }) => {
        expect(resolveSessionCompanionHeaderIntent(input)).toEqual({
            ...expected,
            // A first Show previews what it will seed: the status block and the four row sections.
            itemCount: input.visible || input.itemCount > 0 ? input.itemCount : 5,
        });
    });
});

describe('resolveSessionCompanionHeaderAccessibilityLabel', () => {
    it.each([
        ['show', 'show', 'sessionBoard.companion.a11y.show(count=3)'],
        ['hide', 'hide', 'sessionBoard.companion.actions.hide. sessionBoard.companion.a11y.headerAction(count=3)'],
        ['expand', 'expand', 'sessionBoard.companion.a11y.expand(count=3)'],
        ['open full', 'open_full', 'sessionBoard.companion.actions.openFull. sessionBoard.companion.a11y.headerAction(count=3)'],
    ] as const)('announces the %s action and item count', (_name, accessibility, expected) => {
        expect(resolveSessionCompanionHeaderAccessibilityLabel({
            operation: accessibility === 'open_full' ? 'open_full' : accessibility,
            accessibility,
            itemCount: 3,
            expanded: accessibility === 'hide',
            checked: accessibility !== 'show',
        })).toBe(expected);
    });
});

describe('shouldOpenFullCompanionAfterShow', () => {
    const applied = normalizeSessionCompanionPreference({
        v: 1,
        visible: true,
        collapsed: false,
        edge: 'trailing',
        density: 'compact',
        items: [{ kind: 'builtin', id: 'session_summary' }],
    });

    it('keeps a measured fitting rail in place', () => {
        expect(shouldOpenFullCompanionAfterShow({
            applied,
            resolvePlacement: () => ({ kind: 'reserved_rail', edge: 'trailing', widthPx: 280 }),
        })).toBe(false);
    });

    it('lets a fitting cold rail measure in place before choosing the full destination', () => {
        const geometry: Omit<SessionCompanionPlacementInput, 'preference'> = {
            paneLayout: { arrangement: 'session', mainHidden: false, mainDrawerOpen: false, effectiveDetailsOpen: false, detailsAvailable: true,
                containerWidthPx: 1920, containerHeightPx: 900, mainRegionHeightPx: 800,
                mainRegionWidthPx: 1330, multiPaneEnabled: true, deviceType: 'tablet',
                layout: { main: 'docked', kind: 'single', right: 'hidden', details: 'hidden' }, bottomPresentation: 'docked' },
            hostHeightPx: 800, bottomObstructionPx: 0, mainVisible: true,
            accessibilityModalPaneActive: false, fontScale: 1, cardBounds: null,
        };
        const resolvePlacement = (preference: typeof applied) => resolveSessionCompanionPlacement({ ...geometry, preference });
        const cold = resolvePlacement(applied);
        expect(cold.kind).toBe('measuring_rail');
        expect(shouldOpenFullCompanionAfterShow({
            applied,
            resolvePlacement,
        })).toBe(false);
        expect(resolveSessionCompanionHeaderIntent({ visible: true, itemCount: applied.items.length, placement: cold }).operation).toBe('expand');
        expect(shouldOpenFullCompanionAfterShow({ applied, resolvePlacement: preference => resolveSessionCompanionPlacement({
            ...geometry, preference, cardBounds: { widthPx: 280, heightPx: 168 },
        }) })).toBe(false);
    });

    it('opens the full destination when placement is not proven', () => {
        expect(shouldOpenFullCompanionAfterShow({
            applied,
            resolvePlacement: () => ({ kind: 'collapsed_control', edge: 'trailing', reason: 'unmeasured' }),
        })).toBe(true);
    });
});
