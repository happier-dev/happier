import {
  ConnectedServiceCredentialRecordV1Schema,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from './connectedServiceSchemas.js';
import { requireConnectedAccountDescriptor, type ConnectedAccountDescriptor } from './connectedAccountDescriptors.js';

export function buildConnectedServiceCredentialRecord(
  params:
    | Readonly<{
        now: number;
        serviceId: ConnectedServiceId;
        profileId: string;
        kind: 'oauth';
        expiresAt?: number | null;
        oauth: Readonly<{
          accessToken: string;
          refreshToken: string;
          idToken: string | null;
          scope: string | null;
          tokenType: string | null;
          providerAccountId: string | null;
          providerEmail: string | null;
        }>;
      }>
    | Readonly<{
        now: number;
        serviceId: ConnectedServiceId;
        profileId: string;
        kind: 'token';
        token: Readonly<{
          token: string;
          providerAccountId: string | null;
          providerEmail: string | null;
        }>;
      }>,
): ConnectedServiceCredentialRecordV1 {
  const base = {
    v: 1 as const,
    serviceId: params.serviceId,
    profileId: params.profileId,
    createdAt: params.now,
    updatedAt: params.now,
    expiresAt: params.kind === 'oauth' ? (params.expiresAt ?? null) : null,
  };

  const record: unknown =
    params.kind === 'oauth'
      ? {
          ...base,
          kind: 'oauth' as const,
          oauth: {
            accessToken: params.oauth.accessToken,
            refreshToken: params.oauth.refreshToken,
            idToken: params.oauth.idToken,
            scope: params.oauth.scope,
            tokenType: params.oauth.tokenType,
            providerAccountId: params.oauth.providerAccountId,
            providerEmail: params.oauth.providerEmail,
            raw: null,
          },
          token: null,
        }
      : {
          ...base,
          kind: 'token' as const,
          token: {
            token: params.token.token,
            providerAccountId: params.token.providerAccountId,
            providerEmail: params.token.providerEmail,
            raw: null,
          },
        };

  return ConnectedServiceCredentialRecordV1Schema.parse(record);
}

function resolveTokenMissingMessage(descriptor: ConnectedAccountDescriptor): string {
  return descriptor.tokenSetup?.tokenKind === 'personal-access-token'
    ? 'Missing personal access token'
    : descriptor.tokenSetup?.tokenKind === 'setup-token'
      ? 'Missing setup-token'
      : 'Missing API key';
}

export function buildConnectedAccountCredentialRecordFromTokenInput(params: Readonly<{
  now: number;
  serviceId: ConnectedServiceId;
  profileId: string;
  token: string;
  providerAccountId?: string | null;
  providerEmail?: string | null;
  descriptor?: ConnectedAccountDescriptor;
}>): Extract<ConnectedServiceCredentialRecordV1, { kind: 'token' }> {
  const descriptor = params.descriptor ?? requireConnectedAccountDescriptor(params.serviceId);
  if (descriptor.id !== params.serviceId) {
    throw new Error(`Connected account descriptor id mismatch: ${descriptor.id} !== ${params.serviceId}`);
  }
  if (!descriptor.tokenSetup || !descriptor.credentialKinds.includes('token')) {
    throw new Error(`Connected account does not support token credentials: ${params.serviceId}`);
  }
  const token = params.token.trim();
  if (!token) {
    throw new Error(resolveTokenMissingMessage(descriptor));
  }
  const providerAccountId = params.providerAccountId?.trim() || null;
  const providerEmail = params.providerEmail?.trim() || null;
  if (descriptor.tokenSetup.identity && !providerEmail && !providerAccountId) {
    throw new Error(
      descriptor.tokenSetup.identity.missingValueErrorKey === 'connectedServices.tokenPrompts.errors.missingBitbucketEmailOrUsername'
        ? 'Missing Bitbucket email or username'
        : 'Missing account identity',
    );
  }
  const record = buildConnectedServiceCredentialRecord({
    now: params.now,
    serviceId: params.serviceId,
    profileId: params.profileId,
    kind: 'token',
    token: {
      token,
      providerAccountId,
      providerEmail,
    },
  });
  if (record.kind !== 'token') {
    throw new Error(`Connected account token mapper produced a non-token record: ${params.serviceId}`);
  }
  return record;
}
