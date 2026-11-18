import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_TYPE_SCALE } from '@happier-dev/plugin-ui/presentation';
import {
  getPetAtlasForDimensionsV1,
  PET_ATLAS_V2,
} from '@happier-dev/protocol/pets/constants';
import type { PetImportConfirmationV1 } from '@happier-dev/protocol/pets/importActionV1';
import { createAccountPetReferenceV1 } from '@happier-dev/protocol/pets/selection';

import { PetAddOutcomeActions, PetAddOutcomeLine } from '@/components/pets/add/PetAddOutcome';
import { petAddOutcomeOfImport, petAddOutcomeWithUndo } from '@/components/pets/add/petAddOutcome';
import { usePetSettingsOpeners } from '@/components/pets/add/usePetSettingsOpeners';
import { PetPoseGrid } from '@/components/pets/render/PetPoseGrid';
import { usePetAddUndo } from '@/components/pets/source/usePetImport';
import { usePetSelectionAction } from '@/components/pets/source/usePetSelectionAction';
import { usePetSpritesheetSource } from '@/components/pets/render/usePetSpritesheetSource';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { fireAndForget } from '@/utils/system/fireAndForget';

/** Poses in the card: 56 on a page, 48 on a phone (DECISIONS-R12 spec). */
const POSE_PX = 56;
const POSE_PHONE_PX = 48;
/** One column, at most this wide beside a transcript (DECISIONS-R12 spec); full width on a phone. */
const CARD_MAX_WIDTH = 440;

/**
 * The pet preview card (lab r12-create-C, round 3): the confirmation of Hatch pet's pet-import request. One column on
 * one left edge: the name with where it was made, the check line, and every pose in the shared 3 × 3 grid, which is
 * the try-on. Approving the request is Add to my pets (Keep); the daemon's validation already checked the sheet. Once
 * the import owner answered, the card says the same outcome as the Store listing (one Action, one set of outcomes,
 * R12 §16): Added with Use as a Bot's face…, Make it my companion and Undo, or the refusal. Undo runs on the Home that
 * approved it.
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
    const { outcome } = props.confirmation;
    const added = React.useMemo(() => (outcome ? petAddOutcomeOfImport(outcome) : null), [outcome]);
    const { progress, onUndo } = usePetAddUndo(added?.undo ?? null, props.serverId ?? undefined);
    const state = added ? petAddOutcomeWithUndo(added.state, progress) : null;
    const addedPet = outcome?.kind === 'added' && state?.kind !== 'removed' ? outcome.pet : null;
    const wearPet = React.useMemo(() => (addedPet ? createAccountPetReferenceV1(addedPet) : null), [addedPet]);
    const selectPet = usePetSelectionAction();
    const open = usePetSettingsOpeners();
    const name = validation.manifest.displayName;
    const outcomeProps = state ? {
      state,
      name,
      sourceTitle: machine ?? t('runs.unknownMachine'),
      size: phone ? ('normal' as const) : ('small' as const),
      ...(wearPet ? { wearPet } : {}),
      ...(addedPet ? { onMakeCompanion: () => fireAndForget(
        selectPet({ petRef: { kind: 'accountPet', accountPetId: addedPet.accountPetId } }),
        { tag: 'PetImportConfirmationCard.companion' },
      ) } : {}),
      ...(onUndo ? { onUndo } : {}),
      onOpenSettingsPets: open.pets,
      onOpenFeatures: open.features,
      ...(props.testID ? { testID: props.testID } : {}),
    } : null;
    return (
      <View
        style={[styles.card, phone ? null : styles.cardWide]}
        testID={props.testID}
      >
        <View style={styles.identity}>
          <Text variant="body" emphasis="semiBold" style={styles.name}>
            {name}
          </Text>
          {machine ? (
            <Text variant="meta" style={styles.meta}>
              {t('settingsPets.store.newPetMadeOn', { machine })}
            </Text>
          ) : null}
        </View>
        {outcomeProps ? (
          // The outcome takes the check line's place (lab r12-create-A, -Cs).
          <View style={styles.outcome}>
            <PetAddOutcomeLine {...outcomeProps} />
          </View>
        ) : (
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
        )}
        {spritesheet ? (
          <PetPoseGrid
            spritesheetSource={spritesheet}
            opaqueBounds={null}
            spriteVersionNumber={atlas === PET_ATLAS_V2 ? 2 : 1}
            size={phone ? POSE_PHONE_PX : POSE_PX}
            testID={props.testID ? `${props.testID}.poses` : undefined}
          />
        ) : null}
        {outcomeProps ? <PetAddOutcomeActions {...outcomeProps} /> : null}
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
  outcome: { gap: theme.space.s8 },
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
