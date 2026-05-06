import {
  getConnectedAccountDescriptor,
  type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol';

import type {
  ScmHostingBasicAuthMaterializationRequest,
  ScmHostingBasicAuthMaterializationResult,
  ScmHostingBasicAuthMaterializer,
} from '../../types';

const BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID = 'bitbucket';
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

export const bitbucketScmHostingBasicAuthMaterializer: ScmHostingBasicAuthMaterializer = Object.freeze({
  materialize(request: ScmHostingBasicAuthMaterializationRequest): ScmHostingBasicAuthMaterializationResult {
    const descriptor = getConnectedAccountDescriptor(BITBUCKET_CONNECTED_ACCOUNT_SERVICE_ID);
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
      serviceId: record.serviceId,
      credentialKind: 'bitbucket_basic_auth',
      providerAccountId: record.token.providerAccountId,
      providerEmail: record.token.providerEmail,
    };
  },
});
