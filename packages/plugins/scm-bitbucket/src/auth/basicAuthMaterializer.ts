import {
  BITBUCKET_CONNECTED_ACCOUNT_DESCRIPTOR,
  type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol';

export type BitbucketScmHostingBasicAuthMaterializationRequest = Readonly<{
  kind: 'scm_hosting_basic_auth';
  providerId: string;
  host: string;
  profileId?: string | null;
  records: readonly ConnectedServiceCredentialRecordV1[];
}>;

export type BitbucketScmHostingBasicAuthMaterializationResult =
  | Readonly<{
      kind: 'available';
      username: string;
      password: string;
      profileId: string;
      serviceId: 'bitbucket';
      credentialKind: 'bitbucket_basic_auth';
      providerAccountId: string | null;
      providerEmail: string | null;
    }>
  | Readonly<{
      kind: 'missing';
      reason:
        | 'unsupported_materialization'
        | 'unsupported_provider'
        | 'unsupported_host'
        | 'credential_unavailable';
    }>;

export const BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID = 'bitbucket' as const;

const BITBUCKET_SCM_HOSTING_PROVIDER_ID = 'scm.bitbucket';
const BITBUCKET_CLOUD_HOST = 'bitbucket.org';

function normalizeHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

function isTokenRecord(
  record: ConnectedServiceCredentialRecordV1,
): record is Extract<ConnectedServiceCredentialRecordV1, { kind: 'token' }> {
  return record.kind === 'token';
}

export function materializeBitbucketScmHostingBasicAuth(
  request: BitbucketScmHostingBasicAuthMaterializationRequest,
): BitbucketScmHostingBasicAuthMaterializationResult {
  const descriptor = BITBUCKET_CONNECTED_ACCOUNT_DESCRIPTOR;
  if (!descriptor?.materialization.materializationKinds.includes(request.kind)) {
    return { kind: 'missing', reason: 'unsupported_materialization' };
  }
  if (request.providerId !== BITBUCKET_SCM_HOSTING_PROVIDER_ID) {
    return { kind: 'missing', reason: 'unsupported_provider' };
  }
  if (normalizeHost(request.host) !== BITBUCKET_CLOUD_HOST) {
    return { kind: 'missing', reason: 'unsupported_host' };
  }

  const record = request.records.find((candidate) =>
    candidate.serviceId === descriptor.id
    && isTokenRecord(candidate)
    && (!request.profileId || candidate.profileId === request.profileId),
  );
  if (!record || !isTokenRecord(record)) {
    return { kind: 'missing', reason: 'credential_unavailable' };
  }

  const password = record.token.token.trim();
  const username = (record.token.providerEmail ?? record.token.providerAccountId ?? '').trim();
  if (!password || !username) {
    return { kind: 'missing', reason: 'credential_unavailable' };
  }

  return {
    kind: 'available',
    username,
    password,
    profileId: record.profileId,
    serviceId: BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID,
    credentialKind: 'bitbucket_basic_auth',
    providerAccountId: record.token.providerAccountId,
    providerEmail: record.token.providerEmail,
  };
}
