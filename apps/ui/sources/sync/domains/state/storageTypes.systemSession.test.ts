import { describe, expect, it } from 'vitest';

import { readSystemSessionMetadataFromMetadata } from '@happier-dev/protocol';
import { MetadataSchema } from './storageTypes';

describe('MetadataSchema (systemSessionV1)', () => {
  it('preserves unknown systemSessionV1 fields for forward compatibility', () => {
    const parsed = MetadataSchema.parse({
      path: '/tmp',
      host: 'localhost',
      systemSessionV1: { v: 1, key: 'voice_carrier', hidden: true, extra: 'x' },
    } as any);

    expect((parsed as any).systemSessionV1?.extra).toBe('x');

    const system = readSystemSessionMetadataFromMetadata({ metadata: parsed });
    expect((system as any)?.extra).toBe('x');
  });

  it('preserves unknown top-level metadata fields for forward compatibility', () => {
    const parsed = MetadataSchema.parse({
      path: '/tmp',
      host: 'localhost',
      tag: 'MyTag',
    } as any);

    expect((parsed as any).tag).toBe('MyTag');
  });
});
