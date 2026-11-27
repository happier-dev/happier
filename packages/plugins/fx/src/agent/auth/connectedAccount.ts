import { chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isRecord, PluginError } from '@happier-dev/plugin-sdk';
import { CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV, type RequestAuthHeadersV1 } from '@happier-dev/plugin-sdk/connected-accounts';
import { createConnectedAccountRequestAuthClient } from '@happier-dev/plugin-sdk/connected-accounts/request-auth';
import { writeAtomicJsonFile } from '@happier-dev/plugin-sdk/fs';
import type { AgentLaunchEnvironment, AgentConnectedAccountNativeAuthCodecV1, AgentConnectedAccountStateSharingDescriptorV1, AgentConnectedAccountResumeReachabilityInputV1, AgentConnectedAccountRuntimeAuthAdapterV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { isFxSessionId } from '../externalSessions/source.js';

import {
  KIMI_CONNECTED_ACCOUNT_SERVICE,
  KIMI_SELECTED_CODE_API_KEY_ENV,
  KIMI_CODE_API_BASE_ENV,
  GROK_CONNECTED_ACCOUNT_SERVICE,
  XAI_SELECTED_API_KEY_ENV,
  OPENAI_CONNECTED_ACCOUNT_SERVICE,
  OPENAI_SELECTED_API_KEY_ENV,
  OPENAI_CODEX_CONNECTED_ACCOUNT_SERVICE,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { buildFxConfiguredProviderSettings, FX_PROVIDER_OWNED_ENV_KEYS } from '../providerBinding/adapter.js';

export const FX_NATIVE_KEY_PURPOSES = [
  { purpose: 'openai-api-key', service: OPENAI_CONNECTED_ACCOUNT_SERVICE, environmentKey: OPENAI_SELECTED_API_KEY_ENV, baseUrl: 'https://api.openai.com/v1' },
  { purpose: 'kimi-api-key', service: KIMI_CONNECTED_ACCOUNT_SERVICE, environmentKey: KIMI_SELECTED_CODE_API_KEY_ENV, baseUrlEnvironmentKey: KIMI_CODE_API_BASE_ENV },
  { purpose: 'xai-api-key', service: GROK_CONNECTED_ACCOUNT_SERVICE, environmentKey: XAI_SELECTED_API_KEY_ENV, baseUrl: 'https://api.x.ai/v1' },
] as const;
export const FX_NATIVE_KEY_ENVIRONMENT_USES = FX_NATIVE_KEY_PURPOSES.flatMap(row => [
  { purpose: row.purpose, environmentKey: row.environmentKey },
  ...('baseUrlEnvironmentKey' in row ? [{ purpose: row.purpose, environmentKey: row.baseUrlEnvironmentKey }] : []),
]);
export function hasFxConnectedAccount(environment?: AgentLaunchEnvironment): boolean {
  return Boolean(environment?.values[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV]
    || FX_NATIVE_KEY_PURPOSES.some(row => Object.hasOwn(environment?.values ?? {}, row.environmentKey)));
}

export const FX_CODEX_PURPOSE = 'openai-codex';
export const FX_CODEX_SERVICE = OPENAI_CODEX_CONNECTED_ACCOUNT_SERVICE;
export const FX_REQUEST_AUTH_USE = { purpose: FX_CODEX_PURPOSE, materialization: {
  kind: 'httpHeaders', origin: 'https://chatgpt.com', headerNames: ['authorization', 'chatgpt-account-id'],
} } as const;
const purpose = { consumer: { pluginId: 'happier.agent.fx', localId: 'fx' }, purpose: FX_CODEX_PURPOSE } as const;
const authFile = '.fx/chatgpt-auth.json';
// FX v0.0.14 (1a070af32cdf) parses a nonempty refresh token even while
// unexpired access requires no refresh. This cannot refresh an OpenAI token.
const unusableRefreshToken = 'happier-host-managed-no-refresh';

function encodeAuth(accessToken: string, accountId: string | undefined | null, expiresAt: number | undefined | null) {
  // FX's native refresh deadline is expiry minus 60s (chatgpt_session.zig).
  if (!expiresAt || expiresAt <= Date.now() + 60_000) throw new PluginError({ code: 'fx_connected_account_expiry_unavailable', message: 'FX requires an access token with a known, current expiry. Refresh the Connected Account and retry.' });
  if (!accountId) throw new PluginError({ code: 'fx_connected_account_identity_unavailable', message: 'FX requires the ChatGPT account identifier. Reconnect the Connected Account and retry.' });
  return { version: 1, access_token: accessToken, refresh_token: unusableRefreshToken, account_id: accountId, expires_at_ms: expiresAt };
}

function fromRequestAuth(material: RequestAuthHeadersV1) {
  const account = material.credentialContext.account;
  if (account.service.pluginId !== FX_CODEX_SERVICE.pluginId || account.service.localId !== FX_CODEX_SERVICE.localId) throw new PluginError({ code: 'fx_connected_account_service_mismatch', message: 'FX requires a ChatGPT Connected Account.' });
  const headers = new Headers(material.headers);
  const bearer = /^Bearer (.+)$/i.exec(headers.get('authorization') ?? '');
  if (!bearer) throw new PluginError({ code: 'fx_connected_account_bearer_unavailable', message: 'FX requires Bearer authorization from its ChatGPT Connected Account.' });
  return encodeAuth(bearer[1]!, headers.get('chatgpt-account-id'), material.expiresAt);
}

/** One native encoding for initial launch and host-owned account continuity. */
export const FX_NATIVE_AUTH_CODEC = {
  materialize({ credential }) {
    if (credential.kind !== 'oauth') throw new PluginError({ code: 'fx_connected_account_kind_unsupported', message: 'FX requires a ChatGPT OAuth Connected Account.' });
    const auth = encodeAuth(credential.oauth.accessToken, credential.oauth.providerAccountId, credential.expiresAt);
    return { files: { [authFile]: new TextEncoder().encode(JSON.stringify(auth)) } };
  },
  inspect({ credential, files }) {
    if (credential.kind !== 'oauth') return { status: 'unavailable', retryable: false, reason: 'fx_connected_account_kind_unsupported' };
    try {
      const auth: unknown = JSON.parse(new TextDecoder().decode(files[authFile]));
      const expected = encodeAuth(credential.oauth.accessToken, credential.oauth.providerAccountId, credential.expiresAt);
      if (!isRecord(auth) || Object.entries(expected).some(([key, value]) => auth[key] !== value)) return { status: 'mismatch', retryable: true, reason: 'fx_connected_account_auth_mismatch' };
      return { status: 'verified', providerAccountId: credential.oauth.providerAccountId, source: 'fx_native_auth' };
    } catch { return { status: 'unavailable', retryable: true, reason: 'fx_connected_account_auth_unavailable' }; }
  },
} satisfies AgentConnectedAccountNativeAuthCodecV1;

export const FX_STATE_SHARING = {
  // Released FX resolves HOME/.fx; FX_HOME is only in unreleased upstream.
  nativeHome: { environmentKey: 'HOME', defaultRelativePath: '.', purposes: [FX_CODEX_PURPOSE, ...FX_NATIVE_KEY_PURPOSES.map(row => row.purpose)] },
  providerSupportStatus: 'supported',
  config: { supported: true, modes: ['copied', 'isolated'], entries: [{ path: '.fx/settings.json', mode: 'copied' }, { path: '.fx/mcp.json', mode: 'copied' }] },
  state: { supported: true, modes: ['isolated', 'shared'], entries: [{ path: '.fx/sessions', mode: 'linked', createIfMissing: 'directory', requiresRealDirectory: true }, { path: '.fx/session-files', mode: 'linked', createIfMissing: 'directory', requiresRealDirectory: true }], sharedStatePrivacyRiskAcknowledgementRequired: true, symlinkUnavailableDegradePolicy: 'block_continuity' },
  authIsolation: { mode: 'materialized_home', secretEntries: [authFile] },
} as const satisfies AgentConnectedAccountStateSharingDescriptorV1;

// FX retains its token inside the native process. A new file cannot prove
// adoption; the existing host restart/resume lifecycle owns replacement.
export const FX_RUNTIME_AUTH_ADAPTER = {
  classifyRuntimeAuthFailure: () => null,
  async materializeActiveProfile() { return { supported: true }; },
  canHotApply: () => ({ supported: false, recovery: 'restart_rematerialize' }),
  async hotApply() { return { applied: false, reason: 'fx_restart_required', recovery: 'restart_rematerialize' }; },
  async verifyActiveAccount(input) {
    return await input.inspectNativeAuth?.() ?? { status: 'unavailable', retryable: true, reason: 'fx_connected_account_auth_unavailable' };
  },
  async probeQuota() { return { status: 'unsupported' }; },
  async refreshActiveProfile() { return { status: 'unsupported', recovery: 'restart_rematerialize' }; },
} satisfies AgentConnectedAccountRuntimeAuthAdapterV1;

export async function prepareFxConnectedAccount(environment?: AgentLaunchEnvironment, signal?: AbortSignal, modelId?: string | null): Promise<AgentLaunchEnvironment | undefined> {
  if (!environment) return environment;
  const capabilityFile = environment.values[CONNECTED_ACCOUNT_REQUEST_AUTH_CAPABILITY_PATH_ENV];
  const selectedKeys = FX_NATIVE_KEY_PURPOSES.filter(row => Object.hasOwn(environment.values, row.environmentKey));
  if (!capabilityFile && !selectedKeys.length) return environment;
  if (selectedKeys.length > 1 || (selectedKeys.length && capabilityFile)) throw new PluginError({ code: 'fx_connected_account_service_mismatch', message: 'Choose one Connected Account for FX.' });
  // FX's Codex provider has no compiled default (selectProviderModel). Use the
  // host-resolved model, including finite-run inheritance, rather than ambient FX_MODEL.
  const selectedModel = modelId?.trim();
  if (!selectedModel || selectedModel === 'default') throw new PluginError({ code: 'agent_startup_model_reconciliation_failed', retryable: false,
    message: 'Choose a model for the FX Connected Account.',
    details: { failureCause: { code: 'agent_startup_model_reconciliation_failed',
      phase: 'client_start', failureReason: 'model_selection_required', retryable: false } } });
  const home = environment.values.HOME;
  if (!home) throw new PluginError({ code: 'fx_connected_account_home_unavailable', message: 'FX requires its host-prepared native home.' });
  const nativeKey = selectedKeys[0];
  if (nativeKey) {
    const secret = environment.values[nativeKey.environmentKey];
    const baseUrl = 'baseUrlEnvironmentKey' in nativeKey ? environment.values[nativeKey.baseUrlEnvironmentKey] : nativeKey.baseUrl;
    if (!secret?.trim() || !baseUrl) throw new PluginError({ code: 'fx_connected_account_service_mismatch', message: 'The selected FX account did not provide a native key and endpoint.' });
    const settingsPath = join(home, '.fx/settings.json');
    let existing: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(await readFile(settingsPath, 'utf8'));
      if (!isRecord(parsed)) throw new Error('FX settings must contain an object');
      existing = parsed;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    delete existing.credential_source;
    const settings = buildFxConfiguredProviderSettings({ modelId: selectedModel, baseUrl, hasCredential: true });
    await mkdir(join(home, '.fx'), { recursive: true, mode: 0o700 });
    await chmod(join(home, '.fx'), 0o700);
    await writeAtomicJsonFile({ path: settingsPath, value: { ...existing, ...settings,
      models: { ...(isRecord(existing.models) ? existing.models : {}), ...settings.models },
      providers: { ...(isRecord(existing.providers) ? existing.providers : {}), ...settings.providers } }, mode: 0o600 });
    const remove = new Set<string>([...FX_PROVIDER_OWNED_ENV_KEYS, ...FX_NATIVE_KEY_ENVIRONMENT_USES.map(use => use.environmentKey)]);
    const values = { ...Object.fromEntries(Object.entries(environment.values).filter(([key]) => !remove.has(key))),
      HAPPIER_FX_PROVIDER_API_KEY: secret, FX_PROVIDER: 'happier', FX_AUTH_MODE: 'local', FX_MODEL: selectedModel };
    return { values, unset: [...new Set([...(environment.unset ?? []), ...remove])].filter(key => !Object.hasOwn(values, key)) };
  }
  const client = await createConnectedAccountRequestAuthClient({ capabilityFile: capabilityFile! });
  const material = await client.lookupConnectedAccountRequestAuth({ purpose, ...(signal ? { signal } : {}) });
  const auth = fromRequestAuth(material);
  signal?.throwIfAborted();
  await mkdir(join(home, '.fx'), { recursive: true, mode: 0o700 });
  // The home owner may already have created this parent while copying config.
  // Native FX rejects a profile directory whose mode differs from 0700.
  await chmod(join(home, '.fx'), 0o700);
  await writeAtomicJsonFile({ path: join(home, authFile), value: auth, mode: 0o600 });
  const remove = ['AI_GATEWAY_API_KEY', 'VERCEL_OIDC_TOKEN', 'FX_HOME'];
  const values = { ...Object.fromEntries(Object.entries(environment.values).filter(([key]) => !remove.includes(key))), FX_PROVIDER: 'codex', FX_AUTH_MODE: 'local', FX_MODEL: selectedModel };
  return { values, unset: [...new Set([...(environment.unset ?? []), ...remove])].filter(key => !(key in values)) };
}

export async function verifyFxResumeReachable(input: AgentConnectedAccountResumeReachabilityInputV1) {
  const id = input.vendorResumeId;
  if (!id || !isFxSessionId(id)) return { ok: false as const, reason: 'fx_session_not_found' };
  // FX481104fdbc24 uses sessions v2 for ACP. The log and its whole
  // session directory (including blobs) are the retained native state.
  const currentRoot = `.fx/sessions/v2/${id}`;
  const current = await input.sessionFiles.verifyDeclaredPaths({ paths: [
    { path: `${currentRoot}/log.jsonl`, kind: 'file' }, { path: currentRoot, kind: 'directory' },
  ] });
  if (current.found) return { ok: true as const };
  // Released v0.0.14 sessions remain resumable through the same owner.
  const root = `.fx/sessions/${id}`;
  const result = await input.sessionFiles.verifyDeclaredPaths({ paths: [{ path: `${root}/events.jsonl`, kind: 'file' }, { path: `${root}/session.json`, kind: 'json_object' }, { path: root, kind: 'directory' }] });
  return result.found ? { ok: true as const } : { ok: false as const, reason: 'fx_session_not_found' };
}
