import { describe, expect, it } from 'vitest';

import { MessageMetaSchema } from './messageMetaTypes';

describe('MessageMetaSchema (forward compatibility)', () => {
  it('does not reject unknown permissionMode or sentFrom', () => {
    const parsed = MessageMetaSchema.parse({
      source: 'cli',
      sentFrom: '__future_client__',
      permissionMode: '__future_permission_mode__',
    } as any);

    expect(parsed.sentFrom).toBe('unknown');
    expect((parsed as any).permissionMode).toBe('default');
  });
});

