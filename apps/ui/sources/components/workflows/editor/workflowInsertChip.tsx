import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import {
  HappierPressable,
  HAPPIER_PRESS_FEEDBACK_V1,
} from '@happier-dev/plugin-ui/presentation';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { workflowEditorStyles } from './workflowEditorStyles';

/**
 * Insert (round 1116b g): the quiet "@ Insert" at the top right of a step composer and at the end of a
 * value-accepting field's label line. Both open the same one list of values (Inputs, Step results,
 * Workspace, …) and put the chosen value at the caret.
 */
export function WorkflowInsertButton(
  props: Readonly<{
    onPress: () => void;
    /** What it inserts into ("Message"), so a list of fields reads apart. */
    target?: string;
    expanded?: boolean;
    testID: string;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.target === undefined
        ? t('workflows.editor.insertValue')
        : `${t('workflows.editor.insertValue')}: ${props.target}`}
      hasPopup="listbox"
      {...(props.expanded === undefined ? {} : { expanded: props.expanded })}
      onPress={props.onPress}
      style={(state) => [
        workflowEditorStyles.textFieldInsert,
        state.pressed
          ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle }
          : null,
        focusRingStyle({
          focused: state.focused,
          color: theme.colors.border.focus,
        }),
      ]}
    >
      <Icon name="at" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
      <Text style={workflowEditorStyles.metaText}>
        {t('workflows.editor.insert')}
      </Text>
    </HappierPressable>
  );
}
