import type {
  AccountSettingsBootstrapMode,
  AccountSettingsRefreshMode,
} from './bootstrapAccountSettingsContext';

export function resolveSessionStartAccountSettingsRefreshMode(params: Readonly<{
  mode: AccountSettingsBootstrapMode;
  refreshRequested: boolean;
  minSettingsVersion?: number | null;
}>): AccountSettingsRefreshMode {
  if (params.refreshRequested) return 'force';
  if (typeof params.minSettingsVersion === 'number') return 'auto';
  return params.mode === 'blocking' ? 'force' : 'auto';
}
