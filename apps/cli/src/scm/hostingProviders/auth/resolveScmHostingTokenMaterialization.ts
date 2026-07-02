import type {
  ConnectedServiceId,
} from '@happier-dev/protocol';
import {
  collectScmHostingTokenMaterializerCandidates,
  type ScmHostingAuthMaterializationRegistry,
} from './materializationRegistry';
import type {
  ScmHostingTokenMaterializationRequest,
  ScmHostingTokenMaterializationMissingReason,
  ScmHostingTokenMaterializationResult,
} from './types';

const TOKEN_MISSING_REASONS = new Set<ScmHostingTokenMaterializationMissingReason>([
  'unsupported_materialization',
  'unsupported_provider',
  'unsupported_host',
  'credential_unavailable',
]);

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isTokenMaterializationResult(value: unknown): value is ScmHostingTokenMaterializationResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Readonly<{
    kind?: unknown;
    reason?: unknown;
    token?: unknown;
    profileId?: unknown;
    serviceId?: unknown;
    credentialKind?: unknown;
    providerAccountId?: unknown;
    providerEmail?: unknown;
  }>;
  if (result.kind === 'available') {
    return typeof result.token === 'string'
      && typeof result.profileId === 'string'
      && typeof result.serviceId === 'string'
      && typeof result.credentialKind === 'string'
      && isNullableString(result.providerAccountId)
      && isNullableString(result.providerEmail);
  }
  return result.kind === 'missing'
    && typeof result.reason === 'string'
    && TOKEN_MISSING_REASONS.has(result.reason as ScmHostingTokenMaterializationMissingReason);
}

export async function resolveScmHostingTokenMaterialization(
  request: ScmHostingTokenMaterializationRequest,
  registry?: ScmHostingAuthMaterializationRegistry,
): Promise<ScmHostingTokenMaterializationResult> {
  for (const candidate of collectScmHostingTokenMaterializerCandidates(registry)) {
    const result = await candidate.materializer.materialize(request);
    if (!isTokenMaterializationResult(result)) {
      continue;
    }
    if (result.kind === 'available' || result.reason !== 'unsupported_provider') {
      return result;
    }
  }
  return { kind: 'missing', reason: 'unsupported_provider' };
}

export async function resolveScmHostingTokenServiceId(
  request: Omit<ScmHostingTokenMaterializationRequest, 'records'>,
  registry?: ScmHostingAuthMaterializationRegistry,
): Promise<ConnectedServiceId | null> {
  for (const candidate of collectScmHostingTokenMaterializerCandidates(registry)) {
    const result = await candidate.materializer.materialize({ ...request, records: [] });
    if (!isTokenMaterializationResult(result)) {
      continue;
    }
    if (result.kind === 'available' || result.reason === 'credential_unavailable') {
      return candidate.materializer.serviceId;
    }
    if (result.reason !== 'unsupported_provider') {
      return null;
    }
  }
  return null;
}
