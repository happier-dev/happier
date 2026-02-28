import type { AuthCredentials } from '@/auth/storage/tokenStorage';

import tweetnacl from 'tweetnacl';

import {
  buildConnectedServiceCredentialRecord,
  encodeBase64,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import { exchangeConnectedServiceOauthViaProxy } from '@/sync/api/account/apiConnectedServicesV2';

import { buildOauthRecordFromProxyPayload, parseConnectedServiceOauthProxyBundle } from './connectedServiceOauthProxyBundle';

import { buildClaudeSubscriptionAuthorizationUrl, CLAUDE_SUBSCRIPTION_OAUTH } from './claudeSubscriptionOauth';
import { buildGeminiAuthorizationUrl, exchangeGeminiTokens, GEMINI_OAUTH } from './geminiOauth';
import { buildOpenAiCodexAuthorizationUrl, exchangeOpenAiCodexTokens, OPENAI_CODEX_OAUTH } from './openAiCodexOauth';

export type ConnectedServiceOauthAddMethod = 'device' | 'paste' | 'browser';
export type ConnectedServiceOauthMode = 'device' | 'paste' | 'embedded';

export type ConnectedServiceOauthAdapter = Readonly<{
  serviceId: ConnectedServiceId;
  defaultRedirectUri: string;
  buildAuthorizationUrl: (params: Readonly<{
    redirectUri: string;
    state: string;
    challenge: string;
  }>) => string;
  exchangeAuthorizationCodeForRecord: (params: Readonly<{
    credentials: AuthCredentials;
    profileId: string;
    code: string;
    verifier: string;
    redirectUri: string;
    state: string;
    now: number;
  }>) => Promise<ConnectedServiceCredentialRecordV1>;
}>;

const OPENAI_CODEX_ADAPTER: ConnectedServiceOauthAdapter = Object.freeze({
  serviceId: 'openai-codex',
  defaultRedirectUri: OPENAI_CODEX_OAUTH.defaultRedirectUri,
  buildAuthorizationUrl: ({ redirectUri, state, challenge }) =>
    buildOpenAiCodexAuthorizationUrl({ redirectUri, state, challenge }),
  exchangeAuthorizationCodeForRecord: async ({ profileId, code, verifier, redirectUri, state: _state, now }) => {
    const tokens = await exchangeOpenAiCodexTokens({ code, verifier, redirectUri, now });
    return buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId,
      kind: 'oauth',
      expiresAt: tokens.expiresAt,
      oauth: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        idToken: tokens.idToken,
        scope: null,
        tokenType: null,
        providerAccountId: tokens.providerAccountId,
        providerEmail: null,
      },
    });
  },
});

const GEMINI_ADAPTER: ConnectedServiceOauthAdapter = Object.freeze({
  serviceId: 'gemini',
  defaultRedirectUri: GEMINI_OAUTH.defaultRedirectUri,
  buildAuthorizationUrl: ({ redirectUri, state, challenge }) =>
    buildGeminiAuthorizationUrl({ redirectUri, state, challenge }),
  exchangeAuthorizationCodeForRecord: async ({ profileId, code, verifier, redirectUri, state: _state, now }) => {
    const tokens = await exchangeGeminiTokens({ code, verifier, redirectUri, now });
    return buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'gemini',
      profileId,
      kind: 'oauth',
      expiresAt: tokens.expiresAt,
      oauth: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        idToken: tokens.idToken,
        scope: tokens.scope,
        tokenType: tokens.tokenType,
        providerAccountId: null,
        providerEmail: null,
      },
    });
  },
});

const CLAUDE_SUBSCRIPTION_ADAPTER: ConnectedServiceOauthAdapter = Object.freeze({
  serviceId: 'claude-subscription',
  defaultRedirectUri: CLAUDE_SUBSCRIPTION_OAUTH.defaultRedirectUri,
  buildAuthorizationUrl: ({ redirectUri, state, challenge }) =>
    buildClaudeSubscriptionAuthorizationUrl({ redirectUri, state, challenge }),
  exchangeAuthorizationCodeForRecord: async ({ credentials, profileId, code, verifier, redirectUri, state, now }) => {
    const keyPair = tweetnacl.box.keyPair();
    const publicKeyB64Url = encodeBase64(keyPair.publicKey, 'base64url');
    const exchanged = await exchangeConnectedServiceOauthViaProxy(credentials, {
      serviceId: 'claude-subscription',
      publicKey: publicKeyB64Url,
      code,
      verifier,
      redirectUri,
      state,
    });
    const payload = parseConnectedServiceOauthProxyBundle({
      bundleB64Url: exchanged.bundle,
      recipientSecretKey: keyPair.secretKey,
    });
    if (payload.serviceId !== 'claude-subscription') {
      throw new Error('OAuth bundle service mismatch');
    }
    return buildOauthRecordFromProxyPayload({
      now,
      serviceId: 'claude-subscription',
      profileId,
      payload,
    });
  },
});

const ADAPTERS_BY_SERVICE_ID: Readonly<Partial<Record<ConnectedServiceId, ConnectedServiceOauthAdapter>>> = Object.freeze({
  'openai-codex': OPENAI_CODEX_ADAPTER,
  gemini: GEMINI_ADAPTER,
  'claude-subscription': CLAUDE_SUBSCRIPTION_ADAPTER,
});

export function getConnectedServiceOauthAdapter(serviceId: ConnectedServiceId): ConnectedServiceOauthAdapter | null {
  return ADAPTERS_BY_SERVICE_ID[serviceId] ?? null;
}
