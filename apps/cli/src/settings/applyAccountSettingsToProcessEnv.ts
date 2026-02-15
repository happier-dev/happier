export function applyAccountSettingsToProcessEnv(params: Readonly<{
  settings: Record<string, unknown>;
}>): void {
  // Allow explicit env var overrides (for debugging / CI).
  if (typeof process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY !== 'string') {
    const raw = params.settings?.scmIncludeCoAuthoredBy;
    if (typeof raw === 'boolean') {
      process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = raw ? '1' : '0';
    }
  }

  // Allow explicit env var overrides (for debugging / CI).
  if (typeof process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS !== 'string') {
    const rawActions = (params.settings as any)?.actionsSettingsV1;
    const disabled = Array.isArray(rawActions?.disabledActionIds) ? rawActions.disabledActionIds : null;
    if (disabled && disabled.length > 0) {
      const ids = disabled
        .map((v: any) => (typeof v === 'string' ? v.trim() : ''))
        .filter((v: string) => v.length > 0);
      process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS = JSON.stringify(ids);
    }
  }
}
