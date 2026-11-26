import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import type { IconName } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';

/**
 * The one state anatomy of a Session media tile: a muted glyph, centred, over at most
 * one short line, filling the tile its container sizes. "No preview" and "can't play"
 * both draw here; a staged chip has no room for words and takes the glyph alone, named
 * by the same line for assistive technology.
 */
export const SessionMediaTileState = React.memo(function SessionMediaTileState(
  props: Readonly<{
    icon: IconName;
    iconSize: number;
    label?: string;
    form?: 'tile' | 'glyph';
    accessibilityLabel?: string;
    testID?: string;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const named = props.accessibilityLabel !== undefined;
  return (
    <View
      testID={props.testID}
      accessible={named}
      accessibilityRole={named ? 'image' : undefined}
      accessibilityLabel={props.accessibilityLabel}
      style={stylesheet.state}
    >
      <Icon
        name={props.icon}
        size={props.iconSize}
        color={theme.colors.text.secondary}
      />
      {props.label !== undefined && props.form !== 'glyph' ? (
        <Text variant="meta" style={stylesheet.label} numberOfLines={2}>
          {props.label}
        </Text>
      ) : null}
    </View>
  );
});

const stylesheet = StyleSheet.create((theme) => ({
  state: {
    flex: 1,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface.elevated,
  },
  label: {
    marginTop: theme.space.s6,
    color: theme.colors.text.secondary,
    textAlign: 'center',
    paddingHorizontal: theme.space.s8,
  },
}));
