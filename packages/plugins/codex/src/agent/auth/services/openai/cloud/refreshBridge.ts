import type { JsonValue } from '@happier-dev/plugin-sdk';
import { z } from 'zod';

import type { CodexConnectedServiceRuntimeFailureClassification } from '../../runtime/auth/failure.js';

const connectedServiceProfileIdSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_:-]{0,63}$/u, 'Invalid profile id');
const connectedServiceAuthGroupIdSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u, 'Invalid connected service account group id');

export const CodexChatGptAuthTokensRefreshSelectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('profile'),
    serviceId: z.literal('openai-codex'),
    profileId: connectedServiceProfileIdSchema,
  }),
  z.object({
    kind: z.literal('group'),
    serviceId: z.literal('openai-codex'),
    groupId: connectedServiceAuthGroupIdSchema,
    activeProfileId: connectedServiceProfileIdSchema,
    fallbackProfileId: connectedServiceProfileIdSchema,
    generation: z.number().int().nonnegative(),
  }),
]);

export type CodexChatGptAuthTokensRefreshSelection =
  z.infer<typeof CodexChatGptAuthTokensRefreshSelectionSchema>;

export const CodexChatGptAuthTokensRefreshResponseSchema = z.object({
  accessToken: z.string().min(1),
  chatgptAccountId: z.string().nullable(),
  chatgptPlanType: z.string().nullable(),
});

export type CodexChatGptAuthTokensRefreshResponse =
  z.infer<typeof CodexChatGptAuthTokensRefreshResponseSchema>;

export type CodexChatGptRefreshSelectionResolution = Readonly<{
  selection: CodexChatGptAuthTokensRefreshSelection;
  recoveryGroupId: string | null;
}>;

type CodexChatGptMetadataBinding = Readonly<
  | { source: 'native' }
  | { source: 'connected'; selection: 'profile'; profileId: string }
  | { source: 'connected'; selection: 'group'; groupId: string; profileId?: string }
>;

export type CodexChatGptRefreshSessionFacts = Readonly<{
  connectedServices?: JsonValue;
}>;

type CodexChatGptRefreshChildSelection = Readonly<
  | {
      kind: 'profile';
      serviceId: string;
      profileId: string;
    }
  | {
      kind: 'group';
      serviceId: string;
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
      generation: number;
    }
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readDirectMetadataBinding(facts: CodexChatGptRefreshSessionFacts): CodexChatGptMetadataBinding | null {
  const connectedServices = isRecord(facts.connectedServices) ? facts.connectedServices : null;
  const bindingsByServiceId = connectedServices && isRecord(connectedServices.bindingsByServiceId)
    ? connectedServices.bindingsByServiceId
    : null;
  const binding = bindingsByServiceId && isRecord(bindingsByServiceId['openai-codex'])
    ? bindingsByServiceId['openai-codex']
    : null;
  if (binding?.source === 'connected' && binding.selection === 'group') {
    const groupId = connectedServiceAuthGroupIdSchema.safeParse(binding.groupId);
    if (!groupId.success) return null;
    let profileId: string | undefined;
    if (binding.profileId !== undefined) {
      const parsedProfileId = connectedServiceProfileIdSchema.safeParse(binding.profileId);
      if (!parsedProfileId.success) return null;
      profileId = parsedProfileId.data;
    }
    return {
      source: 'connected',
      selection: 'group',
      groupId: groupId.data,
      ...(profileId ? { profileId } : {}),
    };
  }
  if (binding?.source === 'connected') {
    const profileId = connectedServiceProfileIdSchema.safeParse(binding.profileId);
    if (!profileId.success) return null;
    return {
      source: 'connected',
      selection: 'profile',
      profileId: profileId.data,
    };
  }
  if (binding?.source === 'native') return { source: 'native' };
  return null;
}

function readCodexChatGptMetadataBinding(facts: CodexChatGptRefreshSessionFacts): CodexChatGptMetadataBinding | null {
  return readDirectMetadataBinding(facts);
}

export function resolveCodexChatGptRefreshSelectionFromMetadata(
  facts: CodexChatGptRefreshSessionFacts,
): CodexChatGptRefreshSelectionResolution | null {
  const binding = readCodexChatGptMetadataBinding(facts);
  if (!binding || binding.source !== 'connected') return null;
  if (binding.selection === 'group') {
    if (!binding.profileId) return null;
    return {
      selection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: binding.profileId,
      },
      recoveryGroupId: binding.groupId,
    };
  }
  return {
    selection: {
      kind: 'profile',
      serviceId: 'openai-codex',
      profileId: binding.profileId,
    },
    recoveryGroupId: null,
  };
}

function readCodexChatGptRefreshChildSelection(selection: unknown): CodexChatGptRefreshChildSelection | null {
  if (!isRecord(selection) || selection.serviceId !== 'openai-codex') return null;
  if (selection.kind === 'profile' && typeof selection.profileId === 'string') {
    return {
      kind: 'profile',
      serviceId: 'openai-codex',
      profileId: selection.profileId,
    };
  }
  if (
    selection.kind === 'group'
    && typeof selection.groupId === 'string'
    && typeof selection.activeProfileId === 'string'
    && typeof selection.fallbackProfileId === 'string'
    && typeof selection.generation === 'number'
    && Number.isFinite(selection.generation)
  ) {
    return {
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: selection.groupId,
      activeProfileId: selection.activeProfileId,
      fallbackProfileId: selection.fallbackProfileId,
      generation: Math.max(0, Math.trunc(selection.generation)),
    };
  }
  return null;
}

export function resolveCodexChatGptRefreshSelectionFromChildSelection(
  selection: unknown,
): CodexChatGptRefreshSelectionResolution | null {
  const childSelection = readCodexChatGptRefreshChildSelection(selection);
  if (!childSelection) return null;
  if (childSelection.kind === 'profile') {
    return {
      selection: {
        kind: 'profile',
        serviceId: 'openai-codex',
        profileId: childSelection.profileId,
      },
      recoveryGroupId: null,
    };
  }
  return {
    selection: {
      kind: 'group',
      serviceId: 'openai-codex',
      groupId: childSelection.groupId,
      activeProfileId: childSelection.activeProfileId,
      fallbackProfileId: childSelection.fallbackProfileId,
      generation: childSelection.generation,
    },
    recoveryGroupId: childSelection.groupId,
  };
}

export function createCodexChatGptBridgeRefreshFailureClassification(
  resolution: CodexChatGptRefreshSelectionResolution,
): CodexConnectedServiceRuntimeFailureClassification {
  const { selection } = resolution;
  return {
    kind: 'refresh_failed',
    serviceId: 'openai-codex',
    profileId: selection.kind === 'group' ? selection.activeProfileId : selection.profileId,
    groupId: selection.kind === 'group' ? selection.groupId : resolution.recoveryGroupId,
    resetsAtMs: null,
    retryAfterMs: null,
    planType: null,
    rateLimits: null,
    source: 'provider_runtime_marker',
  };
}

export function readCodexChatGptRefreshPlanType(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const raw = value.chatgptPlanType;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}
