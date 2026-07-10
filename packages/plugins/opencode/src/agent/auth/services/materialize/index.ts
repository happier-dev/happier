import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/plugin-sdk/experimental/cloud/auth';

import { OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV } from '../../../runtime/server/managedServerState.js';
import {
  OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV,
  OPEN_CODE_BROKER_PLUGIN_VERSION,
  OPEN_CODE_BROKER_PLUGIN_VERSION_ENV,
  OPEN_CODE_BROKER_REFRESH_TOKEN_ENV,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  deriveOpenCodeBrokerRefreshToken,
  resolveOpenCodeConnectedConfigHomeDir,
  serializeOpenCodeBrokerSelections,
} from '../broker/index.js';

import {
  createOpenCodeAuthMaterializationAccumulator,
  type OpenCodeAuthMaterializationAccumulator,
} from './accumulator.js';
import { materializeAnthropicAuth } from './anthropic.js';
import { materializeOpenAiAuth } from './openai.js';

export type OpenCodeAuthMaterializationInput = Readonly<{
  openaiCodex?: ConnectedServiceCredentialRecordV1 | null;
  openai?: ConnectedServiceCredentialRecordV1 | null;
  claudeSubscription?: ConnectedServiceCredentialRecordV1 | null;
  anthropic?: ConnectedServiceCredentialRecordV1 | null;
  /**
   * R4-4/F3: serviceId → groupId for GROUP-bound selections (host-provided). Scopes the selection
   * identity by pool WITHOUT generation, so two pools sharing one active profile never collapse to
   * one identity while a generation-only bump keeps the identity stable.
   */
  connectedServiceGroupIdsByServiceId?: Readonly<Record<string, string>> | null;
}>;

export type OpenCodeAuthEnvironmentInput = OpenCodeAuthMaterializationInput & Readonly<{
  /** Per-selection Happier-owned connected-service home dir (host-provided). Roots config isolation. */
  rootDir?: string | null;
  /** Absolute path to the Happier daemon-state file (host-provided). The broker reads its httpPort. */
  daemonStateFilePath?: string | null;
  /**
   * Daemon MASTER control token (host-provided). Used ONLY to DERIVE the scoped broker-refresh
   * capability token injected into the broker env (F2 least privilege). It is NEVER placed in the env;
   * when absent the scoped token is omitted and the broker fails closed at request time.
   */
  daemonControlToken?: string | null;
  /** Managed-server state path (existing reuse contract). */
  managedServerStatePath?: string | null;
}>;

function accumulate(input: OpenCodeAuthMaterializationInput): OpenCodeAuthMaterializationAccumulator {
  const accumulator = createOpenCodeAuthMaterializationAccumulator();
  materializeOpenAiAuth(accumulator, input);
  materializeAnthropicAuth(accumulator, input);
  return accumulator;
}

/** Build only the `OPENCODE_AUTH_CONTENT` JSON (broker markers + direct keys). Pure, no FS. */
export function buildOpenCodeAuthContent(input: OpenCodeAuthMaterializationInput): string {
  return JSON.stringify(accumulate(input).auth);
}

/**
 * Materialize the full connected-service auth environment for an OpenCode managed server.
 *
 * Brokered services (subscription OAuth / setup-token) NEVER receive a refresh token: a stable,
 * non-refreshable broker MARKER is written to `OPENCODE_AUTH_CONTENT`, the broker selection + daemon
 * bridge target are emitted, and the broker fetches fresh access tokens from the Happier daemon bridge
 * at request time (daemon = sole refresher). Direct API keys (OpenAI platform key, Anthropic Console
 * key) stay as real `{type:'api', key}` entries.
 *
 * Connected sessions are config-isolated: `XDG_CONFIG_HOME` is redirected to a Happier-owned config
 * home (derived from the per-selection `rootDir`) so the user's third-party OpenCode plugins do not
 * contaminate connected auth. The broker plugin `.js` is written into that config home's
 * `opencode/plugin/` auto-load dir by the live server-launch path; OpenCode loads it from the
 * redirected `XDG_CONFIG_HOME`. The emitted selection-identity env keys the managed-server fingerprint
 * on the stable account selection (so a same-account token refresh does not churn the server).
 *
 * This function performs NO filesystem I/O: it only references deterministic, version-keyed paths.
 */
export function materializeOpenCodeAuthEnvironment(input: OpenCodeAuthEnvironmentInput): Readonly<{
  env: Readonly<Record<string, string>>;
}> {
  const accumulator = accumulate(input);
  const env: Record<string, string> = {
    OPENCODE_AUTH_CONTENT: JSON.stringify(accumulator.auth),
    ...(input.managedServerStatePath ? {
      HAPPIER_OPENCODE_SERVER_STATE_PATH: input.managedServerStatePath,
    } : {}),
  };

  if (accumulator.identityFragments.length === 0) {
    // No connected credential present ⇒ nothing to materialize (caller treats null as native).
    return { env };
  }

  // Config isolation: redirect XDG_CONFIG_HOME to a Happier-owned config home so connected sessions
  // load NO user third-party plugins. The broker plugin (when present) is written into that config
  // home's `opencode/plugin/` auto-load dir as a `.js` file by the server-launch path; OpenCode then
  // discovers + loads it from the redirected XDG_CONFIG_HOME. We deliberately do NOT register it via
  // `OPENCODE_CONFIG_CONTENT.plugin` — live-verified (opencode v1.14.41): an absolute path there does
  // NOT load, and the auto-discovery glob matches `*.js` ONLY (never `*.mjs`).
  const rootDir = typeof input.rootDir === 'string' && input.rootDir.trim().length > 0 ? input.rootDir : null;
  if (rootDir) {
    env.XDG_CONFIG_HOME = resolveOpenCodeConnectedConfigHomeDir(rootDir);
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({});
  }

  if (accumulator.brokeredProviders.length > 0) {
    env[OPEN_CODE_BROKER_SELECTIONS_ENV] = serializeOpenCodeBrokerSelections(accumulator.brokerSelections);
    if (typeof input.daemonStateFilePath === 'string' && input.daemonStateFilePath.trim().length > 0) {
      env[OPEN_CODE_BROKER_DAEMON_STATE_PATH_ENV] = input.daemonStateFilePath;
    }
    env[OPEN_CODE_BROKER_PLUGIN_VERSION_ENV] = OPEN_CODE_BROKER_PLUGIN_VERSION;
    // F2 (least privilege): inject ONLY the scoped broker-refresh capability token derived from the
    // daemon master control token. The master is NEVER placed in the env. When the host cannot supply a
    // control token the scoped token is omitted and the broker fails closed at request time.
    const scopedRefreshToken = deriveOpenCodeBrokerRefreshToken(input.daemonControlToken);
    if (scopedRefreshToken) {
      env[OPEN_CODE_BROKER_REFRESH_TOKEN_ENV] = scopedRefreshToken;
    }
  }

  // Stable selection identity (keys the managed-server fingerprint; the fingerprint input reads this).
  env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV] = [
    'opencode',
    'connected',
    `broker:${OPEN_CODE_BROKER_PLUGIN_VERSION}`,
    ...accumulator.identityFragments.slice().sort(),
  ].join('|');

  return { env };
}
