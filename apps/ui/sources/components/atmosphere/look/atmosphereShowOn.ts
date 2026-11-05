import {
  ATMOSPHERE_PLACES,
  type AtmospherePlace,
} from '@happier-dev/protocol/account/settings/accountSettings';

/** The three ways "Show background on" reads the stored place set (plan A3). */
export type AtmosphereShowOnMode = 'everywhere' | 'home' | 'custom';

/** The Planet is a Home composition: Sessions and other pages never show it (resolveAtmosphere excludes them). */
export function isAtmospherePlaceAvailable(
  place: AtmospherePlace,
  source: 'none' | 'planet' | 'picture',
): boolean {
  return source !== 'planet' || (place !== 'sessions' && place !== 'pages');
}

/** Everywhere when every place the source can show is on; Home only for exactly Home; anything else is Custom. */
export function atmosphereShowOnMode(
  showOn: readonly AtmospherePlace[],
  source: 'none' | 'planet' | 'picture',
): AtmosphereShowOnMode {
  if (
    ATMOSPHERE_PLACES.every(
      (place) =>
        !isAtmospherePlaceAvailable(place, source) || showOn.includes(place),
    )
  )
    return 'everywhere';
  return showOn.length === 1 && showOn[0] === 'home' ? 'home' : 'custom';
}

/**
 * What choosing a mode writes. Everywhere stores all five places, so switching the source to a picture later
 * still shows it everywhere; Custom keeps the current set for the person to edit.
 */
export function atmosphereShowOnPlaces(
  mode: AtmosphereShowOnMode,
  current: readonly AtmospherePlace[],
): AtmospherePlace[] {
  return mode === 'everywhere'
    ? [...ATMOSPHERE_PLACES]
    : mode === 'home'
      ? ['home']
      : [...current];
}
