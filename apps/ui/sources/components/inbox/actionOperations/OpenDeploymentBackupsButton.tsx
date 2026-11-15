import * as React from 'react';
import { useRouter } from 'expo-router';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { deploymentEnvironmentRoute } from '@/components/projects/deployments/deploymentNavigation';
import { useDeploymentAccountController } from '@/components/projects/deployments/useDeploymentProject';
import { useDeploymentEnvironmentRecord } from '@/components/projects/deployments/useDeploymentReads';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';

const PRESENTED = Object.freeze({
  mounted: true,
  visible: true,
  focused: true,
});

/**
 * Opens the Environment's Backups, where a completed backup run's snapshots now live. The Operation names only the
 * Environment, so its Project comes from the shared deployment owner's record, read while this detail is open.
 * Gone or hidden Environments have no page to open, so the button is not drawn.
 */
export function OpenDeploymentBackupsButton(
  props: Readonly<{
    serverId: string;
    environmentId: string;
    onOpened: () => void;
  }>,
) {
  const { serverId, environmentId, onOpened } = props;
  const router = useRouter();
  const { binding } = useServerCredentialAccountScopeBinding(serverId);
  const controller = useDeploymentAccountController(binding, true, PRESENTED);
  const record = useDeploymentEnvironmentRecord(
    controller,
    environmentId,
    PRESENTED,
  );
  if (record.snapshot.status === 'unavailable') return null;
  const projectSourceId =
    record.snapshot.value?.environment.projectSourceId ?? null;
  return (
    <RoundButton
      title={t('inbox.actionOperations.openBackups')}
      testID="action-operation-open-backups"
      loading={projectSourceId === null}
      disabled={projectSourceId === null}
      onPress={() => {
        if (projectSourceId === null) return;
        router.push(
          deploymentEnvironmentRoute({
            serverId,
            projectSourceId,
            environmentId,
            tab: 'settings',
            section: 'backups',
          }),
        );
        onOpened();
      }}
    />
  );
}
