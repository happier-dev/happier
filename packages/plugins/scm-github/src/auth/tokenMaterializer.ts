import { getConnectedAccountDescriptor } from '@happier-dev/plugin-sdk/experimental/manifest/connectedAccountDescriptors';
import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/plugin-sdk/scm';

export type GithubScmHostingTokenMaterializationRequest = Readonly<{
  kind: 'scm_hosting_token';
  providerId: string;
  host: string;
  profileId?: string | null;
  records: readonly ConnectedServiceCredentialRecordV1[];
}>;

export type GithubScmHostingTokenMaterializationResult =
  | Readonly<{
      kind: 'available';
      token: string;
      profileId: string;
      serviceId: 'github';
      credentialKind: 'token';
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

export const GITHUB_CONNECTED_ACCOUNT_SERVICE_ID = 'github' as const;

const GITHUB_SCM_HOSTING_PROVIDER_ID = 'scm.github';
const GITHUB_DOT_COM_HOST = 'github.com';

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

export function materializeGithubScmHostingToken(
  request: GithubScmHostingTokenMaterializationRequest,
): GithubScmHostingTokenMaterializationResult {
  const descriptor = getConnectedAccountDescriptor(GITHUB_CONNECTED_ACCOUNT_SERVICE_ID);
  if (!descriptor?.materialization.materializationKinds.includes(request.kind)) {
    return { kind: 'missing', reason: 'unsupported_materialization' };
  }
  if (request.providerId !== GITHUB_SCM_HOSTING_PROVIDER_ID) {
    return { kind: 'missing', reason: 'unsupported_provider' };
  }
  if (normalizeHost(request.host) !== GITHUB_DOT_COM_HOST) {
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
  const token = record.token.token.trim();
  if (!token) {
    return { kind: 'missing', reason: 'credential_unavailable' };
  }

  return {
    kind: 'available',
    token,
    profileId: record.profileId,
    serviceId: GITHUB_CONNECTED_ACCOUNT_SERVICE_ID,
    credentialKind: record.kind,
    providerAccountId: record.token.providerAccountId,
    providerEmail: record.token.providerEmail,
  };
}
