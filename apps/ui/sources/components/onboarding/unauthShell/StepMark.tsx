import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';

/** The mark's drawn size (lab direction A `.r3-badge`). */
const STEP_MARK_PX = 64;

/**
 * The round mark over a signed-out step's heading that names what the step is about when it has no identity of its
 * own to show: a link that leads nowhere, an email on its way, a recovery key. One object for every such step, so a
 * dead end and a "check your email" read as the same family. Decorative: the heading says it in words.
 */
export function StepMark(
  props: Readonly<{ iconName: IconName; testID?: string }>,
) {
  const { theme } = useUnistyles();
  const paintColor = useHappierMaterialColorResolver();
  return (
    <View
      testID={props.testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        stylesheet.mark,
        {
          backgroundColor: paintColor(theme.colors.surface.base),
          borderColor: theme.colors.border.default,
        },
      ]}
    >
      <Icon
        name={props.iconName}
        size={ICON_SIZE.xl}
        color={theme.colors.text.primary}
      />
    </View>
  );
}

const stylesheet = StyleSheet.create({
  mark: {
    width: STEP_MARK_PX,
    height: STEP_MARK_PX,
    borderRadius: STEP_MARK_PX / 2,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
});
