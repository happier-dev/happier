import * as React from 'react';

import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { Session } from '@/sync/domains/state/storageTypes';
import { getSessionStatus } from '@/utils/sessions/sessionUtils';
import type { ActiveSignal } from '@/utils/react/activeGatedExternalStore';

import {
  readExternalAgentObservationPresentationInput,
  resolveExternalSessionRuntimePresentation,
} from './externalSessionRuntimePresentation';

/** The hosted external agent's runtime presentation at `nowMs`. */
function resolveExternalSessionRuntimePresentationAt(
  session: Session,
  nowMs: number,
) {
  const hostedStatus = getSessionStatus(session, nowMs, {});
  return resolveExternalSessionRuntimePresentation({
    controlConnectivity: hostedStatus.isConnected ? 'connected' : 'offline',
    detachedActivity:
      hostedStatus.state === 'background_active'
        ? 'active'
        : hostedStatus.isConnected
          ? 'idle'
          : 'unknown',
    externalAgent: readExternalAgentObservationPresentationInput(
      readSessionOwnerMetadataView(session),
    ),
    nowMs,
  });
}

/**
 * A linked external Session's runtime presentation, for every surface that shows the external Agent's state (the
 * Session header, the peek header, the control row). The observation ages on the shared clock only while `visible`
 * and only at its own next expiry; the gate is a subscription, so a hide or show renders nothing.
 */
export function useSessionExternalRuntimePresentation(
  session: Session | null,
  linked: boolean,
  visible: boolean | ActiveSignal,
): ReturnType<typeof resolveExternalSessionRuntimePresentation> | null {
  const readExpiry = React.useCallback(
    (nowMs: number) => {
      if (!session || !linked) return null;
      return (
        resolveExternalSessionRuntimePresentationAt(session, nowMs)
          .externalAgent.nextExpiryAtMs ?? null
      );
    },
    [linked, session],
  );
  const nowMs = useSessionListRuntimeDeadlineNowMs(
    readExpiry,
    linked ? visible : false,
  );
  return React.useMemo(() => {
    if (!session || !linked) return null;
    return resolveExternalSessionRuntimePresentationAt(session, nowMs);
  }, [linked, nowMs, session]);
}
