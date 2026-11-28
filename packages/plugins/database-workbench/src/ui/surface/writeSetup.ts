import type { ReactNode } from 'react';
import type { HostDatabaseWorkbench } from '@happier-dev/plugin-ui/hostApi';

type WriteSetup = Parameters<
  NonNullable<HostDatabaseWorkbench['renderWriteSetup']>
>[0];

/**
 * A refusal that needs the Environment's write connection or role leads to the host's write setup, the one place it is
 * done. Null for every other refusal (and on hosts without that setup), so the caller keeps its own refusal line.
 */
export function renderWorkbenchWriteSetup(
  host: HostDatabaseWorkbench | null,
  target: WriteSetup['target'] | null,
  code: string | undefined,
  onConfigured: () => void,
): ReactNode {
  return target &&
    (code === 'write_role_setup_required' ||
      code === 'write_connection_setup_required')
    ? (host?.renderWriteSetup?.({ target, code, onConfigured }) ?? null)
    : null;
}
