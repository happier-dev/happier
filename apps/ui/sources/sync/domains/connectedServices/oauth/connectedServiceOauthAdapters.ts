import type { AuthCredentials } from '@/auth/storage/tokenStorage';

import tweetnacl from 'tweetnacl';

import {
  CONNECTED_ACCOUNT_DESCRIPTORS,
  encodeBase64,
  type ConnectedAccountDescriptor,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import { exchangeConnectedServiceOauthViaProxy } from '@/sync/api/account/apiConnectedServicesV2';

import { buildOauthRecordFromProxyPayload, parseConnectedServiceOauthProxyBundle } from './connectedServiceOauthProxyBundle';

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

export function buildConnectedAccountAuthorizationUrl(params: Readonly<{
  descriptor: ConnectedAccountDescriptor;
  redirectUri: string;
  state: string;
  challenge: string;
}>): string {
  if (!params.descriptor.oauth) {
    throw new Error(`Connected account does not support OAuth: ${params.descriptor.id}`);
  }
  const authorization = params.descriptor.oauth.authorization;
  const query = new URLSearchParams({
    ...authorization.query.extraParams,
    client_id: params.descriptor.oauth.publicClientId.defaultValue,
    response_type: authorization.query.responseType,
    redirect_uri: params.redirectUri,
    scope: authorization.scopes.join(' '),
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    state: params.state,
  });
  if (authorization.query.accessType) {
    query.set('access_type', authorization.query.accessType);
  }
  if (authorization.query.prompt) {
    query.set('prompt', authorization.query.prompt);
  }
  return `${authorization.endpointUrl}?${query.toString()}`;
}

function createDescriptorOauthAdapter(descriptor: ConnectedAccountDescriptor): ConnectedServiceOauthAdapter | null {
  if (!descriptor.oauth) return null;
  return Object.freeze({
    serviceId: descriptor.id,
    defaultRedirectUri: descriptor.oauth.authorization.defaultRedirectUri,
    buildAuthorizationUrl: ({ redirectUri, state, challenge }) =>
      buildConnectedAccountAuthorizationUrl({ descriptor, redirectUri, state, challenge }),
    exchangeAuthorizationCodeForRecord: async ({ credentials, profileId, code, verifier, redirectUri, state, now }) => {
      return await exchangeOauthViaProxy({
        credentials,
        serviceId: descriptor.id,
        profileId,
        code,
        verifier,
        redirectUri,
        state,
        now,
      });
    },
  });
}

const ADAPTERS_BY_SERVICE_ID: Readonly<Partial<Record<ConnectedServiceId, ConnectedServiceOauthAdapter>>> = Object.freeze(
  Object.fromEntries(
    CONNECTED_ACCOUNT_DESCRIPTORS
      .map((descriptor) => createDescriptorOauthAdapter(descriptor))
      .filter((adapter): adapter is ConnectedServiceOauthAdapter => adapter !== null)
      .map((adapter) => [adapter.serviceId, adapter]),
  ),
);

export function getConnectedServiceOauthAdapter(serviceId: ConnectedServiceId): ConnectedServiceOauthAdapter | null {
  return ADAPTERS_BY_SERVICE_ID[serviceId] ?? null;
}
