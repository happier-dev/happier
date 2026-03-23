import type { AccountSettingsContext } from './bootstrapAccountSettingsContext';

export async function resolveSessionStartAccountSettingsContext(params: Readonly<{
  startedBy: 'daemon' | 'terminal';
  snapshot: AccountSettingsContext;
}>): Promise<AccountSettingsContext> {
  if (
    params.startedBy === 'terminal' &&
    params.snapshot.source === 'none' &&
    params.snapshot.whenRefreshed
  ) {
    return await params.snapshot.whenRefreshed;
  }
  return params.snapshot;
}
