import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { SecretValueControlsProps, SecretValueTextProps } from '@happier-dev/plugin-ui/components';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CopiedPill } from '@/components/ui/copy/CopiedPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

/**
 * The one secret value presentation: Happier's own rows and the public plugin-ui `SecretValueText` /
 * `SecretValueControls` (through the presentation host) draw it here, with one prop contract.
 *
 * A secret's value in a row subtitle: a one-line masked shape while hidden, the whole value (wrapped,
 * readable) while revealed. A recorded disclosure leaves it unselectable, so Copy stays the one copy path.
 */
export function SecretValueText(props: Omit<SecretValueTextProps, 'unavailableLabel'>) {
  return (
    <Text
      testID={props.testID}
      style={styles.value}
      selectable={props.selectable === true && props.revealed !== null}
      numberOfLines={props.revealed === null ? 1 : undefined}
      accessibilityLabel={
        props.revealed === null ? props.maskedAccessibilityLabel : undefined
      }
    >
      {props.revealed ?? props.mask}
    </Text>
  );
}

/**
 * The end-slot controls every secret value shares: an eye that reveals or hides, then Copy that turns
 * into the copied confirmation. Copy is drawn only where the owner offers it; extra controls (Replace)
 * follow it.
 */
export function SecretValueControls(
  props: Omit<SecretValueControlsProps, 'unavailableLabel'> & Readonly<{
    /** Host-only: the Copy control a host flow returns focus to. */
    copyControlRef?: React.ComponentProps<typeof RoundButton>['controlRef'];
  }>,
) {
  const label = props.revealed ? props.hideLabel : props.revealLabel;
  return (
    <View style={styles.actions}>
      <IconButton
        testID={`${props.testIDPrefix}-reveal`}
        accessibilityLabel={label}
        tooltip={label}
        iconName={props.revealed ? 'eye-slash' : 'eye'}
        variant="plain"
        disabled={props.disabled}
        onPress={props.onToggleReveal}
      />
      {props.onCopy ? (
        props.copied ? (
          <CopiedPill visible testID={`${props.testIDPrefix}-copied`} />
        ) : (
          <RoundButton
            testID={`${props.testIDPrefix}-copy`}
            controlRef={props.copyControlRef}
            size="small"
            display="secondary"
            title={t('common.copy')}
            accessibilityLabel={props.copyAccessibilityLabel}
            disabled={props.disabled}
            onPress={props.onCopy}
          />
        )
      ) : null}
      {props.children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  value: {
    ...Typography.mono(),
    fontSize: 12.5,
    lineHeight: 18,
    letterSpacing: 0.5,
    color: theme.colors.text.secondary,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
  },
}));
