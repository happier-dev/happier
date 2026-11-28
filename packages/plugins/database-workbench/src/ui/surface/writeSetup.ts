import type { ReactNode } from 'react';
import type { HostDatabaseWorkbench } from '@happier-dev/plugin-ui/hostApi';

type WriteSetup = Parameters<
  NonNullable<HostDatabaseWorkbench['renderWriteSetup']>
>[0];

/**
 * The host owns Environment binding setup for both native roles and the managed write connection.
 * Managed read setup stays with the provider's read-access Actions.
 */
export function renderWorkbenchWriteSetup(
  host: HostDatabaseWorkbench | null,
  target: WriteSetup['target'] | null,
  code: string | undefined,
  onConfigured: () => void,
): ReactNode {
  return target &&
    ((code === 'read_role_setup_required' && target.kind === 'deployment_service') ||
      code === 'write_role_setup_required' ||
      code === 'write_connection_setup_required')
    ? (host?.renderWriteSetup?.({ target, code, onConfigured }) ?? null)
    : null;
}
