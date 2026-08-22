import { configuration } from '@/configuration';
import type { HappyProcessInfo } from '@/daemon/doctor';
import {
  normalizeProcessCommandPathValue,
  processCommandContainsPathFragment,
} from '@/subprocess/processCommandPathMatch';

function normalizeScopeValue(value: string | null | undefined): string {
  return String(value ?? '').trim();
}

function normalizeServerUrl(value: string | null | undefined): string {
  return normalizeScopeValue(value).replace(/\/+$/, '').toLowerCase();
}

function processEnvValueMatchesCurrent(
  processValue: string | null | undefined,
  currentValue: string | null | undefined,
  normalize: (value: string) => string = normalizeScopeValue,
): boolean {
  const processScopeValue = normalizeScopeValue(processValue);
  if (!processScopeValue) return true;
  const currentScopeValue = normalizeScopeValue(currentValue);
  if (!currentScopeValue) return true;
  return normalize(processScopeValue) === normalize(currentScopeValue);
}

function processServerUrlMatchesCurrent(
  processValue: string | null | undefined,
  requireRecordedScopeFacts: boolean,
): boolean {
  const processServerUrl = normalizeServerUrl(processValue);
  if (!processServerUrl) return !requireRecordedScopeFacts;
  const currentServerUrls = new Set([
    normalizeServerUrl(configuration.serverUrl),
    normalizeServerUrl(configuration.apiServerUrl),
    normalizeServerUrl(configuration.publicServerUrl),
  ].filter(Boolean));
  if (currentServerUrls.size === 0) return !requireRecordedScopeFacts;
  return currentServerUrls.has(processServerUrl);
}

/**
 * Recognizes the command of the long-lived daemon process for the current
 * runtime root. This is deliberately narrower than the process classifier:
 * launcher and wrapper parents are not lifecycle owners and must never
 * satisfy a signal authority.
 */
export function isDaemonCommandForCurrentRuntimeRoot(
  commandValue: string,
  currentRuntimeRoot: string,
): boolean {
  const command = normalizeProcessCommandPathValue(commandValue);
  if (!processCommandContainsPathFragment(command, currentRuntimeRoot)) return false;

  // The public Node wrappers re-exec through `_importRuntimeEntrypoint.mjs` so warning handles
  // cannot leak into the runtime process. During that synchronous re-exec, the parent command
  // still ends in `<wrapper> daemon start-sync`; it is only a bootstrapper, not a relay owner.
  // The imported child includes additional runtime arguments between the wrapper path and
  // `daemon start-sync`, so it remains visible as the real owner.
  if (/\/bin\/happier(?:-dev)?\.mjs["']?\s+daemon\s+start-sync(?:\s|$)/u.test(command)) {
    return false;
  }

  // The process classifier labels both the transient `daemon start` launcher and the actual
  // `daemon start-sync` daemon as `daemon`/`dev-daemon`. Only `start-sync` is a real, long-lived
  // daemon owner. The launcher is a bootstrapper that spawns the detached daemon and then blocks
  // waiting for the relay, so counting it here makes managed startup conflict with its own
  // launcher — producing the all-"unknown" stateless-owner conflict that prevents the daemon from
  // ever coming up.
  return command.includes('daemon start-sync');
}

/**
 * Recognizes the long-lived daemon process for the current runtime root. This
 * adds the inventory's type and self-PID protections to the canonical command
 * classification above.
 */
export function isDaemonProcessForCurrentRuntimeRoot(
  processInfo: HappyProcessInfo,
  currentRuntimeRoot: string,
): boolean {
  if (processInfo.pid === process.pid) return false;
  if (processInfo.type !== 'daemon' && processInfo.type !== 'dev-daemon') return false;
  return isDaemonCommandForCurrentRuntimeRoot(processInfo.command, currentRuntimeRoot);
}

/**
 * Matches a discovered daemon process to the current lifecycle scope. Discovery
 * may classify old processes with incomplete environment facts, but force-stop
 * callers require the recorded scope facts before they are allowed to signal.
 */
export function daemonProcessMatchesCurrentScope(
  processInfo: HappyProcessInfo,
  options: Readonly<{ requireRecordedScopeFacts?: boolean }> = {},
): boolean {
  const requireRecordedScopeFacts = options.requireRecordedScopeFacts === true;
  const env = processInfo.daemonOwnershipEnvironmentVariables;
  if (!env) return !requireRecordedScopeFacts;

  const processHomeDir = normalizeScopeValue(env.HAPPIER_HOME_DIR);
  const currentHomeDir = normalizeScopeValue(configuration.happyHomeDir);
  if (requireRecordedScopeFacts && (!processHomeDir || !currentHomeDir)) return false;
  if (!processEnvValueMatchesCurrent(
    env.HAPPIER_HOME_DIR,
    configuration.happyHomeDir,
    normalizeProcessCommandPathValue,
  )) {
    return false;
  }

  const processLifecycleScopeId = normalizeScopeValue(env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID);
  const currentLifecycleScopeId = normalizeScopeValue(process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID);
  if (processLifecycleScopeId) {
    // Explicit lifecycle scope is the canonical owner identity. Endpoint profiles and URLs are
    // independently mutable connection facts for discovery, but a force-stop requires every
    // available recorded scope fact to agree before it signals the process.
    if (!currentLifecycleScopeId || processLifecycleScopeId !== currentLifecycleScopeId) return false;
    return !requireRecordedScopeFacts
      || processServerUrlMatchesCurrent(env.HAPPIER_SERVER_URL, true);
  }

  // Released stack daemons predate the explicit lifecycle-scope variable. Only that old shape may
  // fall back to the active-server identity and endpoint URL comparison.
  const currentFallbackScope = currentLifecycleScopeId || configuration.activeServerId;
  const processActiveServerId = normalizeScopeValue(env.HAPPIER_ACTIVE_SERVER_ID);
  if (requireRecordedScopeFacts && (!processActiveServerId || !currentFallbackScope)) return false;
  if (!processEnvValueMatchesCurrent(env.HAPPIER_ACTIVE_SERVER_ID, currentFallbackScope)) {
    return false;
  }

  if (!processServerUrlMatchesCurrent(env.HAPPIER_SERVER_URL, requireRecordedScopeFacts)) return false;

  return true;
}
