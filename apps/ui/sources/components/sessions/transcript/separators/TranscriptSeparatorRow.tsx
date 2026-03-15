import * as React from 'react';
import { View, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';

export function TranscriptSeparatorRow(props: Readonly<{
  testID?: string;
  iconName: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  titleTestID?: string;
  subtitle?: string | null;
  rightAccessory?: React.ReactNode;
  padding?: 'default' | 'none';
  containerStyle?: ViewStyle | null;
}>): React.ReactElement {
  const { theme } = useUnistyles();
  const padding = props.padding === 'none' ? 'none' : 'default';

  return (
    <View
      testID={props.testID}
      style={[
        styles.container,
        padding === 'none' ? styles.containerNoPadding : null,
        props.containerStyle ?? null,
      ]}
    >
      <View style={styles.row}>
        <View style={[styles.line, { backgroundColor: theme.colors.divider }]} />
        <View style={[styles.chip, { backgroundColor: theme.colors.surface, borderColor: theme.colors.divider }]}>
          <Ionicons name={props.iconName} size={14} color={theme.colors.textSecondary} />
          <View style={styles.textStack}>
            <Text testID={props.titleTestID} style={[styles.title, { color: theme.colors.text }]} numberOfLines={1}>
              {props.title}
            </Text>
            {props.subtitle ? (
              <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                {props.subtitle}
              </Text>
            ) : null}
          </View>
          {props.rightAccessory ? <View style={styles.rightAccessory}>{props.rightAccessory}</View> : null}
        </View>
        <View style={[styles.line, { backgroundColor: theme.colors.divider }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((_theme) => ({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  containerNoPadding: {
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  row: {
    maxWidth: 720,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  line: {
    flex: 1,
    height: 1,
    opacity: 0.8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  textStack: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'column',
    gap: 2,
  },
  title: {
    fontSize: 12,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 12,
    fontWeight: '500',
  },
  rightAccessory: {
    marginLeft: 6,
  },
}));
