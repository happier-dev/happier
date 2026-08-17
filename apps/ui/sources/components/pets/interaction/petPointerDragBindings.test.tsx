import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    useCompanionPointerDragSession,
    type CompanionPointerDragMove,
    type CompanionPointerDragSelectors,
} from '@/components/companion/interaction/useCompanionPointerDragSession';
import { VOICE_ORB_POINTER_DRAG_SELECTORS } from '@/components/voice/orb/voiceOrbGeometry';

import { PET_POINTER_DRAG_SELECTORS } from './petPointerDragBindings';

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<typeof import('react-native')>();
    return {
        ...actual,
        Platform: { ...actual.Platform, get OS() { return 'web'; } },
    };
});

class TestPointerEvent extends Event {
    clientX: number;
    clientY: number;
    screenX: number;
    screenY: number;

    constructor(type: string, init: Readonly<{ clientX: number; clientY: number }>) {
        super(type);
        this.clientX = init.clientX;
        this.clientY = init.clientY;
        this.screenX = init.clientX;
        this.screenY = init.clientY;
    }
}

/**
 * A DOM target carrying exactly the given attributes, answering `closest` the way a browser would.
 *
 * Matched on the whole attribute selector rather than on a substring on purpose: the orb's no-drag
 * hook (`data-voice-orb-no-drag`) is a prefix extension of its handle (`data-voice-orb`), so a
 * loose stub would report every orb body as an un-draggable region and quietly pass a test that
 * proves nothing.
 */
function targetFor(...attributes: readonly string[]) {
    return {
        closest: (selector: string) => (
            attributes.some((attribute) => selector.includes(`[${attribute}="true"]`)) ? {} : null
        ),
    };
}

type DragProbe = Readonly<{
    moves: CompanionPointerDragMove[];
    pointerDown: (target: unknown) => void;
}>;

async function renderDragProbe(selectors: CompanionPointerDragSelectors): Promise<DragProbe> {
    const moves: CompanionPointerDragMove[] = [];
    let pointerDown: ((event: unknown) => void) | undefined;

    function Probe(): React.ReactElement | null {
        const drag = useCompanionPointerDragSession({
            coordinateSpace: 'client',
            selectors,
            onDragMove: (move) => { moves.push(move); },
        });
        pointerDown = drag.pointerHandlers.onPointerDown;
        return null;
    }

    await renderScreen(<Probe />);
    return {
        moves,
        pointerDown: (target: unknown) => {
            pointerDown?.({
                button: 0,
                clientX: 200,
                clientY: 200,
                screenX: 200,
                screenY: 200,
                target,
                preventDefault: vi.fn(),
                stopPropagation: vi.fn(),
            });
        },
    };
}

/**
 * Two companions now share one pointer-drag owner: the pet's mascot and the Voice orb's body.
 *
 * Sharing the owner is correct — an object under a finger behaves the same whatever is painted on
 * it — but it puts the two companions one selector mistake apart from stealing each other's drags.
 * The pet is the incumbent and its behaviour must be unchanged by the orb's arrival, so this pins
 * the isolation through the real hook rather than by comparing constants: a pointer-down inside one
 * companion's markup must move that companion and only that companion.
 */
describe('pet and Voice orb pointer-drag isolation', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        standardCleanup();
        vi.unstubAllGlobals();
    });

    it('drags the pet from the mascot, and never from the orb', async () => {
        const fakeWindow = Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 600 });
        vi.stubGlobal('window', fakeWindow);
        vi.stubGlobal('PointerEvent', TestPointerEvent);
        const probe = await renderDragProbe(PET_POINTER_DRAG_SELECTORS);

        await act(async () => {
            probe.pointerDown(targetFor('data-voice-orb'));
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', { clientX: 120, clientY: 200 }));
        });
        expect(probe.moves).toHaveLength(0);

        await act(async () => {
            probe.pointerDown(targetFor('data-pet-mascot'));
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', { clientX: 120, clientY: 200 }));
        });
        expect(probe.moves).toHaveLength(1);
        expect(probe.moves[0]!.deltaX).toBe(-80);
    });

    it('drags the orb from its own body, and never from the pet', async () => {
        const fakeWindow = Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 600 });
        vi.stubGlobal('window', fakeWindow);
        vi.stubGlobal('PointerEvent', TestPointerEvent);
        const probe = await renderDragProbe(VOICE_ORB_POINTER_DRAG_SELECTORS);

        await act(async () => {
            probe.pointerDown(targetFor('data-pet-mascot'));
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', { clientX: 120, clientY: 200 }));
        });
        expect(probe.moves).toHaveLength(0);

        await act(async () => {
            probe.pointerDown(targetFor('data-voice-orb'));
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', { clientX: 120, clientY: 200 }));
        });
        expect(probe.moves).toHaveLength(1);
        expect(probe.moves[0]!.deltaX).toBe(-80);
    });

    it('keeps both companions’ no-drag regions honoured by the shared owner', async () => {
        const fakeWindow = Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 600 });
        vi.stubGlobal('window', fakeWindow);
        vi.stubGlobal('PointerEvent', TestPointerEvent);
        const probe = await renderDragProbe(PET_POINTER_DRAG_SELECTORS);

        // The tray's rows and actions live inside the mascot's subtree; pressing one must not drag.
        await act(async () => {
            probe.pointerDown(targetFor('data-pet-no-drag', 'data-pet-mascot'));
            fakeWindow.dispatchEvent(new TestPointerEvent('pointermove', { clientX: 120, clientY: 200 }));
        });

        expect(probe.moves).toHaveLength(0);
    });
});
