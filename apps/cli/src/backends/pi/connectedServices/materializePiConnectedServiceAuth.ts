import { join, win32 } from 'node:path';

import type { ConnectedServiceCredentialRecordV1, ConnectedServiceId } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import { brokerSelectionIdentityGroupSuffix } from '@/daemon/connectedServices/broker/brokerSelectionIdentityGroup';
import { HAPPIER_SESSION_CONNECTED_SERVICE_BROKER_SELECTION_IDENTITY_ENV_KEY } from '@/agent/runtime/sessionConnectedServiceBrokerSelectionIdentityEnv';
import type { ConnectedServiceResolvedSelection } from '@/daemon/connectedServices/materialize/materializeConnectedServicesForSpawn';
import {
  requireConnectedServiceTokenCredentialRecord,
  requireConnectedServiceOauthCredentialRecordWithExpiry,
  type ConnectedServiceOauthCredentialRecordWithExpiry,
} from '@/daemon/connectedServices/shared/connectedServiceCredentialRecord';

import {
  PI_BROKER_STATE_PATH_ENV,
  PI_BROKER_EXTENSION_VERSION_ENV,
  PI_BROKER_SELECTIONS_ENV,
  PI_BROKER_SELECTION_IDENTITY_ENV,
  PI_BROKER_EXTENSION_VERSION,
  buildPiBrokerMarker,
  ensurePiBrokerExtensionAsset,
  piBrokerServiceId,
  piRegisterProviderId,
  serializePiBrokerSelections,
  type PiBrokerProvider,
  type PiBrokerProviderSelection,
  type PiRegisterProviderId,
} from '@/backends/pi/brokerExtension';

const PI_BROKER_CREDENTIAL_MAX_TTL_MS = 10_000;

export function formatPiCodingAgentDirForChildEnv(
  agentDir: string,
  _platform: NodeJS.Platform = process.platform,
): string {
  return agentDir;
}

export function formatPiSessionDirForChildEnv(
  sessionDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return sessionDir;
  if (!win32.isAbsolute(sessionDir)) return sessionDir;
  return win32.toNamespacedPath(sessionDir);
}

export function applyPiCodingAgentDirChildEnvFormatting(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): void {
  env.PI_CODING_AGENT_DIR = formatPiCodingAgentDirForChildEnv(env.PI_CODING_AGENT_DIR, platform);
  if (typeof env.PI_CODING_AGENT_SESSION_DIR === 'string') {
    env.PI_CODING_AGENT_SESSION_DIR = formatPiSessionDirForChildEnv(env.PI_CODING_AGENT_SESSION_DIR, platform);
  }
}

/**
 * Build the BROKERED Pi OAuth credential entry written to `auth.json`.
 *
 * CRITICAL (no-leak / dual-refresher fix): unlike the legacy path (which embedded the real
 * `{access, refresh, expires}` via `buildConnectedServiceOauthAuthEntry`, letting Pi self-refresh
 * against the provider and race the daemon), this writes a credential whose `refresh` is a NON-secret
 * Happier marker — never the provider's single-use refresh token. Pi's broker extension overrides the
 * provider's OAuth so `refreshToken` hits the Happier daemon bridge instead of the provider. The daemon
 * is therefore the SOLE refresher; Pi never holds (and never can rotate) a usable refresh token. Pi's
 * current provider API can call `getApiKey` synchronously on first use, so the materialized credential
 * includes the current short-lived access token and its real expiry. Subsequent refreshes still flow
 * through the broker marker + daemon bridge.
 */
function buildPiBrokeredOauthAuthEntry(
  registerProviderId: PiRegisterProviderId,
  record: ConnectedServiceOauthCredentialRecordWithExpiry,
): Record<string, unknown> {
  const brokeredExpiresAt = Math.min(record.expiresAt, Date.now() + PI_BROKER_CREDENTIAL_MAX_TTL_MS);
  return {
    type: 'oauth',
    // NON-secret marker, NOT the provider refresh token. The broker recognises it and re-brokers.
    refresh: buildPiBrokerMarker(registerProviderId, PI_BROKER_EXTENSION_VERSION),
    // Short-lived access only. This lets Pi's synchronous getApiKey path satisfy the first request while
    // keeping provider refresh authority exclusively in the daemon.
    access: record.oauth.accessToken,
    expires: brokeredExpiresAt,
    ...(record.oauth.providerAccountId ? { accountId: record.oauth.providerAccountId } : {}),
  };
}

