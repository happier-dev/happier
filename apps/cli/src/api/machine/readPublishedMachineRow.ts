import axios from '@/api/client/credentialAxios';
import { MachinePublishedRowV1Schema, type MachinePublishedRowV1 } from '@happier-dev/protocol/machines/machineContentKeyTransitionV1';
import type { ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { StoredCredentials } from '@/persistence';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { MachineContentKeyUnavailableError } from './machineDataEncryptionKey';

type MachineReadOptions = Readonly<{ signal?: AbortSignal; authorization?: ExternalActionExecutionAuthorizationV1; effectActionId?: string }>;
type MachinePublishedObservation = Readonly<{ row: MachinePublishedRowV1; legacyOwnerOnly: boolean }>;

// Released server .17 (a2c45c86804b24e60ac0b76146a3ef36dfcaa15b),
// machineSerialization.ts: its authenticated exact GET filters accountId + id.
// Retire with that supported writer and the matching predecessor wire seam.
const legacyOwnerOnlyFields = new Set([
  'id', 'metadata', 'metadataVersion', 'daemonState', 'daemonStateVersion', 'dataEncryptionKey',
  'installationId', 'installationPublicKey', 'contentPublicKeyFingerprint', 'replacedByMachineId',
  'replacedAt', 'replacementReason', 'replacementSource', 'replacementActorUserId', 'seq', 'active',
  'activeAt', 'revokedAt', 'createdAt', 'updatedAt',
]);

function isCompleteLegacyOwnerOnlyWire(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record);
  // Inspect the raw response, before the tolerant row reader can drop unknown
  // generation fields. A partial/current row never acquires legacy authority.
  return fields.length === legacyOwnerOnlyFields.size && typeof record.metadata === 'string'
    && fields.every(field => legacyOwnerOnlyFields.has(field) && record[field] !== undefined);
}

/** Exact encoded publication; access/currentness readers do not need to open Machine content. */
export async function readPublishedMachineRow(machineId: string, credentials: StoredCredentials | undefined,
  options?: MachineReadOptions,
): Promise<MachinePublishedRowV1 | null> {
  return (await readPublishedMachineObservation(machineId, credentials, options, false))?.row ?? null;
}

/** Private Account Session custody qualification, not a fabricated access DTO. */
export async function readPublishedMachineRowWithLegacyOwnerProof(machineId: string, credentials: StoredCredentials,
  options?: Readonly<{ signal?: AbortSignal }>,
): Promise<MachinePublishedObservation | null> {
  return readPublishedMachineObservation(machineId, credentials, options, true);
}

async function readPublishedMachineObservation(machineId: string, credentials: StoredCredentials | undefined,
  options: MachineReadOptions | undefined, qualifyLegacyOwnerOnly: boolean,
): Promise<MachinePublishedObservation | null> {
  try {
    const path = `/v1/machines/${encodeURIComponent(machineId)}`;
    const http = options?.authorization?.requesterHttpProjection;
    const requesterHeaders = http ? await http.createRequestHeaders({ effectActionId: options?.effectActionId ?? options!.authorization!.binding.actionId,
      method: 'GET', path, ...(options?.signal ? { signal: options.signal } : {}) }) : null;
    if (options?.authorization && !requesterHeaders) throw new MachineContentKeyUnavailableError(machineId);
    const response = await axios.get(
      `${http?.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()}${path}`,
      {
        headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), ...(requesterHeaders ?? { Authorization: `Bearer ${credentials!.token}` }) },
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    const raw: unknown = response.data.machine;
    const legacyOwnerOnly = qualifyLegacyOwnerOnly && isCompleteLegacyOwnerOnlyWire(raw);
    const row = MachinePublishedRowV1Schema.parse(raw);
    return { row, legacyOwnerOnly };
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) return null;
    throw error;
  }
}
