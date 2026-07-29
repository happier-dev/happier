import { resolveCliFeatureDecision, type CliServerFeaturesSnapshot } from '@/features/featureDecisionService';

/**
 * The privileged browser child gates enforced at the daemon execution boundary. These are the
 * capture/automation-adjacent surfaces that are server-represented + default-off (or
 * client-represented + fail-closed for automation): a route owner must NOT be registered and an
 * action must NOT dispatch unless the server feature decision says enabled.
 */
export type BrowserDaemonFeatureGateId =
  | 'browser.sidecar'
  | 'browser.context'
  | 'browser.diagnostics'
  | 'browser.recording'
  | 'browser.recording.attachments'
  | 'attachments.uploads'
  | 'browser.automation';

export type BrowserDaemonFeatureGate = Readonly<{
  // Synchronous read of the latest cached server-features decision. Fail-closed (returns false)
  // until a snapshot has been cached via refresh().
  isEnabled(featureId: BrowserDaemonFeatureGateId): boolean;
  // Best-effort async refresh of the cached snapshot from the daemon-supplied provider. Awaited
  // ONCE before route registration; thereafter callers read the cached value synchronously. A
  // thrown/empty provider keeps the previous snapshot (or none) so the gate stays fail-closed
  // rather than flapping.
  refresh(): Promise<void>;
}>;

export function createBrowserDaemonFeatureGate(params: {
  env: NodeJS.ProcessEnv;
  // The SAME async provider shape already used for local-services inventory + connected-services
  // quotas. The gate (not the call site) owns caching the resolved snapshot.
  resolveServerFeaturesSnapshot: () => Promise<CliServerFeaturesSnapshot | undefined> | CliServerFeaturesSnapshot | undefined;
  onError?: (error: unknown) => void;
}): BrowserDaemonFeatureGate {
  // Mirror the local-services inventory gate (runtime.ts:534-552): hold the latest snapshot,
  // refresh best-effort, resolve every decision through the canonical resolveCliFeatureDecision.
  let cachedServerFeaturesSnapshot: CliServerFeaturesSnapshot | undefined;

  const isEnabled = (featureId: BrowserDaemonFeatureGateId): boolean => {
    const decision = resolveCliFeatureDecision({
      featureId,
      env: params.env,
      ...(cachedServerFeaturesSnapshot ? { serverSnapshot: cachedServerFeaturesSnapshot } : {}),
    });
    return decision.state === 'enabled';
  };

  const refresh = async (): Promise<void> => {
    try {
      const next = await params.resolveServerFeaturesSnapshot();
      if (next) cachedServerFeaturesSnapshot = next;
    } catch (error) {
      params.onError?.(error);
    }
  };

  return { isEnabled, refresh };
}
