import * as React from 'react';
import { View } from 'react-native';
import type { PetAccountReferenceV1 } from '@happier-dev/protocol/pets/selection';

import { RoundButton, type RoundButtonSize } from '@/components/ui/buttons/RoundButton';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Popover } from '@/components/ui/popover';
import { t } from '@/text';

import { BOTS_ROSTER_WIDTH_PX, BotsPopoverContent } from './BotsPopoverContent';

const ROSTER_MAX_HEIGHT_PX = 520;

/**
 * "Use as a Bot's face…" (DECISIONS-R12 §10): opens the Bots roster anchored to the button, on whichever side has room
 * (the shared sheet on a phone), as a chooser wearing this pet. The roster hands the pet to the chosen Bot's own face
 * chooser, or starts New bot wearing it; this button never writes a face. The roster mounts only while open.
 */
export function BotFaceWearButton(
  props: Readonly<{
    pet: PetAccountReferenceV1;
    name: string;
    size?: RoundButtonSize;
    testID?: string;
  }>,
) {
  const anchorRef = React.useRef<View>(null);
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);
  const wearPet = React.useMemo(
    () => ({ pet: props.pet, name: props.name }),
    [props.pet, props.name],
  );
  return (
    <View ref={anchorRef} collapsable={false}>
      <RoundButton
        size={props.size}
        title={t('settingsPets.store.useAsFace')}
        onPress={() => setOpen((value) => !value)}
        testID={props.testID}
      />
      {open ? (
        <Popover
          open
          anchorRef={anchorRef}
          boundaryRef={null}
          placement="auto-vertical"
          phonePresentation="sheet"
          sheetHeader="none"
          accessibilityLabel={t('bots.face.wearTitle', { name: props.name })}
          gap={8}
          edgePadding={{ horizontal: 8, vertical: 8 }}
          portal={{ web: true, native: true, matchAnchorWidth: false, anchorAlign: 'start' }}
          maxWidthCap={BOTS_ROSTER_WIDTH_PX}
          maxHeightCap={ROSTER_MAX_HEIGHT_PX}
          onRequestClose={close}
        >
          {({ maxHeight, maxWidth, presentation }) => (
            <FloatingOverlay
              maxHeight={Math.min(maxHeight, ROSTER_MAX_HEIGHT_PX)}
              edgeFades={{ top: true, bottom: true, size: 18 }}
              surfaceChrome="theme"
              keyboardShouldPersistTaps="always"
              containerStyle={{ width: Math.min(maxWidth, BOTS_ROSTER_WIDTH_PX) }}
            >
              <BotsPopoverContent
                close={close}
                maxHeight={Math.min(maxHeight, ROSTER_MAX_HEIGHT_PX)}
                presentation={presentation === 'sheet' ? 'sheet' : 'popover'}
                wearPet={wearPet}
              />
            </FloatingOverlay>
          )}
        </Popover>
      ) : null}
    </View>
  );
}
