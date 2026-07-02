import { describe, expect, it } from 'vitest';

import * as metadataWriters from './metadataWriters.js';

describe('metadataWriters', () => {
  it('applies final backend launch session-state updates through canonical metadata bindings', () => {
    const applySessionStateUpdatesToMetadata = (
      metadataWriters as Readonly<Record<string, unknown>>
    ).applySessionStateUpdatesToMetadata;

    expect(typeof applySessionStateUpdatesToMetadata).toBe('function');
    if (typeof applySessionStateUpdatesToMetadata !== 'function') return;

    const metadata = applySessionStateUpdatesToMetadata(
      { existing: true },
      [
        {
          fieldId: 'identity.runtimeDescriptor',
          value: {
            v: 1,
            providerId: 'codex',
            provider: {
              backendMode: 'appServer',
              providerSessionId: 'vendor-parent-1',
            },
          },
        },
        {
          fieldId: 'identity.providerSessionId',
          value: 'vendor-child-1',
        },
        {
          fieldId: 'intent.permissionMode',
          value: {
            v: 1,
            permissionMode: 'plan',
            updatedAt: 123,
          },
        },
      ],
    );

    expect(metadata).toMatchObject({
      existing: true,
      codexSessionId: 'vendor-child-1',
      permissionMode: 'plan',
      permissionModeUpdatedAt: 123,
    });
  });
});
