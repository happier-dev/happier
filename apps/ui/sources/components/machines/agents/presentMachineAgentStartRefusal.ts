import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';

import { machineCollectionHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * A Machine refused to start an Agent that is missing or signed out there: say which, keep the draft, and
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
    setupTarget: Readonly<{ machineId: string; serverId: string }> | null;
    openSetup: (href: ReturnType<typeof machineCollectionHref>) => void;
  }>,
): boolean {
  const missing = refusal.code === SPAWN_SESSION_ERROR_CODES.AGENT_CLI_MISSING;
  if (!missing && refusal.code !== SPAWN_SESSION_ERROR_CODES.AGENT_SIGNED_OUT)
    return false;
  const names = { agent: refusal.agentTitle, machine: refusal.machineName };
  const { setupTarget } = refusal;
  Modal.alert(
    missing
      ? t('machineAgents.spawnCliMissing', names)
      : t('machineAgents.spawnSignedOut', names),
    t('machineAgents.draftKept'),
    [
      { text: t('machineAgents.actionCancel'), style: 'cancel' },
      ...(setupTarget
        ? [
            {
              text: missing
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
