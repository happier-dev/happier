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
import { buildGeminiAuthorizationUrl, GEMINI_OAUTH } from './geminiOauth';
import { buildOpenAiCodexAuthorizationUrl, OPENAI_CODEX_OAUTH } from './openAiCodexOauth';

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

async function exchangeOauthViaProxy(params: Readonly<{
  credentials: AuthCredentials;
  serviceId: ConnectedServiceId;
  profileId: string;
  code: string;
  verifier: string;
  redirectUri: string;
  state: string;
  now: number;
}>): Promise<Extract<ConnectedServiceCredentialRecordV1, { kind: 'oauth' }>> {
  const keyPair = tweetnacl.box.keyPair();
  const publicKeyB64Url = encodeBase64(keyPair.publicKey, 'base64url');
  const exchanged = await exchangeConnectedServiceOauthViaProxy(params.credentials, {
    serviceId: params.serviceId,
    publicKey: publicKeyB64Url,
    code: params.code,
    verifier: params.verifier,
    redirectUri: params.redirectUri,
    state: params.state,
  });
  const payload = parseConnectedServiceOauthProxyBundle({
    bundleB64Url: exchanged.bundle,
    recipientSecretKey: keyPair.secretKey,
  });
  if (payload.serviceId !== params.serviceId) {
    throw new Error('OAuth bundle service mismatch');
  }
  return buildOauthRecordFromProxyPayload({
    now: params.now,
    serviceId: params.serviceId,
    profileId: params.profileId,
    payload,
  });
}

const OPENAI_CODEX_ADAPTER: ConnectedServiceOauthAdapter = Object.freeze({
  serviceId: 'openai-codex',
  defaultRedirectUri: OPENAI_CODEX_OAUTH.defaultRedirectUri,
  buildAuthorizationUrl: ({ redirectUri, state, challenge }) =>
    buildOpenAiCodexAuthorizationUrl({ redirectUri, state, challenge }),
  exchangeAuthorizationCodeForRecord: async ({ credentials, profileId, code, verifier, redirectUri, state, now }) => {
    return await exchangeOauthViaProxy({
      credentials,
      serviceId: 'openai-codex',
      profileId,
      code,
      verifier,
      redirectUri,
      state,
      now,
    });
  },
});

const GEMINI_ADAPTER: ConnectedServiceOauthAdapter = Object.freeze({
  serviceId: 'gemini',
  defaultRedirectUri: GEMINI_OAUTH.defaultRedirectUri,
  buildAuthorizationUrl: ({ redirectUri, state, challenge }) =>
    buildGeminiAuthorizationUrl({ redirectUri, state, challenge }),
  exchangeAuthorizationCodeForRecord: async ({ credentials, profileId, code, verifier, redirectUri, state, now }) => {
    return await exchangeOauthViaProxy({
      credentials,
      serviceId: 'gemini',
      profileId,
      code,
      verifier,
      redirectUri,
      state,
      now,
    });
  },
});

const CLAUDE_SUBSCRIPTION_ADAPTER: ConnectedServiceOauthAdapter = Object.freeze({
  serviceId: 'claude-subscription',
  defaultRedirectUri: CLAUDE_SUBSCRIPTION_OAUTH.defaultRedirectUri,
  buildAuthorizationUrl: ({ redirectUri, state, challenge }) =>
    buildClaudeSubscriptionAuthorizationUrl({ redirectUri, state, challenge }),
  exchangeAuthorizationCodeForRecord: async ({ credentials, profileId, code, verifier, redirectUri, state, now }) => {
    return await exchangeOauthViaProxy({
      credentials,
      serviceId: 'claude-subscription',
      profileId,
      code,
      verifier,
      redirectUri,
      state,
      now,
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
