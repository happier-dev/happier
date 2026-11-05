import { describe, expect, it } from 'vitest';
import {
  ATMOSPHERE_PICTURES,
  releaseLook,
} from '@happier-dev/brand/atmosphere';
import {
  DEFAULT_HOME_ATMOSPHERE,
  type HomeAtmosphere,
} from '@happier-dev/protocol/account/settings/accountSettings';
import {
  changedPictureLookControls,
  effectivePictureLook,
  withPicture,
  withPictureLook,
  withShuffledPicture,
  withoutPictureLook,
} from './atmosphereEdits';
import { buildHomeAtmosphereControlMutation, homeAtmosphereStorageBinding } from '../atmosphereSettings';
import { projectAtmosphereEdit } from './projectAtmosphereEdit';
import { settingsDefaults } from '@/sync/domains/settings/settings';

const pictures = ATMOSPHERE_PICTURES;
const painting = pictures.find((picture) => picture.kind === 'painting')!;
const release = releaseLook(painting);
const otherLook = release.effect === 'halftone' ? 'mosaic' : 'halftone';
const onPainting: HomeAtmosphere = withPicture(DEFAULT_HOME_ATMOSPHERE, {
  kind: 'builtin',
  id: painting.id,
});

describe('Look edits: per-picture memory keeps only what differs from the release look', () => {
  it('uses the same layout defaults for complete Home and Project edits and preserves explicit place edits', () => {
    const binding = homeAtmosphereStorageBinding('appearance.homeAtmosphere');
    if (binding.scope !== 'account' || !('mutate' in binding)) throw new Error('Missing Home mutation owner');
    const next = { ...DEFAULT_HOME_ATMOSPHERE, picture: { ...DEFAULT_HOME_ATMOSPHERE.picture, layout: 'wallpaper' as const } };
    expect(binding.mutate(settingsDefaults, next)?.homeAtmosphere?.showOn).toEqual(['home', 'new-session', 'projects', 'sessions', 'pages']);
    expect(projectAtmosphereEdit(DEFAULT_HOME_ATMOSPHERE, 'home', current => ({ ...current,
      picture: { ...current.picture, layout: 'wallpaper' } })).showOn).toEqual(['home', 'new-session', 'projects', 'sessions', 'pages']);
    expect(binding.mutate(settingsDefaults, { ...next, showOn: ['pages'] })?.homeAtmosphere?.showOn).toEqual(['pages']);
  });
  it('preserves an absent plugin release across unrelated Home and Project edits and reappearance', () => {
    const plugin = { id: 'com.acme/sky', look: { effect: 'original', strength: 0.5, dissolve: { style: 'gradient' } } } as const;
    const authored: HomeAtmosphere = { ...DEFAULT_HOME_ATMOSPHERE, source: 'picture',
      picture: { ...DEFAULT_HOME_ATMOSPHERE.picture, ref: { kind: 'builtin', id: plugin.id } },
      looks: { [plugin.id]: { look: 'fine', strength: 1, dissolve: 'ordered' } } };
    const home = buildHomeAtmosphereControlMutation({ ...settingsDefaults, homeAtmosphere: authored }, 'appearance.atmospherePlanetPlacement', 'side')?.homeAtmosphere;
    expect(home?.looks).toEqual(authored.looks);
    const project = projectAtmosphereEdit(authored, undefined, current => ({ ...current, showOn: ['home', 'new-session', 'projects', 'sessions'] }));
    expect(project.looks).toEqual(authored.looks);
    expect(effectivePictureLook(project, [plugin])).toMatchObject({ effect: 'fine', strength: 1, fade: 'ordered' });
    expect(withPictureLook(authored, { strength: 0.7 }, []).looks[plugin.id]).toEqual({ look: 'fine', strength: 0.7, dissolve: 'ordered' });
  });
  it('remembers a changed look for this picture and forgets it once it matches the release again', () => {
    const changed = withPictureLook(onPainting, { look: otherLook }, pictures);
    expect(changed.looks).toEqual({ [painting.id]: { look: otherLook } });
    expect(effectivePictureLook(changed, pictures).effect).toBe(otherLook);
    expect(changedPictureLookControls(changed)).toEqual(['look']);
    const back = withPictureLook(changed, { look: release.effect }, pictures);
    expect(back.looks).toEqual({});
    expect(effectivePictureLook(back, pictures).effect).toBe(release.effect);
  });

  it('applies custom strengths as set and resets only the current picture', () => {
    const other = pictures.find((picture) => picture.id !== painting.id)!;
    const elsewhere = withPictureLook(
      withPicture(onPainting, { kind: 'builtin', id: other.id }),
      { strength: 0.4 },
      pictures,
    );
    const both = withPictureLook(
      withPicture(elsewhere, { kind: 'builtin', id: painting.id }),
      { strength: 2.4, dissolve: 'rows' },
      pictures,
    );
    expect(both.looks[painting.id]).toEqual({
      strength: 2.4,
      dissolve: 'rows',
    });
    expect(effectivePictureLook(both, pictures)).toMatchObject({
      strength: 2.4,
      fade: 'rows',
    });
    const reset = withoutPictureLook(both);
    expect(reset.looks).toEqual({ [other.id]: { strength: 0.4 } });
    expect(reset.moments).toBe(both.moments);
  });

  it('gives your own picture the default release look, remembered under its device-local id', () => {
    const own = withPictureLook(
      withPicture(onPainting, { kind: 'user', localId: 'device-photo' }),
      { look: 'engraving' },
      pictures,
    );
    expect(own.source).toBe('picture');
    expect(own.looks['device-photo']).toEqual({ look: 'engraving' });
    expect(effectivePictureLook(own, pictures).effect).toBe('engraving');
    expect(
      withPictureLook(own, { look: releaseLook({}).effect }, pictures).looks[
        'device-photo'
      ],
    ).toBeUndefined();
  });

  it('shuffles to another built-in picture, never the current one', () => {
    for (const random of [0, 0.5, 0.999]) {
      const next = withShuffledPicture(onPainting, pictures, () => random);
      expect(next.source).toBe('picture');
      expect(next.picture.ref).toMatchObject({ kind: 'builtin' });
      expect(next.picture.ref).not.toEqual({
        kind: 'builtin',
        id: painting.id,
      });
    }
  });
});
