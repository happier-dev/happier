import type {
  AccountSettingsBootstrapMode,
  AccountSettingsRefreshMode,
} from './bootstrapAccountSettingsContext';

export function resolveSessionStartAccountSettingsRefreshMode(params: Readonly<{
  mode: AccountSettingsBootstrapMode;
  refreshRequested: boolean;
}>): AccountSettingsRefreshMode {
  if (params.refreshRequested) return 'force';
  return params.mode === 'blocking' ? 'force' : 'auto';
}
