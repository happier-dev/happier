import { describe, expect, it, vi } from 'vitest';
import type { HttpService } from '@happier-dev/plugin-sdk/http';
import { OPENAI_CODEX_OAUTH_PROFILE } from '@happier-dev/plugin-sdk/connected-accounts';

import {
  authenticateCodexDevice,
} from './device.js';

function jsonResponse(
  url: string,
  status: number,
  value: unknown,
): Awaited<ReturnType<HttpService['request']>> {
  return {
    status,
    finalUrl: url,
    headers: {},
    body: new TextEncoder().encode(JSON.stringify(value)),
  };
}

describe('authenticateCodexDevice', () => {
  it('performs OpenAI device auth and exchanges for tokens', async () => {
    const request = vi.fn<HttpService['request']>(async (input) => {
      if (input.url.includes('/api/accounts/deviceauth/usercode')) {
        return jsonResponse(input.url, 200, {
          device_auth_id: 'dev-1',
          user_code: 'ABCD-EFGH',
          interval: '1',
        });
      }
      if (input.url.includes('/api/accounts/deviceauth/token')) {
        return jsonResponse(input.url, 200, {
          authorization_code: 'auth-code-1',
          code_verifier: 'verifier-1',
        });
      }
      if (input.url.includes('/oauth/token')) {
        const form = new URLSearchParams(new TextDecoder().decode(input.body));
        expect(form.get('redirect_uri')).toBe(OPENAI_CODEX_OAUTH_PROFILE.device.redirectUri);
        expect(form.get('code_verifier')).toBe('verifier-1');
        return jsonResponse(input.url, 200, {
          id_token: 'hdr.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0XzEifQ.sig',
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 60,
        });
      }
      throw new Error(`unexpected url: ${input.url}`);
    });

    const tokens = await authenticateCodexDevice({
      http: { request },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    });

    expect(tokens.refresh_token).toBe('rt');
    expect(tokens.access_token).toBe('at');
    expect(tokens.account_id).toBe('acct_1');
    expect(tokens.expires_in).toBe(60);
  });

  it('treats 403/404 device polling responses as pending and retries', async () => {
    let pollCalls = 0;
    const request = vi.fn<HttpService['request']>(async (input) => {
      if (input.url.includes('/api/accounts/deviceauth/usercode')) {
        return jsonResponse(input.url, 200, {
          device_auth_id: 'dev-1',
          user_code: 'ABCD-EFGH',
          interval: '1',
        });
      }
      if (input.url.includes('/api/accounts/deviceauth/token')) {
        pollCalls += 1;
        return pollCalls === 1
          ? jsonResponse(input.url, 403, {})
          : jsonResponse(input.url, 200, {
              authorization_code: 'auth-code-1',
              code_verifier: 'verifier-1',
            });
      }
      if (input.url.includes('/oauth/token')) {
        return jsonResponse(input.url, 200, {
          id_token: 'hdr.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0XzEifQ.sig',
          access_token: 'at',
          refresh_token: 'rt',
        });
      }
      throw new Error(`unexpected url: ${input.url}`);
    });

    const sleep = vi.fn(async () => {});
    await authenticateCodexDevice({
      http: { request },
      now: () => 1_700_000_000_000,
      sleep,
    });
    expect(pollCalls).toBe(2);
    expect(sleep).toHaveBeenCalledWith(4_000);
  });

  it('redacts token exchange failure response bodies', async () => {
    const request = vi.fn<HttpService['request']>(async (input) => {
      if (input.url.includes('/api/accounts/deviceauth/usercode')) {
        return jsonResponse(input.url, 200, {
          device_auth_id: 'dev-1',
          user_code: 'ABCD-EFGH',
          interval: '1',
        });
      }
      if (input.url.includes('/api/accounts/deviceauth/token')) {
        return jsonResponse(input.url, 200, {
          authorization_code: 'auth-code-1',
          code_verifier: 'verifier-1',
        });
      }
      if (input.url.includes('/oauth/token')) {
        return jsonResponse(input.url, 400, {
          error: 'invalid_grant',
          error_description: 'refresh token codex-device-secret-refresh was rejected',
          access_token: 'codex-device-secret-access',
          refresh_token: 'codex-device-secret-refresh',
        });
      }
      throw new Error(`unexpected url: ${input.url}`);
    });

    let caught: unknown = null;
    try {
      await authenticateCodexDevice({
        http: { request },
        now: () => 1_700_000_000_000,
        sleep: async () => {},
      });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toMatch(/Token exchange failed \(400\): invalid_grant/u);
    expect(String(caught)).not.toMatch(
      /codex-device-secret-refresh|codex-device-secret-access|error_description/u,
    );
  });
});
