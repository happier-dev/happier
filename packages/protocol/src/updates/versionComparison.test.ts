import { describe, expect, it } from 'vitest';

import { isNewerVersion } from './versionComparison.js';

describe('update version availability', () => {
  it('reports comparable upgrades and leaves unsupported version formats unknown', () => {
    expect(isNewerVersion('1.2.3', '1.2.4')).toBe(true);
    expect(isNewerVersion('1.2.4', '1.2.3')).toBe(false);
    expect(isNewerVersion('1.2.3-dev.1', '1.2.3-preview.1')).toBe(true);
    expect(isNewerVersion('1.2.3-beta.1', '1.2.3')).toBe(false);
    expect(isNewerVersion('1.2.3', '1.2.4-beta.1')).toBe(false);
    expect(isNewerVersion('unknown', '1.2.4')).toBe(false);
  });
});
