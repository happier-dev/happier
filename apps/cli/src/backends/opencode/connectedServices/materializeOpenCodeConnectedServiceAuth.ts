import type { ConnectedServiceCredentialRecordV1, ConnectedServiceId } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { requireConnectedServiceTokenCredentialRecord } from '@/daemon/connectedServices/shared/connectedServiceCredentialRecord';
import { brokerSelectionIdentityGroupSuffix } from '@/daemon/connectedServices/broker/brokerSelectionIdentityGroup';
import { HAPPIER_SESSION_CONNECTED_SERVICE_BROKER_SELECTION_IDENTITY_ENV_KEY } from '@/agent/runtime/sessionConnectedServiceBrokerSelectionIdentityEnv';
import type { ConnectedServiceResolvedSelection } from '@/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn';

import {
  OPEN_CODE_BROKER_STATE_PATH_ENV,
  OPEN_CODE_BROKER_PLUGIN_VERSION,
  OPEN_CODE_BROKER_PLUGIN_VERSION_ENV,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  buildOpenCodeBrokerMarker,
  resolveOpenCodeConnectedConfigHomeDir,
  serializeOpenCodeBrokerSelections,
  type OpenCodeBrokerProvider,
  type OpenCodeBrokerProviderSelection,
} from '@/backends/opencode/brokerPlugin';
import { OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV } from '@/backends/opencode/server/openCodeManagedServerEnv';

type MaterializeInput = Readonly<{
  rootDir: string;
  openaiCodex: ConnectedServiceCredentialRecordV1 | null;
  openai: ConnectedServiceCredentialRecordV1 | null;
  claudeSubscription: ConnectedServiceCredentialRecordV1 | null;
  anthropic: ConnectedServiceCredentialRecordV1 | null;
  // Resolved selections carry the pool (group) identity that keys the mint per pool (R4-4).
  selectionsByServiceId?: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>;
}>;

function readProviderAccountId(record: ConnectedServiceCredentialRecordV1): string | null {
  if (record.kind === 'oauth') {
    const accountId = record.oauth.providerAccountId;
    return typeof accountId === 'string' && accountId.trim().length > 0 ? accountId.trim() : null;
  }
  const accountId = record.token.providerAccountId;
  return typeof accountId === 'string' && accountId.trim().length > 0 ? accountId.trim() : null;
}

/**
 * A stable per-account identity fragment for the launch fingerprint. EXCLUDES all rotating
 * access/refresh token bytes; includes only serviceId + profileId + providerAccountId so a
 * same-account token refresh keeps the fingerprint unchanged (no managed-server churn) while two
 * different accounts never collapse to one identity.
 */
function identityFragment(
  record: ConnectedServiceCredentialRecordV1,
  selectionsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection> | undefined,
): string {
  const groupSuffix = brokerSelectionIdentityGroupSuffix(selectionsByServiceId?.get(record.serviceId));
  return `${record.serviceId}:${record.profileId}:${readProviderAccountId(record) ?? ''}${groupSuffix}`;
}

/**
 * Materialize connected-service auth for an OpenCode managed server.
 *
 * Brokered services (subscription OAuth / setup-token) NEVER receive a refresh token: a stable,
 * non-refreshable broker MARKER is written to `OPENCODE_AUTH_CONTENT`, the Happier broker plugin is
 * registered via `OPENCODE_CONFIG_CONTENT`, and the broker fetches fresh access tokens from the
 * Happier daemon bridge at request time (daemon = sole refresher). Direct API keys (OpenAI platform
 * key, Anthropic Console key) stay as real `{type:'api', key}` entries.
 *
 * Connected sessions are config-isolated (`XDG_CONFIG_HOME` → a Happier-owned empty config home) so
 * the user's third-party OpenCode plugins do not contaminate connected auth. The emitted
 * selection-identity env keys the managed-server fingerprint on the stable account selection.
 *
 * This function performs NO filesystem I/O: it only references deterministic, version-keyed paths.
 * The server-launch path writes the broker assets (see `ensureOpenCodeBrokerPluginAssets`).
 */
