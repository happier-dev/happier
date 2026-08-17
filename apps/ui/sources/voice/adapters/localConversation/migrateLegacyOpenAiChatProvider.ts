import {
  ProviderModelIdSchema,
  ProviderConnectionIdSchema,
  migrateProviderAccountSettingsV1,
  normalizeCustomProviderTemplateV1,
} from '@happier-dev/protocol';

import { buildAgentUniverseBackendTargetKey } from '@/agents/catalog/agentUniverse';

import type { VoiceLocalConversationSettings } from './settings';

const MIGRATION_SOURCE_ID = 'voice:openai_compat:chat:v1';
const MIGRATED_CONNECTION_ID = ProviderConnectionIdSchema.parse('voice-openai-compatible-chat');
const MIGRATED_CHAT_SAVED_SECRET_ID = 'voice:openai_compat:chat_api_key';
export const LEGACY_VOICE_OPENAI_CHAT_COMPATIBLE_AGENT_ID = 'opencode' as const;

type MutableRecord = Record<string, unknown>;

export function completeLegacyVoiceOpenAiChatAgentSelection(
  pending: Extract<NonNullable<VoiceLocalConversationSettings['agent']['providerChat']>, { status: 'needs_selection' }>,
  agentId: string,
): Extract<NonNullable<VoiceLocalConversationSettings['agent']['providerChat']>, { status: 'configured' }> | null {
  if (agentId !== LEGACY_VOICE_OPENAI_CHAT_COMPATIBLE_AGENT_ID) return null;
  const agentTargetKey = buildAgentUniverseBackendTargetKey(agentId);
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
    configuration: pending.configuration,
  };
}

function asRecord(value: unknown): MutableRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as MutableRecord
    : null;
}

function readPath(root: unknown, path: readonly string[]): unknown {
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

function readLegacyConfig(input: Readonly<MutableRecord>): MutableRecord | null {
  return asRecord(readPath(input.voice, PREDECESSOR_CONFIG_PATH));
}

function resolveMigratedLegacyChatBinding(
  rawSecret: unknown,
  settings: Readonly<MutableRecord>,
): Readonly<{ ok: true; binding: Readonly<{ account: Readonly<{ apiKey: string }> }> | null }>
  | Readonly<{ ok: false }> {
  if (rawSecret == null) return { ok: true, binding: null };
  const secret = (Array.isArray(settings.secrets) ? settings.secrets : [])
    .map(asRecord)
    .find((candidate) => candidate?.id === MIGRATED_CHAT_SAVED_SECRET_ID);
  if (!secret || JSON.stringify(secret.encryptedValue) !== JSON.stringify(rawSecret)) {
    return { ok: false };
  }
  return {
    ok: true,
    binding: { account: { apiKey: MIGRATED_CHAT_SAVED_SECRET_ID } },
  };
}

function readModelId(value: unknown): string | null {
  const parsed = ProviderModelIdSchema.safeParse(typeof value === 'string' ? value.trim() : value);
  return parsed.success ? parsed.data : null;
}

function writeProviderChatState(next: MutableRecord, state: VoiceLocalConversationSettings['agent']['providerChat']): void {
  for (const [rootKey, configPath] of [
    ['voice', CANONICAL_CONFIG_PATH],
    ['voiceSettingsV1', CANONICAL_CONFIG_PATH],
  ] as const) {
    const root = asRecord(next[rootKey]);
    if (root && asRecord(readPath(root, configPath))) {
      writePath(root, [...configPath, 'agent', 'providerChat'], state);
    }
  }
}

/**
 * Compatibility ingress for the released Voice-owned OpenAI-compatible Chat shape.
 * Secret bytes never cross this function: only the existing SavedSecret identity is rebound.
 */
export function migrateLegacyVoiceOpenAiChatProvider(
  input: Readonly<MutableRecord>,
  next: MutableRecord,
): void {
  const config = readLegacyConfig(input);
  const agent = asRecord(config?.agent);
  const legacy = asRecord(agent?.openaiCompat);
  if (agent?.backend === 'openai_compat' || legacy) {
    writeProviderChatState(next, {
      status: 'migration_required',
      reason: 'invalid_legacy_configuration',
    });
  }
  const baseUrl = typeof legacy?.chatBaseUrl === 'string' ? legacy.chatBaseUrl.trim() : '';
  const chatModelId = readModelId(legacy?.chatModel);
  const commitModelId = readModelId(legacy?.commitModel);
  if (!baseUrl || !chatModelId || !commitModelId) return;

  const resolvedBinding = resolveMigratedLegacyChatBinding(legacy?.chatApiKey, next);
  if (!resolvedBinding.ok) return;
  const binding = resolvedBinding.binding;

  let template;
  try {
    template = normalizeCustomProviderTemplateV1({
      name: 'Voice OpenAI-compatible Chat',
      protocol: 'openai-chat',
      baseUrl,
      ...(binding ? { credentialStyle: 'bearer' as const } : {}),
      catalog: 'manual',
    });
  } catch {
    return;
  }

  // Account settings defaults own this opaque optional artifact as an explicit
  // `undefined`. The Provider migration classifier treats an own malformed
  // subtree as corruption, so project the optional default to true absence.
  const providerMigrationInput = next.providerSettingsV1 === undefined
    ? (() => {
        const { providerSettingsV1: _absentProviderSettings, ...withoutAbsentProviderSettings } = next;
        return withoutAbsentProviderSettings;
      })()
    : next;
  const result = migrateProviderAccountSettingsV1(providerMigrationInput, {
    migratedAt: 0,
    candidates: [{
      kind: 'connection',
      sourceProfileId: MIGRATION_SOURCE_ID,
      connection: {
        v: 1,
        id: MIGRATED_CONNECTION_ID,
        source: { kind: 'custom', template },
        role: 'named',
        displayName: 'Voice OpenAI-compatible Chat',
        displayNameMode: 'custom',
        deployment: { kind: 'external' },
        revision: 0,
        createdAt: 0,
        updatedAt: 0,
      },
      ...(binding ? { secretBindings: binding } : {}),
      manualModels: [...new Set([chatModelId, commitModelId])].map((id) => ({ id, addedAt: 0 })),
    }],
    pendingCustomProfileIds: [],
  });
  if (!result.ok) return;

  const outcome = result.outcomes.find((candidate) => candidate.sourceProfileId === MIGRATION_SOURCE_ID);
  if (!outcome || outcome.kind !== 'connection') return;
  Object.assign(next, result.settings);

  const configuration = {
    temperature: typeof legacy?.temperature === 'number' && Number.isFinite(legacy.temperature)
      ? Math.max(0, Math.min(2, legacy.temperature))
      : null,
  };
  const pending = {
        status: 'needs_selection',
        providerConnectionId: outcome.connectionId,
        chatModelId,
        commitModelId,
        configuration,
      } as const;
  const configured = agent?.agentSource === 'agent'
    ? completeLegacyVoiceOpenAiChatAgentSelection(pending, String(agent.agentId ?? ''))
    : null;
  writeProviderChatState(next, configured ?? pending);
}
