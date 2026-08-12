import { createHash } from 'node:crypto';

import type { ConnectedServiceBindingsV1, ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import {
  createConnectedServiceCredentialApi,
  type ConnectedServiceCredentialApi,
  type ConnectedServiceAuthGroupApi,
} from '@/api/connectedServices/connectedServiceCredentialApi';
import { readClaudeCodeNativeCredential } from '@/backends/claude/connectedServices/nativeAuth/claudeCodeCredentialFile';
import { resolveConnectedServiceCredentialsWithRevisions } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import type { Credentials } from '@/persistence';
import { buildProfileEnvOverlay } from '@/settings/profiles/buildProfileEnvOverlay';
import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import { resolveProfileForAgent } from '@/settings/profiles/resolveProfileForAgent';
import { resolveConfiguredClaudeConfigDir } from '@/backends/claude/utils/resolveConfiguredClaudeConfigDir';
import { DEFAULT_ANTHROPIC_BASE_URL } from './fetchAnthropicModels';

export type ClaudeModelProbeCredential = Readonly<{
  kind: 'bearer' | 'api_key';
  value: string;
}>;

export type ClaudeModelProbeTarget = Readonly<{
  baseUrl: string | null;
  credential: ClaudeModelProbeCredential;
  cacheIdentity: string;
}>;

export type ClaudeProbeBinding = Readonly<{
  serviceId: 'claude-subscription' | 'anthropic';
  selection:
    | Readonly<{ kind: 'group'; groupId: string }>
    | Readonly<{ kind: 'profile'; profileId: string }>;
}>;

const CLAUDE_PROBE_SERVICE_IDS = ['claude-subscription', 'anthropic'] as const;
const CLAUDE_AUTH_ENV_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
] as const;

function readNonBlankString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function resolveClaudeProbeBinding(
  connectedServices?: ConnectedServiceBindingsV1 | null,
): ClaudeProbeBinding | null {
  for (const serviceId of CLAUDE_PROBE_SERVICE_IDS) {
    const binding = connectedServices?.bindingsByServiceId[serviceId] ?? null;
    if (!binding || binding.source === 'native') continue;
    if (binding.selection === 'group') {
      const groupId = readNonBlankString(binding.groupId);
      if (groupId) return { serviceId, selection: { kind: 'group', groupId } };
      continue;
    }
    const profileId = readNonBlankString(binding.profileId);
    if (profileId) return { serviceId, selection: { kind: 'profile', profileId } };
  }
  return null;
}

function readAuthFromEnv(env: NodeJS.ProcessEnv | Readonly<Record<string, string>>): ClaudeModelProbeCredential | null {
  for (const key of CLAUDE_AUTH_ENV_KEYS) {
    const value = readNonBlankString(env[key]);
    if (!value) continue;
    return key === 'ANTHROPIC_API_KEY'
      ? { kind: 'api_key', value }
      : { kind: 'bearer', value };
  }
  return null;
}

function normalizeExplicitBaseUrl(env: NodeJS.ProcessEnv | Readonly<Record<string, string>>): string | null | 'invalid' {
  const raw = readNonBlankString(env.ANTHROPIC_BASE_URL);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'invalid';
    const defaultOrigin = new URL(DEFAULT_ANTHROPIC_BASE_URL);
    if (
      parsed.origin === defaultOrigin.origin
      && (parsed.pathname === '' || parsed.pathname === '/')
      && parsed.search === ''
      && parsed.hash === ''
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return 'invalid';
  }
}

function targetCacheIdentity(baseUrl: string | null, credential: ClaudeModelProbeCredential): string {
  return [
    baseUrl ?? 'https://api.anthropic.com',
    credential.kind,
    createHash('sha256').update(credential.value).digest('hex'),
  ].join('|');
}

function projectConnectedCredential(
  serviceId: ClaudeProbeBinding['serviceId'],
  record: ConnectedServiceCredentialRecordV1,
  nowMs: number,
): ClaudeModelProbeCredential | null {
  if (record.expiresAt !== null && record.expiresAt <= nowMs) return null;
  if (serviceId === 'anthropic') {
    return record.kind === 'token' ? { kind: 'api_key', value: record.token.token } : null;
  }
  return record.kind === 'oauth' ? { kind: 'bearer', value: record.oauth.accessToken } : null;
}

type ConnectedServiceReadApi = ConnectedServiceCredentialApi & ConnectedServiceAuthGroupApi;

