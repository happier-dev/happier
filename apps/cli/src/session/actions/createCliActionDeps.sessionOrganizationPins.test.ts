import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionDeps } from './createCliActionDeps';

describe('headless Account Session pin Action', () => {
  it('pins an ordinary Session to the list without requiring an execution host or Bot metadata', async () => {
    const sessionId = 'c111111111111111111111111';
    const get = vi.spyOn(axios, 'get').mockRejectedValue(new Error('No execution host or metadata read is available'));
    const put = vi.spyOn(axios, 'put').mockResolvedValue({ status: 200, data: { pin: {
      sessionId, pinnedAt: 10, sortKey: 'a', listPinned: true, railPinned: false,
    } } });
    try {
      const executor = createActionExecutor(createCliActionDeps({
        token: 'token', credentials: { token: 'token', encryption: null },
        sessionId: 'cli-global', mode: 'plain', ctx: null, rawSession: {}, serverId: 'home1', serverHttpBaseUrl: 'https://home1.test',
      }));
      await expect(executor.execute('session.organization.pin.set', { sessionId, pinned: true }, {
        surface: 'cli', authority: 'account_automation', serverId: 'home1',
      })).resolves.toMatchObject({ ok: true, result: { pin: { listPinned: true, railPinned: false } } });
      expect(put).toHaveBeenCalledWith(expect.stringContaining(`/v2/session-organization/pins/${sessionId}`),
        { pinned: true }, expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token' }) }));
      expect(get).not.toHaveBeenCalled();
    } finally { get.mockRestore(); put.mockRestore(); }
  });

  it('refuses an exact Home mismatch before sending the personal pin mutation', async () => {
    const put = vi.spyOn(axios, 'put').mockRejectedValue(new Error('The foreign Home must not be reached'));
    try {
      const executor = createActionExecutor(createCliActionDeps({
        token: 'token', credentials: { token: 'token', encryption: null },
        sessionId: 'cli-global', mode: 'plain', ctx: null, rawSession: {}, serverId: 'home1', serverHttpBaseUrl: 'https://home1.test',
      }));
      await expect(executor.execute('session.organization.pin.set',
        { sessionId: 'c111111111111111111111111', pinned: false, surface: 'rail' }, {
          surface: 'cli', authority: 'account_automation', serverId: 'home2',
        })).resolves.toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
      expect(put).not.toHaveBeenCalled();
    } finally { put.mockRestore(); }
  });

  it('writes list/rail through HTTP and refuses ordinary rail-add without an execution host', async () => {
    const sessionId = 'c111111111111111111111111';
    let bot = true;
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (String(url).includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: { session: createSessionRecordFixture({
        id: sessionId, active: false, encryptionMode: 'plain', metadata: JSON.stringify({ bot: bot ? { kind: 'bot' } : undefined }),
      }) } };
      return { status: 404, data: {} };
    });
    const put = vi.spyOn(axios, 'put').mockImplementation(async (_url, data) => ({ status: 200, data: { pin: {
      sessionId, pinnedAt: 10, sortKey: 'a', listPinned: true, railPinned: (data as { pinned: boolean }).pinned,
    } } }));
    try {
      const deps = createCliActionDeps({ token: 'token', credentials: { token: 'token', encryption: null },
        sessionId: 'cli-global', mode: 'plain', ctx: null, rawSession: {}, serverId: 'home1', serverHttpBaseUrl: 'https://home1.test',
      });
      const executor = createActionExecutor(deps);
      const context = { surface: 'cli' as const, authority: 'account_automation' as const, serverId: 'home1' };
      await expect(executor.execute('session.organization.pin.set', { sessionId, surface: 'rail', pinned: true }, context))
        .resolves.toMatchObject({ ok: true, result: { pin: { listPinned: true, railPinned: true } } });
      expect(put).toHaveBeenLastCalledWith(expect.stringContaining(`/v2/session-organization/pins/${sessionId}`),
        { pinned: true, surface: 'rail' }, expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer token' }) }));
      bot = false;
      await expect(executor.execute('session.organization.pin.set', { sessionId, surface: 'rail', pinned: true }, context))
        .resolves.toMatchObject({ ok: false, errorCode: 'session_not_bot' });
      expect(put).toHaveBeenCalledTimes(1);
      await expect(executor.execute('session.organization.pin.set', { sessionId, surface: 'rail', pinned: false }, context))
        .resolves.toMatchObject({ ok: true, result: { pin: { listPinned: true, railPinned: false } } });
      expect(put).toHaveBeenCalledTimes(2);
    } finally { get.mockRestore(); put.mockRestore(); }
  });
});
