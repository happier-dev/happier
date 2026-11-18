import * as React from 'react';

import { useExternalSessionAgentCapabilities } from '@/components/sessions/model/useExternalSessionAgentCapabilities';
import { useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import type { ExternalSessionOperationShellPresentation } from '@/components/sessions/external/progress/externalSessionOperationShellPresentation';
import type { resolveExternalSessionIdentityPresentation } from '@/components/sessions/presentation/externalSessionIdentityPresentation';
import type { resolveExternalSessionRuntimePresentation } from '@/components/sessions/presentation/externalSessionRuntimePresentation';
import { useExternalSessionContinueInNewSession } from '@/components/sessions/model/useExternalSessionContinueInNewSession';
import { useExternalSessionMaterialize } from '@/components/sessions/model/useExternalSessionMaterialize';
import { useExternalSessionReplayForkLauncher } from '@/components/sessions/model/useExternalSessionReplayForkLauncher';
import type { useExternalSessionRuntime } from '@/components/sessions/model/useExternalSessionRuntime';
import type { useExternalSessionTakeover } from '@/components/sessions/model/useExternalSessionTakeover';
import type { readExternalSessionOperationPresentationFromMetadata } from '@/components/sessions/transcript/items/externalSessionOperationMetadata';
import { useEventCallback } from '@/hooks/ui/useEventCallback';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useSetting } from '@/sync/domains/state/storage';

import {
  resolveSessionViewExternalControlFooter,
  type SessionViewExternalControlFooter,
} from './resolveSessionViewExternalControlFooter';

type ReplayForkLauncherParams = Parameters<
  typeof useExternalSessionReplayForkLauncher
>[0];

/**
 * The external Session's control row: its import, Continue in a new session and takeover owners composed into the
 * one footer state. The composer controller reads it before deciding the Session's notice, so the row and the
 * not-resumable notice never say two different things about the way forward.
 */
