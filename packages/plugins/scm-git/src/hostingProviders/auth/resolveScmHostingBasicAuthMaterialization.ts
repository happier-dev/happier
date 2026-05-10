import type { ConnectedServiceId } from '@happier-dev/protocol';

import {
  collectScmHostingAuthMaterializerCandidates,
  type ScmHostingAuthMaterializationRegistry,
} from './materializationRegistry.js';
import type {
  ScmHostingBasicAuthMaterializationMissingReason,
  ScmHostingBasicAuthMaterializationRequest,
  ScmHostingBasicAuthMaterializationResult,
} from './types.js';

const BASIC_AUTH_MISSING_REASONS = new Set<ScmHostingBasicAuthMaterializationMissingReason>([
  'unsupported_materialization',
  'unsupported_provider',
  'unsupported_host',
  'credential_unavailable',
]);

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isBasicAuthMaterializationResult(value: unknown): value is ScmHostingBasicAuthMaterializationResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Readonly<{
    kind?: unknown;
    reason?: unknown;
    username?: unknown;
    password?: unknown;
    profileId?: unknown;
    serviceId?: unknown;
    credentialKind?: unknown;
    providerAccountId?: unknown;
    providerEmail?: unknown;
  }>;
  if (result.kind === 'available') {
    return typeof result.username === 'string'
      && typeof result.password === 'string'
      && typeof result.profileId === 'string'
      && typeof result.serviceId === 'string'
      && result.credentialKind === 'bitbucket_basic_auth'
      && isNullableString(result.providerAccountId)
      && isNullableString(result.providerEmail);
  }
  return result.kind === 'missing'
    && typeof result.reason === 'string'
    && BASIC_AUTH_MISSING_REASONS.has(result.reason as ScmHostingBasicAuthMaterializationMissingReason);
}

export async function resolveScmHostingBasicAuthMaterialization(
  request: ScmHostingBasicAuthMaterializationRequest,
  registry?: ScmHostingAuthMaterializationRegistry,
): Promise<ScmHostingBasicAuthMaterializationResult> {
  for (const candidate of collectScmHostingAuthMaterializerCandidates(request.kind, registry)) {
    for (const hookHandler of candidate.handlers) {
      const result = await hookHandler.handler(request);
      if (!isBasicAuthMaterializationResult(result)) continue;
      if (result.kind === 'available' || result.reason !== 'unsupported_provider') {
        return result;
      }
    }
  }
  return { kind: 'missing', reason: 'unsupported_provider' };
}

export async function resolveScmHostingBasicAuthServiceId(
  request: Omit<ScmHostingBasicAuthMaterializationRequest, 'records'>,
  registry?: ScmHostingAuthMaterializationRegistry,
): Promise<ConnectedServiceId | null> {
  for (const candidate of collectScmHostingAuthMaterializerCandidates(request.kind, registry)) {
    for (const hookHandler of candidate.handlers) {
      const result = await hookHandler.handler({ ...request, records: [] });
      if (!isBasicAuthMaterializationResult(result)) continue;
      if (result.kind === 'available' || result.reason === 'credential_unavailable') {
        return candidate.serviceId;
      }
      if (result.reason !== 'unsupported_provider') return null;
    }
  }
  return null;
}
