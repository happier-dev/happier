import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SelectableRow } from '@/components/ui/lists/SelectableRow';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import type {
  ThemeDevicePickerRow,
  ThemeDevicePickerViewProps,
} from './themeDevicePickerViewTypes';

/**
 * The one connected-device picker (lab B2, findings 5–6): this device first and already wearing the theme,
 * the other connected devices as checkable rows, one primary. Devices that are not connected are not listed;
 * the Account-synced library already holds the theme there. Hosted by an anchored popover on wide screens and
 * the shared bottom sheet on phones; the same body serves both.
 */
export const ThemeDevicePickerView = React.memo(function ThemeDevicePickerView(
  props: ThemeDevicePickerViewProps,
) {
  // A phone sheet: the body takes the sheet's width and the one primary sits at the thumb, full width.
  const phone = useDeviceType() === 'phone';
  const others = props.rows.filter((row) => !row.current);
  const selected = others.filter(
    (row) => row.checked && row.outcome !== 'applied',
  ).length;
  const modeWord =
    props.mode === 'dark'
      ? t('themeDevices.darkMode')
      : t('themeDevices.lightMode');
  const otherModeWord =
    props.mode === 'dark'
      ? t('themeDevices.lightMode')
      : t('themeDevices.darkMode');
  // Done only after Use applied at least one chosen device; before that the one primary stays Use.
  const settled =
    others.some((row) => row.outcome === 'applied') &&
    others.every((row) => !row.checked || row.outcome === 'applied');
  return (
    <View style={[styles.root, phone ? styles.rootPhone : null]} testID={props.testID}>
      <View style={styles.head}>
        <Text variant="label" emphasis="semiBold" style={styles.title}>
          {t('themeDevices.title', { name: props.themeName })}
        </Text>
        <Text variant="meta" style={styles.subtitle}>
          {t('themeDevices.subtitle', {
            mode: modeWord,
            otherMode: otherModeWord,
          })}
        </Text>
      </View>
      {props.state === 'loading' && props.rows.length === 0 ? (
        <Text
          variant="body"
          style={styles.line}
          testID={props.testID ? `${props.testID}:loading` : undefined}
        >
          {t('themeDevices.loading')}
        </Text>
      ) : props.state === 'error' && props.rows.length === 0 ? (
        <View style={styles.lineRow}>
          <Text variant="body" style={[styles.line, styles.lineFill]}>
            {t('themeDevices.failed')}
          </Text>
          <RoundButton
            size="small"
            display="inverted"
            title={t('themeDevices.retry')}
            onPress={props.onRetry}
            testID={props.testID ? `${props.testID}:retry` : undefined}
          />
        </View>
      ) : (
        <View accessibilityRole="list">
          {props.rows.map((row) => (
            <DeviceRow
              key={row.id}
              row={row}
              disabled={props.dispatching}
              onToggle={props.onToggle}
              testID={props.testID}
            />
          ))}
          {others.length === 0 ? (
            <Text variant="body" style={styles.line}>
              {t('themeDevices.noOthers')}
            </Text>
          ) : null}
        </View>
      )}
      {others.length > 0 ? (
        <View style={[styles.foot, phone ? styles.footPhone : null]}>
          {settled ? (
            <RoundButton
              size="small"
              display="secondary"
              title={t('themeDevices.done')}
              onPress={props.onDismiss}
              testID={props.testID ? `${props.testID}:done` : undefined}
            />
          ) : (
            <RoundButton
              size={phone ? 'normal' : 'small'}
              title={t('themeDevices.use', { count: selected })}
              onPress={props.onUse}
              disabled={selected === 0 || props.dispatching}
              loading={props.dispatching}
              testID={props.testID ? `${props.testID}:use` : undefined}
            />
          )}
        </View>
      ) : null}
    </View>
  );
});

function DeviceRow(
  props: Readonly<{
    row: ThemeDevicePickerRow;
    disabled: boolean;
    onToggle: (id: string) => void;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { row } = props;
  const label = row.label ?? t('themeDevices.unnamed');
  const glyph = row.computer ? 'laptop' : 'device-mobile';
  const subtitle = row.current
    ? t('themeDevices.thisDevice')
    : outcomeLine(row.outcome);
  const failed = row.outcome === 'failed' || row.outcome === 'disconnected';
  const right =
    row.current || row.outcome === 'applied' ? (
      <Text variant="meta" style={styles.applied}>
        {t('themeDevices.applied')}
      </Text>
    ) : (
      <SelectionCheckGlyph state={row.checked ? 'checked' : 'unchecked'} />
    );
  return (
    <SelectableRow
      presentation="menu"
      testID={props.testID ? `${props.testID}:row:${row.id}` : undefined}
      title={label}
      subtitle={subtitle ?? undefined}
      subtitleStyle={
        failed ? { color: theme.colors.state.danger.textForeground } : undefined
      }
      left={<Icon name={glyph} size={18} color={theme.colors.text.secondary} />}
      right={right}
      disabled={row.current || row.outcome === 'applied' || props.disabled}
      accessibilityRole="checkbox"
      accessibilityChecked={row.current || row.checked}
      accessibilityLabel={subtitle ? `${label}, ${subtitle}` : label}
      onPress={() => props.onToggle(row.id)}
    />
  );
}

function outcomeLine(outcome: ThemeDevicePickerRow['outcome']): string | null {
  switch (outcome) {
    case 'applying':
      return t('themeDevices.applying');
    case 'failed':
      return t('themeDevices.rowFailed');
    case 'disconnected':
      return t('themeDevices.rowDisconnected');
    case 'applied':
    case null:
      return null;
  }
}

const styles = StyleSheet.create((theme) => ({
  root: {
    width: 340,
    maxWidth: '100%',
    paddingVertical: theme.space.s12,
    gap: theme.space.s8,
  },
  head: {
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s4,
    gap: theme.space.s2,
  },
  title: {
    color: theme.colors.text.primary,
  },
  subtitle: {
    color: theme.colors.text.secondary,
  },
  line: {
    paddingHorizontal: theme.space.s16,
    paddingVertical: theme.space.s8,
    color: theme.colors.text.secondary,
  },
  rootPhone: {
    width: '100%',
  },
  footPhone: {
    flexDirection: 'column',
    alignItems: 'stretch',
    paddingTop: theme.space.s8,
  },
  lineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: theme.space.s12,
  },
  lineFill: {
    flex: 1,
  },
  applied: {
    color: theme.colors.text.tertiary,
  },
  foot: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s4,
  },
}));
