import * as React from 'react';
import { View } from 'react-native';
import type { PetAccountReferenceV1 } from '@happier-dev/protocol/pets/selection';

import { resolveBuiltInPetPackage } from '@/components/pets/builtIns/builtInPetRegistry';
import { usePetSpritesheetSourceResult } from '@/components/pets/render/usePetSpritesheetSource';
import type { SelectedPetPackageSource } from '@/components/pets/source/resolveSelectedPetPackage';
import { usePetReferencePackage } from '@/components/pets/source/usePetReferencePackage';
import { useSetting, useSettingsSelector } from '@/sync/domains/state/storage';

import { BotFace, type BotFaceProps } from './BotFace';
import { BotFacePet, type BotFacePetProps } from './BotFacePet';
import type { BotFaceMood } from './botFaceGeometry';
import { resolveBotFaceIdentity, type BotFaceStyle } from './botFaceIdentity';
import type { SessionBotFaceFacts } from './sessionBotFaceFacts';

/**
 * A Bot Session's face at an identity surface: its saved style or the Account's Bots default, its identity, the mood
 * the surface already decided (`botActivity`, or the completion moment) and the surface's not-live dimming. A Bot that
 * wears a pet shows the pet; a viewer who can't read it, a deleted pet or a failed load shows the face underneath.
 */
export const SessionBotFace = React.memo(function SessionBotFace(
  props: Readonly<{
    facts: SessionBotFaceFacts;
    size: number;
    mood?: BotFaceMood;
    /** A surface's own rendition (Home's moons are flat Planets); never written back as the Bot's choice. It wins over a pet. */
    style?: BotFaceStyle;
    monochrome?: boolean;
    visible?: boolean;
    motion?: BotFaceProps['motion'];
    marker?: React.ReactNode;
    testID?: string;
    accessibilityLabel?: string;
  }>,
) {
  const explicitStyle = props.style ?? props.facts.face?.style;
  const style = useSettingsSelector(settings => explicitStyle ?? settings.botFaceStyle,
    explicitStyle ? [] : ['botFaceStyle']);
  const motionMode = useSetting('botMotion');
  const { seed, face } = props.facts;
  const identity = React.useMemo(
    () => resolveBotFaceIdentity(seed, face),
    [seed, face?.body, face?.palette, face?.shape],
  );
  const mood = props.mood && props.mood !== 'quiet' ? props.mood : props.facts.restingMood ?? 'quiet';
  const monochrome = props.facts.monochrome === true || props.monochrome === true;
  const ownFace = (
    <BotFace
      identity={identity}
      style={style}
      size={props.size}
      mood={mood}
      monochrome={monochrome}
      visible={props.visible}
      motion={props.motion}
      marker={props.marker}
      motionMode={motionMode}
      completedAt={props.facts.completedAt}
      failedAt={props.facts.failedAt}
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
    />
  );
  const pet = props.style ? undefined : face?.pet;
  if (!pet) return ownFace;
  return (
    <SessionBotFacePet
      petRef={pet}
      ownFace={ownFace}
      size={props.size}
      mood={mood}
      seed={identity.seed}
      motion={props.motion}
      motionMode={motionMode}
      visible={props.visible}
      monochrome={monochrome}
      marker={props.marker}
      testID={props.testID}
      accessibilityLabel={props.accessibilityLabel}
    />
  );
});

type PetFaceProps = Omit<BotFacePetProps, 'spritesheetSource' | 'opaqueBounds' | 'fadeIn' | 'spriteVersionNumber' | 'hasNeutralLookCell'>;

/**
 * The pet a face wears (a Bot's, or a chooser tile's), from the shared lookup: `pending` reserves the box (no face swaps on a cold start), `unavailable`
 * shows the Bot's own face, `ready` draws the pet. Built-in atlases ship with the app; an Account pet's loads once per
 * asset and falls back to the Bot's own face if it fails.
 */
export function SessionBotFacePet(props: PetFaceProps & Readonly<{ petRef: PetAccountReferenceV1; ownFace: React.ReactElement }>) {
  const lookup = usePetReferencePackage(props.petRef);
  const [mountedPending] = React.useState(lookup.status === 'pending');
  const { petRef: _petRef, ownFace, ...face } = props;
  if (lookup.status === 'unavailable') return ownFace;
  if (lookup.status === 'pending') return <PetFaceReserved {...face} />;
  if (lookup.source.kind === 'builtIn') {
    return (
      <BotFacePet {...face} fadeIn={mountedPending}
        spritesheetSource={resolveBuiltInPetPackage(lookup.source.petId).spritesheetSource}
        opaqueBounds={lookup.opaqueBounds} spriteVersionNumber={lookup.spriteVersionNumber}
        hasNeutralLookCell={lookup.hasNeutralLookCell} />
    );
  }
  return <SessionBotFaceLoadedPet {...face} source={lookup.source} opaqueBounds={lookup.opaqueBounds}
    hasNeutralLookCell={lookup.hasNeutralLookCell} ownFace={ownFace} />;
}

function SessionBotFaceLoadedPet(props: PetFaceProps & Readonly<{
  source: SelectedPetPackageSource;
  opaqueBounds: BotFacePetProps['opaqueBounds'];
  hasNeutralLookCell: boolean;
  ownFace: React.ReactElement;
}>) {
  const sheet = usePetSpritesheetSourceResult(props.source, undefined, { fallbackWhileLoading: false, fallbackOnError: false });
  const [mountedLoading] = React.useState(sheet.status === 'loading');
  const { source: _source, ownFace, ...face } = props;
  if (sheet.status === 'error' || (sheet.status === 'ready' && !sheet.source)) return ownFace;
  if (!sheet.source) return <PetFaceReserved {...face} />;
  // The delivered image decides the atlas (a v2 sheet adds the look rows).
  return <BotFacePet {...face} spritesheetSource={sheet.source} spriteVersionNumber={sheet.spriteVersionNumber} fadeIn={mountedLoading} />;
}

/** The face's box, held while its pet resolves, with the surface's marker in place. */
function PetFaceReserved(props: PetFaceProps) {
  return (
    <View testID={props.testID} style={{ width: props.size, height: props.size }}>
      {props.marker ? <View pointerEvents="none" style={{ position: 'absolute', inset: 0 }}>{props.marker}</View> : null}
    </View>
  );
}
