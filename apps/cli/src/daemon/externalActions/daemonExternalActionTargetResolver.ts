import { resolveMachineControlLocalityProof } from '@/session/machineControlLocality';
import {
  resolveSessionStoredContentEncryptionMode,
  tryDecryptSessionPresentationMetadataView,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import type { StoredCredentials } from '@/persistence';

import type { ResolveExternalActionTarget } from './executeExternalAction';

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type RawSessionLocalityRecord = Readonly<{
  machineId?: unknown;
  host?: unknown;
  homeDir?: unknown;
  metadata?: unknown;
  metadataLayoutVersion?: unknown;
  ownerMetadata?: unknown;
  dataEncryptionKey?: unknown;
  encryptionMode?: unknown;
}>;

function readSessionLocality(
  session: RawSessionLocalityRecord,
  credentials: StoredCredentials,
): Readonly<{
  machineId: string | null;
  host: string | null;
  homeDir: string | null;
}> {
  const metadata = tryDecryptSessionPresentationMetadataView({
    credentials,
    accountEncryptionMode: resolveSessionStoredContentEncryptionMode(session),
    rawSession: session,
  });
  return {
    // New rows keep owner-locality in encrypted metadata. The raw projection is
    // retained only for older rows that have no readable metadata value.
    machineId: readNonEmptyString(metadata?.machineId)
      ?? readNonEmptyString(session.machineId),
    host: readNonEmptyString(metadata?.host)
      ?? readNonEmptyString(session.host),
    homeDir: readNonEmptyString(metadata?.homeDir)
      ?? readNonEmptyString(session.homeDir),
  };
}

/**
 * Resolves the daemon-local execution target through the existing Session and
 * machine-locality owners. This runs per admitted request, immediately before
 * Action execution, so a Session target cannot rely on a stale route lookup.
 */
export function createDaemonExternalActionTargetResolver(input: Readonly<{
  credentials: StoredCredentials;
  currentMachineHost?: string | null;
  currentMachineHomeDir?: string | null;
}>): ResolveExternalActionTarget {
  return async ({ target, currentMachineId, signal }) => {
    if (!target) {
      return { kind: 'machine', machineId: currentMachineId };
    }

    if (target.kind === 'machine') {
      return target.machineId === currentMachineId ? target : null;
    }

    const session = await fetchSessionById({
      token: input.credentials.token,
      sessionId: target.sessionId,
      ...(signal ? { signal } : {}),
    });
    if (!session) return null;

    const localityRecord = readSessionLocality(session, input.credentials);
    if (!localityRecord.machineId) return null;

    const locality = await resolveMachineControlLocalityProof({
      sessionMachineId: localityRecord.machineId,
      currentMachineId,
      sessionHost: localityRecord.host,
      sessionHomeDir: localityRecord.homeDir,
      ...(input.currentMachineHost ? { currentMachineHost: input.currentMachineHost } : {}),
      ...(input.currentMachineHomeDir
        ? { currentMachineHomeDir: input.currentMachineHomeDir }
        : {}),
      credentials: { token: input.credentials.token },
    });
    return locality ? target : null;
  };
}
