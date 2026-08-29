export const MOBILE_PLUGIN_PLATFORM_CURRENT_SOURCE_FLOW =
  'suites/mobile-e2e/flows/plugin-platform-current-source/managed-inspector-native.yaml';

/**
 * The exact disposable-Session fact for one New Session creation/send handoff,
 * produced or canonically bound by that handoff's own spawn-attempt owner and
 * keyed by the QA-owned draft/attempt. Account-wide lists, timing deltas, and
 * URL guesses are never consulted: the only deletable Session is one this fact
 * binds by exact id.
 */
export type CurrentSourceDisposableSessionExactFact =
  | Readonly<{ status: 'bound'; sessionId: string }>
  /** The handoff produced no Session identity (or none survived). */
  | Readonly<{ status: 'missing' }>
  /** The exact key resolved to more than one Session identity. */
  | Readonly<{ status: 'conflicting'; matches: number }>
  /** The exact-fact source could not be read; never authorizes deletion. */
  | Readonly<{ status: 'unreadable'; error: unknown }>
  /** No exact-fact source is wired for this corridor yet; never authorizes deletion. */
  | Readonly<{ status: 'unavailable'; reason: string }>;

/**
 * Production exact-fact source for the disposable Session created by this
 * row's New Session UI send. The canonical spawn-attempt/Action-operation fact
 * that binds the QA-owned draft to the created Session id is not yet exposed on
 * any harness-reachable surface: the launch-attempt identity lives only in the
 * device-local draft supplement (`SessionDraftLocalSupplement` is never sealed
 * or sent to the server), and Action-operation snapshots are ephemeral
 * encrypted pushes with no account-scoped or daemon-control read. Until that
 * single canonical surface exists, the row fails closed: it never deletes a
 * Session it cannot name exactly, records the unavailability as lifecycle
 * evidence, leaves unrelated concurrent Sessions undeletable by construction,
 * and blocks the deciding row nonzero instead of crediting a green loaded row
 * while the Session it created can be neither named nor deleted.
 */
export async function readCurrentSourceDisposableSessionExactFact(): Promise<CurrentSourceDisposableSessionExactFact> {
  return {
    status: 'unavailable',
    reason: 'plugin_ui_current_source_disposable_session_exact_fact_source_not_wired',
  };
}

/**
 * The bound exact Session id is the sole deletion authority for this row.
 * Missing, conflicting, and unreadable facts fail closed: they delete nothing
 * and surface as aggregated cleanup failures, so an unrelated Session can never
 * be a deletion target.
 */
export function resolveCurrentSourceDisposableSessionDeletionTarget(
  fact: CurrentSourceDisposableSessionExactFact,
): string | null {
  if (fact.status === 'bound') return fact.sessionId;
  if (fact.status === 'missing') {
    throw new Error('plugin_ui_current_source_disposable_session_identity_missing');
  }
  if (fact.status === 'conflicting') {
    throw new Error(`plugin_ui_current_source_disposable_session_identity_conflicting:${fact.matches}`);
  }
  if (fact.status === 'unreadable') {
    throw new Error('plugin_ui_current_source_disposable_session_identity_unreadable', {
      cause: fact.error,
    });
  }
  return null;
}

function stripOption(argv: readonly string[], option: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === option) {
      index += 1;
      continue;
    }
    if (arg.startsWith(`${option}=`)) continue;
    result.push(arg);
  }
  return result;
}

export function resolveMobilePluginPlatformCurrentSourceRun(input: Readonly<{
  argv: string[];
  env: NodeJS.ProcessEnv;
  managedStack?: Readonly<{
    serverUrl: string;
  }>;
}>): Readonly<{ argv: string[]; env: NodeJS.ProcessEnv }> {
  if (!input.managedStack) {
    throw new Error('Current-source Plugin UI mobile QA requires the canonical managed Stack context');
  }
  const serverUrl = input.managedStack.serverUrl;
  const withoutFlow = stripOption(input.argv, '--flows');
  const withoutServer = stripOption(withoutFlow, '--serverUrl');
  return Object.freeze({
    argv: [
      ...withoutServer,
      '--flows',
      MOBILE_PLUGIN_PLATFORM_CURRENT_SOURCE_FLOW,
      '--serverUrl',
      serverUrl,
    ],
    env: {
      ...input.env,
      HAPPIER_E2E_MOBILE_MANAGE_METRO: '1',
      HAPPIER_E2E_EXPO_CLEAR: '1',
      HAPPIER_E2E_UCX_NATIVE_LOADED_IDENTITY: '1',
      HAPPIER_E2E_ATTEST_INSTALLED_NATIVE_APP: '1',
      HAPPIER_E2E_NATIVE_MODULE_PROBE_FLOW:
        'suites/mobile-e2e/flows/plugin-platform-current-source/native-module-probe.yaml',
      // This row consumes the already-running managed Stack daemon. Starting a
      // second ambient daemon would make multi-machine routing evidence
      // ambiguous, so the generic connected-machine bootstrap is forbidden.
      HAPPIER_E2E_MOBILE_CONNECTED_MACHINE_MODE: 'none',
    },
  });
}

export function resolveMobilePluginPlatformCurrentSourceExitCode(result: Readonly<{
  exitCode: number;
  loadedRuntimeKind: 'observed' | 'blocked' | null;
  installedNativeAppIdentityKind?: 'android-base-apk' | 'ios-app-bundle-file-set' | null;
}>): number {
  if (result.exitCode !== 0) return result.exitCode;
  return result.loadedRuntimeKind === 'observed'
    && result.installedNativeAppIdentityKind !== null
    && result.installedNativeAppIdentityKind !== undefined
    ? 0
    : 2;
}
