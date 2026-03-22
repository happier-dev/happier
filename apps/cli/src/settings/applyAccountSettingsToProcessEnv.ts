type AccountSettingsEnvInput = Readonly<Record<string, unknown> & {
  scmIncludeCoAuthoredBy?: boolean;
  actionsSettingsV1?: unknown;
  backendCliSourcePreferenceById?: unknown;
  backendCliSourcePreferenceByTargetKey?: unknown;
}>;

let backendCliSourcePreferencesManagedBySettings = false;
let backendCliSourcePreferencesLastManagedValue: string | null = null;
let scmIncludeCoAuthoredByManagedBySettings = false;
let scmIncludeCoAuthoredByLastManagedValue: string | null = null;
let actionsSettingsManagedBySettings = false;
let actionsSettingsLastManagedValue: string | null = null;

export function __resetApplyAccountSettingsToProcessEnvStateForTests(): void {
  backendCliSourcePreferencesManagedBySettings = false;
  backendCliSourcePreferencesLastManagedValue = null;
  scmIncludeCoAuthoredByManagedBySettings = false;
  scmIncludeCoAuthoredByLastManagedValue = null;
  actionsSettingsManagedBySettings = false;
  actionsSettingsLastManagedValue = null;
}

export function applyAccountSettingsToProcessEnv(params: Readonly<{
  settings: AccountSettingsEnvInput;
}>): void {
  const currentScmEnvValue = typeof process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY === 'string'
    ? process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY
    : null;
  if (scmIncludeCoAuthoredByManagedBySettings && currentScmEnvValue !== scmIncludeCoAuthoredByLastManagedValue) {
    scmIncludeCoAuthoredByManagedBySettings = false;
    scmIncludeCoAuthoredByLastManagedValue = null;
  }
  if (currentScmEnvValue === null || scmIncludeCoAuthoredByManagedBySettings) {
    const raw = params.settings?.scmIncludeCoAuthoredBy;
    if (typeof raw === 'boolean') {
      const nextValue = raw ? '1' : '0';
      process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = nextValue;
      scmIncludeCoAuthoredByManagedBySettings = true;
      scmIncludeCoAuthoredByLastManagedValue = nextValue;
    } else if (scmIncludeCoAuthoredByManagedBySettings) {
      delete process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY;
      scmIncludeCoAuthoredByManagedBySettings = false;
      scmIncludeCoAuthoredByLastManagedValue = null;
    }
  }

  const currentActionsEnvValue = typeof process.env.HAPPIER_ACTIONS_SETTINGS_V1 === 'string'
    ? process.env.HAPPIER_ACTIONS_SETTINGS_V1
    : null;
  if (actionsSettingsManagedBySettings && currentActionsEnvValue !== actionsSettingsLastManagedValue) {
    actionsSettingsManagedBySettings = false;
    actionsSettingsLastManagedValue = null;
  }
  if (currentActionsEnvValue === null || actionsSettingsManagedBySettings) {
    const rawActions = (params.settings as any)?.actionsSettingsV1;
    const parsed = rawActions && typeof rawActions === 'object' ? rawActions : null;
    if (parsed) {
      try {
        const serialized = JSON.stringify(parsed);
        process.env.HAPPIER_ACTIONS_SETTINGS_V1 = serialized;
        actionsSettingsManagedBySettings = true;
        actionsSettingsLastManagedValue = serialized;
      } catch {
        // ignore
      }
    } else if (actionsSettingsManagedBySettings) {
      delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
      actionsSettingsManagedBySettings = false;
      actionsSettingsLastManagedValue = null;
    }
  }

  if (typeof process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON !== 'string') {
    // Allow explicit env var overrides (for debugging / CI) on the first write only.
  }
  const rawPreferences = params.settings.backendCliSourcePreferenceByTargetKey ?? params.settings.backendCliSourcePreferenceById;
  const parsed =
    rawPreferences && typeof rawPreferences === 'object' && !Array.isArray(rawPreferences)
      ? Object.fromEntries(
          Object.entries(rawPreferences).filter(
            ([, value]) => value === 'system-first' || value === 'managed-first',
          ),
        )
      : null;
  const envAlreadySet = typeof process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON === 'string';
  const currentEnvValue = envAlreadySet ? process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON ?? null : null;
  if (backendCliSourcePreferencesManagedBySettings && currentEnvValue !== backendCliSourcePreferencesLastManagedValue) {
    backendCliSourcePreferencesManagedBySettings = false;
    backendCliSourcePreferencesLastManagedValue = null;
  }
  if (!envAlreadySet || backendCliSourcePreferencesManagedBySettings) {
    if (parsed && Object.keys(parsed).length > 0) {
      try {
        const serialized = JSON.stringify(parsed);
        process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON = serialized;
        backendCliSourcePreferencesManagedBySettings = true;
        backendCliSourcePreferencesLastManagedValue = serialized;
      } catch {
        // ignore
      }
    } else if (backendCliSourcePreferencesManagedBySettings) {
      delete process.env.HAPPIER_BACKEND_CLI_SOURCE_PREFERENCES_JSON;
      backendCliSourcePreferencesManagedBySettings = false;
      backendCliSourcePreferencesLastManagedValue = null;
    }
  }
}
