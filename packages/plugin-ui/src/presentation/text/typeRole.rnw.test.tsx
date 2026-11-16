import { describe, expect, it } from 'vitest';
import { SURFACE_CONTEXT_THEME_FIXTURE } from '@happier-dev/plugin-sdk/testing';

import type { HappierTypeRole, HappierUiTypography } from '../../environment/types.js';
import { HAPPIER_TYPE_SCALE, HAPPIER_TYPE_WEIGHT } from './typeScale.js';
import { resolveHappierTypeRoleStyle } from './typeRole.js';

const roles = Object.keys(HAPPIER_TYPE_SCALE) as HappierTypeRole[];
const hostTypography: HappierUiTypography = Object.fromEntries(roles.map(role => [role, {
  ...HAPPIER_TYPE_SCALE[role],
  fontFamily: 'Host-Regular',
}])) as HappierUiTypography;
const resolvedTheme = {
  ...SURFACE_CONTEXT_THEME_FIXTURE,
  typography: {
    ...SURFACE_CONTEXT_THEME_FIXTURE.typography,
    body: { ...SURFACE_CONTEXT_THEME_FIXTURE.typography.body, fontFamily: 'Theme Sans' },
  },
};

describe('resolved theme typeface at the shared type-role owner', () => {
  it('uses the resolved normal family for hosted text while preserving role metrics', () => {
    for (const role of roles) {
      const baseline = resolveHappierTypeRoleStyle(role, SURFACE_CONTEXT_THEME_FIXTURE, null);
      const resolved = resolveHappierTypeRoleStyle(role, resolvedTheme, null);
      expect(resolved.fontFamily).toBe('Theme Sans');
      expect(resolved.fontSize).toBe(baseline.fontSize);
      expect(resolved.lineHeight).toBe(baseline.lineHeight);
      expect(resolved.letterSpacing).toBe(baseline.letterSpacing);
    }
    const weightedTheme = { ...resolvedTheme, typography: { ...resolvedTheme.typography,
      title: { ...resolvedTheme.typography.title, fontFamily: 'Theme-SemiBold' },
    } };
    expect(resolveHappierTypeRoleStyle('heading', weightedTheme, null).fontFamily).toBe('Theme-SemiBold');
  });

  it('retains the supplied same-realm weighted face and applies numeric emphasis on hosted text', () => {
    const typography: HappierUiTypography = { ...hostTypography, weights: {
      regular: { fontFamily: 'Host-Regular' }, medium: { fontFamily: 'Host-Medium' },
      semiBold: { fontFamily: 'Host-SemiBold' },
    } };
    expect(resolveHappierTypeRoleStyle('body', SURFACE_CONTEXT_THEME_FIXTURE, typography, 'semiBold').fontFamily)
      .toBe('Host-SemiBold');
    expect(resolveHappierTypeRoleStyle('body', resolvedTheme, typography, 'semiBold'))
      .toMatchObject({ fontFamily: 'Host-SemiBold' });
    expect(resolveHappierTypeRoleStyle('body', resolvedTheme, null, 'semiBold'))
      .toMatchObject({ fontFamily: 'Theme Sans', fontWeight: HAPPIER_TYPE_WEIGHT.semiBold });
  });
});
