import {
    parseCredentialRecord as readConnectedServiceCredentialRecord,
    requireOauthCredentialRecordWithExpiry as requireConnectedServiceOauthCredentialRecordWithExpiry,
    requireTokenCredentialRecord as requireConnectedServiceTokenCredentialRecord,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type {
    OauthCredentialRecord,
    TokenCredentialRecord,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV } from '../../../runtime/server/managedServerState.js';
import {
  ensureOpenCodeRequestAuthPluginAssets,
  OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  readOpenCodeRequestAuthMaterialization,
  retireCompetingOpenCodeAuthAssets,
  resolveOpenCodeConnectedConfigHomeDir,
  type OpenCodeRequestAuthMaterialization,
  type OpenCodeRequestAuthProvider,
  type OpenCodeRequestAuthPurposeMap,
} from '../requestAuth/index.js';
import { buildOpenCodeRequestAuthMarker } from '../requestAuth/source.js';

export type OpenCodeAuthMaterializationInput = Readonly<{
  openaiCodex?: OauthCredentialRecord | TokenCredentialRecord | null;
  openai?: OauthCredentialRecord | TokenCredentialRecord | null;
  claudeSubscription?: OauthCredentialRecord | TokenCredentialRecord | null;
  anthropic?: OauthCredentialRecord | TokenCredentialRecord | null;
  connectedAccountMaterializationAuthority?:
    | 'qualified'
    | 'legacy_unfenced_one_shot';
  materializationId?: string | null;
  requestAuth?: unknown;
}>;

export type OpenCodeAuthEnvironmentInput = OpenCodeAuthMaterializationInput & Readonly<{
  rootDir?: string | null;
}>;

type MaterializedAuth = Readonly<{
  auth: Readonly<Record<string, unknown>>;
  requestAuthProviders: readonly OpenCodeRequestAuthProvider[];
}>;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readProjectedRequestAuth(
  input: OpenCodeAuthMaterializationInput,
): OpenCodeRequestAuthMaterialization | null {
  if (
    input.requestAuth !== null
    && input.requestAuth !== undefined
    && input.connectedAccountMaterializationAuthority !== 'qualified'
  ) {
    throw new Error('OpenCode request-auth materialization requires qualified authority');
  }
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
  const acceptRawCredentials =
    input.connectedAccountMaterializationAuthority === 'legacy_unfenced_one_shot';
  const openaiCodex = acceptRawCredentials
    ? readConnectedServiceCredentialRecord(input.openaiCodex)
    : null;
  const openai = acceptRawCredentials
    ? readConnectedServiceCredentialRecord(input.openai)
    : null;
  const claudeSubscription = acceptRawCredentials
    ? readConnectedServiceCredentialRecord(input.claudeSubscription)
    : null;
  const anthropic = acceptRawCredentials
    ? readConnectedServiceCredentialRecord(input.anthropic)
    : null;
  const auth: Record<string, unknown> = {};
  const requestAuthProviders: OpenCodeRequestAuthProvider[] = [];

  const openaiRequestAuthTarget = requestAuth?.targetsByProvider.openai;
  if (openaiRequestAuthTarget) {
    if (openaiCodex) requireConnectedServiceOauthCredentialRecordWithExpiry(openaiCodex);
    auth.openai = {
      type: 'api',
      key: buildOpenCodeRequestAuthMarker('openai'),
    };
    requestAuthProviders.push('openai');
  } else if (openaiCodex) {
    requireConnectedServiceOauthCredentialRecordWithExpiry(openaiCodex);
    auth.openai = {
      type: 'api',
      key: buildOpenCodeRequestAuthMarker('openai'),
    };
    requestAuthProviders.push('openai');
  } else if (openai) {
    const record = requireConnectedServiceTokenCredentialRecord(openai, {
      message: 'OpenCode OpenAI auth requires an API key',
    });
    auth.openai = { type: 'api', key: record.token.token };
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
  } else if (anthropic) {
    const record = requireConnectedServiceTokenCredentialRecord(anthropic, {
      message: 'OpenCode Anthropic auth requires an API key',
    });
    auth.anthropic = { type: 'api', key: record.token.token };
  }

  return Object.freeze({
    auth: Object.freeze(auth),
    requestAuthProviders: Object.freeze(requestAuthProviders),
  });
}

function readAuthContentRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || value === undefined || value === '') return Object.freeze({});
  if (typeof value !== 'string') {
    throw new Error('OpenCode qualified auth materialization requires string OPENCODE_AUTH_CONTENT');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('OpenCode qualified auth materialization received malformed OPENCODE_AUTH_CONTENT');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('OpenCode qualified auth materialization received malformed OPENCODE_AUTH_CONTENT');
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function hasExactRequestAuthMarker(
  auth: Readonly<Record<string, unknown>>,
  provider: OpenCodeRequestAuthProvider,
): boolean {
  const entry = auth[provider];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const candidate = entry as Readonly<Record<string, unknown>>;
  return candidate.type === 'api'
    && candidate.key === buildOpenCodeRequestAuthMarker(provider);
}

export function buildOpenCodeQualifiedAuthContent(input: Readonly<{
  baseAuthContent?: unknown;
  directApiKeys?: Readonly<Partial<Record<OpenCodeRequestAuthProvider, string>>>;
  requiredRequestAuthProviders?: readonly OpenCodeRequestAuthProvider[];
}>): string {
  const base = readAuthContentRecord(input.baseAuthContent);
  const auth: Record<string, unknown> = {};
  for (const provider of ['openai', 'anthropic'] as const) {
    if (hasExactRequestAuthMarker(base, provider)) {
      auth[provider] = {
        type: 'api',
        key: buildOpenCodeRequestAuthMarker(provider),
      };
    }
  }
  for (const provider of input.requiredRequestAuthProviders ?? []) {
    if (!hasExactRequestAuthMarker(base, provider)) {
      throw new Error(`OpenCode qualified auth materialization is missing the ${provider} request-auth marker`);
    }
  }
  for (const provider of ['openai', 'anthropic'] as const) {
    const key = input.directApiKeys?.[provider]?.trim() ?? '';
    if (key) auth[provider] = { type: 'api', key };
  }
  return JSON.stringify(auth);
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
  };
  const requiresIsolatedRoot = input.connectedAccountMaterializationAuthority !== undefined
    || Object.keys(materialized.auth).length > 0;
  if (!requiresIsolatedRoot) return { env };

  const rootDir = readString(input.rootDir);
  if (!rootDir) throw new Error('OpenCode connected-service materialization requires a rootDir');
  const materializationIdentity = readString(input.materializationId);
  if (!materializationIdentity) {
    throw new Error('OpenCode connected-service materialization requires the host materialization identity');
  }
  const configHome = resolveOpenCodeConnectedConfigHomeDir(rootDir);
  await retireCompetingOpenCodeAuthAssets(rootDir, configHome);
  env.XDG_CONFIG_HOME = configHome;
  env.OPENCODE_CONFIG_CONTENT = '{}';
  env[OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV] = materializationIdentity;
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
