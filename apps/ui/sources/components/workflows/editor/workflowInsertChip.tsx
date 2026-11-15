import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import {
  AGENT_INPUT_CHIP_ICON_SIZE_PX,
  AGENT_INPUT_MENU_ICON_SIZE_PX,
} from '@/components/sessions/agentInput/definitions/agentInputChipIconMetrics';
import { AgentInputRailChip } from '@/components/sessions/agentInput/definitions/agentInputChipRowReach';
import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { getWorkflowInsertChipPlacement } from '../workflowComposerControlPlacements';

/**
 * Insert (owner 2026-11-15): the visible entry to a prompt's '@' value list — the run's inputs, the
 * trigger and earlier steps' results, the same list typing '@' opens. It asks the composer to open
 * that list at the caret; picking a value inserts its token, as typing does.
 */
export function useWorkflowInsertChip(
  props: Readonly<{ onInsert: () => void; testID: string }>,
): AgentInputExtraActionChip {
  const latestRef = React.useRef(props.onInsert);
  latestRef.current = props.onInsert;
  const { testID } = props;
  return React.useMemo<AgentInputExtraActionChip>(
    () => ({
      key: 'workflow-insert',
      controlId: 'shortcuts',
      placement: getWorkflowInsertChipPlacement(),
      stabilityKey: 'workflow-insert',
      collapsedAction: ({ tint, dismiss }) => ({
        id: 'workflow-insert',
        label: t('workflows.editor.insertValue'),
        icon: (
          <Icon name="at" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />
        ),
        onPress: () => {
          dismiss();
          latestRef.current();
        },
      }),
      render: (ctx) => (
        <InsertComposerChip
          testID={testID}
          onPress={() => latestRef.current()}
          chipStyle={ctx.chipStyle}
          textStyle={ctx.textStyle}
          iconColor={ctx.iconColor}
          showLabel={ctx.showLabel}
        />
      ),
    }),
    [testID],
  );
}

function InsertComposerChip(
  props: Readonly<{
    testID: string;
    onPress: () => void;
    chipStyle: (pressed: boolean) => unknown;
    textStyle: unknown;
    iconColor: string;
    showLabel: boolean;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <AgentInputRailChip
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={t('workflows.editor.insertValue')}
      hasPopup="listbox"
      onPress={props.onPress}
      style={(pressed, focused) => [
        props.chipStyle(pressed) as never,
        focusRingStyle({ focused, color: theme.colors.border.focus }),
      ]}
    >
      <Icon
        name="at"
        size={AGENT_INPUT_CHIP_ICON_SIZE_PX}
        color={props.iconColor}
      />
      {props.showLabel ? (
        <Text numberOfLines={1} style={props.textStyle as never}>
          {t('workflows.editor.insert')}
        </Text>
      ) : null}
    </AgentInputRailChip>
  );
}
