export function applyAccountSettingsToProcessEnv(params: Readonly<{
  settings: Record<string, unknown>;
}>): void {
  // Allow explicit env var overrides (for debugging / CI).
  if (typeof process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY === 'string') {
    return;
  }

  const raw = params.settings?.scmIncludeCoAuthoredBy;
  if (typeof raw === 'boolean') {
    process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY = raw ? '1' : '0';
  }
}

