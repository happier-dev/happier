import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { CollectionAnatomy } from '@happier-dev/plugin-ui';

import { usePetSheetSpriteVersion } from '@/components/pets/render/usePetSheetSpriteVersion';
import { BotFacePet } from '@/components/sessions/bots/face/BotFacePet';
import { useSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';

import type { StorePetArt, StorePetCardView } from './catalog/storePets';

/** The pet stands at rest at this size on its card (DECISIONS-R12 §3); a phone's narrower band fits it smaller. */
export const STORE_PET_CARD_SIZE = 96;
/** Four cards across a wide page, three beside the listing, two on a phone (DECISIONS-R12 spec). */
export const STORE_PET_CARD_MIN_WIDTH = 200;
export const STORE_PET_CARD_MIN_WIDTH_PHONE = 150;

/**
 * Store › Pets cards (lab r12-store-A): the shared Collection grid's preview card. The preview is the pet itself,
 * standing on the card with no band behind it; it plays its idle row now and then on the face clock and hops once
 * under the pointer. Under it: the name, author · source, then the registry's own line or "In your pets".
 */
export function useStorePetCardAnatomy(): CollectionAnatomy<StorePetCardView> {
  return React.useMemo(
    (): CollectionAnatomy<StorePetCardView> => ({
      glyph: () => null,
      title: (card) => card.name,
      where: (card) => card.byline,
      reason: (card) => card.summary,
      preview: (card) => <StorePetCardPreview art={card.art} />,
      accessibilityLabel: (card) =>
        `${card.name}, ${card.byline}, ${card.summary}`,
      testID: (card) => `store.pet.card:${card.key}`,
      columnTitles: {
        title: t('settingsPets.store.columnName'),
        where: t('settingsPets.store.columnSource'),
        reason: t('settingsPets.store.columnAbout'),
      },
    }),
    [],
  );
}

const StorePetCardPreview = React.memo(function StorePetCardPreview(props: Readonly<{ art: StorePetArt | null }>) {
  const motionMode = useSetting('botMotion');
  const version = usePetSheetSpriteVersion(props.art?.spritesheetSource, props.art?.spriteVersionNumber);
  // The grid sets the band's height from the card's width; the pet takes the band, at most its resting size.
  const [size, setSize] = React.useState<number | null>(null);
  // The pet never touches the band's edges.
  const breath = useUnistyles().theme.space.s12;
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    const next = Math.min(STORE_PET_CARD_SIZE, Math.floor(event.nativeEvent.layout.height) - 2 * breath);
    setSize(previous => previous === next ? previous : next);
  }, [breath]);
  return (
    <View style={styles.stage} onLayout={onLayout} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {props.art && size !== null && size > 0 && version ? (
        <BotFacePet spritesheetSource={props.art.spritesheetSource} opaqueBounds={props.art.opaqueBounds} spriteVersionNumber={version}
          size={size} mood="quiet" seed={props.art.seed} motionMode={motionMode} />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create(() => ({
  stage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
