import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_TYPE_SCALE } from '@happier-dev/plugin-ui/presentation';
import {
  getPetAtlasForDimensionsV1,
  PET_ATLAS_V2,
} from '@happier-dev/protocol/pets/constants';
import type { PetImportConfirmationV1 } from '@happier-dev/protocol/pets/importActionV1';

import { PetPoseGrid } from '@/components/pets/render/PetPoseGrid';
import { usePetSpritesheetSource } from '@/components/pets/render/usePetSpritesheetSource';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

/** Poses in the card: 56 on a page, 48 on a phone (DECISIONS-R12 spec). */
const POSE_PX = 56;
const POSE_PHONE_PX = 48;
/** One column, at most this wide beside a transcript (DECISIONS-R12 spec); full width on a phone. */
const CARD_MAX_WIDTH = 440;

/**
 * The pet preview card (lab r12-create-C, round 3): the confirmation of Hatch pet's pet-import request. One column on
 * one left edge: the name with where it was made, the check line, and every pose in the shared 3 × 3 grid, which is
 * the try-on. Approving the request is Add to my pets (Keep); the daemon's validation already checked the sheet.
 */
export const PetImportConfirmationCard = React.memo(
  function PetImportConfirmationCard(
    props: Readonly<{
      confirmation: PetImportConfirmationV1;
      serverId: string | null;
      testID?: string;
    }>,
  ) {
    const phone = useDeviceType() === 'phone';
    const { theme } = useUnistyles();
    const { input, preview } = props.confirmation;
    const machineId =
      input.source.kind === 'machine' ? input.source.machineId : null;
    const machine = useServerScopedMachineLabel(props.serverId, machineId);
    const { validation, previewHandle } = preview;
    const source = React.useMemo(
      () =>
        props.serverId && machineId
          ? {
              kind: 'happierManagedLocal' as const,
              sourceKey: previewHandle.sourceKey,
              mediaType: validation.mediaType,
              digest: validation.digest,
              daemonTarget: { serverId: props.serverId, machineId },
            }
          : null,
      [
        props.serverId,
        machineId,
        previewHandle.sourceKey,
        validation.mediaType,
        validation.digest,
      ],
    );
    const spritesheet = usePetSpritesheetSource(source, null);
    // The daemon decoded the sheet: its dimensions, not any label, say which atlas it is.
    const atlas = getPetAtlasForDimensionsV1(
      validation.width,
      validation.height,
    );
    return (
      <View
        style={[styles.card, phone ? null : styles.cardWide]}
        testID={props.testID}
      >
        <View style={styles.identity}>
          <Text variant="body" emphasis="semiBold" style={styles.name}>
            {validation.manifest.displayName}
          </Text>
          {machine ? (
            <Text variant="meta" style={styles.meta}>
              {t('settingsPets.store.newPetMadeOn', { machine })}
            </Text>
          ) : null}
        </View>
        <View style={styles.check}>
          <View style={styles.checkGlyph}>
            <Icon
              name="check"
              size={ICON_SIZE.xs}
              color={theme.colors.text.secondary}
            />
          </View>
          <Text variant="meta" style={styles.meta}>
            {t('settingsPets.store.checkedAll')}
          </Text>
        </View>
        {spritesheet ? (
          <PetPoseGrid
            spritesheetSource={spritesheet}
            opaqueBounds={null}
            spriteVersionNumber={atlas === PET_ATLAS_V2 ? 2 : 1}
            size={phone ? POSE_PHONE_PX : POSE_PX}
            testID={props.testID ? `${props.testID}.poses` : undefined}
          />
        ) : null}
      </View>
    );
  },
);

const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.space.s12,
    padding: theme.space.s16,
    alignSelf: 'stretch',
  },
  cardWide: { maxWidth: CARD_MAX_WIDTH },
  identity: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    columnGap: theme.space.s8,
  },
  name: { color: theme.colors.text.primary },
  meta: { color: theme.colors.text.secondary, flexShrink: 1 },
  check: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.s6,
  },
  // One meta line high, so the glyph centres on the check line's first line.
  checkGlyph: {
    height: HAPPIER_TYPE_SCALE.meta.lineHeight,
    justifyContent: 'center',
  },
}));
