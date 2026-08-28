export const MOBILE_PLUGIN_PLATFORM_CURRENT_SOURCE_FLOW =
  'suites/mobile-e2e/flows/plugin-platform-current-source/managed-inspector-native.yaml';

export type CurrentSourceDisposableSessionAttribution =
  | Readonly<{ status: 'attributed'; sessionId: string }>
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'ambiguous'; deltaCount: number }>;

/**
 * Attributes the Session delta inside one New Session creation/send window.
 * `before`/`after` are Account snapshots taken immediately around that window;
 * they can only name the single Session the window created and never authorize
 * deleting an unrelated delta.
 */
export function resolveCurrentSourceDisposableSessionCleanupId(input: Readonly<{
  before: ReadonlySet<string>;
  after: ReadonlySet<string>;
}>): CurrentSourceDisposableSessionAttribution {
  const createdSessionIds = [...input.after].filter((sessionId) => !input.before.has(sessionId));
  if (createdSessionIds.length === 1) {
    return { status: 'attributed', sessionId: createdSessionIds[0] ?? '' };
  }
  if (createdSessionIds.length === 0) return { status: 'absent' };
  return { status: 'ambiguous', deltaCount: createdSessionIds.length };
}

export type CurrentSourceDisposableSessionCapture = Readonly<{
  /** Exact Session id armed for cleanup, or null when nothing was attributable. */
  sessionId: string | null;
  /** Typed attribution conflict; never authorizes deletion. */
  conflict: string | null;
  /** Unreadable snapshot error; never authorizes deletion. */
  readError: unknown;
}>;

const DISPOSABLE_SESSION_CAPTURE_DEFAULT_ATTEMPTS = 3;
const DISPOSABLE_SESSION_CAPTURE_DEFAULT_DELAY_MS = 250;

function delaySync(ms: number): Promise<void> {
  return new Promise((resolveDelay) => { setTimeout(resolveDelay, ms); });
}

/**
 * Arms exact cleanup for the Session created by this row's New Session
 * creation/send handoff. `before` must be the Account snapshot taken
 * immediately before the window opened. A short retry on an absent delta
 * absorbs the row's own list read racing the just-created Session; ambiguity
 * and unreadable reads never arm deletion.
 */
export async function captureCurrentSourceDisposableSessionId(input: Readonly<{
  before: ReadonlySet<string>;
  readSessionIds: () => Promise<ReadonlySet<string>>;
  attempts?: number;
  delayMs?: number;
}>): Promise<CurrentSourceDisposableSessionCapture> {
  const attempts = Math.max(1, Math.floor(input.attempts ?? DISPOSABLE_SESSION_CAPTURE_DEFAULT_ATTEMPTS));
  const delayMs = Math.max(0, Math.floor(input.delayMs ?? DISPOSABLE_SESSION_CAPTURE_DEFAULT_DELAY_MS));
  let readError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let after: ReadonlySet<string>;
    try {
      after = await input.readSessionIds();
      readError = null;
    } catch (error) {
      readError = error;
      if (attempt + 1 < attempts) {
        await delaySync(delayMs);
        continue;
      }
      return { sessionId: null, conflict: null, readError };
    }
    const attribution = resolveCurrentSourceDisposableSessionCleanupId({
      before: input.before,
      after,
    });
    if (attribution.status === 'attributed') {
      return { sessionId: attribution.sessionId, conflict: null, readError: null };
    }
    if (attribution.status === 'ambiguous') {
      return {
        sessionId: null,
        conflict: `plugin_ui_current_source_disposable_session_identity_ambiguous:${attribution.deltaCount}`,
        readError: null,
      };
    }
    if (attempt + 1 < attempts) await delaySync(delayMs);
  }
  return { sessionId: null, conflict: null, readError };
}

/**
 * The armed exact Session id is the sole deletion authority for this row.
 * Attribution conflicts and unreadable reads fail closed: they delete nothing
 * and surface as aggregated cleanup failures. Account-wide snapshot deltas are
 * never consulted here, so unrelated concurrent Sessions are undeletable by
 * construction.
 */
export function resolveCurrentSourceDisposableSessionDeletionTarget(
  capture: CurrentSourceDisposableSessionCapture,
): string | null {
  if (capture.readError != null) {
    throw new Error('plugin_ui_current_source_disposable_session_identity_unreadable', {
      cause: capture.readError,
    });
  }
  if (capture.conflict) throw new Error(capture.conflict);
  return capture.sessionId;
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
