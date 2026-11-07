import * as React from 'react';
import type { View } from 'react-native';

import { useSubmenuHoverIntent } from '@/components/ui/forms/dropdown/useSubmenuHoverIntent';

import type { AgentInputActionMenuAction } from '../actionMenuActions';
import type { AgentInputActionMenuSubmenu } from '../selection/agentInputActionMenuSubmenu';

/**
 * The composer's + menu opens a row's picker beside that row, as a submenu (calm-shell P3, lab
 * `cscomp:C2plus`). Every row records itself as the picker's anchor when it acts, so whatever it opens
 * hangs from it; a row that opens a picker (`opensPicker`) also opens on the shared hover intent and on
 * Right. The picker itself reads `AgentInputActionMenuSubmenuContext`.
 */
export function useAgentInputActionMenuSubmenu(
  params: Readonly<{
    actions: ReadonlyArray<AgentInputActionMenuAction>;
    /** The + menu is presented. */
    menuOpen: boolean;
    /** A picker opened from a row of this menu is open beside it. */
    submenuOpen: boolean;
    /** The anchor of a picker opened with `actionMenuRow`: set to the row that opened it. */
    rowAnchorRef: React.RefObject<View | null>;
    /** Close the picker and keep the + menu open. */
    returnToMenu: () => void;
  }>,
): Readonly<{
  actions: ReadonlyArray<AgentInputActionMenuAction>;
  /** The same rows without hover intent, for a menu presented as a sheet (rows open by press only). */
  pressActions: ReadonlyArray<AgentInputActionMenuAction>;
  /** The pointer left the + menu's surface. */
  onMenuPointerLeave: (event: unknown) => void;
  submenu: AgentInputActionMenuSubmenu;
}> {
  const { rowAnchorRef } = params;
  const rowElementsRef = React.useRef(new Map<string, View>());
  const openRowIdRef = React.useRef<string | null>(null);
  const [openRowTitle, setOpenRowTitle] = React.useState<string | undefined>(undefined);
  const hover = useSubmenuHoverIntent({
    activeItemId: params.submenuOpen ? openRowIdRef.current : null,
    enabled: params.menuOpen,
    closeSubmenu: params.returnToMenu,
  });

  const actions = React.useMemo(
    () =>
      params.actions.map((action): AgentInputActionMenuAction => {
        const activate = () => {
          rowAnchorRef.current = rowElementsRef.current.get(action.id) ?? null;
          openRowIdRef.current = action.opensPicker ? action.id : null;
          setOpenRowTitle(action.label);
          action.onPress?.();
        };
        const opensPicker =
          action.opensPicker === true &&
          action.disabled !== true &&
          action.onPress !== undefined;
        return {
          ...action,
          rowRef: (element: View | null) => {
            if (element) rowElementsRef.current.set(action.id, element);
            else rowElementsRef.current.delete(action.id);
          },
          ...(action.onPress ? { onPress: activate } : {}),
          onHover: () =>
            hover.hoverItem(action.id, opensPicker ? activate : null),
          ...(opensPicker
            ? {
                onKeyDown: (event: unknown) => {
                  const keyEvent = event as {
                    nativeEvent?: { key?: unknown };
                    key?: unknown;
                    preventDefault?: () => void;
                  };
                  if (
                    (keyEvent.nativeEvent?.key ?? keyEvent.key) !== 'ArrowRight'
                  )
                    return;
                  keyEvent.preventDefault?.();
                  activate();
                },
              }
            : {}),
        };
      }),
    [hover, params.actions, rowAnchorRef],
  );

  const submenu = React.useMemo<AgentInputActionMenuSubmenu>(
    () => ({
      title: openRowTitle,
      returnToMenu: params.returnToMenu,
      onSurfacePointerChange: hover.surfacePointerChange,
    }),
    [hover.surfacePointerChange, openRowTitle, params.returnToMenu],
  );

  const pressActions = React.useMemo(
    () => actions.map((row): AgentInputActionMenuAction => ({ ...row, onHover: undefined })),
    [actions],
  );

  return { actions, pressActions, onMenuPointerLeave: hover.scheduleClose, submenu };
}
