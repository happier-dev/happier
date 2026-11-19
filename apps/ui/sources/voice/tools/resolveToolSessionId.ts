import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { storage } from '@/sync/domains/state/storage';
import { resolveVoiceActionTargetAddress, useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { normalizeNonEmptyString } from './actionImpl/shared';
import { acquireAdmittedSessionReferenceCorpusOptions } from './actionImpl/admittedSessionReferenceCorpus';
import { resolveVoiceSessionReference } from './actionImpl/sessionReference';
import type { VoiceSessionBinding } from '@/voice/binding/voiceConversationBindingTypes';
import { resolveActiveLocalVoiceAgentBinding } from '@/voice/context/resolveActiveLocalVoiceAgentBinding';

export async function resolveToolSessionAddress(opts: Readonly<{
  explicitSessionId?: unknown;
  explicitServerId?: unknown;
  currentSessionId?: string | null;
  currentServerId?: string | null;
  binding?: VoiceSessionBinding | null;
}>): Promise<SessionAddress | null> {
  const state = storage.getState();
  const explicitSessionId = normalizeNonEmptyString(opts.explicitSessionId);
  const explicitServerId = normalizeNonEmptyString(opts.explicitServerId);
  if (explicitSessionId) {
    // An exact tuple is already qualified and never consults a corpus. A bare id is resolved
    // against the one admitted corpus — acquired through the canonical `session.list` owner when
    // no pane holds one — so a single authoritative match opens while ambiguity, absence and
    // unproven coverage all stay closed here (Lane 07.1 §3).
    const corpusOptions = explicitServerId
      ? null
      : await acquireAdmittedSessionReferenceCorpusOptions(state);
    // Resolve against the store as it stands after the acquisition: its row-only
    // read hydrated the rows the admitted addresses name.
    const resolution = resolveVoiceSessionReference(
      { sessionId: explicitSessionId, serverId: explicitServerId },
      storage.getState(),
      corpusOptions ?? undefined,
    );
    return resolution.kind === 'unique' ? resolution.address : null;
  }

  const currentSessionAddress = normalizeSessionAddress(
    opts.currentServerId ?? getActiveServerSnapshot().serverId,
    opts.currentSessionId,
  );
  const { scope, primaryActionSessionAddress, lastFocusedSessionAddress } = useVoiceTargetStore.getState();
  return resolveVoiceActionTargetAddress({
    scope,
    binding: opts.binding === undefined ? resolveActiveLocalVoiceAgentBinding()?.binding : opts.binding,
    currentSessionAddress,
    primaryActionSessionAddress,
    lastFocusedSessionAddress,
  });
}

export async function resolveToolSessionId(opts: Readonly<{
  explicitSessionId?: unknown;
  explicitServerId?: unknown;
  currentSessionId?: string | null;
  currentServerId?: string | null;
}>): Promise<string | null> {
  return (await resolveToolSessionAddress(opts))?.sessionId ?? null;
}
