import {
  ConnectedServiceCredentialRevisionV1Schema,
  ConnectedServiceIdSchema,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

import type { ConnectedServiceProviderAdoptedGenerationTarget } from '../../sessionAuthSwitch/connectedServiceAuthSwitchOutcome';

export const CONNECTED_SERVICE_PENDING_AUTH_GROUP_GENERATIONS_METADATA_KEY =
  'connectedServicePendingAuthGroupGenerationsV1';

export type ConnectedServiceProviderAdoptedAuthGroupGeneration = Readonly<{
  kind: 'provider_adopted_generation';
  providerAdoptedTarget: ConnectedServiceProviderAdoptedGenerationTarget;
  proofStrength: 'exact';
  updatedAtMs: number;
}>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function readGeneration(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function readTimestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : null;
}

function parseTarget(value: unknown): Readonly<{
  serviceId: ConnectedServiceId;
  groupId: string;
  profileId: string;
  generation: number;
  credentialRevision: string | null;
}> | null {
  const record = asRecord(value);
  if (!record) return null;
  const serviceId = ConnectedServiceIdSchema.safeParse(record.serviceId);
  const groupId = readNonEmptyString(record.groupId);
  const profileId = readNonEmptyString(record.profileId);
  const generation = readGeneration(record.generation);
  const credentialRevision = record.credentialRevision === null || record.credentialRevision === undefined
    ? null
    : ConnectedServiceCredentialRevisionV1Schema.safeParse(record.credentialRevision);
  if (
    !serviceId.success
    || !groupId
    || !profileId
    || generation === null
    || (credentialRevision !== null && !credentialRevision.success)
  ) return null;
  return {
    serviceId: serviceId.data,
    groupId,
    profileId,
    generation,
    credentialRevision: credentialRevision === null ? null : credentialRevision.data,
  };
}

function parseProviderAdoptedEntry(value: unknown): ConnectedServiceProviderAdoptedAuthGroupGeneration | null {
  const record = asRecord(value);
  if (record?.kind !== 'provider_adopted_generation' || record.proofStrength !== 'exact') return null;
  const targetRecord = asRecord(record.providerAdoptedTarget);
  const target = parseTarget(record.providerAdoptedTarget);
  const proofRecord = targetRecord ? asRecord(targetRecord.proof) : null;
  const proofStatus = proofRecord ? readNonEmptyString(proofRecord.status) : null;
  const proofSource = proofRecord ? readNonEmptyString(proofRecord.source) : null;
  const providerAccountId = proofRecord ? readNonEmptyString(proofRecord.providerAccountId) : null;
  const activeAccountId = proofRecord ? readNonEmptyString(proofRecord.activeAccountId) : null;
  const sharedAuthSurfaceId = proofRecord ? readNonEmptyString(proofRecord.sharedAuthSurfaceId) : null;
  const credentialRevisionParsed = proofRecord
    ? ConnectedServiceCredentialRevisionV1Schema.safeParse(proofRecord.credentialRevision)
    : null;
  const credentialRevision = credentialRevisionParsed?.success ? credentialRevisionParsed.data : null;
  const updatedAtMs = readTimestamp(record.updatedAtMs);
  if (
    !target
    || proofStatus !== 'verified'
    || !proofSource
    || (!providerAccountId && !activeAccountId && !sharedAuthSurfaceId && credentialRevision === null)
    || updatedAtMs === null
  ) return null;
  const providerAdoptedTarget: ConnectedServiceProviderAdoptedGenerationTarget = {
    ...target,
    proof: {
      status: 'verified',
      source: proofSource,
      ...(providerAccountId ? { providerAccountId } : {}),
      ...(activeAccountId ? { activeAccountId } : {}),
      ...(sharedAuthSurfaceId ? { sharedAuthSurfaceId } : {}),
      ...(credentialRevision === null ? {} : { credentialRevision }),
    },
  };
  return Object.freeze({
    kind: 'provider_adopted_generation',
    providerAdoptedTarget,
    proofStrength: 'exact',
    updatedAtMs,
  });
}

export function readConnectedServiceProviderAdoptedAuthGroupGenerationsFromMetadata(
  metadata: Readonly<Record<string, unknown>>,
): readonly ConnectedServiceProviderAdoptedAuthGroupGeneration[] {
  const envelope = asRecord(metadata[CONNECTED_SERVICE_PENDING_AUTH_GROUP_GENERATIONS_METADATA_KEY]);
  if (envelope?.v !== 1 || !Array.isArray(envelope.entries)) return [];
  const byScope = new Map<string, ConnectedServiceProviderAdoptedAuthGroupGeneration>();
  for (const rawEntry of envelope.entries) {
    const entry = parseProviderAdoptedEntry(rawEntry);
    if (!entry) continue;
    const key = `${entry.providerAdoptedTarget.serviceId}\0${entry.providerAdoptedTarget.groupId}`;
    const current = byScope.get(key);
    const candidateGeneration = entry.providerAdoptedTarget.generation;
    const currentGeneration = current?.providerAdoptedTarget.generation ?? -1;
    if (!current || candidateGeneration > currentGeneration || (
      candidateGeneration === currentGeneration && entry.updatedAtMs > current.updatedAtMs
    )) byScope.set(key, entry);
  }
  return Object.freeze([...byScope.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, entry]) => entry));
}
