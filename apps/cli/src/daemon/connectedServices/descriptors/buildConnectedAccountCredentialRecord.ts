import {
  buildConnectedAccountCredentialRecordFromTokenInput,
  buildConnectedServiceCredentialRecord,
  requireConnectedAccountDescriptor,
  type ConnectedAccountDescriptor,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

export { buildConnectedAccountCredentialRecordFromTokenInput };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown, options?: Readonly<{ preserveEmpty?: boolean }>): string | null {
  return typeof value === 'string' && (options?.preserveEmpty || value.length > 0) ? value : null;
}

function readRequiredString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readMappedString(
  data: Readonly<Record<string, unknown>>,
  mapping: string | Readonly<{ objectField?: string; field: string }> | undefined,
  options?: Readonly<{ preserveEmpty?: boolean }>,
): string | null {
  if (!mapping) return null;
  if (typeof mapping === 'string') return readString(data[mapping], options);
  const owner = mapping.objectField ? data[mapping.objectField] : data;
  const record = isRecord(owner) ? owner : {};
  return readString(record[mapping.field], options);
}

function resolveExpiresAt(params: Readonly<{
  now: number;
  data: Readonly<Record<string, unknown>>;
  absoluteField?: string;
  expiresInField?: string;
  allowZeroExpiresIn?: boolean;
}>): number | null {
  if (params.absoluteField) {
    const explicit = params.data[params.absoluteField];
    if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return explicit;
  }
  if (params.expiresInField) {
    const expiresIn = params.data[params.expiresInField];
    if (
      typeof expiresIn === 'number' &&
      Number.isFinite(expiresIn) &&
      (expiresIn > 0 || (params.allowZeroExpiresIn && expiresIn === 0))
    ) {
      return params.now + Math.trunc(expiresIn) * 1000;
    }
  }
  return null;
}

export type MappedConnectedAccountOauthPayload = Readonly<{
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  scope: string | null;
  tokenType: string | null;
  providerAccountId: string | null;
  providerEmail: string | null;
  expiresAt: number | null;
}>;

export function mapConnectedAccountOauthPayload(params: Readonly<{
  descriptor: ConnectedAccountDescriptor;
  now: number;
  payload: unknown;
  fallbackRefreshToken?: string;
  preserveEmptyOptionalStrings?: boolean;
  allowZeroExpiresIn?: boolean;
}>): MappedConnectedAccountOauthPayload {
  if (!params.descriptor.oauth) {
    throw new Error(`Connected account does not support OAuth credentials: ${params.descriptor.id}`);
  }
  const data = isRecord(params.payload) ? params.payload : {};
  const mapping = params.descriptor.oauth.payloadMapping;
  const mappedRefreshToken = readRequiredString(data[mapping.refreshTokenField]);
  return {
    accessToken: readRequiredString(data[mapping.accessTokenField]),
    refreshToken: mappedRefreshToken || params.fallbackRefreshToken || '',
    idToken: readMappedString(data, mapping.idTokenField, { preserveEmpty: params.preserveEmptyOptionalStrings }),
    scope: readMappedString(data, mapping.scopeField, { preserveEmpty: params.preserveEmptyOptionalStrings }),
    tokenType: readMappedString(data, mapping.tokenTypeField, { preserveEmpty: params.preserveEmptyOptionalStrings }),
    providerAccountId: readMappedString(data, mapping.providerAccountIdField, {
      preserveEmpty: params.preserveEmptyOptionalStrings,
    }),
    providerEmail: readMappedString(data, mapping.providerEmailField, { preserveEmpty: params.preserveEmptyOptionalStrings }),
    expiresAt: resolveExpiresAt({
      now: params.now,
      data,
      absoluteField: mapping.expiresAt.absoluteField,
      expiresInField: mapping.expiresAt.expiresInField,
      allowZeroExpiresIn: params.allowZeroExpiresIn,
    }),
  };
}

export function buildConnectedAccountCredentialRecordFromOauthPayload(params: Readonly<{
  now: number;
  serviceId: ConnectedServiceId;
  profileId: string;
  payload: unknown;
}>): Extract<ConnectedServiceCredentialRecordV1, { kind: 'oauth' }> {
  const descriptor = requireConnectedAccountDescriptor(params.serviceId);
  if (!descriptor.oauth) {
    throw new Error(`Connected account does not support OAuth credentials: ${params.serviceId}`);
  }
  const mapped = mapConnectedAccountOauthPayload({
    descriptor,
    now: params.now,
    payload: params.payload,
  });
  const record = buildConnectedServiceCredentialRecord({
    now: params.now,
    serviceId: params.serviceId,
    profileId: params.profileId,
    kind: 'oauth',
    expiresAt: mapped.expiresAt,
    oauth: {
      accessToken: mapped.accessToken,
      refreshToken: mapped.refreshToken,
      idToken: mapped.idToken,
      scope: mapped.scope,
      tokenType: mapped.tokenType,
      providerAccountId: mapped.providerAccountId,
      providerEmail: mapped.providerEmail,
    },
  });
  if (record.kind !== 'oauth') {
    throw new Error(`Connected account OAuth mapper produced a non-OAuth record: ${params.serviceId}`);
  }
  return record;
}