export async function materializeOpenCodeConnectedServiceAuth(params: MaterializeInput): Promise<Readonly<{ env: Record<string, string> }>> {
  const auth: Record<string, unknown> = {};
  const brokerSelections: { -readonly [K in OpenCodeBrokerProvider]?: OpenCodeBrokerProviderSelection } = {};
  const brokeredProviders: OpenCodeBrokerProvider[] = [];
  const identityFragments: string[] = [];

  const brokerProvider = (
    provider: OpenCodeBrokerProvider,
    serviceId: OpenCodeBrokerProviderSelection['serviceId'],
    record: ConnectedServiceCredentialRecordV1,
  ): void => {
    auth[provider] = { type: 'api', key: buildOpenCodeBrokerMarker(provider, OPEN_CODE_BROKER_PLUGIN_VERSION) };
    brokerSelections[provider] = {
      serviceId,
      profileId: record.profileId,
      accountId: readProviderAccountId(record),
      planType: null,
    };
    brokeredProviders.push(provider);
    identityFragments.push(identityFragment(record, params.selectionsByServiceId));
  };

  // OpenAI: subscription OAuth (Codex) is brokered; a platform API key is used directly.
  if (params.openaiCodex) {
    brokerProvider('openai', 'openai-codex', params.openaiCodex);
  } else if (params.openai) {
    const record = requireConnectedServiceTokenCredentialRecord(params.openai);
    auth.openai = { type: 'api', key: record.token.token };
    identityFragments.push(identityFragment(record, params.selectionsByServiceId));
  }

  // Anthropic: Claude subscription (setup-token OR browser-login OAuth) is brokered (Bearer + beta,
  // per OQ-1); a Console API key is used directly via x-api-key.
  if (params.claudeSubscription) {
    brokerProvider('anthropic', 'claude-subscription', params.claudeSubscription);
  } else if (params.anthropic) {
    const record = requireConnectedServiceTokenCredentialRecord(params.anthropic);
    auth.anthropic = { type: 'api', key: record.token.token };
    identityFragments.push(identityFragment(record, params.selectionsByServiceId));
  }

  const env: Record<string, string> = {
    OPENCODE_AUTH_CONTENT: JSON.stringify(auth),
  };

  if (identityFragments.length === 0) {
    // No connected credential present ⇒ nothing to materialize (caller treats null as native).
    return { env };
  }

  // Config isolation: redirect XDG_CONFIG_HOME to a Happier-owned config home so connected sessions
  // load NO user third-party plugins. The broker plugin (when present) is written into that config
  // home's `opencode/plugin/` auto-load dir as a `.js` file by the server-launch path; OpenCode then
  // discovers + loads it from the redirected XDG_CONFIG_HOME. We deliberately do NOT register it via
  // `OPENCODE_CONFIG_CONTENT.plugin` — live-verified (opencode v1.14.41): an absolute path there does
  // NOT load, and the auto-discovery glob matches `*.js` ONLY (never `*.mjs`).
  env.XDG_CONFIG_HOME = resolveOpenCodeConnectedConfigHomeDir();
  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({});

  if (brokeredProviders.length > 0) {
    env[OPEN_CODE_BROKER_SELECTIONS_ENV] = serializeOpenCodeBrokerSelections(brokerSelections);
    env[OPEN_CODE_BROKER_STATE_PATH_ENV] = configuration.connectedServiceBrokerStateFile;
    env[OPEN_CODE_BROKER_PLUGIN_VERSION_ENV] = OPEN_CODE_BROKER_PLUGIN_VERSION;
  }

  // Stable selection identity (keys the managed-server fingerprint; A1 reads this env var).
  const brokerSelectionIdentity = [
    'opencode',
    'connected',
    `broker:${OPEN_CODE_BROKER_PLUGIN_VERSION}`,
    ...identityFragments.slice().sort(),
  ].join('|');
  env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV] = brokerSelectionIdentity;
  env[HAPPIER_SESSION_CONNECTED_SERVICE_BROKER_SELECTION_IDENTITY_ENV_KEY] = brokerSelectionIdentity;

  return { env };
}
