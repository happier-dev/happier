import { describe, expect, it, vi } from 'vitest';

import { isManagedProviderSessionInvocationCurrent, isRetainedManagedProviderInvocationCurrent } from './invocationCurrentness';

function currentness(overrides: Partial<Parameters<typeof isRetainedManagedProviderInvocationCurrent>[0]> = {}) {
  return {
    readsRetainedAuthorityCurrent: () => true,
    revalidatePolicy: vi.fn(async () => true),
    fenceRetainedPolicy: async () => undefined,
    readHardRevocationRevision: vi.fn(async () => 7),
    readGenerationIntegrityCurrentness: vi.fn(async () => true),
    hardRevocationRevisionAtAdmission: 7,
    ...overrides,
  };
}

describe('isRetainedManagedProviderInvocationCurrent', () => {
  it('does no Home policy or plugin filesystem reads across admitted model requests', async () => {
    const input = currentness();
    for (let request = 0; request < 3; request += 1) {
      await expect(isRetainedManagedProviderInvocationCurrent(input)).resolves.toBe(true);
    }
    expect(input.revalidatePolicy).not.toHaveBeenCalled();
    expect(input.readHardRevocationRevision).not.toHaveBeenCalled();
    expect(input.readGenerationIntegrityCurrentness).not.toHaveBeenCalled();
    // The pushed route withdrawal is the local authority for the next call.
    await expect(isRetainedManagedProviderInvocationCurrent({
      ...input, readsRetainedAuthorityCurrent: () => false,
    })).resolves.toBe(false);
  });

  it('uses initial admission only before adoption and the local route lifetime afterwards', async () => {
    let adopted = false;
    let active = true;
    const policy = vi.fn(async () => true);
    const input = {
      adoptionCommitted: () => adopted,
      revalidateInitialPolicy: policy,
      readsRetainedAuthorityCurrent: () => active,
      revalidateRetainedPolicy: policy,
      fenceRetainedPolicy: async () => undefined,
      readHardRevocationRevision: vi.fn(async () => 7),
      readGenerationIntegrityCurrentness: vi.fn(async () => true),
      hardRevocationRevisionAtAdmission: 7,
    };
    await expect(isManagedProviderSessionInvocationCurrent(input)).resolves.toBe(true);
    expect(policy).toHaveBeenCalledOnce();
    adopted = true;
    for (let request = 0; request < 3; request += 1) {
      await expect(isManagedProviderSessionInvocationCurrent(input)).resolves.toBe(true);
    }
    expect(policy).toHaveBeenCalledOnce();
    expect(input.readHardRevocationRevision).not.toHaveBeenCalled();
    expect(input.readGenerationIntegrityCurrentness).not.toHaveBeenCalled();
    active = false;
    await expect(isManagedProviderSessionInvocationCurrent(input)).resolves.toBe(false);
  });
});
