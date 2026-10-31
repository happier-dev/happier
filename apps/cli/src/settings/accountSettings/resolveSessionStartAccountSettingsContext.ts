import type { AccountSettingsContext } from './bootstrapAccountSettingsContext';

export async function resolveSessionStartAccountSettingsContext(params: Readonly<{
  startedBy: 'daemon' | 'terminal';
  snapshot: AccountSettingsContext;
  refreshRequested?: boolean;
}>): Promise<AccountSettingsContext> {
  if (
    (params.startedBy === 'terminal' || params.startedBy === 'daemon') &&
    (params.snapshot.source === 'none' || params.refreshRequested === true) &&
    params.snapshot.whenRefreshed
  ) {
    return await params.snapshot.whenRefreshed;
  }
  return params.snapshot;
}
