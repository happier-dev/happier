import { describe, expect, it, vi } from 'vitest';

import { activate } from './activate.js';

describe('activate', () => {
  it('registers the Cursor backend engine through the plugin API', async () => {
    const registerBackendEngine = vi.fn();

    activate({ registerBackendEngine });

    expect(registerBackendEngine).toHaveBeenCalledWith(expect.objectContaining({
      backendId: 'cursor',
      create: expect.any(Function),
    }));
  });
});
