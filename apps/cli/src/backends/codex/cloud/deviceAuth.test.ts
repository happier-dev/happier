import { describe, expect, it, vi } from 'vitest';

import { authenticateCodexDevice, OPENAI_CODEX_DEVICE_REDIRECT_URI } from './deviceAuth';

describe('authenticateCodexDevice', () => {
  it('performs OpenAI device auth and exchanges for tokens', async () => {
    const fetchMock = vi.fn(async (url: any, init?: any) => {
      const u = String(url);
      if (u.includes('/api/accounts/deviceauth/usercode')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ device_auth_id: 'dev-1', user_code: 'ABCD-EFGH', interval: '1' }),
        } as any;
      }
      if (u.includes('/api/accounts/deviceauth/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ authorization_code: 'auth-code-1', code_verifier: 'verifier-1' }),
        } as any;
      }
      if (u.includes('/oauth/token')) {
        expect(String(init?.body ?? '')).toContain(`redirect_uri=${encodeURIComponent(OPENAI_CODEX_DEVICE_REDIRECT_URI)}`);
        expect(String(init?.body ?? '')).toContain('code_verifier=verifier-1');
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id_token: 'hdr.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0XzEifQ.sig',
            access_token: 'at',
            refresh_token: 'rt',
            expires_in: 60,
          }),
          text: async () => '',
        } as any;
      }
      throw new Error(`unexpected url: ${u}`);
    });

    const tokens = await authenticateCodexDevice({
      fetcher: fetchMock as any,
      now: 1700000000000,
      sleep: async () => {},
    });

    expect(tokens.refresh_token).toBe('rt');
    expect(tokens.access_token).toBe('at');
    expect(tokens.account_id).toBe('acct_1');
    expect(tokens.expires_in).toBe(60);
  });

  it('treats 403/404 device polling responses as pending and retries', async () => {
    let pollCalls = 0;
    const fetchMock = vi.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/api/accounts/deviceauth/usercode')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ device_auth_id: 'dev-1', user_code: 'ABCD-EFGH', interval: '1' }),
        } as any;
      }
      if (u.includes('/api/accounts/deviceauth/token')) {
        pollCalls++;
        if (pollCalls === 1) {
          return { ok: false, status: 403, json: async () => ({}) } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ authorization_code: 'auth-code-1', code_verifier: 'verifier-1' }),
        } as any;
      }
      if (u.includes('/oauth/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id_token: 'hdr.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0XzEifQ.sig',
            access_token: 'at',
            refresh_token: 'rt',
          }),
          text: async () => '',
        } as any;
      }
      throw new Error(`unexpected url: ${u}`);
    });

    const sleepSpy = vi.fn(async () => {});
    await authenticateCodexDevice({ fetcher: fetchMock as any, now: 1700000000000, sleep: sleepSpy });
    expect(pollCalls).toBe(2);
    expect(sleepSpy).toHaveBeenCalled();
  });
});
