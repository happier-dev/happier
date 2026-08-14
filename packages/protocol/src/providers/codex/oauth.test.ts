import { describe, expect, it } from 'vitest';

import {
  OPENAI_CODEX_AUTH_BASE_URL,
  OPENAI_CODEX_CALLBACK_URL,
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_DEVICE_REDIRECT_URI,
  OPENAI_CODEX_DEVICE_TOKEN_URL,
  OPENAI_CODEX_DEVICE_USER_CODE_URL,
  OPENAI_CODEX_DEVICE_VERIFICATION_URL,
  OPENAI_CODEX_SCOPE,
  OPENAI_CODEX_TOKEN_URL,
} from './oauth';

describe('OpenAI Codex OAuth facts', () => {
  it('matches the current Codex CLI OAuth contract', () => {
    expect(OPENAI_CODEX_CLIENT_ID).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(OPENAI_CODEX_AUTH_BASE_URL).toBe('https://auth.openai.com');
    expect(OPENAI_CODEX_CALLBACK_URL).toBe('http://localhost:1455/auth/callback');
    expect(OPENAI_CODEX_TOKEN_URL).toBe('https://auth.openai.com/oauth/token');
    expect(OPENAI_CODEX_DEVICE_USER_CODE_URL).toBe('https://auth.openai.com/api/accounts/deviceauth/usercode');
    expect(OPENAI_CODEX_DEVICE_TOKEN_URL).toBe('https://auth.openai.com/api/accounts/deviceauth/token');
    expect(OPENAI_CODEX_DEVICE_VERIFICATION_URL).toBe('https://auth.openai.com/codex/device');
    expect(OPENAI_CODEX_DEVICE_REDIRECT_URI).toBe('https://auth.openai.com/deviceauth/callback');
    expect(OPENAI_CODEX_SCOPE).toBe('openid profile email offline_access');
  });
});
