type VoiceConversationScopeKind = 'voice_home' | 'session_root';

type PersistedVoiceConversationScopeV1 = Readonly<
  | {
      v: 1;
      kind: 'voice_home';
    }
  | {
      v: 1;
      kind: 'session_root';
      sessionRootId: string;
    }
>;

function normalizeId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type VoiceConversationScopeMetadata = Readonly<
  | { kind: 'voice_home' }
  | { kind: 'session_root'; sessionRootId: string }
>;

export function readVoiceConversationScopeMetadata(metadata: unknown): VoiceConversationScopeMetadata | null {
  if (!metadata || typeof metadata !== 'object') return null;

  const raw = (metadata as any).voiceConversationScopeV1 as PersistedVoiceConversationScopeV1 | undefined;
  if (!raw || raw.v !== 1) return null;
  if (raw.kind === 'voice_home') return { kind: 'voice_home' };
  if (raw.kind === 'session_root') {
    const sessionRootId = normalizeId(raw.sessionRootId);
    if (!sessionRootId) return null;
    return { kind: 'session_root', sessionRootId };
  }
  return null;
}

export function writeVoiceConversationScopeMetadata<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  scope: VoiceConversationScopeMetadata,
): TMetadata & { voiceConversationScopeV1: PersistedVoiceConversationScopeV1 };
export function writeVoiceConversationScopeMetadata(
  metadata: unknown,
  scope: VoiceConversationScopeMetadata,
): Record<string, unknown> & { voiceConversationScopeV1: PersistedVoiceConversationScopeV1 };
export function writeVoiceConversationScopeMetadata(
  metadata: unknown,
  scope: VoiceConversationScopeMetadata,
): Record<string, unknown> & { voiceConversationScopeV1: PersistedVoiceConversationScopeV1 } {
  const base = metadata && typeof metadata === 'object' ? { ...(metadata as Record<string, unknown>) } : {};
  const nextScope: PersistedVoiceConversationScopeV1 =
    scope.kind === 'voice_home'
      ? { v: 1, kind: 'voice_home' }
      : { v: 1, kind: 'session_root', sessionRootId: scope.sessionRootId };

  return {
    ...base,
    voiceConversationScopeV1: nextScope,
  };
}

export function matchesVoiceConversationScope(
  metadata: unknown,
  scope: Readonly<{ kind: VoiceConversationScopeKind; sessionRootId?: string | null }>,
): boolean {
  const persisted = readVoiceConversationScopeMetadata(metadata);
  if (!persisted) {
    return scope.kind === 'voice_home';
  }

  if (persisted.kind !== scope.kind) return false;
  if (persisted.kind !== 'session_root') return true;
  return persisted.sessionRootId === normalizeId(scope.sessionRootId);
}
