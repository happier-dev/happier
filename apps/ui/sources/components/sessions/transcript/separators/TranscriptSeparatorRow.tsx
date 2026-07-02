import * as React from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';
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
  onPress?: () => void;
  chipTestID?: string;
  accessibilityLabel?: string;
  padding?: 'default' | 'none';
  chipChrome?: 'default' | 'minimal';
  containerStyle?: ViewStyle | null;
}>): React.ReactElement {
  const { theme } = useUnistyles();
  const padding = props.padding === 'none' ? 'none' : 'default';
  const chipChrome = props.chipChrome === 'minimal' ? 'minimal' : 'default';
  const chipContent = (
    <>
      <Ionicons name={props.iconName} size={14} color={theme.colors.text.secondary} />
      <View style={styles.textStack}>
        <Text testID={props.titleTestID} style={[styles.title, { color: theme.colors.text.primary }]} numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text style={[styles.subtitle, { color: theme.colors.text.secondary }]} numberOfLines={1}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.rightAccessory ? <View style={styles.rightAccessory}>{props.rightAccessory}</View> : null}
    </>
  );

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
        <View style={[styles.line, { backgroundColor: theme.colors.border.default }]} />
        {props.onPress ? (
          <Pressable
            testID={props.chipTestID}
            onPress={props.onPress}
            accessibilityRole="button"
            accessibilityLabel={props.accessibilityLabel ?? props.title}
            hitSlop={chipChrome === 'minimal' ? 10 : undefined}
            style={({ pressed }) => [
              styles.chip,
              chipChrome === 'minimal' ? styles.chipMinimal : null,
              { backgroundColor: theme.colors.surface.base, borderColor: theme.colors.border.default, opacity: pressed ? 0.82 : 1 },
            ]}
          >
            {chipContent}
          </Pressable>
        ) : (
          <View
            testID={props.chipTestID}
            style={[
              styles.chip,
              chipChrome === 'minimal' ? styles.chipMinimal : null,
              { backgroundColor: theme.colors.surface.base, borderColor: theme.colors.border.default },
            ]}
          >
            {chipContent}
          </View>
        )}
        <View style={[styles.line, { backgroundColor: theme.colors.border.default }]} />
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
  chipMinimal: {
    borderWidth: 0,
    paddingHorizontal: 0,
    paddingVertical: 0,
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
