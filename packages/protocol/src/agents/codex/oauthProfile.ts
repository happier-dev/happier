import {
  OPENAI_CODEX_AUTH_BASE_URL,
  OPENAI_CODEX_AUTHORIZE_URL,
  OPENAI_CODEX_CLIENT_ID,
  OPENAI_CODEX_DEVICE_REDIRECT_URI,
  OPENAI_CODEX_DEVICE_TOKEN_URL,
  OPENAI_CODEX_DEVICE_USER_CODE_URL,
  OPENAI_CODEX_DEVICE_VERIFICATION_URL,
  OPENAI_CODEX_SCOPE,
  OPENAI_CODEX_SCOPES,
  OPENAI_CODEX_TOKEN_URL,
} from '../../providers/codex/oauth.js';

/** Public, nonsecret OAuth and device-flow metadata shared by Codex authors. */
export const OPENAI_CODEX_OAUTH_PROFILE: Readonly<{
  authBaseUrl: string;
  authorizeUrl: string;
  clientId: string;
  scope: string;
  scopes: readonly string[];
  tokenUrl: string;
  device: Readonly<{
    redirectUri: string;
    tokenUrl: string;
    userCodeUrl: string;
    verificationUrl: string;
  }>;
}> = Object.freeze({
  authBaseUrl: OPENAI_CODEX_AUTH_BASE_URL,
  authorizeUrl: OPENAI_CODEX_AUTHORIZE_URL,
  clientId: OPENAI_CODEX_CLIENT_ID,
  scope: OPENAI_CODEX_SCOPE,
  scopes: OPENAI_CODEX_SCOPES,
  tokenUrl: OPENAI_CODEX_TOKEN_URL,
  device: Object.freeze({
    redirectUri: OPENAI_CODEX_DEVICE_REDIRECT_URI,
    tokenUrl: OPENAI_CODEX_DEVICE_TOKEN_URL,
    userCodeUrl: OPENAI_CODEX_DEVICE_USER_CODE_URL,
    verificationUrl: OPENAI_CODEX_DEVICE_VERIFICATION_URL,
  }),
});
