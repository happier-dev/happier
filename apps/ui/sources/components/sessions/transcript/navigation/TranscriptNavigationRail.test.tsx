import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

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

function baseProps(onJump = vi.fn()) {
    return {
        currentAnchorId: 'turn-1',
        entries,
        onJumpToEntry: onJump,
        paneHeightPx: 800,
        paneWidthPx: 1000,
        platformOS: 'web' as const,
        transcriptContentWidthPx: 800,
        visibleAnchorIds: ['turn-1'],
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

    it('shows an accessible preview for the focused marker and ignores touch hover activation', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');

        const screen = await renderScreen(<TranscriptNavigationRail {...baseProps()} />);
        const marker = screen.findByTestId('transcript-navigation-rail.marker:pin-a');

        await act(async () => {
            marker?.props.onPointerEnter?.({ nativeEvent: { pointerType: 'touch' } });
        });
        expect(screen.findByTestId('transcript-navigation-rail.preview')).toBeNull();

        await act(async () => {
            marker?.props.onPointerEnter?.({ nativeEvent: { pointerType: 'mouse' } });
        });

        expect(screen.findByTestId('transcript-navigation-rail.preview')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Pinned answer preview');
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
                currentAnchorId="turn-1"
                entries={longEntries}
                paneHeightPx={240}
                visibleAnchorIds={['turn-1']}
            />,
        );
        expect(screen.findByTestId('transcript-navigation-rail.fade.top')).toBeNull();
        expect(screen.findByTestId('transcript-navigation-rail.fade.bottom')).toBeTruthy();

        const marker = screen.findByTestId('transcript-navigation-rail.marker:turn-31');
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
        const topFade = screen.findByTestId('transcript-navigation-rail.fade.top');
        expect(topFade).toBeTruthy();
        // Overflow fades are real gradients, not solid overlay blocks.
        expect(topFade?.findAll((node) => String(node.type) === 'LinearGradient').length).toBeGreaterThan(0);
        expect(topAfterScroll).toBeLessThan(topBeforeScroll);

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail.scroll')?.props.onScroll?.({
                nativeEvent: { contentOffset: { y: 2000 } },
            });
        });

        expect(screen.findByTestId('transcript-navigation-rail.fade.bottom')).toBeNull();
    });

    it('batches pointer motion through one animation frame for large rails', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');
        const previousRaf = globalThis.requestAnimationFrame;
        const previousCancelRaf = globalThis.cancelAnimationFrame;
        const frameCallbacks: FrameRequestCallback[] = [];
        const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
            frameCallbacks.push(callback);
            return frameCallbacks.length;
        });
        const cancelAnimationFrame = vi.fn();

        globalThis.requestAnimationFrame = requestAnimationFrame;
        globalThis.cancelAnimationFrame = cancelAnimationFrame;

        try {
            const screen = await renderScreen(
                <TranscriptNavigationRail
                    {...baseProps()}
                    entries={buildEntries(250)}
                    paneHeightPx={900}
                />,
            );

            await act(async () => {
                screen.findByTestId('transcript-navigation-rail.marker:turn-100')?.props.onPointerEnter?.({
                    nativeEvent: { pointerType: 'mouse' },
                });
                screen.findByTestId('transcript-navigation-rail.marker:turn-101')?.props.onPointerEnter?.({
                    nativeEvent: { pointerType: 'mouse' },
                });
            });

            expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
            await act(async () => {
                frameCallbacks[0]?.(16);
            });
        } finally {
            globalThis.requestAnimationFrame = previousRaf;
            globalThis.cancelAnimationFrame = previousCancelRaf;
        }
    });

    it('magnifies the focused marker through bounded React state when direct style writes are unavailable', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');

        // react-test-renderer host refs are null without createNodeMock, so the
        // direct write path is unavailable and the rail must fall back to
        // React-state-driven marker motion instead of silently no-oping.
        const screen = await renderScreen(<TranscriptNavigationRail {...baseProps()} />);
        const marker = screen.findByTestId('transcript-navigation-rail.marker:pin-a');

        await act(async () => {
            marker?.props.onPointerEnter?.({ nativeEvent: { pointerType: 'mouse' } });
        });

        const focusedLine = screen.findByTestId('transcript-navigation-rail.marker-line:pin-a');
        expect(readStyleNumber(focusedLine?.props.style, 'width')).toBe(16);
        expect(readStyleNumber(focusedLine?.props.style, 'opacity')).toBeGreaterThanOrEqual(0.7);

        // Neighbors taper instead of jumping to full focus width.
        const neighborLine = screen.findByTestId('transcript-navigation-rail.marker-line:turn-2');
        const neighborWidth = readStyleNumber(neighborLine?.props.style, 'width');
        expect(neighborWidth).toBeGreaterThan(3);
        expect(neighborWidth).toBeLessThan(16);

        await act(async () => {
            screen.findByTestId('transcript-navigation-rail')?.props.onKeyDown?.({ key: 'Escape', preventDefault: vi.fn() });
        });
        expect(readStyleNumber(
            screen.findByTestId('transcript-navigation-rail.marker-line:pin-a')?.props.style,
            'width',
        )).toBe(3);
    });

    it('drives marker motion through direct handle writes without re-rendering markers when handles support it', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');
        const nodeMocks = new Map<string, { style: Record<string, unknown> }>();

        const screen = await renderScreen(<TranscriptNavigationRail {...baseProps()} />, {
            createNodeMock: (element) => {
                const mock = { style: {} as Record<string, unknown> };
                const testID = (element.props as { testID?: unknown } | null)?.testID;
                if (typeof testID === 'string') nodeMocks.set(testID, mock);
                return mock;
            },
        });
        const marker = screen.findByTestId('transcript-navigation-rail.marker:pin-a');

        await act(async () => {
            marker?.props.onPointerEnter?.({ nativeEvent: { pointerType: 'mouse' } });
        });

        const focusedHandle = nodeMocks.get('transcript-navigation-rail.marker-line:pin-a');
        expect(focusedHandle?.style.width).toBe('16px');
        expect(Number(focusedHandle?.style.opacity)).toBeGreaterThanOrEqual(0.7);

        // The React render output keeps rest motion: styling came from the
        // direct handle write, not from re-rendering every marker.
        const focusedLine = screen.findByTestId('transcript-navigation-rail.marker-line:pin-a');
        expect(readStyleNumber(focusedLine?.props.style, 'width')).toBe(3);
    });

    it('glides marker magnification toward the target across frames instead of snapping', async () => {
        const { TranscriptNavigationRail } = await import('./TranscriptNavigationRail');
        const previousRaf = globalThis.requestAnimationFrame;
        const previousCancelRaf = globalThis.cancelAnimationFrame;
        const frameCallbacks: FrameRequestCallback[] = [];
        globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
            frameCallbacks.push(callback);
            return frameCallbacks.length;
        });
        globalThis.cancelAnimationFrame = vi.fn();
        const nodeMocks = new Map<string, { style: Record<string, unknown> }>();

        try {
            const screen = await renderScreen(<TranscriptNavigationRail {...baseProps()} />, {
                createNodeMock: (element) => {
                    const mock = { style: {} as Record<string, unknown> };
                    const testID = (element.props as { testID?: unknown } | null)?.testID;
                    if (typeof testID === 'string') nodeMocks.set(testID, mock);
                    return mock;
                },
            });

            await act(async () => {
                screen.findByTestId('transcript-navigation-rail.marker:pin-a')?.props.onPointerEnter?.({
                    nativeEvent: { pointerType: 'mouse' },
                });
            });

            const handle = nodeMocks.get('transcript-navigation-rail.marker-line:pin-a');
            const readWidth = () => Number.parseFloat(String(handle?.style.width ?? '0'));
            // Run one "frame tick": every callback queued so far (motion loop
            // plus any presence-frame flips), never callbacks queued by them.
            const runFrameTick = async (timestamp: number) => {
                const callbacks = frameCallbacks.splice(0, frameCallbacks.length);
                await act(async () => {
                    for (const callback of callbacks) callback(timestamp);
                });
            };

            await runFrameTick(16);
            const firstFrameWidth = readWidth();
            expect(firstFrameWidth).toBeGreaterThan(3);
            expect(firstFrameWidth).toBeLessThan(16);

            await runFrameTick(32);
            const secondFrameWidth = readWidth();
            expect(secondFrameWidth).toBeGreaterThan(firstFrameWidth);
            expect(secondFrameWidth).toBeLessThanOrEqual(16);

            // The loop keeps stepping until it settles exactly on the target,
            // then stops scheduling frames.
            let guard = 0;
            while (frameCallbacks.length > 0 && guard < 120) {
                await runFrameTick(48 + guard);
                guard += 1;
            }
            expect(guard).toBeLessThan(120);
            expect(readWidth()).toBe(16);
            expect(frameCallbacks).toHaveLength(0);
        } finally {
            globalThis.requestAnimationFrame = previousRaf;
            globalThis.cancelAnimationFrame = previousCancelRaf;
        }
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

        const marker = screen.findByTestId('transcript-navigation-rail.marker:turn-120');
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
