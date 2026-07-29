import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';

describe('activate', () => {
  it('registers the manifest-local backend through the contribution API', () => {
    const registerBackend = vi.fn();

    activate({ scm: { registerBackend } } as Parameters<typeof activate>[0]);

    expect(registerBackend).toHaveBeenCalledOnce();
    expect(registerBackend).toHaveBeenCalledWith('git', expect.objectContaining({
      handlers: expect.any(Object),
      runtime: expect.objectContaining({ repoModes: ['.git'] }),
    }));
  });
});
