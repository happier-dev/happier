import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { findTranscriptEncryptedMessageByLocalIdV2 } from './transcriptMessageLookup';

describe('transcript lookup strict message parsing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
