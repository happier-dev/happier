import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { findTranscriptEncryptedMessageByLocalIdV2 } from './transcriptMessageLookup';

describe('transcript lookup strict message parsing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { v: 1, kind: 'manual_handled' },
    { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: {
      v: 1, acceptedAtMs: 100, delivery: { kind: 'newTurn', turnId: 'native-turn' },
    } } },
  ])('preserves explicit delivery resolution $kind from the exact read', async (deliveryResolution) => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({ status: 200, data: { message: {
      id: 'm1', seq: 1, localId: 'local-1', createdAt: 100, updatedAt: 101,
      content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } },
      deliveryResolution,
    } } });
    await expect(findTranscriptEncryptedMessageByLocalIdV2({ token: 'token',
      serverUrl: 'https://server.example', sessionId: 'sid', localId: 'local-1',
    })).resolves.toMatchObject({ type: 'found', message: { deliveryResolution } });
  });

  it('rejects fractional transcript timestamps instead of silently truncating them', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        message: {
          id: 'm1',
          seq: 1,
          localId: 'local-1',
          sidechainId: null,
          createdAt: 111.5,
          updatedAt: 222.5,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'hi' } } },
        },
      },
    });

    await expect(findTranscriptEncryptedMessageByLocalIdV2({
      token: 'token',
      serverUrl: 'https://server.example',
      sessionId: 'sid',
      localId: 'local-1',
    })).resolves.toMatchObject({ type: 'protocol_error' });
  });
});
