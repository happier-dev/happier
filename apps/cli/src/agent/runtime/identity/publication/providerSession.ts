import type { AgentId, VendorResumeIdField } from '@happier-dev/agents';
import { applyProviderSessionIdSessionMetadata } from '@happier-dev/agents/session/state/metadataWriters';

import type { SessionClientPort } from '../../../../api/session/sessionClientPort';
import { findHappyProcessByPid } from '../../../../daemon/doctor';
import { hashProcessCommand, listSessionMarkers, writeSessionMarker } from '../../../../daemon/sessionRegistry';
import { createSessionRuntimeIdentityMetadataUpdater } from '../metadata/updater';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readHostPid(metadata: unknown): number | null {
  if (!isRecord(metadata)) return null;
  const pid = metadata.hostPid;
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function refreshTrackedSessionMarkerProviderSessionId(params: Readonly<{
  agentId: AgentId;
  session: Pick<SessionClientPort, 'sessionId'> & Partial<Pick<SessionClientPort, 'getMetadataSnapshot'>>;
  providerSessionId: string;
  vendorResumeIdField: VendorResumeIdField;
}>): Promise<void> {
  if (typeof params.session.getMetadataSnapshot !== 'function') return;
  const pid = readHostPid(params.session.getMetadataSnapshot());
  if (!pid) return;

  const markers = await listSessionMarkers().catch(() => []);
  const currentMarker = markers
    .filter((marker) => marker.pid === pid)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;

  const snapshot = params.session.getMetadataSnapshot();
  const metadata = isRecord(snapshot) ? snapshot : {};
  const nextMetadata = applyProviderSessionIdSessionMetadata({
    ...(isRecord(currentMarker?.metadata) ? currentMarker.metadata : {}),
    ...metadata,
    flavor: params.agentId,
  } as Record<string, unknown>, {
    metadataKey: params.vendorResumeIdField,
    value: params.providerSessionId,
  });
  const liveProcess =
    !currentMarker?.processCommandHash || !currentMarker?.processCommand
      ? await findHappyProcessByPid(pid).catch(() => null)
      : null;
  const processCommand = typeof liveProcess?.command === 'string' && liveProcess.command.trim().length > 0
    ? liveProcess.command
    : currentMarker?.processCommand;
  const processCommandHash = processCommand
    ? hashProcessCommand(processCommand)
    : currentMarker?.processCommandHash;

  await writeSessionMarker({
    pid,
    happySessionId: params.session.sessionId,
    flavor: params.agentId,
    startedBy: currentMarker?.startedBy,
    cwd: currentMarker?.cwd ?? (typeof nextMetadata.path === 'string' ? nextMetadata.path : undefined),
    processCommandHash,
    processCommand,
    metadata: nextMetadata,
    ...(currentMarker?.respawn ? { respawn: currentMarker.respawn } : {}),
  });
}

export function createProviderSessionIdentityPublisher(params: Readonly<{
  agentId: AgentId;
  session: SessionClientPort;
  vendorResumeIdField: VendorResumeIdField;
  lastPublished: { value: string | null };
}>): (nextSessionId: string | null) => void {
  const publishProviderSessionId = createSessionRuntimeIdentityMetadataUpdater(
    params.vendorResumeIdField,
  );

  return (nextSessionId: string | null): void => {
    publishProviderSessionId({
      sessionId: params.session.sessionId,
      getSessionId: () => nextSessionId,
      updateHappySessionMetadata: (updater) => params.session.updateMetadata(updater),
      lastPublished: params.lastPublished,
      afterUpdate: (sessionId) => refreshTrackedSessionMarkerProviderSessionId({
        agentId: params.agentId,
        session: params.session,
        providerSessionId: sessionId,
        vendorResumeIdField: params.vendorResumeIdField,
      }),
    });
  };
}
