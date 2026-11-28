async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve the best public server URL to present to users / generate links.
 *
 * Priority:
 * 1) explicit public URL override (if non-default)
 * 2) persisted relay-access config with a canonical public URL
 * 3) if enabled, prefer existing https://*.ts.net from tailscale serve status
 * 4) fallback to defaultPublicUrl
 *
 * If HAPPIER_STACK_TAILSCALE_SERVE=1, this can also try to enable serve and wait briefly for Tailscale to come up.
 */
export async function resolvePublicServerUrl({
  internalServerUrl,
  defaultPublicUrl,
  envPublicUrl,
  allowEnable = true,
  stackName = 'main',
  env = process.env,
}) {
  const preferTailscalePublicUrl = (env.HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL ?? '1') !== '0';
  const normalizedEnvPublicUrl = String(envPublicUrl ?? '').trim();
  const envPublicUrlIsLocalDefault =
    !!normalizedEnvPublicUrl &&
    (normalizedEnvPublicUrl === defaultPublicUrl || normalizedEnvPublicUrl === internalServerUrl);
  let relayAccessPublicUrl = null;
  if (!normalizedEnvPublicUrl || envPublicUrlIsLocalDefault) {
    const { resolveRelayAccessConfiguredCanonicalPublicServerUrl } = await import('@happier-dev/cli-common/relayAccess/publicUrl');
    relayAccessPublicUrl = await resolveRelayAccessConfiguredCanonicalPublicServerUrl(env, {
      upstreamUrl: internalServerUrl,
      allowTailscaleProviders: preferTailscalePublicUrl,
    });
  }
  const effectiveEnvPublicUrl = relayAccessPublicUrl || normalizedEnvPublicUrl;
  const userExplicitlySetPublicUrl =
    !!effectiveEnvPublicUrl && effectiveEnvPublicUrl !== defaultPublicUrl && effectiveEnvPublicUrl !== internalServerUrl;

  if (userExplicitlySetPublicUrl || !preferTailscalePublicUrl) {
    return {
      publicServerUrl: effectiveEnvPublicUrl || defaultPublicUrl,
      source: relayAccessPublicUrl ? 'relay-access' : 'env',
    };
  }

  const fallback = {
    publicServerUrl: effectiveEnvPublicUrl || defaultPublicUrl,
    source: effectiveEnvPublicUrl ? (relayAccessPublicUrl ? 'relay-access' : 'env') : 'default',
  };
  const nonMainStack = Boolean(stackName && stackName !== 'main');
  // Non-main stacks can discover an existing route only when enabled by the caller.
  if (nonMainStack && !allowEnable) return fallback;

  const { tailscaleAutoEnableTimeoutMs, tailscaleServeEnable, tailscaleServeHttpsUrlForInternalServerUrl } =
    await import('../net/tailscale_serve.mjs');
  const { TailscaleCommandError } = await import('@happier-dev/cli-common/tailscale');
  // Discovery is optional: preserve other routes while reporting a terminal refusal.
  try {
    const existing = await tailscaleServeHttpsUrlForInternalServerUrl(internalServerUrl);
    if (existing) {
      return { publicServerUrl: existing, source: 'tailscale-status' };
    }
    const enableServe = (env.HAPPIER_STACK_TAILSCALE_SERVE ?? '0') === '1';
    if (nonMainStack || !enableServe || !allowEnable) return fallback;

    // Try enabling Serve, then use the existing readiness budget for transient failures.
    try {
      const res = await tailscaleServeEnable({ internalServerUrl, timeoutMs: tailscaleAutoEnableTimeoutMs() });
      if (res?.httpsUrl) {
        return { publicServerUrl: res.httpsUrl, source: 'tailscale-enable' };
      }
    } catch (error) {
      if (error instanceof TailscaleCommandError && error.failure?.retryable === false) throw error;
    }

    const waitMs = env.HAPPIER_STACK_TAILSCALE_WAIT_MS?.trim()
      ? Number(env.HAPPIER_STACK_TAILSCALE_WAIT_MS.trim())
      : 15000;
    const deadline = Date.now() + (Number.isFinite(waitMs) ? waitMs : 15000);
    while (Date.now() < deadline) {
      const url = await tailscaleServeHttpsUrlForInternalServerUrl(internalServerUrl);
      if (url) {
        return { publicServerUrl: url, source: 'tailscale-wait' };
      }
      await sleep(500);
    }

    return fallback;
  } catch (error) {
    if (!(error instanceof TailscaleCommandError) || !error.failure) throw error;
    console.warn(`[tailscale] ${error.failure.code}: ${error.message}`);
    return { ...fallback, failure: error.failure };
  }
}
