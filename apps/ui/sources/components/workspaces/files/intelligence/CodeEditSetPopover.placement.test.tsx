import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
  findHostNodesByTestId,
  flattenTestStyle,
  reportPopoverContentLayout,
  withPopoverWebGlobals,
} from '@/dev/testkit/harness/popoverHarness';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installPopoverCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeNativeMock } =
      await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock(
      { platformOS: 'ios' },
      { useWindowDimensions: () => ({ width: 1000, height: 800 }) },
    );
  },
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

// Only the remote Machine is scripted.
const machine = vi.hoisted(() => ({ preview: vi.fn(), apply: vi.fn() }));
vi.mock('@/sync/ops/machineLanguageIntelligence', () => ({
  machineLanguageIntelligencePreviewAction: machine.preview,
  machineLanguageIntelligenceApplyAction: machine.apply,
}));

const { CodeEditSetPopover } = await import('./CodeEditSetPopover');
const { OverlayPortalProvider, OverlayPortalHost } =
  await import('@/components/ui/popover/OverlayPortal');
const { PopoverPortalTargetContextProvider } =
  await import('@/components/ui/popover/PopoverPortalTarget');

const WINDOW = { width: 1000, height: 800 };
// The File page region the card is mounted in: a column beside a 280 px rail, below a 48 px header.
const PAGE = { x: 280, y: 48, width: 720, height: 700 };

let restorePopoverGlobals: (() => void) | undefined;
beforeEach(() => {
  restorePopoverGlobals = withPopoverWebGlobals();
  machine.preview.mockReset();
});
afterEach(async () => {
  await standardCleanup();
  restorePopoverGlobals?.();
});

/** Test Renderer has no layout: the File page region (and anything inside it) reports PAGE's box. */
function createNodeMock(
  element: Readonly<{ type: unknown; props: Record<string, unknown> }>,
) {
  if (element.type !== 'View') return null;
  const style = flattenTestStyle(element.props.style);
  // The page region's box and the seat inside it (the only views here that overlay without content).
  if (style.pointerEvents !== 'none' && style.height !== 8) return null;
  const height = typeof style.height === 'number' ? style.height : PAGE.height;
  const top = typeof style.top === 'number' ? PAGE.y + style.top : PAGE.y;
  return {
    measureInWindow: (
      done: (x: number, y: number, w: number, h: number) => void,
    ) => done(PAGE.x, top, PAGE.width, height),
  };
}

async function openFromCommand(stageSetup: 'unsaved' | 'refused') {
  machine.preview.mockResolvedValue({
    status: 'error',
    errorCode: 'file_changed',
  });
  const screen = await renderScreen(
    <PopoverPortalTargetContextProvider
      value={{
        rootRef: {
          current: {
            measureInWindow: (cb: any) => cb(0, 0, WINDOW.width, WINDOW.height),
            measure: (cb: any) => cb(0, 0, WINDOW.width, WINDOW.height, 0, 0),
          } as any,
        },
        layout: WINDOW,
      }}
    >
      <OverlayPortalProvider>
        <CodeEditSetPopover
          // Format from the File menu or its key: a command, so no name on the page anchors it.
          request={{
            op: 'format',
            anchor: null,
            line: 0,
            character: 0,
            symbol: '',
          }}
          scope={{ serverId: 's', machineId: 'm1', rootPath: '/repo' }}
          accountId="a"
          filePath="src/a.ts"
          languageId="typescript"
          readText={() => 'const a = 1;'}
          isUnsaved={() => stageSetup === 'unsaved'}
          save={async () => false}
          syncDocument={async () => null}
          sourceLabel={null}
          onRequestClose={() => {}}
        />
        <OverlayPortalHost />
      </OverlayPortalProvider>
    </PopoverPortalTargetContextProvider>,
    { createNodeMock },
  );
  await act(async () => {
    await flushHookEffects({ cycles: 1, turns: 8, frames: 1 });
  });
  await act(async () => {
    reportPopoverContentLayout(screen, { width: 420, height: 120 });
    await flushHookEffects({ cycles: 1, turns: 6, frames: 1 });
  });
  return screen;
}

function cardBox(screen: Awaited<ReturnType<typeof openFromCommand>>) {
  const [card] = findHostNodesByTestId(screen, 'code-edit-set-card');
  expect(card).toBeTruthy();
  // The nearest ancestor the Popover positioned.
  let node = card.parent;
  while (node && typeof flattenTestStyle(node.props?.style).left !== 'number') node = node.parent;
  if (!node) throw new Error('Expected a positioned Popover container');
  const style = flattenTestStyle(node.props.style);
  // The container carries a transparent gutter for the card's shadow; the card is inside it.
  return {
    left: Number(style.left) + Number(style.paddingLeft ?? 0),
    top: Number(style.top) + Number(style.paddingTop ?? 0),
    opacity: style.opacity,
  };
}

describe('Edit-set card opened by a command (Format, Organize imports): no name on the page anchors it', () => {
  it.each(['unsaved', 'refused'] as const)(
    'seats the %s card inside the File page region, not at the window origin',
    async (state) => {
      const screen = await openFromCommand(state);
      const card = cardBox(screen);
      expect(card.opacity).not.toBe(0);
      expect(card.left).toBeGreaterThanOrEqual(PAGE.x);
      expect(card.left + 420).toBeLessThanOrEqual(PAGE.x + PAGE.width);
      expect(card.top).toBeGreaterThanOrEqual(PAGE.y);
      expect(card.top + 120).toBeLessThanOrEqual(PAGE.y + PAGE.height);
      // Its stage controls are inside the card, which is inside the viewport.
      expect(
        findHostNodesByTestId(
          screen,
          state === 'unsaved' ? 'code-edit-set-unsaved' : 'code-edit-set-note',
        ),
      ).toHaveLength(1);
    },
  );
});
