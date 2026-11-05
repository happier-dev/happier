import { describe, expect, it } from 'vitest';
import { ATMOSPHERE_PLACES } from '@happier-dev/protocol/account/settings/accountSettings';
import {
  atmosphereShowOnMode,
  atmosphereShowOnPlaces,
  isAtmospherePlaceAvailable,
} from './atmosphereShowOn';

describe('Show background on: the stored place set seen as Everywhere / Home only / Custom', () => {
  it('reads Everywhere when every place the source can show is on, so a Planet with its three places is Everywhere', () => {
    expect(atmosphereShowOnMode([...ATMOSPHERE_PLACES], 'picture')).toBe(
      'everywhere',
    );
    expect(
      atmosphereShowOnMode(['home', 'new-session', 'projects'], 'picture'),
    ).toBe('custom');
    expect(
      atmosphereShowOnMode(['home', 'new-session', 'projects'], 'planet'),
    ).toBe('everywhere');
  });

  it('reads Home only for exactly Home, and Custom for anything else, including nowhere', () => {
    expect(atmosphereShowOnMode(['home'], 'picture')).toBe('home');
    expect(atmosphereShowOnMode(['home', 'sessions'], 'picture')).toBe(
      'custom',
    );
    expect(atmosphereShowOnMode([], 'picture')).toBe('custom');
  });

  it('writes all five places for Everywhere and only Home for Home only; Custom keeps the current set', () => {
    expect(atmosphereShowOnPlaces('everywhere', ['home'])).toEqual([
      ...ATMOSPHERE_PLACES,
    ]);
    expect(atmosphereShowOnPlaces('home', [...ATMOSPHERE_PLACES])).toEqual([
      'home',
    ]);
    expect(atmosphereShowOnPlaces('custom', ['projects', 'home'])).toEqual([
      'projects',
      'home',
    ]);
  });

  it('keeps Sessions and Other pages unavailable to the Planet, which is a Home composition', () => {
    expect(isAtmospherePlaceAvailable('sessions', 'planet')).toBe(false);
    expect(isAtmospherePlaceAvailable('pages', 'planet')).toBe(false);
    expect(isAtmospherePlaceAvailable('projects', 'planet')).toBe(true);
    expect(isAtmospherePlaceAvailable('pages', 'picture')).toBe(true);
  });
});
