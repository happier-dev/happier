/**
 * @vitest-environment jsdom
 */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => await vi.importActual('react-native-web'));

import { useInlineLevelFocusReturn } from './focusReturn';

// A form level that pushes a child in place of itself (the recipe's folder browser): the opener unmounts
// while the child is shown and is a new element when the form comes back.
function PushedLevel() {
  const [open, setOpen] = React.useState(false);
  const { attachOrigin, attachEntry } = useInlineLevelFocusReturn(open);
  if (open)
    return (
      <button data-testid="back" ref={attachEntry} onClick={() => setOpen(false)}>
        Back
      </button>
    );
  return (
    <>
      <button data-testid="other">Agent</button>
      <button
        data-testid="opener"
        ref={attachOrigin}
        onClick={() => setOpen(true)}
      >
        Working directory
      </button>
    </>
  );
}

// A host that keeps its opener mounted and reaches the level through a Promise port (the participant picker):
// the press records the focused control.
function PortLevel() {
  const [open, setOpen] = React.useState(false);
  const { originRef } = useInlineLevelFocusReturn(open);
  return (
    <>
      <button
        data-testid="browse"
        onClick={() => {
          originRef.current = document.activeElement as HTMLElement;
          setOpen(true);
        }}
      >
        Browse
      </button>
      {open ? (
        <button data-testid="back" onClick={() => setOpen(false)}>
          Back
        </button>
      ) : null}
    </>
  );
}

async function run(Level: () => React.ReactElement, opener: string, onOpened?: (focused: string) => void) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Level />));
    const press = async (testId: string) => {
      const el = host.querySelector<HTMLButtonElement>(
        `[data-testid="${testId}"]`,
      )!;
      el.focus();
      await act(async () => el.click());
    };
    await press(opener);
    onOpened?.((document.activeElement as HTMLElement | null)?.getAttribute('data-testid') ?? 'BODY');
    await press('back');
    return (
      (document.activeElement as HTMLElement | null)?.getAttribute(
        'data-testid',
      ) ?? 'BODY'
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}

describe('useInlineLevelFocusReturn', () => {
  // F-U5-UI live: Back from the recipe's folder browser left focus on BODY, so a keyboard or screen-reader
  // user lost their place in the sheet.
  it('returns focus to the remounted opener when a level that replaced it closes', async () => {
    expect(await run(PushedLevel, 'opener')).toBe('opener');
  });

  // F-JOURNEY-UI live: pushing the participant picker or the folder browser left focus on BODY until Back.
  it('moves focus into the pushed level when its opener unmounts', async () => {
    let opened = '';
    await run(PushedLevel, 'opener', (focused) => { opened = focused; });
    expect(opened).toBe('back');
  });

  it('returns focus to a kept-mounted opener recorded from the press', async () => {
    expect(await run(PortLevel, 'browse')).toBe('browse');
  });
});
