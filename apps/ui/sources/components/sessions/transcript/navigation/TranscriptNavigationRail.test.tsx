import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { getTranscriptNavigationVisibilityStore } from '@/components/sessions/transcript/viewport/visibility/transcriptNavigationVisibilityStore';

import type { TranscriptNavigationEntry } from './transcriptNavigationTypes';
import type { TranscriptNavigationRailEntry } from './TranscriptNavigationRail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

// The glass hover preview renders through GlassPanel, whose blur preference
// lives behind the storage settings boundary.
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({});
});

const SOFT_EXIT_WAIT_MS = 180;

async function waitForSoftExit() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, SOFT_EXIT_WAIT_MS));
    });
}

type StyleRecord = Readonly<Record<string, unknown>>;

function entry(overrides: Partial<TranscriptNavigationEntry> & Pick<TranscriptNavigationEntry, 'id' | 'kind' | 'label'>): TranscriptNavigationEntry {
    const { id, kind, label, ...rest } = overrides;
    return {
        createdAtMs: null,
        id,
        kind,
        label,
        loaded: true,
        pinned: false,
        pinnedAtMs: null,
        promptPreview: null,
        responsePreview: null,
        role: 'unknown',
        routeMessageId: null,
        seq: null,
        transcriptBlockIndex: null,
        sessionId: 'session-1',
        ...rest,
    };
}

function buildEntries(count: number): readonly TranscriptNavigationEntry[] {
    return Array.from({ length: count }, (_, index) => entry({
        id: `turn-${index + 1}`,
        kind: 'user-turn',
        label: `Prompt ${index + 1}`,
        promptPreview: `Prompt preview ${index + 1}`,
        role: 'user',
        routeMessageId: `server:message-${index + 1}`,
        seq: index + 1,
    }));
}

function flattenStyle(style: unknown): StyleRecord {
    if (Array.isArray(style)) {
        return style.reduce<StyleRecord>((accumulator, item) => ({
            ...accumulator,
            ...flattenStyle(item),
        }), {});
    }
    if (!style || typeof style !== 'object') return {};
    return style as StyleRecord;
}

function readStyleNumber(style: unknown, key: string): number {
    const value = flattenStyle(style)[key];
    return typeof value === 'number' ? value : Number.NaN;
}

const entries: readonly TranscriptNavigationEntry[] = [
    entry({
        id: 'turn-1',
        kind: 'user-turn',
        label: 'First prompt',
        promptPreview: 'First prompt preview',
        responsePreview: 'First response preview',
        role: 'user',
        routeMessageId: 'server:user-1',
        seq: 10,
    }),
    entry({
        id: 'pin-a',
        kind: 'pinned-assistant',
        label: 'Pinned answer',
        promptPreview: 'Pinned answer preview',
        pinned: true,
        pinnedAtMs: 200,
        role: 'assistant',
        routeMessageId: 'server:assistant-1',
        seq: 11,
    }),
    entry({
        id: 'turn-2',
        kind: 'user-turn',
        label: 'Second prompt',
        promptPreview: 'Second prompt preview',
        role: 'user',
        routeMessageId: 'server:user-2',
        seq: 12,
    }),
];

const RAIL_SESSION_ID = 'session-1';

function seedVisibility(snapshot: Readonly<{
    currentAnchorId: string | null;
    visibleAnchorIds: readonly string[];
}>) {
    getTranscriptNavigationVisibilityStore(RAIL_SESSION_ID).set(snapshot);
}

function baseProps(onJump = vi.fn()) {
    seedVisibility({ currentAnchorId: 'turn-1', visibleAnchorIds: ['turn-1'] });
    return {
        entries,
        onJumpToEntry: onJump,
        paneHeightPx: 800,
        paneWidthPx: 1000,
        platformOS: 'web' as const,
        sessionId: RAIL_SESSION_ID,
        transcriptContentWidthPx: 800,
    };
}

