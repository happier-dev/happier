import { describe, expect, it, vi } from 'vitest';

vi.mock('@/configuration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/configuration')>();
  return {
    ...actual,
    configuration: new Proxy(actual.configuration, {
      get(target, property, receiver) {
        if (property === 'daemonReattachCatchUpConcurrency') {
          throw new Error('Existing-session lookup configuration was accessed during module import');
        }
        return Reflect.get(target, property, receiver);
      },
    }),
  };
});

import { resolveExistingSessionAttachContext } from './resolveExistingSessionAttachContext';

describe('resolveExistingSessionAttachContext import behavior', () => {
  it('does not create the existing-session lookup gate at module import time', async () => {
    expect(resolveExistingSessionAttachContext).toEqual(expect.any(Function));
  });
});
