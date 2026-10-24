import { describe, expect, it } from 'vitest';

import { isPathExcludedFromIntelligence } from './pathExclusion';

describe('isPathExcludedFromIntelligence', () => {
  it('honours glob patterns in configured exclusions instead of matching them literally', () => {
    expect(isPathExcludedFromIntelligence('services/billing/secrets/keys.ts', ['**/secrets/'])).toBe(true);
    expect(isPathExcludedFromIntelligence('config/prod.yaml', ['config/*.yaml'])).toBe(true);
    expect(isPathExcludedFromIntelligence('config/nested/prod.yaml', ['config/*.yaml'])).toBe(false);
  });

  it('still excludes a path whose directory or file name contains a line break', () => {
    expect(isPathExcludedFromIntelligence('odd\ndir/secrets/keys.ts', ['**/secrets/'])).toBe(true);
    expect(isPathExcludedFromIntelligence('certs/odd\nname.pem', [])).toBe(true);
  });

  it('keeps plain configured entries as path prefixes', () => {
    expect(isPathExcludedFromIntelligence('internal/payroll/run.ts', ['internal/'])).toBe(true);
    expect(isPathExcludedFromIntelligence('src/app.ts', ['internal/'])).toBe(false);
  });
});
