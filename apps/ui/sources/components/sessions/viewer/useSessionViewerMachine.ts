import {
  useSessionMachineDisplayIdentity,
  useSessionMachineTarget,
} from '@/components/sessions/model/useSessionMachineTarget';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { t } from '@/text';

import { useOptionalSessionViewerController } from './SessionViewerController';
import type { SessionViewerSource } from './sessionViewerPresentation';

/**
 * The Machine a Session's Computer is on, named even while it cannot be reached: the viewer then
 * says so itself instead of the Computer vanishing with the Machine. Null only when the Session
 * has no Machine at all.
 */
export function useSessionViewerMachineId(
  sessionId: string,
  serverId: string | null,
): string | null {
  const reachable =
    useSessionMachineTarget(sessionId, serverId)?.machineId ?? null;
  const named = useSessionMachineDisplayIdentity(sessionId, serverId).machineId;
  return reachable ?? (named || null);
}

/**
 * The one name the viewer gives a Machine, wherever it says it (the controls' identity capsule, a
 * pane's bar, a recovery sentence): the name the source's owner states, else the Machine's own
 * presence name. Never its raw id; a Machine nothing can name is left unnamed.
 */
export function resolveSessionViewerMachineName(
  stated: string | null | undefined,
  presenceName: string | null | undefined,
): string | null {
  return stated?.trim() || presenceName?.trim() || null;
}

/**
 * The Machine the viewer's source runs on, as every part of the viewer names it (the controls'
 * identity capsule and the frame's own label). A source that publishes no name (the Browser) is
 * still on the Session's Machine.
 */
export function useSessionViewerMachine(
  sessionId: string,
  serverId: string | null,
  source: SessionViewerSource,
): Readonly<{ name: string; online: boolean | null; targetTitle: string | null }> {
  const facts = useOptionalSessionViewerController()?.facts[source];
  const stated = facts?.machineName ?? null;
  const machineId = useSessionViewerMachineId(sessionId, serverId);
  const presence = useMachinePresenceSummary(serverId, machineId);
  return {
    name: resolveSessionViewerMachineName(stated, presence.name) ?? '',
    online: presence.reachability === 'unknown' ? null : presence.reachability === 'reachable',
    targetTitle: facts?.targetTitle ?? null,
  };
}

/** Source identity in the frame's accessible name in every picture state: the selected window or display, else its kind. */
export function resolveSessionViewerSourceLabel(
  source: SessionViewerSource,
  targetTitle?: string | null,
): string {
  return targetTitle?.trim() || t(
    source === 'computer'
      ? 'computerUse.presentation.sourceComputer'
      : 'computerUse.presentation.sourceBrowser',
  );
}

/** The frame's accessible name: what is watched and where, never a dangling "on". */
export function resolveSessionViewerWatchingLabel(
  source: SessionViewerSource,
  machineName: string,
  targetTitle?: string | null,
): string {
  const sourceLabel = resolveSessionViewerSourceLabel(source, targetTitle);
  return machineName
    ? t('computerUse.presentation.watchingA11y', { source: sourceLabel, machine: machineName })
    : t('computerUse.presentation.watchingSourceA11y', { source: sourceLabel });
}
