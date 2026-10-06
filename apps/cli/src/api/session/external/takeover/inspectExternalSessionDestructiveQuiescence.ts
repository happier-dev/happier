import { isDeepStrictEqual } from 'node:util';

import { doesExternalSessionDestructiveQuiescencePermitAdmissionV1, ExternalSessionDestructiveQuiescenceResultV1Schema } from '@happier-dev/protocol/sessions/external/takeoverV1';
import { readNonAuthoritativeLinkedExternalSessionV1FromMetadata } from '@happier-dev/protocol/sessions/external/linked-metadata';
import type { ExternalSessionDestructiveQuiescenceResultV1, ExternalSessionDestructiveQuiescenceStatusV1, ExternalSessionTakeoverResultV1 } from '@happier-dev/protocol';

import {
  verifySessionMarkerProcessLiveness,
  verifyProcessLiveness,
  type VerifiedProcessLiveness,
} from '@/daemon/processLivenessVerifier';
import {
  listSessionMarkers,
  type DaemonSessionMarker,
} from '@/daemon/sessionRegistry';

import { findTrustedExternalSessionOwners } from './findTrustedExternalSessionOwners';
import type { LoadedLinkedExternalSession } from './loadLinkedExternalSession';

type DestructiveQuiescenceLinkedSession = Pick<
  LoadedLinkedExternalSession,
  | 'agentId'
  | 'linkGeneration'
  | 'machineId'
  | 'metadata'
  | 'remoteSessionId'
  | 'source'
  | 'canonicalResolvedSourceKey'
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
  retainedQuiescence?: ExternalSessionDestructiveQuiescenceResultV1;
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
  const persistedLink = readNonAuthoritativeLinkedExternalSessionV1FromMetadata(params.linked.metadata);
  if (!persistedLink?.qualifiedIdentity) return unknown(null);
  const sourceKey = params.linked.canonicalResolvedSourceKey ?? null;
  if (!sourceKey) return unknown(null);

  const markers = await (params.listSessionMarkersFn ?? listSessionMarkers)({ requireComplete: true }).catch(() => null);
  if (!markers) return unknown(null);
  const ownerMarkers = findTrustedExternalSessionOwners({
    markers,
    agentId: params.linked.agentId,
    remoteSessionId: params.linked.remoteSessionId,
  });
  const sourceIdentity = {
    machineId: params.machineId,
    linkedSessionId: params.linkedSessionId,
    remoteSessionId: params.linked.remoteSessionId,
    linkGeneration: params.linked.linkGeneration,
    sourceKey,
    qualifiedIdentity: persistedLink.qualifiedIdentity,
  };
  const retained = ExternalSessionDestructiveQuiescenceResultV1Schema.safeParse(
    params.retainedQuiescence,
  );
  // A current owner always wins, including an owner whose liveness is unknown.
  // A retained observation supplies identity only; restart never revives its
  // old liveness verdict. A live/reused PID cannot be admitted without a marker.
  const retainedIdentity = ownerMarkers.length === 0
    && retained.success
    && retained.data.status === 'verified_stopped'
    && isDeepStrictEqual(retained.data.sourceIdentity, sourceIdentity)
      ? retained.data.processIdentity
      : null;
  if (ownerMarkers.length === 0 && !retainedIdentity) return unknown(null);
  let admitted: ExternalSessionDestructiveQuiescenceInspection | null = null;
  // Several Happier processes can resume the same provider Session. Every
  // matching owner must be stopped; a newer dead marker cannot hide a writer.
  for (const ownerMarker of ownerMarkers.length > 0 ? ownerMarkers : [null]) {
    if (ownerMarker && ownerMarker.processStartTimeMs === undefined) return unknown(ownerMarker);
    const pid = ownerMarker?.pid ?? retainedIdentity!.pid;
    const startedAtMs = ownerMarker?.processStartTimeMs ?? retainedIdentity!.startedAtMs;
    const liveness = ownerMarker
      ? await (params.verifySessionMarkerProcessLivenessFn ?? verifySessionMarkerProcessLiveness)(ownerMarker).catch(() => null)
      : await verifyProcessLiveness({
          pid,
          processStartTimeMs: startedAtMs,
          verifyIdentity: async () => 'unknown',
        });
    if (!liveness || liveness.pid !== pid || liveness.processStartTimeMs !== startedAtMs) {
      return unknown(ownerMarker);
    }
    const processIdentity = {
      machineId: params.machineId,
      pid,
      startedAtMs,
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

    const inspection: ExternalSessionDestructiveQuiescenceInspection = {
      status: parsed.data.status,
      permitsAdmission: doesExternalSessionDestructiveQuiescencePermitAdmissionV1(parsed.data),
      protocolResult: parsed.data,
      ownerMarker,
      observedAtMs,
    };
    if (!inspection.permitsAdmission) return inspection;
    admitted ??= inspection;
  }
  return admitted ?? unknown(null);
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
