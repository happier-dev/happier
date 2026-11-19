import {
  lookFor,
  type AtmosphereEffectiveLook,
  type AtmosphereLookPicture,
  type AtmosphereRememberedLooks,
} from '@happier-dev/brand/atmosphere';
import {
  type AtmosphereLookOverride,
  type AtmospherePresentation,
} from '@happier-dev/protocol/account/settings/accountSettings';
import { normalizeAtmosphereLooks } from '../atmosphereSettings';

/**
 * The Look panel's and Settings' one set of edits. Home and a project override share this shape; each
 * edit returns the next value and never touches what it does not own. Per-picture looks keep only
 * what differs from the picture's release look (the brand's `releaseLook` through the shared
 * normalizer), so a value set back to the release disappears from storage.
 */
export type PictureRef = AtmospherePresentation['picture']['ref'];
type Pictures = readonly AtmosphereLookPicture[];

/** The key a picture's remembered look is stored under: a built-in's id or a user picture's localId. */
export function pictureLookKey(ref: PictureRef): string {
  return ref.kind === 'builtin' ? ref.id : ref.localId;
}

/** A user picture has no release entry; it starts from the brand's default release look. */
function withLookPicture(pictures: Pictures, key: string): Pictures {
  return pictures.some((picture) => picture.id === key)
    ? pictures
    : [...pictures, { id: key }];
}

/** Storage names (look, dissolve) mapped onto the brand's memory names (effect, fade). */
function brandLooks(
  key: string,
  override: AtmosphereLookOverride | undefined,
): AtmosphereRememberedLooks {
  if (!override) return {};
  return {
    [key]: {
      ...(override.look !== undefined ? { effect: override.look } : {}),
      ...(override.dissolve !== undefined ? { fade: override.dissolve } : {}),
      ...(override.strength !== undefined
        ? { strength: override.strength }
        : {}),
    },
  };
}

export function effectivePictureLook(
  atmosphere: Pick<AtmospherePresentation, 'picture' | 'looks'>,
  pictures: Pictures,
): AtmosphereEffectiveLook {
  const key = pictureLookKey(atmosphere.picture.ref);
  return lookFor(
    key,
    brandLooks(key, atmosphere.looks[key]),
    withLookPicture(pictures, key),
  );
}

/** Which controls differ from the release look, in the panel's order. */
export function changedPictureLookControls(
  atmosphere: Pick<AtmospherePresentation, 'picture' | 'looks'>,
): ReadonlyArray<'look' | 'dissolve' | 'strength'> {
  const override =
    atmosphere.looks[pictureLookKey(atmosphere.picture.ref)] ?? {};
  return (['look', 'dissolve', 'strength'] as const).filter(
    (key) => override[key] !== undefined,
  );
}

/** The released builtin Look owns adaptive legibility; an own picture or custom Look stays as composed. */
export function pictureHazeIsAdaptive(
  atmosphere: Pick<AtmospherePresentation, 'picture' | 'looks'>,
  builtinPicture: AtmosphereLookPicture | null | undefined,
): boolean {
  return builtinPicture != null && changedPictureLookControls(atmosphere).length === 0;
}

export function withSource<T extends AtmospherePresentation>(
  atmosphere: T,
  source: T['source'],
): T {
  return { ...atmosphere, source };
}

export function withPicture<T extends AtmospherePresentation>(
  atmosphere: T,
  ref: PictureRef,
): T {
  return {
    ...atmosphere,
    source: 'picture',
    picture: { ...atmosphere.picture, ref },
  };
}

/** Another built-in picture, excluding the shown one while preserving the saved selection's intent. */
export function withShuffledPicture<T extends AtmospherePresentation>(
  atmosphere: T,
  pictures: Pictures,
  random: () => number = Math.random,
  shownRef: PictureRef = atmosphere.picture.ref,
): T {
  const current =
    atmosphere.source === 'picture'
      ? pictureLookKey(shownRef)
      : null;
  const others = pictures.filter((picture) => picture.id !== current);
  const next =
    others[Math.min(others.length - 1, Math.floor(random() * others.length))];
  return next
    ? withPicture(atmosphere, { kind: 'builtin', id: next.id })
    : atmosphere;
}

export function withLayout<T extends AtmospherePresentation>(
  atmosphere: T,
  layout: T['picture']['layout'],
): T {
  return { ...atmosphere, picture: { ...atmosphere.picture, layout } };
}

export function withPlanet<T extends AtmospherePresentation>(
  atmosphere: T,
  patch: Partial<T['planet']>,
): T {
  return { ...atmosphere, planet: { ...atmosphere.planet, ...patch } };
}

export function withPictureLook<T extends AtmospherePresentation>(
  atmosphere: T,
  patch: AtmosphereLookOverride,
  pictures: Pictures,
  ref: PictureRef = atmosphere.picture.ref,
): T {
  const key = pictureLookKey(ref);
  const looks = {
    ...atmosphere.looks,
    [key]: { ...atmosphere.looks[key], ...patch },
  };
  return {
    ...atmosphere,
    looks: normalizeAtmosphereLooks(looks, ref.kind === 'user' ? withLookPicture(pictures, key) : pictures),
  };
}

export function withoutPictureLook<T extends AtmospherePresentation>(
  atmosphere: T,
  ref: PictureRef = atmosphere.picture.ref,
): T {
  const key = pictureLookKey(ref);
  if (!(key in atmosphere.looks)) return atmosphere;
  const { [key]: _removed, ...looks } = atmosphere.looks;
  return { ...atmosphere, looks };
}
