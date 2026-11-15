import { resolveCliFeatureDecision, type CliServerFeaturesSnapshot } from '@/features/featureDecisionService';
import type { ProcessEnvInput } from '@/utils/processEnv/buildScopedProcessEnv';

/**
 * The privileged browser child gates enforced at the daemon execution boundary. These are the
 * capture/automation-adjacent surfaces represented by canonical feature settings:
 * a route owner must NOT be registered and an
 * action must NOT dispatch unless the server feature decision says enabled.
 */
const BROWSER_DAEMON_FEATURE_GATE_IDS = [
  'browser.sidecar',
  'browser.context',
  'browser.diagnostics',
  'browser.recording',
  'browser.recording.attachments',
  'attachments.uploads',
  'browser.automation',
] as const;

export type BrowserDaemonFeatureGateId = typeof BROWSER_DAEMON_FEATURE_GATE_IDS[number];

export type BrowserDaemonFeatureGate = Readonly<{
  // Synchronous read of the latest decision. Fail-closed until refresh() succeeds.
  isEnabled(featureId: BrowserDaemonFeatureGateId): boolean;
  // The daemon refreshes before route registration and on reconnect. A thrown/empty provider
  // retains the previous decisions; a successful refresh also publishes withdrawals.
  refresh(): Promise<void>;
}>;

export function createBrowserDaemonFeatureGate(params: {
  env: ProcessEnvInput;
  // The SAME async provider shape already used for local-services inventory + connected-services
  // quotas. This gate owns the resolved decisions consumed by routes and event publication.
  resolveServerFeaturesSnapshot: () => Promise<CliServerFeaturesSnapshot | undefined> | CliServerFeaturesSnapshot | undefined;
  onError?: (error: unknown) => void;
}): BrowserDaemonFeatureGate {
  let enabledFeatures = new Set<BrowserDaemonFeatureGateId>();
  const isEnabled = (featureId: BrowserDaemonFeatureGateId): boolean => enabledFeatures.has(featureId);

  const refresh = async (): Promise<void> => {
    try {
      const next = await params.resolveServerFeaturesSnapshot();
      if (next) {
        enabledFeatures = new Set(BROWSER_DAEMON_FEATURE_GATE_IDS.filter(featureId =>
          resolveCliFeatureDecision({ featureId, env: params.env, serverSnapshot: next }).state === 'enabled'));
      }
    } catch (error) {
      params.onError?.(error);
    }
  };

  return { isEnabled, refresh };
}
