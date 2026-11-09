import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

/**
 * Where one OS grant stands, as the person reads it. `reopen` is macOS's "allowed, but this process
 * still sees the old answer" (the grant owner's RestartRequired); `unknown` was never checked.
 */
export type SystemPermissionRowState =
  | 'granted'
  | 'missing'
  | 'reopen'
  | 'unknown';

/**
 * One OS grant as a row (screen capture's Settings section and permission window, computer use's
 * permission card): the grant, what it unlocks, and either its state or the one next step. Each
 * consumer keeps its own grant owner and maps it to {@link SystemPermissionRowState}.
 */
export function SystemPermissionRow(
  props: Readonly<{
    title: string;
    /** What the grant unlocks; a pending reopen says what to do instead. */
    purpose: string;
    state: SystemPermissionRowState;
    /** Present when this surface can open the OS privacy pane itself. */
    onOpenSettings?: () => void;
    openBusy?: boolean;
    /** Present when this surface can relaunch the app the grant belongs to. */
    onReopen?: () => void;
    testID: string;
  }>,
): React.ReactElement {
  const { state } = props;
  const action =
    state === 'missing' && props.onOpenSettings ? (
      <RoundButton
        size="small"
        display="secondary"
        title={t('screenCapture.permission.openSettings')}
        loading={props.openBusy}
        onPress={props.onOpenSettings}
        testID={`${props.testID}-open-settings`}
      />
    ) : state === 'reopen' && props.onReopen ? (
      <RoundButton
        size="small"
        display="secondary"
        title={t('screenCapture.permission.reopen')}
        onPress={props.onReopen}
        testID={`${props.testID}-reopen`}
      />
    ) : null;
  return (
    <Item
      testID={props.testID}
      title={props.title}
      subtitle={
        state === 'reopen'
          ? t('screenCapture.permission.reopenNeeded')
          : props.purpose
      }
      showChevron={false}
      rightElement={
        action ?? (
          <GrantStatus state={state} testID={`${props.testID}-${state}`} />
        )
      }
    />
  );
}

/** Healthy is quiet ink; only a grant that needs the person carries the attention tint. */
function GrantStatus(
  props: Readonly<{ state: SystemPermissionRowState; testID: string }>,
) {
  const { theme } = useUnistyles();
  const granted = props.state === 'granted';
  const unknown = props.state === 'unknown';
  const glyph = granted
    ? theme.colors.text.secondary
    : unknown
      ? theme.colors.text.tertiary
      : theme.colors.state.attention.foreground;
  return (
    <View style={styles.status} testID={props.testID}>
      <Icon
        name={granted ? 'check' : unknown ? 'question' : 'warning'}
        size={ICON_SIZE.xs}
        color={glyph}
      />
      <Text variant="meta" style={styles.statusText}>
        {granted
          ? t('computerUse.permission.granted')
          : unknown
            ? t('computerUse.permission.unknown')
            : t('computerUse.permission.denied')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s4,
  },
  statusText: {
    color: theme.colors.text.secondary,
  },
}));
