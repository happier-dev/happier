import type { Credentials } from '@/persistence';
import { configuration } from '@/configuration';
import { stopDaemonSession } from '@/daemon/controlClient';
import { listSessionMarkers, removeSessionMarker } from '@/daemon/sessionRegistry';
import { createStopSession } from '@/daemon/sessions/stopSession';
import type { StopSessionResult } from '@/daemon/sessions/stopSessionContract';
import { waitForTrackedRunnerProcessesExit } from '@/daemon/sessions/waitForTrackedRunnerProcessesExit';
import { retireExactTerminalControlServiceability } from '@/daemon/sessions/retireTerminalControlServiceability';
import { buildTrackedSessionFromMarker } from '@/daemon/sessions/trackedSessionFromMarker';
import type { TrackedSession } from '@/daemon/types';
import { buildSpawnSessionOptionsFromRespawnDescriptorV1 } from '@/daemon/processSupervision/sessionRunnerRespawnDescriptor';
import { createDefaultTerminalHostAdapterInventory } from '@/integrations/terminal/host/defaultAdapters';
import { notifyTerminalAttachmentRetiredThroughCatalog } from '@/terminal/attachment/catalogHooks';
import { logger } from '@/ui/logger';
import { resolveSessionIdOrPrefix } from '@/session/query/resolveSessionId';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import {
  resolveSessionControlStopPollIntervalMs,
  resolveSessionControlStopTimeoutMs,
} from '@/session/transport/shared/sessionTimeouts';
import { delay } from '@/utils/time';
import { readTerminalHostAttachmentState } from '@/terminal/attachment/terminalAttachmentInfo';

type StopSessionAttemptResult = StopSessionResult | Readonly<{
  status: 'incomplete';
  reason: 'transport_ambiguous' | 'marker_fallback_failed';
}>;

async function waitForSessionStopResult(params: Readonly<{
  token: string;
  sessionId: string;
}>): Promise<boolean> {
  const deadlineMs = Date.now() + resolveSessionControlStopTimeoutMs();

  while (Date.now() <= deadlineMs) {
    const session = await fetchSessionByIdCompat({
      token: params.token,
      sessionId: params.sessionId,
    }).catch(() => null);

    if (session?.active === false) {
      return true;
    }

    if (Date.now() >= deadlineMs) {
      break;
    }

    await delay(resolveSessionControlStopPollIntervalMs());
  }

  return false;
}

async function stopSessionViaMarkersBestEffort(params: Readonly<{
  credentials: Credentials;
  sessionId: string;
  expectedTerminalAttachmentId?: string;
}>): Promise<StopSessionResult> {
  const { sessionId } = params;
  const markers = (await listSessionMarkers()).filter((marker) => marker.happySessionId === sessionId);
  if (markers.length === 0) {
    return { status: 'not_found' };
  }

  const pidToTrackedSession = new Map<number, TrackedSession>(
    markers.map((marker) => {
      let spawnOptions: ReturnType<typeof buildSpawnSessionOptionsFromRespawnDescriptorV1> | undefined;
      if (marker.respawn) {
        try {
          spawnOptions = buildSpawnSessionOptionsFromRespawnDescriptorV1(marker.respawn, {
            encryptionMaterial: params.credentials.encryption,
          });
        } catch {
          spawnOptions = undefined;
        }
      }
      return [
        marker.pid,
        buildTrackedSessionFromMarker({
          marker,
          startedByFallback: 'terminal',
          ...(spawnOptions ? { spawnOptions } : {}),
        }),
      ];
    }),
  );
  let terminalHostAdapterInventoryPromise: ReturnType<typeof createDefaultTerminalHostAdapterInventory> | null = null;

  return await createStopSession({
    pidToTrackedSession,
    requireTerminalTopologyProof: true,
    ...(params.expectedTerminalAttachmentId
      ? { expectedTerminalAttachmentId: params.expectedTerminalAttachmentId }
      : {}),
    logPidReuseRefusal: (message) => logger.debug(message),
    logWarning: (message, ...args) => logger.debug(message, ...args),
    loadTerminalHostAdapters: async () => {
      terminalHostAdapterInventoryPromise ??= createDefaultTerminalHostAdapterInventory({
        happyHomeDir: configuration.happyHomeDir,
        preference: process.platform === 'win32' ? 'zellij' : 'auto',
      });
      return (await terminalHostAdapterInventoryPromise).adapters;
    },
    areTrackedRunnersExited: async ({ trackedPids }) => await waitForTrackedRunnerProcessesExit({
      runners: trackedPids.map((pid) => ({ pid })),
      timeoutMs: 0,
      pollIntervalMs: 0,
    }),
    waitForTrackedRunnersExit: async ({ trackedPids }) => await waitForTrackedRunnerProcessesExit({
      runners: trackedPids.map((pid) => ({ pid })),
      timeoutMs: resolveSessionControlStopTimeoutMs(),
      pollIntervalMs: resolveSessionControlStopPollIntervalMs(),
    }),
    onExactTerminalAttachmentRetired: notifyTerminalAttachmentRetiredThroughCatalog,
    retireExactTerminalControlServiceability: async ({ attachmentInfo, terminalMode }) => {
      await retireExactTerminalControlServiceability({
        credentials: params.credentials,
        sessionId,
        attachmentId: attachmentInfo.attachmentId,
        terminalMode,
      });
    },
  })(sessionId);
}

