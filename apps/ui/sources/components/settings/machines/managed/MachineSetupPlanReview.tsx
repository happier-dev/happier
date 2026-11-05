import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { t } from '@/text';

/**
 * The review's closing row, shared by every setup review (Store Install on…, Set up from a preset):
 * who approves on the left, Cancel and the one primary action on the right (lab `setup/review`).
 */
export function MachineSetupReviewFooter(
  props: Readonly<{
    onCancel: () => void;
    cancelTestID: string;
    /** The secondary control's name; Cancel by default (a review one step in says Back). */
    cancelLabel?: string;
    /** The footer's quiet note; the approval note by default, none when `null` (nothing it could reassure about). */
    note?: string | null;
    /** Absent while the run waits on its approval elsewhere. */
    primary?: Readonly<{
      label: string;
      onPress: () => void;
      loading?: boolean;
      disabled?: boolean;
      /** Why it is disabled, for assistive technology. */
      accessibilityHint?: string;
      testID: string;
    }>;
  }>,
) {
  const { theme } = useUnistyles();
  return (
    <View style={footerStyles.footer}>
      {props.note === null ? null : (
        <View style={footerStyles.note}>
          <Icon
            name="shield-check"
            size={ICON_SIZE.xs}
            color={theme.colors.text.secondary}
          />
          <Text
            variant="meta"
            style={[footerStyles.noteText, { color: theme.colors.text.secondary }]}
          >
            {props.note ?? t('capabilities.store.softwarePage.approvalNote')}
          </Text>
        </View>
      )}
      <View style={footerStyles.buttons}>
        <RoundButton
          testID={props.cancelTestID}
          size="normal"
          display="secondary"
          title={props.cancelLabel ?? t('common.cancel')}
          onPress={props.onCancel}
        />
        {props.primary ? (
          <RoundButton
            testID={props.primary.testID}
            size="normal"
            title={props.primary.label}
            loading={props.primary.loading}
            disabled={props.primary.disabled}
            {...(props.primary.accessibilityHint ? { accessibilityHint: props.primary.accessibilityHint } : {})}
            onPress={props.primary.onPress}
          />
        ) : null}
      </View>
    </View>
  );
}

const footerStyles = StyleSheet.create((theme) => ({
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: theme.space.s12,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 200,
  },
  noteText: { flexShrink: 1 },
  buttons: { flexDirection: 'row', gap: theme.space.s8, marginLeft: 'auto' },
}));
