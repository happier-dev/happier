import type { StoredCredentials } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { RequesterSessionRuntimeContext } from '../sessionEncryption/requesterSessionCredentials';
import { logger } from '@/ui/logger';
import type { OrphanedDeadDaemonSession } from './reattachFromMarkers';
import { retireExactTerminalControlServiceability } from './retireTerminalControlServiceability';

/** Reconnect retires the departed runner's control projection after its terminal ACK. */
export async function retireOrphanedTerminalControlServiceability<Context extends Pick<RequesterSessionRuntimeContext, 'bootstrap' | 'isCurrent'>>(params: Readonly<{
  marker: OrphanedDeadDaemonSession;
  credentials: StoredCredentials;
  resolveRequesterSessionRuntimeContext?(sessionId: string, attribution: OrphanedDeadDaemonSession['requesterWorkAttributionV1']): Promise<Context | null>;
  releaseRequesterSessionRuntimeContext?(context: Context): Promise<void>;
}>): Promise<void> {
  const { marker } = params;
  const attribution = marker.requesterWorkAttributionV1;
  const context = await params.resolveRequesterSessionRuntimeContext?.(marker.sessionId, attribution);
  if (attribution && !context) {
    // Home already acknowledged this dead runner's terminal state. An unavailable
    // requester projection cannot lend the custodian authority or keep that ACK
    // replaying. Keep requester credential custody with its existing lifetime owner.
    logger.warn('[DAEMON RUN] Orphan terminal projection unavailable after terminal settlement', {
      code: 'requester_session_context_unavailable', sessionId: marker.sessionId,
    });
    return;
  }
  try {
    const publish = () => retireExactTerminalControlServiceability({
      credentials: context?.bootstrap.credentials ?? params.credentials, sessionId: marker.sessionId,
      terminalMode: 'plain', expectedRunner: { pid: marker.pid, startTimeMs: marker.processStartTimeMs },
      ...(context ? { currentness: { verifyCurrent: () => context.isCurrent() } } : {}) });
    await (context ? runWithServerHttpBaseUrl(context.bootstrap.serverHttpBaseUrl, publish) : publish());
  } finally {
    if (context) await params.releaseRequesterSessionRuntimeContext?.(context);
  }
}
