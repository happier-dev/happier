import type { E2eCliProviderSpecV1 } from '@happier-dev/protocol';

type ProviderAuth = NonNullable<E2eCliProviderSpecV1['auth']>;
type AuthOverlay = NonNullable<ProviderAuth['env'] | ProviderAuth['host']>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function envHasAll(env: Record<string, unknown>, keys: string[] | undefined): boolean {
  if (!keys || keys.length === 0) return true;
  return keys.every((k) => isNonEmptyString(env[k]));
}

function envMatchesAnyOf(env: Record<string, unknown>, anyOf: string[][] | undefined): boolean {
  if (!anyOf || anyOf.length === 0) return true;
  return anyOf.some((bucket) => bucket.every((k) => isNonEmptyString(env[k])));
}

function assertOverlayRequirements(params: { mode: 'env' | 'host'; overlay: AuthOverlay; baseEnv: Record<string, unknown> }): void {
  const { overlay, baseEnv, mode } = params;

  const requiredAll = overlay.requiredAll ?? [];
  if (!envHasAll(baseEnv, requiredAll)) {
    throw new Error(`Missing required env for provider auth mode ${mode}: ${requiredAll.join(', ')}`);
  }

  const requiredAnyOf = overlay.requiredAnyOf ?? [];
  if (!envMatchesAnyOf(baseEnv, requiredAnyOf)) {
    const formatted = requiredAnyOf.map((b) => `(${b.join(' && ')})`).join(' || ');
    throw new Error(`Missing required env for provider auth mode ${mode}: ${formatted}`);
  }
}

export function resolveProviderAuthOverlay(params: {
  auth: ProviderAuth | undefined;
  baseEnv: Record<string, string | undefined>;
}): { mode: 'env' | 'host'; env: Record<string, string> } {
  const { auth } = params;
  const baseEnv: Record<string, string> = Object.fromEntries(
    Object.entries(params.baseEnv).flatMap(([k, v]) => (isNonEmptyString(v) ? [[k, v]] : [])),
  );

  if (!auth) return { mode: 'host', env: baseEnv };

  const mode = auth.mode ?? 'auto';
  const envOverlay = auth.env;
  const hostOverlay = auth.host;

  const canUseEnv =
    envOverlay &&
    envHasAll(baseEnv, envOverlay.requiredAll) &&
    envMatchesAnyOf(baseEnv, envOverlay.requiredAnyOf);

  const selected: 'env' | 'host' =
    mode === 'env' ? 'env' : mode === 'host' ? 'host' : canUseEnv ? 'env' : 'host';

  const overlay = selected === 'env' ? envOverlay : hostOverlay;
  if (!overlay) {
    // No overlay rules; return base env unchanged.
    return { mode: selected, env: baseEnv };
  }

  if (mode === 'env' || mode === 'host') {
    assertOverlayRequirements({ mode: selected, overlay, baseEnv });
  }

  const merged: Record<string, string> = { ...baseEnv, ...(overlay.env ?? {}) };
  for (const key of overlay.envUnset ?? []) {
    delete merged[key];
  }

  return { mode: selected, env: merged };
}
