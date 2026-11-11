import {
    parseCredentialRecord as readConnectedServiceCredentialRecord,
    requireOauthCredentialRecordWithExpiry as requireConnectedServiceOauthCredentialRecordWithExpiry,
    requireTokenCredentialRecord as requireConnectedServiceTokenCredentialRecord,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type {
    OauthCredentialRecord,
    TokenCredentialRecord,
} from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginContributionRef } from '@happier-dev/plugin-sdk';

import { OPENCODE_CONNECTED_SERVICE_SELECTION_IDENTITY_ENV } from '../../../runtime/server/managedServerState.js';
import type { OpenCodeConfigPart } from '../../../runtime/server/opencodeConfigContent.js';
import {
  ensureOpenCodeRequestAuthPluginAssets,
  buildOpenCodeV2ConnectedAuthConfigPart,
  OPEN_CODE_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  readOpenCodeRequestAuthMaterialization,
  retireCompetingOpenCodeAuthAssets,
  resolveOpenCodeConnectedConfigHomeDir,
  type OpenCodeRequestAuthMaterialization,
  type OpenCodeRequestAuthProvider,
  type OpenCodeRequestAuthPurposeMap,
} from '../requestAuth/index.js';
import { buildOpenCodeRequestAuthMarker } from '../requestAuth/source.js';
import { OPEN_CODE_NATIVE_PROVIDERS, OPEN_CODE_REQUEST_AUTH_PROVIDERS, type OpenCodeNativeProvider } from '../purposes.js';
import { buildOpenCodeNativeAccountConfigPart } from '../requestAuth/assets.js';

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

function readDirectApiKeys(materialized: MaterializedAuth): Readonly<
  Partial<Record<OpenCodeRequestAuthProvider, string>>
> {
  const keys: Partial<Record<OpenCodeRequestAuthProvider, string>> = {};
  for (const provider of OPEN_CODE_REQUEST_AUTH_PROVIDERS) {
    if (materialized.requestAuthProviders.includes(provider)) continue;
    const entry = materialized.auth[provider];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const key = (entry as Readonly<Record<string, unknown>>).key;
    if (typeof key === 'string' && key.trim().length > 0) keys[provider] = key;
  }
  return Object.freeze(keys);
}

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

export type OpenCodeNativeAccountCredential = Readonly<{ key?: string; service: PluginContributionRef; baseURL?: string; headers?: Readonly<Record<string, string>> }>;

export function buildOpenCodeQualifiedAuthContent(input: Readonly<{
  baseAuthContent?: unknown;
  directAccountCredentials?: Readonly<Partial<Record<OpenCodeNativeProvider, OpenCodeNativeAccountCredential>>>;
  requiredRequestAuthProviders?: readonly OpenCodeRequestAuthProvider[];
}>) {
  const base = readAuthContentRecord(input.baseAuthContent);
  const auth: Record<string, unknown> = {};
  const nativeAccountServicesByProvider: Partial<Record<OpenCodeNativeProvider, PluginContributionRef>> = {};
  for (const provider of OPEN_CODE_REQUEST_AUTH_PROVIDERS) {
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
  for (const provider of OPEN_CODE_NATIVE_PROVIDERS) {
    const credential = input.directAccountCredentials?.[provider];
    if (!credential) continue;
    nativeAccountServicesByProvider[provider] = Object.freeze({ ...credential.service });
    if (!credential.key?.trim()) continue;
    // Native Copilot owns its inference-token exchange. Its refresh slot holds
    // the GitHub token, not a vendor OAuth refresh secret (V1 and V2 loaders).
    auth[provider] = provider === 'github-copilot'
      ? { type: 'oauth', refresh: credential.key, access: '', expires: 0 }
      : { type: 'api', key: credential.key };
  }
  const enabledProviders = OPEN_CODE_NATIVE_PROVIDERS.filter(provider =>
    auth[provider] || input.directAccountCredentials?.[provider]);
  const nativeConfigPart = buildOpenCodeNativeAccountConfigPart(input.directAccountCredentials ?? {});
  return Object.freeze({ authContent: JSON.stringify(auth),
    configPart: enabledProviders.length > 0
      ? { ...nativeConfigPart, enabled_providers: enabledProviders }
      : nativeConfigPart,
    nativeAccountServicesByProvider: Object.freeze(nativeAccountServicesByProvider) });
}

export function buildOpenCodeAuthContent(input: OpenCodeAuthMaterializationInput): string {
  return JSON.stringify(materializeAuth(
    input,
    readProjectedRequestAuth(input),
  ).auth);
}

export async function materializeOpenCodeAuthEnvironment(
  input: OpenCodeAuthEnvironmentInput,
): Promise<Readonly<{ env: Readonly<Record<string, string>>; configPart?: OpenCodeConfigPart }>> {
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
  const configPart = buildOpenCodeV2ConnectedAuthConfigPart({
    configHome,
    requestAuthProviders: materialized.requestAuthProviders,
    directApiKeys: readDirectApiKeys(materialized),
  });
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

  return { env, configPart };
}
