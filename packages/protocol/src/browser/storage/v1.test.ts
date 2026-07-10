import { describe, expect, it } from 'vitest';

async function loadStorageModule() {
  return import('./v1.js').catch(() => null);
}

describe('browser storage v1 protocol', () => {
  it('serializes storage partitions without storing cookie jars in preview proxy state', async () => {
    const mod = await loadStorageModule();

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserStoragePartitionV1Schema.safeParse({
      partitionId: 'partition_1',
      profileId: 'profile_1',
      originKey: 'https://preview.example.test',
      targetKind: 'localServicePreview',
      persistence: 'session',
      state: 'active',
      createdAt: 1_000,
      updatedAt: 1_100,
      expiresAt: 2_000,
    });

    expect(result.success).toBe(true);
  });

  it('rejects page URLs where storage partitions require origin keys', async () => {
    const mod = await loadStorageModule();

    expect(mod).not.toBeNull();
    if (!mod) return;

    const result = mod.BrowserStoragePartitionV1Schema.safeParse({
      partitionId: 'partition_1',
      profileId: 'profile_1',
      originKey: 'https://preview.example.test/dashboard',
      targetKind: 'localServicePreview',
      persistence: 'session',
      createdAt: 1_000,
      updatedAt: 1_100,
    });

    expect(result.success).toBe(false);
  });
});
