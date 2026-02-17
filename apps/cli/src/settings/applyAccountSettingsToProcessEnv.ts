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
  if (typeof process.env.HAPPIER_ACTIONS_SETTINGS_V1 !== 'string') {
    const rawActions = (params.settings as any)?.actionsSettingsV1;
    const parsed = rawActions && typeof rawActions === 'object' ? rawActions : null;
    if (parsed) {
      try {
        process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify(parsed);
      } catch {
        // ignore
      }
    }
  }
}
