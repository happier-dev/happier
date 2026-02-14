import * as React from 'react';
import { ActivityIndicator, Pressable, StyleProp, View, ViewStyle } from 'react-native';

import { StyleSheet, useUnistyles } from 'react-native-unistyles';

const stylesheet = StyleSheet.create((theme) => ({
  root: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
    flexShrink: 0,
  },
  inner: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
}));

export const PrimaryCircleIconButton = React.memo(
  (
    props: Readonly<{
      active: boolean;
      disabled?: boolean;
      loading?: boolean;
      accessibilityLabel: string;
      accessibilityHint?: string;
      accessibilityState?: { disabled?: boolean } & Record<string, unknown>;
      hitSlop?: any;
      onPress?: () => void;
      style?: StyleProp<ViewStyle>;
      children?: React.ReactNode;
    }>,
  ) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const computedDisabled = Boolean(props.disabled || props.loading || !props.onPress);
    const primary = theme.colors.button?.primary;
    const backgroundColor = props.active
      ? (primary?.background ?? theme.colors.surfaceHigh ?? theme.colors.surface)
      : (primary?.disabled ?? theme.colors.divider);
    const tintColor = primary?.tint ?? theme.colors.text;

    return (
      <View style={[styles.root, props.style]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.accessibilityLabel}
          accessibilityHint={props.accessibilityHint}
          accessibilityState={{ ...(props.accessibilityState ?? {}), disabled: computedDisabled }}
          hitSlop={props.hitSlop}
          disabled={computedDisabled}
          onPress={props.onPress}
          style={({ pressed }) => [
            styles.inner,
            {
              borderRadius: 16,
              backgroundColor,
              opacity: pressed ? 0.72 : 1,
            },
          ]}
        >
          {props.loading ? (
            <ActivityIndicator size="small" color={tintColor} />
          ) : (
            props.children
          )}
        </Pressable>
      </View>
    );
  },
);
