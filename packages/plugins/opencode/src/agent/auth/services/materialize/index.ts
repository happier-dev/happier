import { createHash } from 'node:crypto';

import {
  readConnectedServiceCredentialRecord,
  requireConnectedServiceOauthCredentialRecordWithExpiry,
  requireConnectedServiceTokenCredentialRecord,
  type ConnectedServiceCredentialRecordV1,
} from '@happier-dev/plugin-sdk/experimental/cloud/auth';

import { OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV } from '../../../runtime/server/managedServerState.js';
import {
  ensureOpenCodeRequestAuthPluginAssets,
  OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  readOpenCodeRequestAuthMaterialization,
  retireLegacyOpenCodeBrokerAssets,
  resolveOpenCodeConnectedConfigHomeDir,
  type OpenCodeRequestAuthMaterialization,
  type OpenCodeRequestAuthProvider,
  type OpenCodeRequestAuthPurposeMap,
  type OpenCodeRequestAuthTarget,
} from '../requestAuth/index.js';
import { buildOpenCodeRequestAuthMarker } from '../requestAuth/source.js';

export type OpenCodeAuthMaterializationInput = Readonly<{
  openaiCodex?: ConnectedServiceCredentialRecordV1 | null;
  openai?: ConnectedServiceCredentialRecordV1 | null;
  claudeSubscription?: ConnectedServiceCredentialRecordV1 | null;
  anthropic?: ConnectedServiceCredentialRecordV1 | null;
  connectedServiceGroupIdsByServiceId?: Readonly<Record<string, string>> | null;
  requestAuth?: unknown;
}>;

export type OpenCodeAuthEnvironmentInput = OpenCodeAuthMaterializationInput & Readonly<{
  rootDir?: string | null;
  managedServerStatePath?: string | null;
}>;

type MaterializedAuth = Readonly<{
  auth: Readonly<Record<string, unknown>>;
  requestAuthProviders: readonly OpenCodeRequestAuthProvider[];
  selectionIdentity: string | null;
}>;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function identityEntry(
  serviceId: string,
  record: ConnectedServiceCredentialRecordV1,
  groupId: string | null,
): Readonly<Record<string, string | null>> {
  if (groupId) {
    return Object.freeze({
      serviceId,
      selection: 'group',
      groupId,
    });
  }
  const providerAccountId = record.kind === 'oauth'
    ? record.oauth.providerAccountId
    : record.token.providerAccountId;
  return Object.freeze({
    serviceId,
    selection: 'account',
    profileId: record.profileId,
    providerAccountId: providerAccountId?.trim() || null,
  });
}

function requestAuthIdentityEntry(
  serviceId: 'openai-codex' | 'claude-subscription',
  target: OpenCodeRequestAuthTarget,
): Readonly<Record<string, string | null>> {
  return target.kind === 'group'
    ? Object.freeze({
        serviceId,
        selection: 'group',
        groupId: target.groupId,
      })
    : Object.freeze({
        serviceId,
        selection: 'account',
        profileId: target.accountId,
        providerAccountId: null,
      });
}

function buildSelectionIdentity(entries: readonly Readonly<Record<string, string | null>>[]): string | null {
  if (entries.length === 0) return null;
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return `happier-opencode-selection:v2:sha256:${digest}`;
}

function readProjectedRequestAuth(
  input: OpenCodeAuthMaterializationInput,
): OpenCodeRequestAuthMaterialization | null {
  const projected = readOpenCodeRequestAuthMaterialization(input.requestAuth);
  if (input.requestAuth !== null && input.requestAuth !== undefined && !projected) {
    throw new Error(
      'OpenCode request-auth materialization requires the exact declared openai purpose or anthropic purpose and child capability',
    );
  }
  return projected;
}

