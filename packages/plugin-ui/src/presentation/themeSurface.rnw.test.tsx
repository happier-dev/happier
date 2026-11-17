import { expect, it } from 'vitest';
import { SURFACE_CONTEXT_THEME_FIXTURE } from '@happier-dev/plugin-sdk/testing';
import { resolveHappierThemeSurfaceStyle } from './themeSurface.js';

it('resolves the already compiled native part and semantic state without applying it on web', () => {
  const base = { paddingTop: 7, backgroundColor: 'rgb(1, 2, 3)' };
  const disabled = { ...base, opacity: 0.4 };
  const theme = { ...SURFACE_CONTEXT_THEME_FIXTURE, surfaces: {
    composer: { root: { base, states: { disabled } } },
  } };
  expect(resolveHappierThemeSurfaceStyle(theme, { surface: 'composer', part: 'root' }, 'ios')).toBe(base);
  expect(resolveHappierThemeSurfaceStyle(theme, { surface: 'composer', part: 'root', state: 'disabled' }, 'android')).toBe(disabled);
  expect(resolveHappierThemeSurfaceStyle(theme, { surface: 'composer', part: 'toolbar' }, 'ios')).toBeUndefined();
  expect(resolveHappierThemeSurfaceStyle(theme, { surface: 'composer', part: 'root' }, 'web')).toBeUndefined();
  expect(resolveHappierThemeSurfaceStyle(SURFACE_CONTEXT_THEME_FIXTURE, { surface: 'composer', part: 'root' }, 'ios')).toBeUndefined();
});
