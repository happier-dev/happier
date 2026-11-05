import { HAPPIER_ICON_BUTTON_SIZE } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { resolveIconButtonGlyphSize } from '@/components/ui/icons/iconButtonGlyphSize';
import { t } from '@/text';

/**
 * The island's pin (lab `ntdock-T`): a quiet outline while the panel is only open, a filled glyph in
 * ink once it is pinned, so the two states read apart without a selection fill behind the glyph.
 */
export function DesktopActivityOverlayPinButton(
  props: Readonly<{
    testID: string;
    pinned: boolean;
    onPress: () => void;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const label = t(
    props.pinned
      ? 'settingsDesktop.overlay.notchUnpin'
      : 'settingsDesktop.overlay.notchPin',
  );
  return (
    <IconButton
      testID={props.testID}
      variant="plain"
      icon={
        <Icon
          name="push-pin"
          size={resolveIconButtonGlyphSize(HAPPIER_ICON_BUTTON_SIZE)}
          weight={props.pinned ? 'fill' : 'regular'}
          color={
            props.pinned
              ? theme.colors.text.primary
              : theme.colors.text.secondary
          }
        />
      }
      selected={props.pinned}
      selectedBackground={false}
      accessibilityLabel={label}
      tooltip={label}
      onPress={props.onPress}
    />
  );
}
