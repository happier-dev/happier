import fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { sendSessionMessage } from './sendSessionMessage';

describe('ordinary Session Send selected pending target', () => {
  it('derives the exact Machine from requester-owned metadata and freezes it into ordinary admission', async () => {
    const app = fastify();
    const sessionId = 'c123456789012345678901234';
    const origin = 'http://requester-send.test';
    const requests: Array<{ targetMachineId?: string; localId?: string }> = [];
    app.addHook('onRequest', async request => {
      expect(request.headers.authorization).toBe('Bearer bob-ordinary');
    });
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get(`/v2/sessions/${sessionId}`, async () => ({ session: createSessionRecordFixture({
      id: sessionId, active: true, encryptionMode: 'plain', dataEncryptionKey: null,
      metadata: JSON.stringify({ machineId: 'selected-alice-machine', path: '/workspace', flavor: 'codex' }),
    }) }));
    app.post(`/v2/sessions/${sessionId}/pending`, async request => {
      const body = request.body as { targetMachineId?: string; localId?: string; requestedAction: unknown };
      requests.push(body);
      return { didWrite: true, pending: { localId: body.localId }, requestedAction: body.requestedAction };
    });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin });
    try {
      expect(await runWithServerHttpBaseUrl(origin, () => sendSessionMessage({ credentials: { token: 'bob-ordinary', encryption: null },
        idOrPrefix: sessionId, message: 'hello', localId: 'selected-input', wait: false, timeoutMs: 1000,
      }))).toMatchObject({ ok: true, localId: 'selected-input' });
      expect(requests).toEqual([expect.objectContaining({ targetMachineId: 'selected-alice-machine', localId: 'selected-input' })]);
      requests.length = 0;
      expect(await runWithServerHttpBaseUrl(origin, () => sendSessionMessage({ credentials: { token: 'bob-ordinary', encryption: null },
        idOrPrefix: sessionId, message: 'hello', targetMachineId: 'wrong-machine',
        localId: 'wrong-input', wait: false, timeoutMs: 1000,
      }))).toMatchObject({ ok: false, admissionResult: { status: 'rejected', code: 'session_input_target_unavailable' } });
      expect(requests).toEqual([]);
    } finally {
      restore();
      await app.close();
    }
  });
});
