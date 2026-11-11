import * as React from 'react';
import { I18nManager } from 'react-native';
import {
  resolveHappierRovingSelection,
  resolveHappierRovingTabStop,
  type HappierFocusable,
} from '@happier-dev/plugin-ui/presentation';

import type { AgentInputChipPickerOption } from './AgentInputChipPickerTypes';

export type AgentInputChipPickerRovingFocus = Readonly<{
  tabIndexFor: (index: number) => -1 | 0;
  registerTarget: (index: number, target: HappierFocusable | null) => void;
  /** A `HappierPressable` `onKeyDown`: true when the key moved focus along the rail. */
  onKeyDown: (index: number, key: string) => boolean;
}>;

/**
 * The Agent rail's keyboard (the split rail and the stacked strip): one Tab stop, on the Agent the picker shows,
 * and the arrow keys, Home and End move focus along it. Moving focus shows nothing; Enter or Space presses the
 * focused option, through its own press. Key and tab-stop rules come from the shared roving owner; this binds them
 * to the rail's focus targets. Native has no keyboard path here, so its press behaviour is unchanged.
 */
export function useAgentInputChipPickerRovingFocus(
  params: Readonly<{
    options: ReadonlyArray<AgentInputChipPickerOption>;
    currentOptionId: string | null;
  }>,
): AgentInputChipPickerRovingFocus {
  const targets = React.useRef(new Map<number, HappierFocusable>());
  const entries = React.useMemo(
    () =>
      params.options.map((option) => ({ disabled: option.disabled === true })),
    [params.options],
  );
  const tabStopIndex = resolveHappierRovingTabStop({
    entries,
    selectedIndex: params.options.findIndex(
      (option) => option.id === params.currentOptionId,
    ),
  });
  const tabIndexFor = React.useCallback(
    (index: number) => (index === tabStopIndex ? 0 : -1),
    [tabStopIndex],
  );
  const registerTarget = React.useCallback(
    (index: number, target: HappierFocusable | null) => {
      if (target) targets.current.set(index, target);
      else targets.current.delete(index);
    },
    [],
  );
  const onKeyDown = React.useCallback(
    (index: number, key: string) => {
      // Enter and Space stay with the option's own press.
      if (key === 'Enter' || key === ' ' || key === 'Spacebar') return false;
      const next = resolveHappierRovingSelection({
        entries,
        currentIndex: index,
        key,
        rtl: I18nManager.isRTL,
      });
      if (next === null) return false;
      targets.current.get(next)?.focus();
      return true;
    },
    [entries],
  );
  return React.useMemo(
    () => ({ tabIndexFor, registerTarget, onKeyDown }),
    [onKeyDown, registerTarget, tabIndexFor],
  );
}
