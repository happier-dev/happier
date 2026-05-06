import { describe, expect, it } from 'vitest';

describe('Azure DevOps installables exports', () => {
  it('exposes the dep.az descriptor through the provider-owned protocol path', async () => {
    const mod = await import('./installables.js').catch(() => null);

    expect(mod).not.toBeNull();
    if (!mod) return;
    expect(mod.AZ_DEP_ID).toBe('dep.az');
    expect(mod.AZ_BINARY_NAME).toBe('az');
    expect(mod.AZ_INSTALLABLE_DESCRIPTOR).toEqual(expect.objectContaining({
      key: 'az',
      capabilityId: 'dep.az',
      source: expect.objectContaining({
        kind: 'manual_only',
      }),
      binary: expect.objectContaining({
        commands: ['az'],
        systemFirst: true,
        managedFallback: false,
      }),
    }));
  });
});
