import { describe, expect, it } from 'vitest';

describe('connected service quota snapshot schema', () => {
  it('exports a quota snapshot schema', async () => {
    const mod: any = await import('./connectedServiceSchemas.js');
    expect(mod.ConnectedServiceQuotaSnapshotV1Schema).toBeDefined();
  });
});

