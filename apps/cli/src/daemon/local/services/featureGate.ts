import { resolveCliFeatureDecision, type CliServerFeaturesSnapshot } from '@/features/featureDecisionService';

/**
 * The local-service execution gates enforced at the daemon execution boundary. These mirror the
 * connected-service quotas / browser daemon feature-gate pattern: a disabled feature must be
 * REFUSED when the action is executed, not merely hidden in the UI. The server is the gate, so a
 * server that disables a feature fails the corresponding actions closed at the daemon.
 */
export type LocalServicesDaemonFeatureGateId =
  | 'localServices'
  | 'localServices.inventory'
  | 'localServices.managed'
  | 'localServices.launcher'
  | 'localServices.actions'
  | 'localServices.actions.terminate'
  | 'localServices.preview'
  | 'localServices.publicPreview';

export type LocalServicesDaemonFeatureGate = Readonly<{
  // Synchronous read of the latest cached server-features decision. Fail-closed (returns false)
  // until a snapshot has been cached via refresh().
  isEnabled(featureId: LocalServicesDaemonFeatureGateId): boolean;
  // Best-effort async refresh of the cached snapshot from the daemon-supplied provider. A
  // thrown/empty provider keeps the previous snapshot (or none) so the gate stays fail-closed
  // rather than flapping.
  refresh(): Promise<void>;
}>;

export function createLocalServicesDaemonFeatureGate(params: {
  env: NodeJS.ProcessEnv;
  // The SAME async provider shape already used for local-services inventory + connected-services
  // quotas + the browser daemon gate. The gate (not the call site) owns caching the snapshot.
  resolveServerFeaturesSnapshot: () => Promise<CliServerFeaturesSnapshot | undefined> | CliServerFeaturesSnapshot | undefined;
  onError?: (error: unknown) => void;
}): LocalServicesDaemonFeatureGate {
  let cachedServerFeaturesSnapshot: CliServerFeaturesSnapshot | undefined;

  const isEnabled = (featureId: LocalServicesDaemonFeatureGateId): boolean => {
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