describe('TranscriptNavigationRail', () => {
    it('uses the canonical navigation entry contract for rail activation', () => {
        expectTypeOf<TranscriptNavigationRailEntry>().toEqualTypeOf<TranscriptNavigationEntry>();
    });

    it('renders on wide web and hides on narrow/native or with fewer than two entries', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');

        const wide = await renderScreen(<TranscriptNavigationRail {...baseProps()} />);
        expect(wide.findByTestId('transcript-navigation-rail')).toBeTruthy();

        const narrow = await renderScreen(
            <TranscriptNavigationRail {...baseProps()} paneWidthPx={700} />,
        );
        expect(narrow.findByTestId('transcript-navigation-rail')).toBeNull();

        const native = await renderScreen(
            <TranscriptNavigationRail {...baseProps()} platformOS="ios" />,
        );
        expect(native.findByTestId('transcript-navigation-rail')).toBeNull();

        const singleton = await renderScreen(
            <TranscriptNavigationRail {...baseProps()} entries={[entries[0]]} />,
        );
        expect(singleton.findByTestId('transcript-navigation-rail')).toBeNull();
    });

    it('calls the jump callback with the selected entry and alignment when a marker is pressed', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');
        const onJump = vi.fn();

        const screen = await renderScreen(<TranscriptNavigationRail {...baseProps(onJump)} />);
        await screen.pressByTestIdAsync('transcript-navigation-rail.marker:pin-a');

        expect(onJump).toHaveBeenCalledWith(entries[1], {
            align: 'center',
            scope: { kind: 'main', sessionId: 'session-1' },
            source: 'rail',
            target: {
                kind: 'route-message-id',
                routeMessageId: 'server:assistant-1',
                seqHint: 11,
                transcriptBlockIndex: null,
                role: 'assistant',
            },
        });
        expect(onJump.mock.calls[0]?.[0]).toMatchObject({
            sessionId: 'session-1',
            seq: 11,
            routeMessageId: 'server:assistant-1',
            kind: 'pinned-assistant',
            role: 'assistant',
            loaded: true,
        });
    });

    it('uses one tab stop and keyboard arrows to rove focus before Enter activates the focused marker', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');
        const onJump = vi.fn();

        const screen = await renderScreen(<TranscriptNavigationRail {...baseProps(onJump)} />);
        const tabStop = screen.findByTestId('transcript-navigation-rail.roving-tabstop');
        expect(tabStop?.props.tabIndex).toBe(0);
        expect(screen.findByTestId('transcript-navigation-rail.marker:turn-1')?.props.tabIndex).toBe(-1);
        expect(screen.findByTestId('transcript-navigation-rail.marker:pin-a')?.props.tabIndex).toBe(-1);

        await act(async () => {
            tabStop?.props.onKeyDown?.({ key: 'ArrowDown', preventDefault: vi.fn() });
            tabStop?.props.onKeyDown?.({ key: 'Enter', preventDefault: vi.fn() });
        });

        expect(onJump).toHaveBeenCalledWith(entries[1], {
            align: 'center',
            scope: { kind: 'main', sessionId: 'session-1' },
            source: 'rail',
            target: {
                kind: 'route-message-id',
                routeMessageId: 'server:assistant-1',
                seqHint: 11,
                transcriptBlockIndex: null,
                role: 'assistant',
            },
        });
    });

    it('shows an accessible preview for the focused marker on hover and on touch', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');

        const screen = await renderScreen(<TranscriptNavigationRail {...baseProps()} />);
        const marker = screen.findByTestId('transcript-navigation-rail.marker:pin-a');

        await act(async () => {
            marker?.props.onPointerEnter?.({ nativeEvent: { pointerType: 'mouse' } });
        });
        expect(screen.findByTestId('transcript-navigation-rail.preview')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Pinned answer preview');

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail')?.props.onPointerLeave?.({
                nativeEvent: { pointerType: 'mouse' },
            });
        });
        await waitForSoftExit();
        expect(screen.findByTestId('transcript-navigation-rail.preview')).toBeNull();

        // Touch-web: a tap must reveal the preview too, not silently fall
        // through to a 4px target with no affordance.
        await act(async () => {
            screen.findByTestId('transcript-navigation-rail.marker:pin-a')?.props.onPointerEnter?.({
                nativeEvent: { pointerType: 'touch' },
            });
        });
        expect(screen.findByTestId('transcript-navigation-rail.preview')).toBeTruthy();
    });

    it('activates a marker on a touch tap', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');
        const onJump = vi.fn();

        const screen = await renderScreen(<TranscriptNavigationRail {...baseProps(onJump)} />);
        const marker = screen.findByTestId('transcript-navigation-rail.marker:turn-2');
        await act(async () => {
            marker?.props.onPointerEnter?.({ nativeEvent: { pointerType: 'touch' } });
            marker?.props.onClick?.();
        });

        expect(onJump).toHaveBeenCalledTimes(1);
        expect(onJump.mock.calls[0]?.[0]).toBe(entries[2]);
    });

    it('marks the turn being read active from the visibility store even when its prompt row is unmounted', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');

        const screen = await renderScreen(<TranscriptNavigationRail {...baseProps()} />);
        expect(screen.findByTestId('transcript-navigation-rail.marker:turn-1')?.props.accessibilityState?.selected)
            .toBe(true);

        // Scrolled deep into turn-2's body: nothing is visible (its prompt row
        // is virtualized away) yet turn-2 is the turn being read.
        await act(async () => {
            seedVisibility({ currentAnchorId: 'turn-2', visibleAnchorIds: [] });
        });

        expect(screen.findByTestId('transcript-navigation-rail.marker:turn-2')?.props.accessibilityState?.selected)
            .toBe(true);
        expect(screen.findByTestId('transcript-navigation-rail.marker:turn-1')?.props.accessibilityState?.selected)
            .toBe(false);
    });

    it('points the roving tabstop at the active descendant without moving DOM focus', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');

        const screen = await renderScreen(<TranscriptNavigationRail {...baseProps()} />);
        const tabstop = screen.findByTestId('transcript-navigation-rail.roving-tabstop');
        const activeMarker = screen.findByTestId('transcript-navigation-rail.marker:turn-1');

        expect(tabstop?.props.tabIndex).toBe(0);
        expect(tabstop?.props['aria-activedescendant']).toBe(activeMarker?.props.id);
        expect(activeMarker?.props.tabIndex).toBe(-1);
    });

    it('names markers through the canonical entry accessibility resolver', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');
        const fallbackEntries = [
            entries[0]!,
            entry({
                id: 'pin-fallback',
                kind: 'pinned-tool',
                label: '',
                fallbackLabelKind: 'pinned-tool',
                pinned: true,
                pinnedAtMs: 5,
                role: 'tool',
                routeMessageId: 'server:tool-1',
                seq: 13,
            }),
        ];

        const screen = await renderScreen(
            <TranscriptNavigationRail {...baseProps()} entries={fallbackEntries} />,
        );

        const label = screen.findByTestId('transcript-navigation-rail.marker:pin-fallback')?.props.accessibilityLabel;
        expect(typeof label).toBe('string');
        expect(String(label).length).toBeGreaterThan(0);
    });

    it('renders marker motion from React alone: hover, unhover, then active leaves no inline write behind', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');

        const screen = await renderScreen(<TranscriptNavigationRail {...baseProps()} />);
        const readWidth = () => readStyleNumber(
            screen.findByTestId('transcript-navigation-rail.marker-line:pin-a')?.props.style,
            'width',
        );
        expect(readWidth()).toBe(3);

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail.marker:pin-a')?.props.onPointerEnter?.({
                nativeEvent: { pointerType: 'mouse' },
            });
        });
        expect(readWidth()).toBe(16);

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail')?.props.onPointerLeave?.({
                nativeEvent: { pointerType: 'mouse' },
            });
        });
        expect(readWidth()).toBe(3);

        await act(async () => {
            seedVisibility({ currentAnchorId: 'pin-a', visibleAnchorIds: ['pin-a'] });
        });

        const activeLine = screen.findByTestId('transcript-navigation-rail.marker-line:pin-a');
        // The active style is the rendered style: no leftover imperative
        // magnification, and every channel comes from props.
        expect(readStyleNumber(activeLine?.props.style, 'width')).toBe(3);
        expect(readStyleNumber(activeLine?.props.style, 'opacity')).toBeGreaterThanOrEqual(0.9);
        expect(screen.findByTestId('transcript-navigation-rail.marker:pin-a')?.props.accessibilityState?.selected)
            .toBe(true);
    });

    it('eases marker motion through a CSS transition whose duration collapses under reduced motion', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');

        const eased = await renderScreen(<TranscriptNavigationRail {...baseProps()} />);
        expect(flattenStyle(
            eased.findByTestId('transcript-navigation-rail.marker-line:pin-a')?.props.style,
        ).transitionDuration).toBe('160ms');

        const instant = await renderScreen(<TranscriptNavigationRail {...baseProps()} reducedMotion />);
        expect(flattenStyle(
            instant.findByTestId('transcript-navigation-rail.marker-line:pin-a')?.props.style,
        ).transitionDuration).toBe('0ms');
    });

    it('renders a bold one-line title over the multi-line message text on a glass surface', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');

        const screen = await renderScreen(<TranscriptNavigationRail {...baseProps()} />);
        const marker = screen.findByTestId('transcript-navigation-rail.marker:turn-1');

        await act(async () => {
            marker?.props.onPointerEnter?.({ nativeEvent: { pointerType: 'mouse' } });
        });

        // Short bold title line: the turn's prompt, clamped to one line.
        const title = screen.findByTestId('transcript-navigation-rail.preview.title');
        expect(title?.props.numberOfLines).toBe(1);
        expect(screen.getTextContent()).toContain('First prompt preview');

        // Below it, the actual message text in regular weight, clamped to a few lines.
        const body = screen.findByTestId('transcript-navigation-rail.preview.body');
        expect(body).toBeTruthy();
        expect(body?.props.numberOfLines).toBeGreaterThanOrEqual(2);
        expect(body?.props.numberOfLines).toBeLessThanOrEqual(3);
        expect(screen.getTextContent()).toContain('First response preview');
        const bodyStyle = flattenStyle(body?.props.style);
        expect(bodyStyle.fontWeight === undefined || bodyStyle.fontWeight === '400' || bodyStyle.fontWeight === 'normal').toBe(true);

        // Rendered on the canonical glass material, not an opaque block.
        const glass = screen.findByTestId('transcript-navigation-rail.preview.glass');
        expect(glass).toBeTruthy();
        const glassStyle = flattenStyle(glass?.props.style);
        expect(glassStyle.backdropFilter ?? glassStyle.WebkitBackdropFilter).toContain('blur');
    });

    it('omits the message-text row when the entry has no secondary text', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');

        const screen = await renderScreen(<TranscriptNavigationRail {...baseProps()} />);
        const marker = screen.findByTestId('transcript-navigation-rail.marker:turn-2');

        await act(async () => {
            marker?.props.onPointerEnter?.({ nativeEvent: { pointerType: 'mouse' } });
        });

        expect(screen.findByTestId('transcript-navigation-rail.preview.title')).toBeTruthy();
        expect(screen.findByTestId('transcript-navigation-rail.preview.body')).toBeNull();
    });

    it('fades the preview out on dismissal before unmounting it', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');

        const screen = await renderScreen(<TranscriptNavigationRail {...baseProps()} />);
        const marker = screen.findByTestId('transcript-navigation-rail.marker:pin-a');

        await act(async () => {
            marker?.props.onPointerEnter?.({ nativeEvent: { pointerType: 'mouse' } });
        });
        expect(flattenStyle(
            screen.findByTestId('transcript-navigation-rail.preview.glass')?.props.style,
        ).opacity).toBe(1);

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail')?.props.onKeyDown?.({ key: 'Escape', preventDefault: vi.fn() });
        });

        // Soft exit: hidden and hover-inert immediately, unmounted after the fade window.
        const fading = screen.findByTestId('transcript-navigation-rail.preview');
        expect(fading).toBeTruthy();
        expect(flattenStyle(fading?.props.style).pointerEvents).toBe('none');
        expect(flattenStyle(
            screen.findByTestId('transcript-navigation-rail.preview.glass')?.props.style,
        ).opacity).toBe(0);

        await waitForSoftExit();
        expect(screen.findByTestId('transcript-navigation-rail.preview')).toBeNull();
    });

    it('dismisses pointer-triggered preview with Escape from the rail container', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');

        const screen = await renderScreen(<TranscriptNavigationRail {...baseProps()} />);
        const rail = screen.findByTestId('transcript-navigation-rail');
        const marker = screen.findByTestId('transcript-navigation-rail.marker:pin-a');

        await act(async () => {
            marker?.props.onPointerEnter?.({ nativeEvent: { pointerType: 'mouse' } });
        });
        expect(screen.findByTestId('transcript-navigation-rail.preview')).toBeTruthy();

        await act(async () => {
            rail?.props.onKeyDown?.({ key: 'Escape', preventDefault: vi.fn() });
        });

        await waitForSoftExit();
        expect(screen.findByTestId('transcript-navigation-rail.preview')).toBeNull();
    });

    it('keeps the hover preview open while hovered and dismisses after leaving rail and preview', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');

        const screen = await renderScreen(<TranscriptNavigationRail {...baseProps()} />);
        const rail = screen.findByTestId('transcript-navigation-rail');
        const marker = screen.findByTestId('transcript-navigation-rail.marker:pin-a');

        await act(async () => {
            marker?.props.onPointerEnter?.({ nativeEvent: { pointerType: 'mouse' } });
        });
        const preview = screen.findByTestId('transcript-navigation-rail.preview');
        expect(preview).toBeTruthy();

        await act(async () => {
            preview?.props.onPointerEnter?.({ nativeEvent: { pointerType: 'mouse' } });
            rail?.props.onPointerLeave?.({ nativeEvent: { pointerType: 'mouse' } });
        });
        expect(screen.findByTestId('transcript-navigation-rail.preview')).toBeTruthy();

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail.preview')?.props.onPointerLeave?.({
                nativeEvent: { pointerType: 'mouse' },
            });
        });

        await waitForSoftExit();
        expect(screen.findByTestId('transcript-navigation-rail.preview')).toBeNull();
    });

    it('updates long-rail fades and preview placement from internal scroll offset', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');
        const longEntries = buildEntries(120);

        const screen = await renderScreen(
            <TranscriptNavigationRail
                {...baseProps()}
                entries={longEntries}
                paneHeightPx={240}
            />,
        );
        expect(screen.findByTestId('transcript-navigation-rail.edge.top')).toBeNull();
        expect(screen.findByTestId('transcript-navigation-rail.edge.bottom')).toBeTruthy();

        // A marker the 192 px rail viewport shows: off-viewport markers are not mounted to hover.
        const marker = screen.findByTestId('transcript-navigation-rail.marker:turn-12');
        await act(async () => {
            marker?.props.onPointerEnter?.({ nativeEvent: { pointerType: 'mouse' } });
        });
        const topBeforeScroll = readStyleNumber(
            screen.findByTestId('transcript-navigation-rail.preview')?.props.style,
            'top',
        );

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail.scroll')?.props.onScroll?.({
                nativeEvent: { contentOffset: { y: 300 } },
            });
        });

        const topAfterScroll = readStyleNumber(
            screen.findByTestId('transcript-navigation-rail.preview')?.props.style,
            'top',
        );
        const topFade = screen.findByTestId('transcript-navigation-rail.edge.top');
        expect(topFade).toBeTruthy();
        // Overflow fades are real gradients, not solid overlay blocks.
        expect(topFade?.findAll((node) => String(node.type) === 'LinearGradient').length).toBeGreaterThan(0);
        expect(topAfterScroll).toBeLessThan(topBeforeScroll);

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail.scroll')?.props.onScroll?.({
                nativeEvent: { contentOffset: { y: 2000 } },
            });
        });

        expect(screen.findByTestId('transcript-navigation-rail.edge.bottom')).toBeNull();
    });

    // Issue #864: every session switch remounts the rail, and it mounted one marker per turn of
    // loaded history (80 markers / 640 fibers on a 750-message fixture switch, live 2026-11-05).
    // Only the markers the rail viewport can reach are mounted; the active one stays addressable.
    it('mounts only the markers within reach of the rail viewport and follows the rail scroll', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');
        const longEntries = buildEntries(400);
        seedVisibility({ currentAnchorId: 'turn-1', visibleAnchorIds: ['turn-1'] });
        const screen = await renderScreen(
            <TranscriptNavigationRail {...baseProps()} entries={longEntries} paneHeightPx={800} />,
        );
        const markerIds = () => screen
            .findAll((node) => typeof node.type === 'string'
                && /^transcript-navigation-rail\.marker:/.test(String(node.props?.testID ?? '')))
            .map((node) => String(node.props.testID));
        const mountedAtTop = new Set(markerIds());
        // A 640 px rail viewport at a 12 px pitch shows ~54 markers. Half a viewport of overscan
        // each side (one side at the top) bounds the mounted set well below the 400 entries.
        expect(mountedAtTop.size).toBeGreaterThanOrEqual(54);
        expect(mountedAtTop.size).toBeLessThanOrEqual(81);
        expect(mountedAtTop.has('transcript-navigation-rail.marker:turn-1')).toBe(true);
        expect(mountedAtTop.has('transcript-navigation-rail.marker:turn-300')).toBe(false);

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail.scroll')?.props.onScroll?.({
                nativeEvent: { contentOffset: { y: 3_588 } },
            });
        });
        const mountedAfterScroll = new Set(markerIds());
        expect(mountedAfterScroll.has('transcript-navigation-rail.marker:turn-300')).toBe(true);
        // 107 in the window plus the active marker kept mounted above it.
        expect(mountedAfterScroll.size).toBeLessThanOrEqual(108);
        // The active descendant is referenced by id, so it stays mounted off-window.
        const tabstop = screen.findByTestId('transcript-navigation-rail.roving-tabstop');
        const activeMarker = screen.findByTestId('transcript-navigation-rail.marker:turn-1');
        expect(activeMarker).toBeTruthy();
        expect(tabstop?.props['aria-activedescendant']).toBe(activeMarker?.props.id);
    });

    it('keeps mounted marker press handlers stable when entries append', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');
        const initialEntries = buildEntries(20);
        const onJump = vi.fn();
        const screen = await renderScreen(
            <TranscriptNavigationRail {...baseProps(onJump)} entries={initialEntries} />,
        );
        const before = screen.findByTestId('transcript-navigation-rail.marker:turn-3')?.props.onClick;
        await act(async () => {
            screen.tree.update(
                <TranscriptNavigationRail {...baseProps(onJump)} entries={buildEntries(21)} />,
            );
        });
        const marker = screen.findByTestId('transcript-navigation-rail.marker:turn-3');
        expect(marker?.props.onClick).toBe(before);
        await act(async () => {
            marker?.props.onClick?.();
        });
        expect(onJump).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'turn-3' }),
            expect.objectContaining({ source: 'rail' }),
        );
    });

    it('fades the rail out softly when it drops below the width threshold', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');

        const screen = await renderScreen(<TranscriptNavigationRail {...baseProps()} />);
        expect(screen.findByTestId('transcript-navigation-rail')).toBeTruthy();

        await act(async () => {
            screen.update(<TranscriptNavigationRail {...baseProps()} paneWidthPx={700} />);
        });

        // Soft exit: still mounted for the fade, hidden and pointer-inert.
        // (Unmount after the fade window is covered by the presence hook's
        // fake-timer unit tests.)
        const fadingRail = screen.findByTestId('transcript-navigation-rail');
        expect(fadingRail).toBeTruthy();
        const fadingStyle = flattenStyle(fadingRail?.props.style);
        expect(fadingStyle.opacity).toBe(0);
        expect(fadingStyle.pointerEvents).toBe('none');
    });

    it('hides the rail instantly on threshold crossings under reduced motion', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');

        const screen = await renderScreen(<TranscriptNavigationRail {...baseProps()} reducedMotion />);
        expect(screen.findByTestId('transcript-navigation-rail')).toBeTruthy();

        await act(async () => {
            screen.update(<TranscriptNavigationRail {...baseProps()} paneWidthPx={700} reducedMotion />);
        });

        expect(screen.findByTestId('transcript-navigation-rail')).toBeNull();
    });

    it('disables width morphing but keeps instant opacity emphasis under reduced motion', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');

        const screen = await renderScreen(<TranscriptNavigationRail {...baseProps()} reducedMotion />);
        const marker = screen.findByTestId('transcript-navigation-rail.marker:pin-a');

        await act(async () => {
            marker?.props.onPointerEnter?.({ nativeEvent: { pointerType: 'mouse' } });
        });

        const focusedLine = screen.findByTestId('transcript-navigation-rail.marker-line:pin-a');
        expect(readStyleNumber(focusedLine?.props.style, 'width')).toBe(3);
        expect(readStyleNumber(focusedLine?.props.style, 'opacity')).toBeGreaterThanOrEqual(0.7);
    });

    it('dismisses a hover preview with Escape at the document level without rail keyboard focus', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');
        const listeners = new Map<string, (event: unknown) => void>();
        const documentStub = {
            addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
                listeners.set(type, listener);
            }),
            removeEventListener: vi.fn((type: string) => {
                listeners.delete(type);
            }),
        };
        const hadDocument = 'document' in globalThis;
        const previousDocument = (globalThis as { document?: unknown }).document;
        (globalThis as { document?: unknown }).document = documentStub;

        try {
            const screen = await renderScreen(<TranscriptNavigationRail {...baseProps()} />);
            const marker = screen.findByTestId('transcript-navigation-rail.marker:pin-a');

            await act(async () => {
                marker?.props.onPointerEnter?.({ nativeEvent: { pointerType: 'mouse' } });
            });
            expect(screen.findByTestId('transcript-navigation-rail.preview')).toBeTruthy();
            const keydown = listeners.get('keydown');
            expect(keydown).toBeTruthy();

            await act(async () => {
                keydown?.({ key: 'Escape' });
            });
            await waitForSoftExit();
            expect(screen.findByTestId('transcript-navigation-rail.preview')).toBeNull();
        } finally {
            if (hadDocument) {
                (globalThis as { document?: unknown }).document = previousDocument;
            } else {
                delete (globalThis as { document?: unknown }).document;
            }
        }
    });

    it('clamps the hover preview inside the pane using its measured height', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');
        const longEntries = buildEntries(120);

        const screen = await renderScreen(
            <TranscriptNavigationRail
                {...baseProps()}
                entries={longEntries}
                paneHeightPx={240}
            />,
        );

        // The last marker the 192 px rail viewport shows at rest.
        const marker = screen.findByTestId('transcript-navigation-rail.marker:turn-16');
        await act(async () => {
            marker?.props.onPointerEnter?.({ nativeEvent: { pointerType: 'mouse' } });
        });

        const topBeforeMeasure = readStyleNumber(
            screen.findByTestId('transcript-navigation-rail.preview')?.props.style,
            'top',
        );

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail.preview')?.props.onLayout?.({
                nativeEvent: { layout: { height: 120, width: 220 } },
            });
        });

        const topAfterMeasure = readStyleNumber(
            screen.findByTestId('transcript-navigation-rail.preview')?.props.style,
            'top',
        );
        // Pane height 240 with a 24px viewport offset leaves at most
        // 240 - 24 - 120 - 8 = 88px for a 120px-tall preview.
        expect(topAfterMeasure).toBeLessThan(topBeforeMeasure);
        expect(topAfterMeasure).toBeLessThanOrEqual(88);
    });

    it('renders a quiet pinned marker distinction separate from the active state', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');

        const screen = await renderScreen(<TranscriptNavigationRail {...baseProps()} />);

        expect(screen.findByTestId('transcript-navigation-rail.marker-pin:pin-a')).toBeTruthy();
        expect(screen.findByTestId('transcript-navigation-rail.marker-pin:turn-1')).toBeNull();
    });
});
