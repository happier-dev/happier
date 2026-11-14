/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { AgentInputActionMenuAction } from '../actionMenuActions';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Viewport dimensions are the platform boundary; the real RNW, Popover, push host, + menu and its hover intent run below it.
vi.mock('react-native', async () => {
  const nativeWeb =
    await vi.importActual<typeof import('react-native-web')>(
      'react-native-web',
    );
  return {
    ...nativeWeb,
    useWindowDimensions: () => ({
      width: 390,
      height: 844,
      scale: 1,
      fontScale: 1,
    }),
  };
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

const { View, Text } = await import('react-native');
const { AgentInputSelectionPopover } =
  await import('./AgentInputSelectionPopover');
const { AgentInputActionMenuSubmenuContext } =
  await import('./agentInputActionMenuSubmenu');
const { AgentInputContentPopover } =
  await import('../components/AgentInputContentPopover');
const { AgentInputActionMenuPopoverContent } =
  await import('../components/AgentInputActionMenuPopoverContent');
const { useAgentInputActionMenuSubmenu } =
  await import('../components/useAgentInputActionMenuSubmenu');

// PATTERNS-1110 (web 390): a + menu row's picker (Session Goal, Run a pattern) did nothing when tapped. On a phone
// the + menu is a panel and the row's picker pushes inside it, hiding the menu; the menu's hover intent then read
// the pointer leaving the hidden menu as leaving for good and closed the picker. A menu that pushes its submenus
// has no hover intent, as the shared dropdown's does not.
it('keeps a + menu row picker pushed inside the phone menu when the pointer leaves the hidden menu', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  function Harness() {
    const menuAnchor = React.useRef<React.ComponentRef<typeof View>>(null);
    const rowAnchorRef = React.useRef<React.ComponentRef<typeof View> | null>(
      null,
    );
    const [pickerOpen, setPickerOpen] = React.useState(false);
    const actions = React.useMemo(
      (): readonly AgentInputActionMenuAction[] => [
        {
          id: 'goal',
          section: 'controls',
          testID: 'goal-row',
          label: 'Goal',
          opensPicker: true,
          onPress: () => setPickerOpen(true),
        },
      ],
      [],
    );
    const menu = useAgentInputActionMenuSubmenu({
      actions,
      menuOpen: true,
      submenuOpen: pickerOpen,
      rowAnchorRef,
      returnToMenu: () => setPickerOpen(false),
    });
    return (
      <>
        <View ref={menuAnchor}>
          <Text>+</Text>
        </View>
        <AgentInputContentPopover
          open
          anchorRef={menuAnchor}
          onRequestClose={() => {}}
          content={(args) => (
            <AgentInputActionMenuPopoverContent
                    // The composer's wiring (AgentInputOverlayLayer): a menu that pushes opens its rows by press only.
                    actionMenuActions={args.pushesSubmenus ? menu.pressActions : menu.actions}
                    onPointerLeave={args.pushesSubmenus ? undefined : menu.onMenuPointerLeave}
                >
              {pickerOpen ? (
                <AgentInputActionMenuSubmenuContext.Provider
                  value={menu.submenu}
                >
                  <AgentInputSelectionPopover
                    open
                    anchorRef={rowAnchorRef}
                    onRequestClose={() => setPickerOpen(false)}
                  >
                    {() => <Text testID="goal-picker">Set goal</Text>}
                  </AgentInputSelectionPopover>
                </AgentInputActionMenuSubmenuContext.Provider>
              ) : null}
            </AgentInputActionMenuPopoverContent>
          )}
        />
      </>
    );
  }
  const pushedPicker = () =>
    document.querySelector(
      '[data-testid="popover-push.view"] [data-testid="goal-picker"]',
    );
  try {
    await act(async () => root.render(<Harness />));
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="goal-row"]')).not.toBeNull(),
    );
    await act(async () => {
      (
        document.querySelector('[data-testid="goal-row"]') as HTMLElement
      ).click();
    });
    await vi.waitFor(() => expect(pushedPicker()).not.toBeNull());
    // The menu is hidden under the pushed view: the mouse now reads as outside it.
    const menu = document.querySelector(
      '[data-testid="agent-input-action-menu-overlay"]',
    )!;
    await act(async () => {
      menu.dispatchEvent(
        new MouseEvent('pointerout', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      menu.dispatchEvent(
        new MouseEvent('mouseout', {
          bubbles: true,
          relatedTarget: document.body,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    expect(pushedPicker()).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
