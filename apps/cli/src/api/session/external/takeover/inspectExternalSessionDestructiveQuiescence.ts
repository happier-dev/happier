import {
  doesExternalSessionDestructiveQuiescencePermitAdmissionV1,
  ExternalSessionDestructiveQuiescenceResultV1Schema,
  readLinkedExternalSessionV1FromMetadata,
  resolveExternalSessionsSourceKey,
  type ExternalSessionDestructiveQuiescenceResultV1,
  type ExternalSessionDestructiveQuiescenceStatusV1,
  type ExternalSessionTakeoverResultV1,
} from '@happier-dev/protocol';

import {
  verifySessionMarkerProcessLiveness,
  type VerifiedProcessLiveness,
} from '@/daemon/processLivenessVerifier';
import {
  listSessionMarkers,
  type DaemonSessionMarker,
} from '@/daemon/sessionRegistry';

import { findTrustedExternalSessionOwner } from './findTrustedExternalSessionOwner';
import type { LoadedLinkedExternalSession } from './loadLinkedExternalSession';

type DestructiveQuiescenceLinkedSession = Pick<
  LoadedLinkedExternalSession,
  'agentId' | 'linkGeneration' | 'machineId' | 'metadata' | 'remoteSessionId' | 'source'
>;

export type ExternalSessionDestructiveQuiescenceInspection = Readonly<{
  status: ExternalSessionDestructiveQuiescenceStatusV1;
  permitsAdmission: boolean;
  protocolResult: ExternalSessionDestructiveQuiescenceResultV1 | null;
  ownerMarker: DaemonSessionMarker | null;
  observedAtMs: number;
}>;

export async function inspectExternalSessionDestructiveQuiescence(params: Readonly<{
  linked: DestructiveQuiescenceLinkedSession;
  linkedSessionId: string;
  machineId: string;
  observedAtMs?: number;
  listSessionMarkersFn?: typeof listSessionMarkers;
  verifySessionMarkerProcessLivenessFn?: (
    marker: DaemonSessionMarker,
  ) => Promise<VerifiedProcessLiveness>;
}>): Promise<ExternalSessionDestructiveQuiescenceInspection> {
  const observedAtMs = params.observedAtMs ?? Date.now();
  const unknown = (
    ownerMarker: DaemonSessionMarker | null,
  ): ExternalSessionDestructiveQuiescenceInspection => ({
    status: 'unknown',
    permitsAdmission: false,
    protocolResult: null,
    ownerMarker,
    observedAtMs,
  });

  if (params.machineId !== params.linked.machineId) return unknown(null);
  const persistedLink = readLinkedExternalSessionV1FromMetadata(params.linked.metadata);
  if (!persistedLink?.qualifiedIdentity) return unknown(null);

  const markers = await (params.listSessionMarkersFn ?? listSessionMarkers)().catch(() => null);
  if (!markers) return unknown(null);
  const ownerMarker = findTrustedExternalSessionOwner({
    markers,
    agentId: params.linked.agentId,
    remoteSessionId: params.linked.remoteSessionId,
  });
  if (
    !ownerMarker
    || !ownerMarker.processCommandHash
    || ownerMarker.processStartTimeMs === undefined
  ) {
    return unknown(ownerMarker);
  }

  const liveness = await (
    params.verifySessionMarkerProcessLivenessFn ?? verifySessionMarkerProcessLiveness
  )(ownerMarker).catch(() => null);
  if (
    !liveness
    || liveness.pid !== ownerMarker.pid
    || liveness.processStartTimeMs !== ownerMarker.processStartTimeMs
  ) {
    return unknown(ownerMarker);
  }

  const sourceIdentity = {
    machineId: params.machineId,
    linkedSessionId: params.linkedSessionId,
    remoteSessionId: params.linked.remoteSessionId,
    linkGeneration: params.linked.linkGeneration,
    sourceKey: resolveExternalSessionsSourceKey(params.linked.source),
    qualifiedIdentity: persistedLink.qualifiedIdentity,
  };
  const processIdentity = {
    machineId: params.machineId,
    pid: ownerMarker.pid,
    startedAtMs: ownerMarker.processStartTimeMs,
  };
  const parsed = ExternalSessionDestructiveQuiescenceResultV1Schema.safeParse({
    status: liveness.status,
    sourceIdentity,
    processIdentity,
    evidence: {
      kind: 'operating_system_process_state',
      processState: liveness.status,
      observedAtMs,
      sourceIdentity,
      processIdentity,
    },
  });
  if (!parsed.success) return unknown(ownerMarker);

  return {
    status: parsed.data.status,
    permitsAdmission: doesExternalSessionDestructiveQuiescencePermitAdmissionV1(parsed.data),
    protocolResult: parsed.data,
    ownerMarker,
    observedAtMs,
  };
}

export function externalSessionTakeoverSafetyFailureFromInspection(
  inspection: ExternalSessionDestructiveQuiescenceInspection,
  params: Readonly<{
    machineId: string;
    sourceKind?: string;
  }>,
): Extract<ExternalSessionTakeoverResultV1, Readonly<{ ok: false }>> {
  const errorCode = inspection.status === 'verified_running'
    ? 'external_process_active'
    : 'external_process_unknown';
  return {
    ok: false,
    errorCode,
    error: errorCode,
    // Outside Agent writers are not force-stopped. A future Agent-native graceful
    // stop capability must be supplied by its typed contribution, not inferred here.
    gracefulStopAvailable: false,
    details: {
      machineId: params.machineId,
      observedAtMs: inspection.observedAtMs,
      evidenceKind: 'operating_system_process_state',
      ...(inspection.protocolResult
        ? { process: inspection.protocolResult.processIdentity }
        : {}),
      ...(params.sourceKind ? { sourceKind: params.sourceKind } : {}),
    },
  };
}
