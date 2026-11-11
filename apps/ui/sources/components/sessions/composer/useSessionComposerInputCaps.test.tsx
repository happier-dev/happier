import * as React from 'react';
import type { SharedValue } from 'react-native-reanimated';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
  ComposerKeyboardProvider,
  type ComposerKeyboardLayout,
} from '@/components/sessions/keyboardAvoidance/ComposerKeyboardContext';

import { useSessionComposerInputCaps } from './useSessionComposerInputCaps';

afterEach(() => standardCleanup());

/** A keyboard scaffold's published room, as the native layout owner publishes it (Reanimated values are a boundary). */
function scaffoldLayout(
  room: Readonly<{ availablePanelHeight: number; keyboardHeight: number }>,
): ComposerKeyboardLayout {
  const shared = (value: number) =>
    ({ value }) as unknown as SharedValue<number>;
  return {
    availablePanelHeight: shared(room.availablePanelHeight),
    bottomInset: shared(0),
    composerHeight: shared(0),
    isKeyboardLiftSuppressed: {
      value: false,
    } as unknown as SharedValue<boolean>,
    keyboardHeightForInset: shared(room.keyboardHeight),
    keyboardHeightLive: shared(room.keyboardHeight),
    keyboardProgress: shared(1),
    listBottomInset: shared(0),
    getKeyboardHeight: () => room.keyboardHeight,
    setComposerMeasuredHeight: () => {},
    subscribeAvailablePanelHeight: (listener) => {
      listener(room.availablePanelHeight);
      return () => {};
    },
    subscribeKeyboardHeight: (listener) => {
      listener(room.keyboardHeight);
      return () => {};
    },
  };
}

type Caps = ReturnType<typeof useSessionComposerInputCaps>;
const expansion = { expanded: false, setExpanded: () => {} };

function Probe(props: Readonly<{ cardsContentHeight: number; textlessHeight: number; onCaps: (caps: Caps) => void }>) {
    props.onCaps(useSessionComposerInputCaps({
        cardsContentHeight: props.cardsContentHeight,
        textlessHeight: props.textlessHeight,
        expansion,
    }));
    return null;
}

/** An 844 pt phone with the keyboard up: the scaffold leaves 361 pt below the Session header and page tabs. */
const PHONE_KEYBOARD_UP = { availablePanelHeight: 361, keyboardHeight: 336 };
/** The composer without its text lines (status row, chips, paddings), as AgentInput measures it. */
const TEXTLESS = 110;
/** Two lines of the composer's 22 pt text. */
const TWO_LINES = 44;

async function capsFor(cardsContentHeight: number): Promise<Caps> {
    let caps: Caps | null = null;
    await renderScreen(
        <ComposerKeyboardProvider layout={scaffoldLayout(PHONE_KEYBOARD_UP)}>
            <Probe cardsContentHeight={cardsContentHeight} textlessHeight={TEXTLESS} onCaps={(next) => { caps = next; }} />
        </ComposerKeyboardProvider>,
    );
    return caps!;
}

describe('the Session composer column (owner 2026-11-11)', () => {
    it('keeps the input its controls plus two lines under a ~270 pt card stack, and gives the stack the rest to scroll', async () => {
        const caps = await capsFor(270);
        // The input never goes below its floor.
        expect(caps.maxPanelHeight).toBe(TEXTLESS + TWO_LINES);
        // The cards get what the floor leaves, as a scrolling max height, so the column never passes the tabs.
        expect(caps.cardsMaxHeight).toBe(PHONE_KEYBOARD_UP.availablePanelHeight - (TEXTLESS + TWO_LINES));
        expect(caps.cardsMaxHeight + caps.maxPanelHeight!).toBeLessThanOrEqual(PHONE_KEYBOARD_UP.availablePanelHeight);
    });

    it('lets short cards stand whole and gives the input the rest', async () => {
        const caps = await capsFor(60);
        expect(caps.maxPanelHeight).toBe(PHONE_KEYBOARD_UP.availablePanelHeight - 60);
        expect(caps.cardsMaxHeight).toBeGreaterThanOrEqual(60);
    });
});
