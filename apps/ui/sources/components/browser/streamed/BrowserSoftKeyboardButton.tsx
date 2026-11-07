import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { CORE_CAPSULE_HOST } from '@/components/ui/status/capsuleHost';
import { t } from '@/text';

/** It stands at the page's top-right corner: the keyboard, once up, covers the bottom of the page. */
const DOCK_STYLE = {
  position: 'absolute',
  top: 12,
  right: 12,
  zIndex: 3,
} as const;

/**
 * The phone's way to bring the keyboard back to the field the person tapped. A tap into a page field
 * raises the keyboard on its own; a phone can refuse that (mobile WebKit allows focus only inside a
 * gesture) and the person can put the keyboard away. Then this one floating control, in the capsule
 * material, offers it again, and leaves as soon as the keyboard is up or the tap left the field.
 */
export function BrowserSoftKeyboardButton(
  props: Readonly<{ visible: boolean; onPress: () => void; testID: string }>,
): React.ReactElement | null {
  const { theme } = useUnistyles();
  const Dock = CORE_CAPSULE_HOST.Dock!;
  const { Surface, Button } = CORE_CAPSULE_HOST;
  return (
    <Dock visible={props.visible} edge="top" style={DOCK_STYLE}>
      {(leaving) => (
        <Surface
          elevation="low"
          testID={leaving ? `${props.testID}-leaving` : props.testID}
        >
          <Button
            emphasis="plain"
            title={t('browserPresence.interaction.showKeyboard')}
            leading={
              <Icon
                name="keyboard"
                size={16}
                color={theme.colors.text.primary}
              />
            }
            onPress={props.onPress}
            testID={`${props.testID}-show`}
          />
        </Surface>
      )}
    </Dock>
  );
}
