import {
  buildConnectedServiceCredentialRecord,
  ConnectedServiceIdSchema,
  decodeBase64,
  openBoxBundle,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

type ProxyExchangePayload = Readonly<{
  serviceId: ConnectedServiceId;
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  scope: string | null;
  tokenType: string | null;
  providerEmail: string | null;
  providerAccountId: string | null;
  expiresAt: number | null;
  raw: unknown;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseConnectedServiceOauthProxyBundle(params: Readonly<{
  bundleB64Url: string;
  recipientSecretKey: Uint8Array;
}>): ProxyExchangePayload {
  const bytes = decodeBase64(params.bundleB64Url, 'base64url');
  const opened = openBoxBundle({ bundle: bytes, recipientSecretKeyOrSeed: params.recipientSecretKey });
  if (!opened) throw new Error('Failed to decrypt OAuth bundle');
  const json: unknown = JSON.parse(new TextDecoder().decode(opened));
  if (!isRecord(json)) throw new Error('OAuth bundle payload is not an object');
  const serviceId = ConnectedServiceIdSchema.parse(json.serviceId);
  return {
    serviceId,
    accessToken: String(json.accessToken ?? ''),
    refreshToken: String(json.refreshToken ?? ''),
    idToken: typeof json.idToken === 'string' ? json.idToken : null,
    scope: typeof json.scope === 'string' ? json.scope : null,
    tokenType: typeof json.tokenType === 'string' ? json.tokenType : null,
    providerEmail: typeof json.providerEmail === 'string' ? json.providerEmail : null,
    providerAccountId: typeof json.providerAccountId === 'string' ? json.providerAccountId : null,
    expiresAt: typeof json.expiresAt === 'number' ? json.expiresAt : null,
    raw: json.raw ?? null,
  };
}

export function buildOauthRecordFromProxyPayload(params: Readonly<{
  now: number;
  serviceId: ConnectedServiceId;
  profileId: string;
  payload: ProxyExchangePayload;
}>): Extract<ConnectedServiceCredentialRecordV1, { kind: 'oauth' }> {
  const record = buildConnectedServiceCredentialRecord({
    now: params.now,
    serviceId: params.serviceId,
    profileId: params.profileId,
    kind: 'oauth',
    expiresAt: params.payload.expiresAt,
    oauth: {
      accessToken: params.payload.accessToken,
      refreshToken: params.payload.refreshToken,
      idToken: params.payload.idToken,
      scope: params.payload.scope,
      tokenType: params.payload.tokenType,
      providerAccountId: params.payload.providerAccountId,
      providerEmail: params.payload.providerEmail,
    },
  });
  if (record.kind !== 'oauth') {
    throw new Error(`Unexpected credential record kind: ${record.kind}`);
  }
  return record;
}
