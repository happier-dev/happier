import { describe, expect, it } from 'vitest';

import { UpdateBodySchema } from './index.js';

function buildNewSessionUpdateBody(overrides: Record<string, unknown> = {}) {
  return {
    t: 'new-session',
    id: 's1',
    seq: 1,
    metadata: 'metadata',
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 1,
    dataEncryptionKey: null,
    active: true,
    activeAt: 1,
    createdAt: 1,
    updatedAt: 1,
    encryptionMode: 'plain',
    ...overrides,
  };
}

describe('session update payloads', () => {
  it('accepts legacy new-session updates without a storage encryption mode', () => {
    const parsed = UpdateBodySchema.parse(buildNewSessionUpdateBody({ encryptionMode: undefined }));

    expect(parsed.t).toBe('new-session');
    expect(parsed.encryptionMode).toBeUndefined();
  });

  it('accepts explicit plaintext new-session updates', () => {
    const parsed = UpdateBodySchema.parse(buildNewSessionUpdateBody({ encryptionMode: 'plain' }));

    expect(parsed.encryptionMode).toBe('plain');
  });

  it('types the split metadata layout and owner envelope on new-session updates', () => {
    const parsed = UpdateBodySchema.safeParse(buildNewSessionUpdateBody({
      metadataLayoutVersion: 1,
      ownerMetadata: {
        t: 'plain',
        v: { v: 1 },
      },
    }));

    expect(parsed.success).toBe(true);
    expect(UpdateBodySchema.safeParse(buildNewSessionUpdateBody({
      metadataLayoutVersion: 1,
      ownerMetadata: {
        t: 'encrypted',
        c: 'oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==',
      },
    })).success).toBe(true);
    expect(UpdateBodySchema.safeParse(buildNewSessionUpdateBody({
      metadataLayoutVersion: '1',
      ownerMetadata: {
        t: 'plain',
        v: { v: 1 },
      },
    })).success).toBe(false);
    expect(UpdateBodySchema.safeParse(buildNewSessionUpdateBody({
      metadataLayoutVersion: 1,
      ownerMetadata: 42,
    })).success).toBe(false);
    expect(UpdateBodySchema.safeParse(buildNewSessionUpdateBody({
      metadataLayoutVersion: 1,
      ownerMetadata:
        'oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==',
    })).success).toBe(false);
  });
});
