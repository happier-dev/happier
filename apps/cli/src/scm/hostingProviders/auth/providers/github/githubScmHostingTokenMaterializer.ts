import {
  getConnectedAccountDescriptor,
  type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/protocol';

import type {
  ScmHostingTokenMaterializationRequest,
  ScmHostingTokenMaterializationResult,
  ScmHostingTokenMaterializer,
} from '../../types';

const GITHUB_CONNECTED_ACCOUNT_SERVICE_ID = 'github';
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

export const githubScmHostingTokenMaterializer: ScmHostingTokenMaterializer = Object.freeze({
  materialize(request: ScmHostingTokenMaterializationRequest): ScmHostingTokenMaterializationResult {
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
    if (!record || !token) {
      return { kind: 'missing', reason: 'credential_unavailable' };
    }

    return {
      kind: 'available',
      token,
      profileId: record.profileId,
      serviceId: record.serviceId,
      credentialKind: record.kind,
      providerAccountId: record.token.providerAccountId,
      providerEmail: record.token.providerEmail,
    };
  },
});
