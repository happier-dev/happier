import { describe, expect, it } from 'vitest';

import { updateMemorySynopsisPointerBestEffort } from './updateMemorySynopsisPointerBestEffort';

describe('updateMemorySynopsisPointerBestEffort', () => {
  it('writes memorySynopsisPointerV1 via metadata updater when a session row is available', async () => {
    let updatedMetadata: Record<string, unknown> | undefined;
    const rawSession = {
      metadata: JSON.stringify({ flavor: 'claude', path: '/tmp' }),
      metadataVersion: 0,
      encryptionMode: 'plain',
      dataEncryptionKey: null,
    };

    await updateMemorySynopsisPointerBestEffort({
      credentials: { token: 't', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) } } as any,
      sessionId: 'sess_1',
      synopsis: { seqTo: 10, updatedAtMs: 99 },
      deps: {
        fetchSessionById: async () => rawSession as any,
        updateSessionMetadataWithRetry: async (params: any) => {
          const next = params.updater(JSON.parse(rawSession.metadata));
          updatedMetadata = next;
          return { version: 1, metadata: next };
        },
      },
    });

    expect(updatedMetadata).toMatchObject({
      memorySynopsisPointerV1: { v: 1, localId: 'memory:synopsis:v1:10', seqTo: 10, updatedAtMs: 99 },
    });
  });
});
