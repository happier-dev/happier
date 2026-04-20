import { afterEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { HttpStatusError } from '@/api/client/httpStatusError';
import type { Credentials } from '@/persistence';

describe('resolveForkCutoffSeqInclusive timeouts', () => {
  const prevServerUrl = process.env.HAPPIER_SERVER_URL;
  const prevTimeout = process.env.HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS;

  afterEach(() => {
    if (prevServerUrl === undefined) delete process.env.HAPPIER_SERVER_URL;
    else process.env.HAPPIER_SERVER_URL = prevServerUrl;

    if (prevTimeout === undefined) delete process.env.HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS;
    else process.env.HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS = prevTimeout;

    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('uses configuration.sessionControlHttpTimeoutMs for session message fetches', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    process.env.HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS = '54321';

    vi.resetModules();
    const { resolveForkCutoffSeqInclusive } = await import('./resolveForkCutoffSeqInclusive');

    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        messages: [
          {
            seq: 1,
            createdAt: 1,
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'hi' } } },
          },
        ],
      },
    } as any);

    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };

    await resolveForkCutoffSeqInclusive({
      credentials,
      parentSessionId: 'sess_parent_1',
      parentRawSession: { encryptionMode: 'plain', dataEncryptionKey: null },
      targetSeqInclusive: 1,
    });

    expect(getSpy).toHaveBeenCalledTimes(1);
    expect(getSpy.mock.calls[0]?.[1]?.timeout).toBe(54_321);
  });

  it('throws a stable auth status error for terminal auth failures', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';

    vi.resetModules();
    const { resolveForkCutoffSeqInclusive } = await import('./resolveForkCutoffSeqInclusive');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 403,
      data: {},
    } as any);

    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };

    await expect(
      resolveForkCutoffSeqInclusive({
        credentials,
        parentSessionId: 'sess_parent_1',
        parentRawSession: { encryptionMode: 'plain', dataEncryptionKey: null },
        targetSeqInclusive: 1,
      }),
    ).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 403 },
    } satisfies Partial<HttpStatusError>);
  });
});