async function readExactTerminalAttachmentId(sessionId: string): Promise<string | null> {
  const state = await readTerminalHostAttachmentState({
    happyHomeDir: configuration.happyHomeDir,
    sessionId,
  }).catch(() => ({ status: 'unreadable' as const, reason: 'io_error' as const }));
  return state.status === 'present' && state.info.version === 2
    ? state.info.attachmentId
    : null;
}

async function cleanupStoppedSessionMarkersBestEffort(sessionId: string): Promise<void> {
  const markers = await listSessionMarkers();
  await Promise.all(
    markers
      .filter((marker) => marker.happySessionId === sessionId)
      .map((marker) => removeSessionMarker(marker.pid).catch(() => undefined)),
  );
}

export async function requestSessionStop(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
}>): Promise<
  | Readonly<{ ok: true; sessionId: string; stopped: boolean }>
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'unsupported'; candidates?: string[] }>
> {
  const resolved = await resolveSessionIdOrPrefix({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      code: resolved.code,
      ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
    };
  }

  try {
    const exactAttachmentIdBeforeDaemonStop = await readExactTerminalAttachmentId(resolved.sessionId);
    let physicalStopResult: StopSessionAttemptResult;
    try {
      physicalStopResult = await stopDaemonSession(resolved.sessionId);
    } catch {
      physicalStopResult = { status: 'incomplete', reason: 'transport_ambiguous' };
    }
    // A transport failure may mean the daemon accepted Stop but the response was lost. Retry only
    // when a v2 attachment supplies immutable host identity; plain/legacy/unreadable paths retain
    // the single-actor fail-closed behavior.
    const mayRunExactAmbiguousFallback = physicalStopResult.status === 'incomplete'
      && physicalStopResult.reason === 'transport_ambiguous'
      && exactAttachmentIdBeforeDaemonStop !== null;
    if (physicalStopResult.status === 'not_found' || mayRunExactAmbiguousFallback) {
      physicalStopResult = await stopSessionViaMarkersBestEffort({
        credentials: params.credentials,
        sessionId: resolved.sessionId,
        ...(mayRunExactAmbiguousFallback && exactAttachmentIdBeforeDaemonStop
          ? { expectedTerminalAttachmentId: exactAttachmentIdBeforeDaemonStop }
          : {}),
      }).catch(
        (): StopSessionAttemptResult => ({ status: 'incomplete', reason: 'marker_fallback_failed' }),
      );
    }
    const stopped = physicalStopResult.status === 'stopped'
      ? await waitForSessionStopResult({
          token: params.credentials.token,
          sessionId: resolved.sessionId,
        })
      : false;
    if (stopped) {
      await cleanupStoppedSessionMarkersBestEffort(resolved.sessionId).catch(() => undefined);
    }
    return {
      ok: true,
      sessionId: resolved.sessionId,
      stopped,
    };
  } catch {
    return {
      ok: true,
      sessionId: resolved.sessionId,
      stopped: false,
    };
  }
}
