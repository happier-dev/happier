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

  it('accepts cloud sessions without host/path', () => {
    const parsed = MetadataSchema.parse({
      name: 'cloud-session',
    } as any);

    expect(parsed.host).toBe('');
    expect(parsed.path).toBe('');
    expect(parsed.name).toBe('cloud-session');
  });

  it('accepts legacy metadata encoded as a JSON string', () => {
    const parsed = MetadataSchema.parse(JSON.stringify({ name: 'string-metadata' }) as any);
    expect(parsed.name).toBe('string-metadata');
    expect(parsed.host).toBe('');
    expect(parsed.path).toBe('');
  });
});
