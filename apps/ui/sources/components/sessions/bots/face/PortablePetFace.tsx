import * as React from 'react';
import { View } from 'react-native';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import type { PetPortableImportSourceV1 } from '@happier-dev/protocol/pets/importActionV1';
import { computeAccountPetPackageDigestV1, findMatchingAccountPetV1 } from '@happier-dev/protocol/pets/portablePetV1';
import type { SessionBotFaceV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';

import { usePetSheetSpriteVersion } from '@/components/pets/render/usePetSheetSpriteVersion';
import {
  storePetArt,
  storePetSeed,
} from '@/components/store/catalog/storePets';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useRegistryItem } from '@/registries/useRegistryItem';
import {
  storage,
  usePeripheralFeedDemand,
  useSetting,
} from '@/sync/domains/state/storage';

import { BotFacePet } from './BotFacePet';
import { SessionBotFace } from './SessionBotFace';

/** A pet that travels with a Bot template: a registry identity, or the package itself (PET-SHARE). */
export type PortablePet = Readonly<{
  name: string;
  source: PetPortableImportSourceV1;
}>;

type Props = Readonly<{
  pet: PortablePet;
  /** The face the Bot falls back to (the template's seeded face): drawn until the pet is ready, and if it never is. */
  seed: string;
  face: SessionBotFaceV1 | null;
  size: number;
  motion?: boolean | 'interaction';
  testID?: string;
}>;

/**
 * A portable pet drawn as a Bot's face, before anyone has added it: the person's own copy when they already hold it
 * (matched by registry origin or package digest), otherwise the template's bundled sheet or the registry's sheet.
 * Until the sheet is read, and when pets are off, the Bot's own face stands in.
 */
export const PortablePetFace = React.memo(function PortablePetFace(
  props: Props,
) {
  const companion = useFeatureEnabled('pets.companion');
  const sync = useFeatureEnabled('pets.sync');
  usePeripheralFeedDemand('accountPets', companion && sync);
  const source = props.pet.source;
  const identity = React.useMemo(() => {
    if (!companion || !sync) return null;
    if (source.kind === 'registry') return source;
    const { manifest, spritesheet } = source.package;
    return {
      kind: 'digest' as const,
      digest: computeAccountPetPackageDigestV1(manifest, decodeBase64(spritesheet.data)),
    };
  }, [companion, sync, source]);
  const heldId = storage((state) =>
    identity
      ? (findMatchingAccountPetV1(
          Object.values(state.accountPetsById),
          identity,
        )?.accountPetId ?? null)
      : null,
  );
  const fallback = React.useMemo(
    () => ({ seed: props.seed, face: props.face }),
    [props.seed, props.face],
  );
  const held = React.useMemo(
    () =>
      heldId
        ? {
            seed: props.seed,
            face: {
              ...props.face,
              pet: { kind: 'accountPet' as const, accountPetId: heldId },
            },
          }
        : null,
    [heldId, props.seed, props.face],
  );
  if (!companion)
    return (
      <SessionBotFace
        facts={fallback}
        size={props.size}
        motion={props.motion}
        testID={props.testID}
      />
    );
  if (held)
    return (
      <SessionBotFace
        facts={held}
        size={props.size}
        motion={props.motion}
        testID={props.testID}
      />
    );
  return source.kind === 'registry' ? (
    <RegistryPetFace
      {...props}
      sourceId={source.sourceId}
      itemId={source.itemId}
      fallback={fallback}
    />
  ) : (
    <SheetPetFace
      {...props}
      fallback={fallback}
      art={null}
      pkg={source.package}
    />
  );
});

function RegistryPetFace(
  props: Props &
    Readonly<{
      sourceId: string;
      itemId: string;
      fallback: { seed: string; face: SessionBotFaceV1 | null };
    }>,
) {
  const read = useRegistryItem({
    kind: 'pet',
    sourceId: props.sourceId,
    itemId: props.itemId,
  });
  const art = React.useMemo(
    () => (read.item?.summary ? storePetArt(read.item.summary) : null),
    [read.item?.summary],
  );
  // While the catalog answers, the face's box is held; a catalog that can't be reached leaves the Bot's own face.
  return <SheetPetFace {...props} art={art} pkg={null} resolving={!art && read.loading} />;
}

function SheetPetFace(
  props: Props &
    Readonly<{
      fallback: { seed: string; face: SessionBotFaceV1 | null };
      art: ReturnType<typeof storePetArt>;
      resolving?: boolean;
      pkg:
        | Extract<PetPortableImportSourceV1, { kind: 'package' }>['package']
        | null;
    }>,
) {
  const motionMode = useSetting('botMotion');
  const { pkg } = props;
  // The bundled sheet is the template's own bytes, drawn as they are; the server validates them only when added.
  const sheet = React.useMemo(
    () =>
      pkg
        ? {
            uri: `data:${pkg.spritesheet.mediaType};base64,${pkg.spritesheet.data}`,
          }
        : props.art?.spritesheetSource,
    [pkg, props.art?.spritesheetSource],
  );
  const version = usePetSheetSpriteVersion(
    sheet,
    pkg?.manifest.spriteVersionNumber ?? props.art?.spriteVersionNumber,
  );
  const [arrived] = React.useState(!(sheet && version));
  // The box is held while the sheet is read (R11: no face swaps on a cold start); an unreadable sheet shows the own face.
  if ((sheet && version === undefined) || (!sheet && props.resolving))
    return <View testID={props.testID} style={{ width: props.size, height: props.size }} />;
  if (!sheet || !version)
    return (
      <SessionBotFace
        facts={props.fallback}
        size={props.size}
        motion={props.motion}
        testID={props.testID}
      />
    );
  return (
    <BotFacePet
      spritesheetSource={sheet}
      opaqueBounds={props.art?.opaqueBounds ?? null}
      spriteVersionNumber={version}
      size={props.size}
      mood="quiet"
      seed={props.art?.seed ?? storePetSeed(props.pet.name)}
      motion={props.motion}
      motionMode={motionMode}
      fadeIn={arrived}
      testID={props.testID}
      accessibilityLabel={props.pet.name}
    />
  );
}