export function useSessionViewExternalControlFooter(
  params: Readonly<{
    sessionId: string;
    session: Session;
    hasWriteAccess: boolean;
    externalSessionRuntime: ReturnType<typeof useExternalSessionRuntime>;
    externalSessionRuntimePresentation: ReturnType<
      typeof resolveExternalSessionRuntimePresentation
    > | null;
    externalSessionIdentityPresentation: ReturnType<
      typeof resolveExternalSessionIdentityPresentation
    >;
    /** The transcript lives only on the source machine and must be imported first. */
    materializeNeeded: boolean;
    /** The imported transcript snapshot is published. */
    importPublished: boolean;
    externalSessionOperationPresentation: ReturnType<
      typeof readExternalSessionOperationPresentationFromMetadata
    >;
    externalSessionOperationShell: ExternalSessionOperationShellPresentation;
    externalSessionTakeover: Pick<
      ReturnType<typeof useExternalSessionTakeover>,
      | 'takeoverInFlight'
      | 'takeoverPreflightInFlight'
      | 'requestTakeoverPreflight'
    >;
    isHiddenSystemSessionSession: boolean;
    sessionRouteServerId: string | null | undefined;
    machineId: string | null | undefined;
    sessionAccountLifetime: Parameters<
      typeof useExternalSessionAgentCapabilities
    >[0]['accountLifetime'];
    executionRunsEnabled: boolean;
    router: ReplayForkLauncherParams['router'];
  }>,
): SessionViewExternalControlFooter | null {
  const {
    sessionId,
    session,
    hasWriteAccess,
    externalSessionRuntime,
    externalSessionRuntimePresentation,
    externalSessionIdentityPresentation,
    materializeNeeded,
    externalSessionOperationShell,
    externalSessionTakeover,
    isHiddenSystemSessionSession,
    sessionRouteServerId,
  } = params;
  const externalSessionMaterialize = useExternalSessionMaterialize({
    sessionId,
    hasWriteAccess,
    externalSessionRuntime,
  });
  const requestExternalSessionTakeoverPreflight = useEventCallback(() =>
    externalSessionTakeover.requestTakeoverPreflight(),
  );
  const requestExternalSessionMaterialize = useEventCallback(() =>
    externalSessionMaterialize.requestMaterialize(),
  );
  const openExternalSessionReplayFork = useExternalSessionReplayForkLauncher({
    sessionId,
    session,
    serverId:
      externalSessionRuntime.sessionServerId ?? sessionRouteServerId ?? null,
    machineId: params.machineId ?? null,
    enabled: externalSessionRuntime.externalSessionLink !== null,
    executionRunsEnabled: params.executionRunsEnabled,
    router: params.router,
  });
  const sessionReplayEnabled = useSetting('sessionReplayEnabled') === true;
  const externalSessionContinueInNewSession =
    useExternalSessionContinueInNewSession({
      sessionId,
      replayEnabled: sessionReplayEnabled,
      materializeNeeded,
      importPublished: params.importPublished,
      operation: params.externalSessionOperationPresentation,
      requestMaterialize: requestExternalSessionMaterialize,
      openReplayFork: openExternalSessionReplayFork,
    });
  const externalSessionLink = externalSessionRuntime.externalSessionLink;
  const externalServerId = externalSessionRuntime.sessionServerId ?? sessionRouteServerId;
  const [sourcePresence] = useMachinePresenceSummaries(
    externalServerId,
    externalSessionLink && materializeNeeded ? [externalSessionLink.machineId] : [],
    params.sessionAccountLifetime,
  );
  const { writerSafety: takeoverWriterSafety, materializeAvailable } = useExternalSessionAgentCapabilities({
    link: externalSessionLink,
    serverId: externalServerId,
    sourceMachineOnline: sourcePresence?.reachability === 'reachable',
    accountLifetime: params.sessionAccountLifetime,
  });
  return React.useMemo(
    () =>
      resolveSessionViewExternalControlFooter({
        externalSessionOperationRunning: externalSessionOperationShell.running,
        externalSessionOperationBlocksNewOperation:
          externalSessionOperationShell.blocksNewOperation,
        externalSessionLink: externalSessionRuntime.externalSessionLink
          ? { machineId: externalSessionRuntime.externalSessionLink.machineId }
          : null,
        externalSessionRuntimePresentation: externalSessionRuntimePresentation
          ? {
              externalAgent: {
                state: externalSessionRuntimePresentation.externalAgent.state,
                labelKey:
                  externalSessionRuntimePresentation.externalAgent.labelKey,
              },
            }
          : null,
        externalSessionIdentity: {
          agentLabel: externalSessionIdentityPresentation.agentLabel,
          machineLabel: externalSessionIdentityPresentation.machineLabel,
        },
        materializeNeeded,
        materializeAvailable,
        hasWriteAccess,
        externalSessionRuntime: {
          status: externalSessionRuntime.status
            ? {
                machineOnline: externalSessionRuntime.status.machineOnline,
                runnerActive: externalSessionRuntime.status.runnerActive,
                activity: externalSessionRuntime.status.activity,
                canTakeOverDirect:
                  externalSessionRuntime.status.canTakeOverDirect,
                canTakeOverPersist:
                  externalSessionRuntime.status.canTakeOverPersist,
                trustedPid: externalSessionRuntime.status.trustedPid,
              }
            : null,
        },
        externalSessionTakeover: {
          writerSafety: takeoverWriterSafety,
          takeoverInFlight: externalSessionTakeover.takeoverInFlight,
          takeoverPreflightInFlight:
            externalSessionTakeover.takeoverPreflightInFlight,
          requestTakeoverPreflight: requestExternalSessionTakeoverPreflight,
        },
        externalSessionMaterialize: {
          materializeInFlight: externalSessionMaterialize.materializeInFlight,
          requestMaterialize: requestExternalSessionMaterialize,
        },
        externalSessionContinueInNewSession: {
          available: externalSessionContinueInNewSession.available,
          inFlight: externalSessionContinueInNewSession.inFlight,
          requestContinue: externalSessionContinueInNewSession.requestContinue,
        },
        isHiddenSystemSessionSession,
      }),
    [
      externalSessionIdentityPresentation.agentLabel,
      externalSessionIdentityPresentation.machineLabel,
      externalSessionMaterialize.materializeInFlight,
      materializeAvailable,
      materializeNeeded,
      externalSessionContinueInNewSession.available,
      externalSessionContinueInNewSession.inFlight,
      externalSessionContinueInNewSession.requestContinue,
      externalSessionOperationShell.blocksNewOperation,
      externalSessionOperationShell.running,
      externalSessionRuntime.externalSessionLink?.machineId,
      externalSessionRuntime.status?.activity,
      externalSessionRuntime.status?.canTakeOverDirect,
      externalSessionRuntime.status?.canTakeOverPersist,
      externalSessionRuntime.status?.machineOnline,
      externalSessionRuntime.status?.runnerActive,
      externalSessionRuntime.status?.trustedPid,
      externalSessionRuntimePresentation?.externalAgent.labelKey,
      externalSessionRuntimePresentation?.externalAgent.state,
      externalSessionTakeover.takeoverInFlight,
      externalSessionTakeover.takeoverPreflightInFlight,
      hasWriteAccess,
      isHiddenSystemSessionSession,
      requestExternalSessionMaterialize,
      requestExternalSessionTakeoverPreflight,
      takeoverWriterSafety,
    ],
  );
}