function materializeAuth(
  input: OpenCodeAuthMaterializationInput,
  requestAuth: OpenCodeRequestAuthMaterialization | null,
): MaterializedAuth {
  const openaiCodex = readConnectedServiceCredentialRecord(input.openaiCodex);
  const openai = readConnectedServiceCredentialRecord(input.openai);
  const claudeSubscription = readConnectedServiceCredentialRecord(input.claudeSubscription);
  const anthropic = readConnectedServiceCredentialRecord(input.anthropic);
  const groupIds = input.connectedServiceGroupIdsByServiceId ?? {};
  const auth: Record<string, unknown> = {};
  const requestAuthProviders: OpenCodeRequestAuthProvider[] = [];
  const identityEntries: Readonly<Record<string, string | null>>[] = [];

  const openaiRequestAuthTarget = requestAuth?.targetsByProvider.openai;
  if (openaiRequestAuthTarget) {
    if (openaiCodex) requireConnectedServiceOauthCredentialRecordWithExpiry(openaiCodex);
    auth.openai = {
      type: 'api',
      key: buildOpenCodeRequestAuthMarker('openai'),
    };
    requestAuthProviders.push('openai');
    identityEntries.push(requestAuthIdentityEntry(
      'openai-codex',
      openaiRequestAuthTarget,
    ));
  } else if (openaiCodex) {
    requireConnectedServiceOauthCredentialRecordWithExpiry(openaiCodex);
    auth.openai = {
      type: 'api',
      key: buildOpenCodeRequestAuthMarker('openai'),
    };
    requestAuthProviders.push('openai');
    identityEntries.push(identityEntry(
      'openai-codex',
      openaiCodex,
      readString(groupIds['openai-codex']),
    ));
  } else if (openai) {
    const record = requireConnectedServiceTokenCredentialRecord(openai, {
      message: 'OpenCode OpenAI auth requires an API key',
    });
    auth.openai = { type: 'api', key: record.token.token };
    identityEntries.push(identityEntry('openai', record, readString(groupIds.openai)));
  }

  const anthropicRequestAuthTarget = requestAuth?.targetsByProvider.anthropic;
  if (anthropicRequestAuthTarget) {
    if (claudeSubscription) {
      requireConnectedServiceOauthCredentialRecordWithExpiry(claudeSubscription);
    }
    auth.anthropic = {
      type: 'api',
      key: buildOpenCodeRequestAuthMarker('anthropic'),
    };
    requestAuthProviders.push('anthropic');
    identityEntries.push(requestAuthIdentityEntry(
      'claude-subscription',
      anthropicRequestAuthTarget,
    ));
  } else if (claudeSubscription) {
    if (claudeSubscription.kind === 'oauth') {
      requireConnectedServiceOauthCredentialRecordWithExpiry(claudeSubscription);
      auth.anthropic = {
        type: 'api',
        key: buildOpenCodeRequestAuthMarker('anthropic'),
      };
      requestAuthProviders.push('anthropic');
    } else {
      const record = requireConnectedServiceTokenCredentialRecord(claudeSubscription, {
        message: 'OpenCode Claude subscription auth requires OAuth or a setup token',
      });
      auth.anthropic = { type: 'api', key: record.token.token };
    }
    identityEntries.push(identityEntry(
      'claude-subscription',
      claudeSubscription,
      readString(groupIds['claude-subscription']),
    ));
  } else if (anthropic) {
    const record = requireConnectedServiceTokenCredentialRecord(anthropic, {
      message: 'OpenCode Anthropic auth requires an API key',
    });
    auth.anthropic = { type: 'api', key: record.token.token };
    identityEntries.push(identityEntry('anthropic', record, readString(groupIds.anthropic)));
  }

  return Object.freeze({
    auth: Object.freeze(auth),
    requestAuthProviders: Object.freeze(requestAuthProviders),
    selectionIdentity: buildSelectionIdentity(identityEntries),
  });
}

export function buildOpenCodeAuthContent(input: OpenCodeAuthMaterializationInput): string {
  return JSON.stringify(materializeAuth(
    input,
    readProjectedRequestAuth(input),
  ).auth);
}

export async function materializeOpenCodeAuthEnvironment(
  input: OpenCodeAuthEnvironmentInput,
): Promise<Readonly<{ env: Readonly<Record<string, string>> }>> {
  const projectedRequestAuth = readProjectedRequestAuth(input);
  const materialized = materializeAuth(input, projectedRequestAuth);
  const env: Record<string, string> = {
    OPENCODE_AUTH_CONTENT: JSON.stringify(materialized.auth),
    ...(readString(input.managedServerStatePath)
      ? { HAPPIER_OPENCODE_SERVER_STATE_PATH: readString(input.managedServerStatePath) ?? '' }
      : {}),
  };
  if (!materialized.selectionIdentity) return { env };

  const rootDir = readString(input.rootDir);
  if (!rootDir) throw new Error('OpenCode connected-service materialization requires a rootDir');
  const configHome = resolveOpenCodeConnectedConfigHomeDir(rootDir);
  await retireLegacyOpenCodeBrokerAssets(rootDir, configHome);
  env.XDG_CONFIG_HOME = configHome;
  env.OPENCODE_CONFIG_CONTENT = '{}';
  env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV] = materialized.selectionIdentity;
  // The materialized OpenCode auth file is the only native-key authority for a connected launch.
  env.OPENAI_API_KEY = '';
  env.ANTHROPIC_API_KEY = '';

  if (materialized.requestAuthProviders.length > 0) {
    if (!projectedRequestAuth) {
      throw new Error('OpenCode request-auth materialization requires a child capability');
    }
    const purposes: {
      -readonly [K in OpenCodeRequestAuthProvider]?: NonNullable<OpenCodeRequestAuthPurposeMap[K]>;
    } = {};
    for (const provider of materialized.requestAuthProviders) {
      const purpose = projectedRequestAuth.purposesByProvider[provider];
      if (!purpose) {
        throw new Error(`OpenCode request-auth materialization requires the exact declared ${provider} purpose`);
      }
      purposes[provider] = purpose;
    }
    await ensureOpenCodeRequestAuthPluginAssets(configHome, purposes);
    env[OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV] = projectedRequestAuth.capabilityPath;
  }

  return { env };
}
