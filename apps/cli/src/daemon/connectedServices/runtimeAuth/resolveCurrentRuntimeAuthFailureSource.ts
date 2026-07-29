import {
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedServiceIdSchema,
  type ConnectedServiceCredentialRecordV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import type {
  LegacyConnectedServiceRuntimeAuthFailureSourceRevisionResolver,
} from '@/agent/catalog/types';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

type CurrentCredential = Readonly<{
  record: ConnectedServiceCredentialRecordV1;
  credentialRevision: string;
}>;

type ExactRuntimeIdentity = Readonly<{
  serviceId: ConnectedServiceId;
  proofStrength: 'exact' | 'weak' | 'diagnostic' | 'none' | 'unknown';
  providerAccountId: string | null;
  profileId: string | null;
  groupId: string | null;
  generation: number | null;
  credentialRevision: string | null;
}>;

type RuntimeIdentityReadResult =
  | ExactRuntimeIdentity
  | Readonly<{
      status: 'unavailable';
      reason: string;
    }>;

function isUnavailableRuntimeIdentity(
  value: RuntimeIdentityReadResult | null,
): value is Extract<RuntimeIdentityReadResult, { status: 'unavailable' }> {
  return value !== null && 'status' in value && value.status === 'unavailable';
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export type CurrentRuntimeAuthFailureSource = Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
  generation: number;
  credentialRevision: string;
}>;

/**
 * Provider-neutral owner for authorizing the exact live runtime tuple that
 * emitted a failure. Provider-specific predecessor-wire evidence is delegated
 * to the catalog leaf and is never consulted for current revisioned reports.
 */
export async function resolveCurrentRuntimeAuthFailureSource(input: Readonly<{
  classification: ConnectedServiceRuntimeFailureClassification;
  readRuntimeIdentity: (request: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
    profileId: string;
    generation: number;
    credentialRevision: string | null;
  }>) => Promise<RuntimeIdentityReadResult | null>;
  resolveCurrentCredential: (
    serviceId: ConnectedServiceId,
    profileId: string,
  ) => Promise<CurrentCredential | null>;
  resolveLegacySourceRevision?:
    LegacyConnectedServiceRuntimeAuthFailureSourceRevisionResolver | null;
}>): Promise<CurrentRuntimeAuthFailureSource | null> {
  const serviceId = ConnectedServiceIdSchema.safeParse(input.classification.serviceId);
  const groupId = readNonEmptyString(input.classification.groupId);
  const profileId = readNonEmptyString(input.classification.profileId);
  const generation = typeof input.classification.groupGeneration === 'number'
    && Number.isFinite(input.classification.groupGeneration)
    ? Math.trunc(input.classification.groupGeneration)
    : null;
  const reportedRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(
    input.classification.expectedCredentialRevision,
  );
  const reportCarriesRevision = input.classification.expectedCredentialRevision !== null
    && input.classification.expectedCredentialRevision !== undefined;
  if (!serviceId.success || !groupId || !profileId || generation === null) return null;

  const liveIdentityResult = await input.readRuntimeIdentity({
    serviceId: serviceId.data,
    groupId,
    profileId,
    generation,
    credentialRevision: reportedRevision.success ? reportedRevision.data : null,
  });
  if (isUnavailableRuntimeIdentity(liveIdentityResult)) {
    throw new Error(
      liveIdentityResult.reason.trim()
        || 'connected-service runtime identity temporarily unavailable',
    );
  }
  const liveIdentity = liveIdentityResult;
  const liveGroupId = readNonEmptyString(liveIdentity?.groupId);
  const liveProfileId = readNonEmptyString(liveIdentity?.profileId);
  const liveGeneration = typeof liveIdentity?.generation === 'number'
    && Number.isFinite(liveIdentity.generation)
    ? Math.trunc(liveIdentity.generation)
    : null;
  const liveRevision = ConnectedServiceCredentialRevisionV1Schema.safeParse(
    liveIdentity?.credentialRevision,
  );
  if (
    !liveIdentity
    || liveIdentity.serviceId !== serviceId.data
    || liveIdentity.proofStrength !== 'exact'
    || !liveGroupId
    || !liveProfileId
    || liveGeneration === null
  ) return null;

  if (reportCarriesRevision) {
    if (!reportedRevision.success || !liveRevision.success) return null;
    return {
      serviceId: serviceId.data,
      groupId: liveGroupId,
      profileId: liveProfileId,
      generation: liveGeneration,
      credentialRevision: liveRevision.data,
    };
  }

  const resolveLegacySourceRevision = input.resolveLegacySourceRevision;
  if (!resolveLegacySourceRevision) return null;
  const currentCredential = await input.resolveCurrentCredential(serviceId.data, liveProfileId);
  if (!currentCredential) return null;
  const legacyRevision = resolveLegacySourceRevision({
    reportedCredentialRevision: null,
    reportedProviderAccountId: readNonEmptyString(input.classification.sourceProviderAccountId),
    failingAccessTokenFingerprint: readNonEmptyString(
      input.classification.failingAccessTokenFingerprint,
    ),
    liveIdentity: {
      providerAccountId: liveIdentity.providerAccountId,
      credentialRevision: liveIdentity.credentialRevision,
    },
    currentCredential,
  });
  if (legacyRevision !== currentCredential.credentialRevision) return null;

  return {
    serviceId: serviceId.data,
    groupId: liveGroupId,
    profileId: liveProfileId,
    generation: liveGeneration,
    credentialRevision: legacyRevision,
  };
}