export async function materializePiConnectedServiceAuth(params: Readonly<{
  rootDir: string;
  openaiCodex: ConnectedServiceCredentialRecordV1 | null;
  openai: ConnectedServiceCredentialRecordV1 | null;
  claudeSubscription: ConnectedServiceCredentialRecordV1 | null;
  anthropic: ConnectedServiceCredentialRecordV1 | null;
  // Resolved selections carry the pool (group) identity that keys the mint per pool (R4-4).
  selectionsByServiceId?: ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection>;
}>): Promise<Readonly<{ env: Record<string, string> }>> {
  const agentDir = join(params.rootDir, 'pi-agent-dir');
  const auth: Record<string, unknown> = {};
  const env: Record<string, string> = {
    PI_CODING_AGENT_DIR: agentDir,
  };

  // Brokered OAuth providers (NO real refresh token reaches Pi). Each present here both writes a marker
  // OAuth cred to auth.json AND contributes a broker selection + identity fragment.
  const brokerSelections: { -readonly [K in PiBrokerProvider]?: PiBrokerProviderSelection } = {};
  const brokeredProviders: PiBrokerProvider[] = [];
  const identityFragments: string[] = [];

  // `provider` is the SHARED bridge tag (openai/anthropic), keying the selections + identity to match
  // the OpenCode broker + shared bridge-call source. The `auth.json` entry + marker use Pi's provider id.
  const brokerProvider = (
    provider: PiBrokerProvider,
    record: ConnectedServiceOauthCredentialRecordWithExpiry,
  ): void => {
    const registerProviderId = piRegisterProviderId(provider);
    auth[registerProviderId] = buildPiBrokeredOauthAuthEntry(registerProviderId, record);
    brokerSelections[provider] = {
      serviceId: piBrokerServiceId(provider),
      profileId: record.profileId,
      accountId: record.oauth.providerAccountId ?? null,
      planType: null,
    };
    brokeredProviders.push(provider);
    const groupSuffix = brokerSelectionIdentityGroupSuffix(params.selectionsByServiceId?.get(record.serviceId));
    identityFragments.push(`${provider}:${record.profileId}:${record.oauth.providerAccountId ?? ''}${groupSuffix}`);
  };

  // OpenAI: Codex subscription is OAuth-only ⇒ always brokered. A platform API key is direct.
  if (params.openaiCodex) {
    const record = requireConnectedServiceOauthCredentialRecordWithExpiry(params.openaiCodex);
    brokerProvider('openai', record);
  }

  if (params.openai) {
    const record = requireConnectedServiceTokenCredentialRecord(params.openai);
    auth.openai = {
      type: 'api_key',
      key: record.token.token,
    };
  }

  // Anthropic: Claude subscription OAuth ⇒ brokered; setup-token ⇒ direct api_key. A Console API key
  // (anthropic service) ⇒ direct api_key. Anthropic-service OAuth remains rejected.
  if (params.claudeSubscription) {
    if (params.claudeSubscription.kind === 'oauth') {
      const record = requireConnectedServiceOauthCredentialRecordWithExpiry(params.claudeSubscription);
      brokerProvider('anthropic', record);
    } else {
      const record = requireConnectedServiceTokenCredentialRecord(params.claudeSubscription);
      auth.anthropic = {
        type: 'api_key',
        key: record.token.token,
      };
    }
  } else if (params.anthropic) {
    if (params.anthropic.kind !== 'token') {
      throw new Error('Anthropic OAuth credentials are not supported. Reconnect using an Anthropic API key.');
    }
    auth.anthropic = {
      type: 'api_key',
      key: params.anthropic.token.token,
    };
  }

  await writeJsonAtomic(join(agentDir, 'auth.json'), auth);

  // Brokered sessions: write the broker extension + emit the broker env (selections, broker-state path,
  // version, and stable selection identity). The broker reads the current least-privilege capability
  // atomically with the daemon port from the minimal descriptor. Direct-API-key / native Pi sessions skip all
  // of this, so their agent dirs + env stay free of the broker.
  if (brokeredProviders.length > 0) {
    await ensurePiBrokerExtensionAsset(agentDir);
    env[PI_BROKER_SELECTIONS_ENV] = serializePiBrokerSelections(brokerSelections);
    env[PI_BROKER_STATE_PATH_ENV] = configuration.connectedServiceBrokerStateFile;
    env[PI_BROKER_EXTENSION_VERSION_ENV] = PI_BROKER_EXTENSION_VERSION;
    // Stable selection identity (keys the broker load handshake + preflight match).
    const brokerSelectionIdentity = [
      'pi',
      'connected',
      `broker:${PI_BROKER_EXTENSION_VERSION}`,
      ...identityFragments.sort(),
    ].join('|');
    env[PI_BROKER_SELECTION_IDENTITY_ENV] = brokerSelectionIdentity;
    env[HAPPIER_SESSION_CONNECTED_SERVICE_BROKER_SELECTION_IDENTITY_ENV_KEY] = brokerSelectionIdentity;
  }

  return {
    env,
  };
}
