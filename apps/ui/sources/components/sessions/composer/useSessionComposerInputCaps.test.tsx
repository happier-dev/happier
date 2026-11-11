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

function Probe(
  props: Readonly<{ reservedHeight: number; onCaps: (caps: Caps) => void }>,
) {
  props.onCaps(
    useSessionComposerInputCaps({
      reservedHeight: props.reservedHeight,
      expansion,
    }),
  );
  return null;
}

describe('the Session composer caps', () => {
  it('take the room of the keyboard scaffold the composer is rendered inside, less the cards above the input (native 2026-11-11)', async () => {
    let caps: Caps | null = null;
    await renderScreen(
      <ComposerKeyboardProvider
        layout={scaffoldLayout({
          availablePanelHeight: 360,
          keyboardHeight: 336,
        })}
      >
        <Probe
          reservedHeight={200}
          onCaps={(next) => {
            caps = next;
          }}
        />
      </ComposerKeyboardProvider>,
    );
    // The scaffold leaves 360 above the keyboard; a 200 card stack leaves the panel 160, never the window.
    expect(caps!.maxPanelHeight).toBe(160);
    expect(caps!.inputMaxHeight).toBeLessThanOrEqual(160);
    expect(caps!.inputExpansion.collapsedMaxHeight).toBeLessThanOrEqual(160);
  });
});
