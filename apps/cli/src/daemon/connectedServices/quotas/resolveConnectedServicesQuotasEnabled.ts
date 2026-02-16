function resolveBoolEnv(raw: string | undefined, fallback: boolean): boolean {
  if (typeof raw !== 'string') return fallback;
  const v = raw.trim().toLowerCase();
  if (!v) return fallback;
  if (v === '1' || v === 'true' || v === 'yes' || v === 'y' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'n' || v === 'off') return false;
  return fallback;
}

export function resolveConnectedServicesQuotasEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    resolveBoolEnv(env.HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED, true) &&
    resolveBoolEnv(env.HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED, false)
  );
}