async function resolveConnectedCredential(params: Readonly<{
  binding: ClaudeProbeBinding;
  credentials: Credentials;
  api: ConnectedServiceReadApi;
  nowMs: number;
}>): Promise<ClaudeModelProbeCredential | null> {
  const readProfile = async (profileId: string): Promise<ClaudeModelProbeCredential | null> => {
    const resolved = await resolveConnectedServiceCredentialsWithRevisions({
      credentials: params.credentials,
      api: params.api,
      bindings: [{ serviceId: params.binding.serviceId, profileId }],
    });
    const record = resolved.get(params.binding.serviceId)?.record ?? null;
    return record ? projectConnectedCredential(params.binding.serviceId, record, params.nowMs) : null;
  };

  if (params.binding.selection.kind === 'profile') {
    return await readProfile(params.binding.selection.profileId);
  }

  // A passive probe may observe a concurrent group switch. Re-read once after credential
  // resolution and accept only a stable active member/generation; never mutate group state.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await params.api.getConnectedServiceAuthGroup({
      serviceId: params.binding.serviceId,
      groupId: params.binding.selection.groupId,
    });
    const activeProfileId = readNonBlankString(before?.activeProfileId);
    if (!before || !activeProfileId) return null;
    const projected = await readProfile(activeProfileId);
    const after = await params.api.getConnectedServiceAuthGroup({
      serviceId: params.binding.serviceId,
      groupId: params.binding.selection.groupId,
    });
    if (
      after
      && after.generation === before.generation
      && after.activeProfileId === activeProfileId
    ) {
      return projected;
    }
  }
  return null;
}

export type ResolveClaudeModelProbeTargetParams = Readonly<{
  connectedServices?: ConnectedServiceBindingsV1 | null;
  credentials?: Credentials | null;
  accountSettings?: Readonly<Record<string, unknown>> | null;
  profileId?: string | null;
  processEnv?: NodeJS.ProcessEnv;
  nowMs?: () => number;
  createCredentialApi?: (credentials: Credentials) => ConnectedServiceReadApi;
}>;

/**
 * Resolve the exact endpoint/credential pair used for model discovery.
 *
 * This is deliberately passive: it reads profiles and selected connected credentials but never
 * mutates process env, materializes auth homes, refreshes OAuth, or switches account groups.
 */
export async function resolveClaudeModelProbeTarget(
  params: ResolveClaudeModelProbeTargetParams,
): Promise<ClaudeModelProbeTarget | null> {
  const processEnv = params.processEnv ?? process.env;
  let effectiveEnv: NodeJS.ProcessEnv = { ...processEnv };
  const profileId = readNonBlankString(params.profileId);
  if (profileId) {
    if (!params.credentials || !params.accountSettings) return null;
    try {
      const { customProfiles } = readProfilesFromAccountSettings(params.accountSettings);
      const profile = resolveProfileForAgent({ agentId: 'claude', query: profileId, customProfiles });
      const overlay = await buildProfileEnvOverlay({
        agentId: 'claude',
        profile,
        accountSettings: params.accountSettings,
        credentials: params.credentials,
        processEnv,
        promptSecretFn: null,
        startedBy: 'daemon',
      });
      effectiveEnv = { ...processEnv, ...overlay.envOverlayExpanded };
    } catch {
      return null;
    }
  }

  const baseUrl = normalizeExplicitBaseUrl(effectiveEnv);
  if (baseUrl === 'invalid') return null;

  const binding = resolveClaudeProbeBinding(params.connectedServices);
  if (binding) {
    if (!params.credentials) return null;
    try {
      const api = (params.createCredentialApi ?? createConnectedServiceCredentialApi)(params.credentials);
      const credential = await resolveConnectedCredential({
        binding,
        credentials: params.credentials,
        api,
        nowMs: (params.nowMs ?? Date.now)(),
      });
      if (!credential) return null;
      return { baseUrl, credential, cacheIdentity: targetCacheIdentity(baseUrl, credential) };
    } catch {
      return null;
    }
  }

  const envCredential = readAuthFromEnv(effectiveEnv);
  if (envCredential) {
    return { baseUrl, credential: envCredential, cacheIdentity: targetCacheIdentity(baseUrl, envCredential) };
  }

  // Never pair a native saved subscription token with an explicitly configured third-party
  // endpoint. With the default endpoint, reading the native credential mirrors Claude Code login.
  if (baseUrl !== null) return null;
  try {
    const native = await readClaudeCodeNativeCredential({
      claudeConfigDir: resolveConfiguredClaudeConfigDir({ env: effectiveEnv }),
    });
    const accessToken = readNonBlankString(native?.payload.claudeAiOauth.accessToken);
    if (!accessToken) return null;
    const credential = { kind: 'bearer' as const, value: accessToken };
    return { baseUrl: null, credential, cacheIdentity: targetCacheIdentity(null, credential) };
  } catch {
    return null;
  }
}
