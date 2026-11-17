import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { SessionBotFaceV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';

import {
  usePetImport,
  type PetImportResult,
} from '@/components/pets/source/usePetImport';
import { usePetReferencePackage } from '@/components/pets/source/usePetReferencePackage';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

type Failure = Exclude<PetImportResult['kind'], 'added'>;

/**
 * A shared Bot that wears a catalog pet the viewer doesn't hold shows its own face, plus this one line where the Bot
 * is described: what the face is, and "Add <pet>" through `pet.import`. Once added, the face matches it by origin and
 * draws it, and the line goes. Created pets travel only inside templates, so they offer nothing here (PET-SHARE).
 */
export function SharedBotPetOffer(
  props: Readonly<{
    face: SessionBotFaceV1 | null | undefined;
    style?: StyleProp<ViewStyle>;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const sync = useFeatureEnabled('pets.sync');
  const pet = props.face?.pet?.kind === 'accountPet' ? props.face.pet : null;
  const origin = pet?.origin ?? null;
  const name = pet?.displayName ?? null;
  const lookup = usePetReferencePackage(origin && name ? pet : null);
  const importPet = usePetImport();
  const [adding, setAdding] = React.useState(false);
  const [failure, setFailure] = React.useState<Failure | null>(null);
  const add = React.useCallback(() => {
    if (!origin) return;
    setAdding(true);
    setFailure(null);
    fireAndForget(
      (async () => {
        try {
          const result = await importPet({ source: origin });
          setFailure(result.kind === 'added' ? null : result.kind);
        } finally {
          setAdding(false);
        }
      })(),
      { tag: 'SharedBotPetOffer.add' },
    );
  }, [importPet, origin]);
  // Only a pet the viewer could add: a catalog origin, pets on, and not already theirs (the face draws it then).
  if (!origin || !name || !sync || lookup.status !== 'unavailable') return null;
  const line =
    failure === 'library_full'
      ? t('petShare.offerLibraryFull')
      : failure === 'pet_sync_off'
        ? t('petShare.offerSyncOff')
        : failure === 'could_not_add'
          ? t('petShare.offerCouldNotAdd', { name })
          : failure === 'unreachable'
            ? t('petShare.offerUnreachable', { name })
            : t('petShare.offerLine');
  const canAdd = failure !== 'library_full' && failure !== 'pet_sync_off';
  return (
    <View style={[styles.row, props.style]} testID={props.testID ?? 'shared-bot-pet-offer'}>
      <Text
        variant="meta"
        style={[styles.line, failure ? styles.failed : null]}
        accessibilityRole={failure ? 'alert' : undefined}
        testID="shared-bot-pet-offer-line"
      >
        {line}
      </Text>
      {canAdd ? (
        <ToolbarButton
          testID="shared-bot-pet-offer-add"
          label={t('petShare.offerAdd', { name })}
          icon={
            <Icon name="plus" size={12} color={theme.colors.text.primary} />
          }
          busy={adding}
          disabled={adding}
          onPress={add}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    columnGap: theme.space.s12,
    rowGap: theme.space.s4,
  },
  line: {
    flexShrink: 1,
    color: theme.colors.text.secondary,
  },
  failed: {
    color: theme.colors.text.primary,
  },
}));
