import { resolveCliFeatureDecision, type CliServerFeaturesSnapshot } from '@/features/featureDecisionService';

/**
 * The simulator execution gate enforced at the daemon execution boundary. Mirrors the browser /
 * local-services daemon feature-gate pattern: a server-disabled feature must be REFUSED when the
 * action is executed, not merely hidden in the UI. `devices.simulatorPreview` is the canonical
 * gate for every `devices.simulator.*` runtime action; its catalog dependencies (`devices`,
 * `machines.liveStream`, `browser.viewTargets`) cascade through the central feature decision.
 */
export type SimulatorDaemonFeatureGateId = 'devices.simulatorPreview';

export type SimulatorDaemonFeatureGate = Readonly<{
  // Synchronous read of the latest cached server-features decision.
  isEnabled(featureId: SimulatorDaemonFeatureGateId): boolean;
  // Best-effort async refresh of the cached snapshot from the daemon-supplied provider. A
  // thrown/empty provider keeps the previous snapshot (or none) so the gate does not flap.
  refresh(): Promise<void>;
}>;

export function createSimulatorDaemonFeatureGate(params: {
  env: NodeJS.ProcessEnv;
  // The SAME async provider shape already used by the browser / local-services daemon gates.
  // The gate (not the call site) owns caching the snapshot.
  resolveServerFeaturesSnapshot: () => Promise<CliServerFeaturesSnapshot | undefined> | CliServerFeaturesSnapshot | undefined;
  onError?: (error: unknown) => void;
}): SimulatorDaemonFeatureGate {
  let cachedServerFeaturesSnapshot: CliServerFeaturesSnapshot | undefined;

  const isEnabled = (featureId: SimulatorDaemonFeatureGateId): boolean => {
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
