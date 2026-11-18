import * as React from 'react';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { AgentInputControlPlacement } from '@/components/sessions/agentInput/controls/agentInputControlTypes';
import { Icon } from '@/components/ui/icons/Icon';

import { AGENT_INPUT_MENU_ICON_SIZE_PX } from './agentInputChipIconMetrics';

/**
 * A control this Composer cannot offer right now (one aimed at several Sessions, whose control state is per
 * Session, or whose targets disagree) still names itself in the + menu, disabled, with why as its subtitle.
 * It never rides the chip row: there is nothing to press there.
 */
export function createUnavailableComposerControlChip(
  params: Readonly<{
    key: string;
    controlId: AgentInputExtraActionChip['controlId'];
    placement: AgentInputControlPlacement;
    menuId?: string;
    reason: string;
  }>,
): AgentInputExtraActionChip {
  const { placement } = params;
  return {
    key: params.key,
    controlId: params.controlId,
    placement: { ...placement, defaultPlacement: 'overflow' },
    composerPreview: () => ({ absent: true }),
    collapsedAction: ({ tint }) => ({
      id: params.menuId ?? params.key,
      label: placement.title,
      subtitle: params.reason,
      disabled: true,
      ...(placement.icon
        ? {
            icon: (
              <Icon
                name={placement.icon}
                size={AGENT_INPUT_MENU_ICON_SIZE_PX}
                color={tint}
              />
            ),
          }
        : {}),
      onPress: () => {},
    }),
    render: () => null,
  };
}
