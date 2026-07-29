import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';

describe('activate', () => {
  it('registers the manifest-local hosting provider through the contribution API', () => {
    const registerHostingProvider = vi.fn();

    // Boundary fixture intentionally supplies only the activation surface exercised here.
    activate({
      scm: { registerHostingProvider },
      connectedAccounts: { register: vi.fn() },
    } as Parameters<typeof activate>[0]);

    expect(registerHostingProvider).toHaveBeenCalledOnce();
    expect(registerHostingProvider).toHaveBeenCalledWith('github', expect.objectContaining({
      adapter: expect.any(Object),
    }));
    expect(registerHostingProvider.mock.calls[0]?.[1]).not.toHaveProperty('auth');
  });
});
