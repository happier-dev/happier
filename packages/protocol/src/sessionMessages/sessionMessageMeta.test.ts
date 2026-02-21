import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

describe('sessionMessages meta', () => {
  it('parses unknown sentFrom/permissionMode without throwing', () => {
    const parsed = (protocol as any).SessionMessageMetaSchema.parse({
      source: 'cli',
      sentFrom: '__future__',
      permissionMode: '__future__',
      extra: 'x',
    });

    expect(parsed.sentFrom).toBe('unknown');
    expect(parsed.permissionMode).toBe('default');
    expect((parsed as any).extra).toBe('x');
  });
});

