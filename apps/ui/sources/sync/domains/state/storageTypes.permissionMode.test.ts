import { describe, expect, it } from 'vitest';

import { MetadataSchema } from './storageTypes';

describe('MetadataSchema (permissionMode forward compatibility)', () => {
  it('does not reject metadata when permissionMode is unknown', () => {
    const parsed = MetadataSchema.parse({
      path: '/tmp',
      host: 'localhost',
      permissionMode: '__unknown_mode__',
      permissionModeUpdatedAt: 123,
    } as any);

    expect((parsed as any).permissionMode).toBe('default');
    expect((parsed as any).permissionModeUpdatedAt).toBe(123);
  });
});
