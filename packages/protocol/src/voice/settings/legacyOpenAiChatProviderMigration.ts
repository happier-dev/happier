import { ProviderModelIdSchema } from '../../providers/ids.js';
import { normalizeCustomProviderTemplateV1 } from '../../providers/connections/normalizeCustomTemplateV1.js';
import { resolveBackendTargetKeyV2 } from '../../backends/targets/backendTargetRefV2.js';
import { readSavedSecretTransferSourceV1 } from '../../account/settings/savedSecretMutationOwner.js';

import { parsePredecessorVoiceCredentialBindings } from './voiceCredentialBindingCompatibility.js';

import type { VoiceLocalConversationSettings } from './localConversation.js';

const MIGRATED_CHAT_SAVED_SECRET_ID = 'voice:openai_compat:chat_api_key';
export const LEGACY_VOICE_OPENAI_CHAT_COMPATIBLE_AGENT_ID = 'opencode' as const;

type MutableRecord = Record<string, unknown>;

export function completeLegacyVoiceOpenAiChatAgentSelection(
  pending: Extract<NonNullable<VoiceLocalConversationSettings['agent']['providerChat']>, { status: 'needs_selection' }>,
  agentId: string,
): Extract<NonNullable<VoiceLocalConversationSettings['agent']['providerChat']>, { status: 'configured' }> | null {
  if (agentId !== LEGACY_VOICE_OPENAI_CHAT_COMPATIBLE_AGENT_ID) return null;
  const agentTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: agentId.trim() });
  return {
    status: 'configured',
    chat: {
      agentTargetKey,
      providerConnectionId: pending.providerConnectionId,
      modelId: pending.chatModelId,
    },
    commit: {
      agentTargetKey,
      providerConnectionId: pending.providerConnectionId,
      modelId: pending.commitModelId,
    },
  };
}

function asRecord(value: unknown): MutableRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as MutableRecord
    : null;
}

export function readLegacyVoiceOpenAiChatPath(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[segment];
  }
  return current;
}

function writePath(root: MutableRecord, path: readonly string[], value: unknown): void {
  let current = root;
  for (const segment of path.slice(0, -1)) {
    const next = asRecord(current[segment]) ?? {};
    current[segment] = next;
    current = next;
  }
  current[path[path.length - 1]!] = value;
}

const CANONICAL_CONFIG_PATH = ['providers', 'local_conversation', 'config'] as const;
const PREDECESSOR_CONFIG_PATH = ['adapters', 'local_conversation'] as const;

export function readLegacyVoiceOpenAiChatConfig(input: Readonly<MutableRecord>): MutableRecord | null {
  return asRecord(readLegacyVoiceOpenAiChatPath(input.voice, PREDECESSOR_CONFIG_PATH));
}

function resolveMigratedLegacyChatBinding(
  rawSecret: unknown,
  input: Readonly<MutableRecord>,
): Readonly<{ ok: true; binding: Readonly<{ account: Readonly<{ apiKey: string }> }> | null }>
  | Readonly<{ ok: false }> {
  if (rawSecret == null) return { ok: true, binding: null };
  const boundSecretId = parsePredecessorVoiceCredentialBindings(input.voice)
    .find(binding => binding.providerId === 'openai_compat')
    ?.credentialBindings.account?.chat_api_key ?? MIGRATED_CHAT_SAVED_SECRET_ID;
  const source = readSavedSecretTransferSourceV1(input);
  const receipt = source.legacyChatCredential;
  if (receipt && (receipt.source.kind === 'existing-resource-reference'
    ? receipt.source.resourceRef === boundSecretId : receipt.source.secretId === boundSecretId)) {
    // Structural provenance permits only a pending diagnostic. Material admission remains S2-owned.
    return { ok: true, binding: { account: { apiKey: boundSecretId } } };
  }
  // Classify the original source, not the post-promotion destination inventory.
  const secret = source.secrets.find(candidate => candidate.id === boundSecretId);
  if (!secret || JSON.stringify(secret.encryptedValue) !== JSON.stringify(rawSecret)) {
    return { ok: false };
  }
  return {
    ok: true,
    binding: { account: { apiKey: boundSecretId } },
  };
}

export function readLegacyVoiceOpenAiChatModelId(value: unknown): string | null {
  const parsed = ProviderModelIdSchema.safeParse(typeof value === 'string' ? value.trim() : value);
  return parsed.success ? parsed.data : null;
}

function writeProviderChatState(next: MutableRecord, state: VoiceLocalConversationSettings['agent']['providerChat']): void {
  for (const [rootKey, configPath] of [
    ['voice', CANONICAL_CONFIG_PATH],
    ['voiceSettingsV1', CANONICAL_CONFIG_PATH],
  ] as const) {
    const root = asRecord(next[rootKey]);
    if (root && asRecord(readLegacyVoiceOpenAiChatPath(root, configPath))) {
      writePath(root, [...configPath, 'agent', 'providerChat'], state);
    }
  }
}

/**
 * Compatibility ingress for the released Voice-owned OpenAI-compatible Chat shape.
 * This synchronous reader reports pending import; it never publishes a Provider catalog.
 */
export function migrateLegacyVoiceOpenAiChatProvider(
  input: Readonly<MutableRecord>,
  next: MutableRecord,
): boolean {
  const state = resolveLegacyVoiceOpenAiChatImportState(input, next);
  if (!state) return false;
  writeProviderChatState(next, state);
  return true;
}

/** Pure ingress classification; only the asynchronous Provider owner can import it. */
export function resolveLegacyVoiceOpenAiChatImportState(
  input: Readonly<MutableRecord>,
  _settings: Readonly<MutableRecord>,
): Extract<NonNullable<VoiceLocalConversationSettings['agent']['providerChat']>, { status: 'migration_required' }> | null {
  const config = readLegacyVoiceOpenAiChatConfig(input);
  const agent = asRecord(config?.agent);
  const legacy = asRecord(agent?.openaiCompat);
  // The predecessor prefaults openaiCompat even for its daemon selection.
  // Only the explicitly selected direct Chat backend establishes import intent.
  if (agent?.backend !== 'openai_compat') return null;
  const invalid = { status: 'migration_required', reason: 'invalid_legacy_configuration' } as const;
  const baseUrl = typeof legacy?.chatBaseUrl === 'string' ? legacy.chatBaseUrl.trim() : '';
  const chatModelId = readLegacyVoiceOpenAiChatModelId(legacy?.chatModel);
  const commitModelId = readLegacyVoiceOpenAiChatModelId(legacy?.commitModel);
  if (!baseUrl || !chatModelId || !commitModelId) return invalid;

  const resolvedBinding = resolveMigratedLegacyChatBinding(legacy?.chatApiKey, input);
  if (!resolvedBinding.ok) return invalid;
  const binding = resolvedBinding.binding;

  try {
    normalizeCustomProviderTemplateV1({
      name: 'Voice OpenAI-compatible Chat',
      protocol: 'openai-chat',
      baseUrl,
      ...(binding ? { credentialStyle: 'bearer' as const } : {}),
      catalog: 'manual',
    });
  } catch {
    return invalid;
  }
  return { status: 'migration_required', reason: 'provider_catalog_import_required' };
}
