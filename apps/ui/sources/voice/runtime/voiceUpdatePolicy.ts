import {
  resolveVoiceSessionUpdatePolicyV1,
  type VoiceSessionUpdatePolicyV1,
  type VoiceUpdateLevelV1,
} from '@happier-dev/protocol/voice/sourceDisclosureV1';

import { storage } from '@/sync/domains/state/storage';
import {
  normalizeSessionAddress,
  sessionAddressKey,
  type SessionAddress,
} from '@/sync/domains/session/sessionAddress';
import { resolveVoiceSessionRef } from '@/voice/tools/actionImpl/sessionReference';

export type VoiceUpdateLevel = VoiceUpdateLevelV1;

export type VoiceSessionUpdatePolicy = VoiceSessionUpdatePolicyV1;

/**
 * The per-Session Voice update level. The decision itself lives in Protocol so
 * the daemon Voice path answers identically; this keeps only the app's
 * address-shaped call signature.
 */
export function resolveVoiceSessionUpdatePolicy(params: Readonly<{
  sessionId: string;
  sessionAddress?: SessionAddress | null;
  settings: unknown;
  includeInVoice?: boolean;
  isCurrentAttemptTarget?: boolean;
}>): VoiceSessionUpdatePolicy {
  return resolveVoiceSessionUpdatePolicyV1({
    accountSettings: params.settings,
    ...(params.includeInVoice === undefined ? {} : { includeInVoice: params.includeInVoice }),
    ...(params.isCurrentAttemptTarget === undefined ? {} : { isCurrentAttemptTarget: params.isCurrentAttemptTarget }),
  });
}

function readViewerIncludeInVoice(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const viewer = (value as { viewer?: unknown }).viewer;
  if (!viewer || typeof viewer !== 'object') return false;
  const follow = (viewer as { follow?: unknown }).follow;
  return Boolean(follow && typeof follow === 'object' && (follow as { includeInVoice?: unknown }).includeInVoice === true);
}

/** Reads only the synchronized exact-Home Account Follow projection. */
export function readSessionIncludedInVoiceFromState(
  state: unknown,
  address: SessionAddress | null | undefined,
): boolean {
  if (!address || !state || typeof state !== 'object') return false;
  const record = state as {
    sessions?: Record<string, unknown>;
    sessionListRowsByServerId?: Record<string, Record<string, unknown> | undefined>;
  };
  const listRow = record.sessionListRowsByServerId?.[address.serverId]?.[address.sessionId];
  if (listRow) return readViewerIncludeInVoice(listRow);
  const active = record.sessions?.[address.sessionId];
  if (!active || typeof active !== 'object') return false;
  const activeServerId = (active as { serverId?: unknown }).serverId;
  return activeServerId === address.serverId && readViewerIncludeInVoice(active);
}

/**
 * Enumerates the exact-Home Include-in-Voice relationships already held by the synchronized
 * Account Follow projection. The Voice target store is attempt-local presentation state and must
 * never seed replacement writes after restart or an update made on another device.
 */
export function listSessionsIncludedInVoiceFromState(state: unknown): SessionAddress[] {
  if (!state || typeof state !== 'object') return [];
  const record = state as {
    sessions?: Record<string, unknown>;
    sessionListRowsByServerId?: Record<string, Record<string, unknown> | undefined>;
  };
  const byKey = new Map<string, SessionAddress>();
  for (const [serverId, rows] of Object.entries(record.sessionListRowsByServerId ?? {})) {
    for (const [sessionId, row] of Object.entries(rows ?? {})) {
      const address = normalizeSessionAddress(serverId, sessionId);
      if (address && readViewerIncludeInVoice(row)) byKey.set(sessionAddressKey(address), address);
    }
  }
  for (const [sessionId, row] of Object.entries(record.sessions ?? {})) {
    if (!row || typeof row !== 'object') continue;
    const address = normalizeSessionAddress(
      (row as { serverId?: unknown }).serverId,
      (row as { id?: unknown }).id ?? sessionId,
    );
    if (address && readViewerIncludeInVoice(row)) byKey.set(sessionAddressKey(address), address);
  }
  return [...byKey.values()].sort((left, right) =>
    sessionAddressKey(left).localeCompare(sessionAddressKey(right)));
}

export function getVoiceSessionUpdatePolicy(sessionId: string): VoiceSessionUpdatePolicy {
  const state = storage.getState();
  const sessionAddress = resolveVoiceSessionRef(sessionId, state)?.address ?? null;
  return resolveVoiceSessionUpdatePolicy({
    sessionId,
    sessionAddress,
    settings: state.settings,
    includeInVoice: readSessionIncludedInVoiceFromState(state, sessionAddress),
  });
}
