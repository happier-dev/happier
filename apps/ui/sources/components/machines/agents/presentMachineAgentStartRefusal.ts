import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import type { SessionAgentUpdateNoticeV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

import { machineCollectionHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { Modal } from '@/modal';
import { t } from '@/text';

/** A successful launch used the installed version while its optional update needs attention. */
export function presentMachineAgentUpdateNotice(
  notice: Readonly<{ status: SessionAgentUpdateNoticeV1['status']; agentTitle: string; machineName: string }>,
): void {
  Modal.alert(
    notice.status === 'pending'
      ? t('machineAgents.updatePendingNotice', { agent: notice.agentTitle })
      : t('machineAgents.updateFailedNotice', { agent: notice.agentTitle }),
    t('machineAgents.sessionStartedWithInstalledVersion', { machine: notice.machineName }),
  );
}

/**
 * A Machine refused to start an Agent that needs setup or sign-in: say which, keep the draft, and
 * lead to that Machine's Agent setup (lab agent-setup ST). This is Machine recovery; Home Account recovery
 * is a different identity and a different destination.
 *
 * `setupTarget` is null where the person cannot go to the Machine, which leaves the alert informational.
 * Returns false for any other code, so the caller keeps its own failure presentation.
 */
export function presentMachineAgentStartRefusal(
  refusal: Readonly<{
    code: unknown;
    agentTitle: string;
    machineName: string;
    /** Present when setup requires the Machine owner's help; null is an unnamed owner. */
    setupOwnerName?: string | null;
    setupTarget: Readonly<{ machineId: string; serverId: string }> | null;
    openSetup: (href: ReturnType<typeof machineCollectionHref>) => void;
  }>,
): boolean {
  const missing = refusal.code === SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING;
  const needsSetup = missing || refusal.code === SPAWN_SESSION_ERROR_CODES.AGENT_CLI_NOT_READY;
  if (!needsSetup && refusal.code !== SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT)
    return false;
  const names = { agent: refusal.agentTitle, machine: refusal.machineName };
  const { setupTarget } = refusal;
  Modal.alert(
    missing
      ? t('machineAgents.spawnCliMissing', names)
      : needsSetup
        ? t('machineAgents.spawnCliNotReady', names)
        : t('machineAgents.spawnSignedOut', names),
    [t('machineAgents.draftKept'), ...(needsSetup && refusal.setupOwnerName !== undefined
      ? [refusal.setupOwnerName
        ? t('machineAgents.setupOwner', { owner: refusal.setupOwnerName })
        : t('machineAgents.setupMachineOwner')]
      : [])].join('\n\n'),
    [
      { text: t('machineAgents.actionCancel'), style: 'cancel' },
      ...(setupTarget
        ? [
            {
              text: needsSetup
                ? t('machineAgents.setUp')
                : t('machineAgents.actionSignIn'),
              onPress: () =>
                refusal.openSetup(machineCollectionHref(setupTarget)),
            },
          ]
        : []),
    ],
  );
  return true;
}
