import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ExecutableParticipantPickerProps } from '@happier-dev/plugin-ui/components';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SelectionList, type SelectionListStep } from '@/components/ui/selectionList';

/** The single host renderer for the public controlled picker, with no inventory or setup controller. */
export function ExecutableParticipantPickerPresentation(props: ExecutableParticipantPickerProps) {
  const rootStep = React.useMemo<SelectionListStep>(() => ({
    id: 'executable-participant-picker',
    inputPlaceholder: props.searchPlaceholder,
    sections: props.sections.map(section => ({ ...section, kind: 'static' as const })),
  }), [props.searchPlaceholder, props.sections]);
  return <View testID={props.testID} style={styles.body}>
    <SelectionList
      rootStep={rootStep}
      fillAvailableSpace
      autoFocusInputOnWeb
      selection={props.selection}
      onSelect={props.onSelect}
      onRequestClose={props.onRequestClose}
      inputTestID={props.testID === undefined ? undefined : `${props.testID}-search`}
      // Done is the list's one whole-list action: it sits in the list's own footer, inset like every other.
      footerAction={props.selection.kind === 'multiple' ? <RoundButton
        testID={props.testID === undefined ? undefined : `${props.testID}-done`}
        size="normal"
        title={props.doneLabel}
        disabled={!props.canConfirm}
        onPress={props.onDone}
      /> : undefined}
    />
  </View>;
}

const styles = StyleSheet.create(() => ({
  body: { flex: 1, minHeight: 0 },
}));
