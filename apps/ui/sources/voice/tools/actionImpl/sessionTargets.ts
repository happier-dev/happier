import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { applyVoiceSessionTargetSelection } from '@/voice/binding/applyVoiceSessionTargetSelection';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { replaceSessionVoiceInclusions } from '@/sync/api/session/sessionFollowApi';
import {
  normalizeSessionAddress,
  sessionAddressKey,
  type SessionAddress,
} from '@/sync/domains/session/sessionAddress';
import { listSessionAddressesForSessionIdFromLocalState } from '@/sync/domains/session/resolveSessionAddressFromLocalState';
import { storage } from '@/sync/domains/state/storage';
import {
  readSessionIncludedInVoiceFromState,
} from '@/voice/runtime/voiceUpdatePolicy';
import { SessionFollowErrorCodeV1Schema } from '@happier-dev/protocol/sessions/follow/api';
import type { VoiceTrackedTargetsActionResultV1 } from '@happier-dev/protocol/sessions/follow/voiceTrackedTargetsCompatibilityV1';

import {
  resolveVoiceSessionRef,
  resolveVoiceSessionReference,
  type VoiceSessionCandidate,
} from './sessionReference';
import type { VoiceSessionCorpusOptions } from './voiceSessionRows';

type VoiceTargetMutationError = Readonly<{
  ok: false;
  status: 'not_found' | 'ambiguous' | 'incomplete' | 'unavailable';
  error: Readonly<{
    code: 'session_not_found' | 'session_ambiguous' | 'session_lookup_incomplete' | 'session_follow_unavailable';
    message: string;
    sessionTitle?: string;
    sessionId?: string;
    candidates?: VoiceSessionCandidate[];
  }>;
}>;

function publishTrackedSessionProjection(
  projectionByKey: ReadonlyMap<string, SessionAddress>,
  state: unknown,
) {
  const sessionAddresses = [...projectionByKey.values()].sort((left, right) =>
    sessionAddressKey(left).localeCompare(sessionAddressKey(right)));
  useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses(sessionAddresses);
  const storedSessionAddresses = useVoiceTargetStore.getState().voiceLiveContextSessionAddresses;
  const sessions = storedSessionAddresses
    .map((address) => resolveVoiceSessionRef(address, state))
    .filter((session): session is VoiceSessionCandidate => Boolean(session));
  return {
    sessionIds: storedSessionAddresses.map((address) => address.sessionId),
    sessionAddresses: storedSessionAddresses.map((address) => ({ ...address })),
    sessions: sessions.map((session) => ({
      ...session,
      address: { ...session.address },
    })),
  };
}

function resolveBareTargetAddress(
  sessionId: string,
  state: unknown,
  serverId?: string | null,
): SessionAddress | null {
  const exact = normalizeSessionAddress(serverId, sessionId);
  if (exact) return exact;
  return resolveVoiceSessionRef(sessionId, state, {
    activeServerId: getActiveServerSnapshot().serverId,
  })?.address ?? null;
}

function unresolvedBareTarget(
  sessionId: string,
  state: Parameters<typeof listSessionAddressesForSessionIdFromLocalState>[0],
): VoiceTargetMutationError {
  const addresses = listSessionAddressesForSessionIdFromLocalState(state, sessionId);
  if (addresses.length > 1) {
    return {
      ok: false,
      status: 'ambiguous',
      error: {
        code: 'session_ambiguous',
        message: 'More than one Home has that session. Choose a Home before changing the Voice target.',
        sessionId,
        candidates: addresses.map((address) => ({
          address,
          id: address.sessionId,
          serverId: address.serverId,
        })),
      },
    };
  }
  return {
    ok: false,
    status: 'not_found',
    error: {
      code: 'session_not_found',
      message: 'I could not find that session.',
      sessionId,
    },
  };
}

export async function setPrimaryActionSessionId(params: Readonly<{
  sessionId: string | null;
  serverId?: string | null;
  sessionTitle?: string | null;
  updateLastFocused?: boolean;
  corpus?: VoiceSessionCorpusOptions;
}>): Promise<
  | Readonly<{
    ok: true;
    status: 'ok';
    sessionId: string | null;
    serverId: string | null;
    address: SessionAddress | null;
    session?: VoiceSessionCandidate;
  }>
  | VoiceTargetMutationError
> {
  const state = storage.getState();
  let address: SessionAddress | null = null;
  let session: VoiceSessionCandidate | null = null;

  if (params.sessionTitle) {
    const resolution = resolveVoiceSessionReference(
      { serverId: params.serverId, sessionTitle: params.sessionTitle },
      state,
      params.corpus ?? { coverage: 'incomplete' },
    );
    if (resolution.kind !== 'unique') {
      const sessionTitle = String(params.sessionTitle).trim();
      if (resolution.kind === 'ambiguous') {
        return {
          ok: false,
          status: 'ambiguous',
          error: {
            code: 'session_ambiguous',
            message: `More than one session is titled "${sessionTitle}". Choose a Home or session.`,
            sessionTitle,
            candidates: [...resolution.candidates],
          },
        };
      }
      if (resolution.kind === 'incomplete') {
        return {
          ok: false,
          status: 'incomplete',
          error: {
            code: 'session_lookup_incomplete',
            message: `I cannot verify that "${sessionTitle}" is unique while one or more selected Homes are unavailable.`,
            sessionTitle,
          },
        };
      }
      return {
        ok: false,
        status: 'not_found',
        error: {
          code: 'session_not_found',
          message: `I could not find a session titled "${sessionTitle}".`,
          sessionTitle,
        },
      };
    }
    address = resolution.address;
    session = resolution.candidate;
  } else if (params.sessionId !== null) {
    const sessionId = String(params.sessionId ?? '').trim();
    if (!sessionId) return unresolvedBareTarget(sessionId, state);
    address = resolveBareTargetAddress(sessionId, state, params.serverId);
    if (!address) return unresolvedBareTarget(sessionId, state);
    session = resolveVoiceSessionRef(address, state);
  }

  await applyVoiceSessionTargetSelection({
    controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    targetSessionAddress: address,
    updateLastFocused: params.updateLastFocused === true,
  });
  return {
    ok: true,
    status: 'ok',
    sessionId: address?.sessionId ?? null,
    serverId: address?.serverId ?? null,
    address,
    ...(session ? { session } : {}),
  };
}

export async function setTrackedSessionIds(params: Readonly<{
  sessionIds?: readonly string[];
  sessionAddresses?: readonly SessionAddress[];
  serverId?: string | null;
  corpus?: VoiceSessionCorpusOptions;
}>): Promise<VoiceTrackedTargetsActionResultV1> {
  const state = storage.getState();
  const addresses: SessionAddress[] = [];
  for (const raw of params.sessionAddresses ?? []) {
    const address = normalizeSessionAddress(raw.serverId, raw.sessionId);
    if (address) addresses.push(address);
  }
  for (const raw of params.sessionIds ?? []) {
    const sessionId = String(raw ?? '').trim();
    if (!sessionId) continue;
    const address = resolveBareTargetAddress(sessionId, state, params.serverId);
    if (!address) return unresolvedBareTarget(sessionId, state);
    addresses.push(address);
  }

  const desiredByKey = new Map<string, SessionAddress>();
  for (const address of addresses) desiredByKey.set(sessionAddressKey(address), address);
  const desired = [...desiredByKey.values()].sort((left, right) =>
    sessionAddressKey(left).localeCompare(sessionAddressKey(right)));

  const corpus = params.corpus ?? { coverage: 'incomplete' as const };
  if (corpus.coverage !== 'complete' || corpus.addresses === undefined) {
    return {
      ok: false,
      status: 'incomplete',
      error: {
        code: 'session_lookup_incomplete',
        message: 'I cannot replace Include in Voice while the current Sessions list is incomplete.',
      },
    };
  }
  const currentInclusions = corpus.addresses.filter((address) =>
    readSessionIncludedInVoiceFromState(state, address));

  const groups = new Map<string, string[]>();
  for (const address of desired) {
    const ids = groups.get(address.serverId) ?? [];
    ids.push(address.sessionId);
    groups.set(address.serverId, ids);
  }
  const currentInclusionsByServerId = new Map<string, string[]>();
  for (const address of currentInclusions) {
    const ids = currentInclusionsByServerId.get(address.serverId) ?? [];
    ids.push(address.sessionId);
    currentInclusionsByServerId.set(address.serverId, ids);
    if (!groups.has(address.serverId)) groups.set(address.serverId, []);
  }
  const completed = new Map<string, SessionAddress>();
  for (const [serverId, sessionIds] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const outcome = await replaceSessionVoiceInclusions(serverId, sessionIds);
    if (outcome.kind !== 'ok') {
      if (completed.size === 0) return {
        ok: false,
        status: 'unavailable',
        error: { code: 'session_follow_unavailable', message: 'Include in Voice could not be updated.' },
      };
      const projection = publishTrackedSessionProjection(completed, state);
      const reason = SessionFollowErrorCodeV1Schema.safeParse(outcome.error);
      return {
        ok: false,
        status: 'partial',
        ...projection,
        error: {
          code: 'session_follow_partial',
          message: 'Include in Voice was updated on only some Homes. Retry to finish the requested set.',
          operation: sessionIds.length > 0 ? 'include' : 'exclude',
          address: {
            serverId,
            sessionId: sessionIds[0] ?? currentInclusionsByServerId.get(serverId)?.[0] ?? '',
          },
          reason: reason.success ? reason.data : 'unavailable',
        },
      };
    }
    for (const sessionId of sessionIds) {
      const address = { serverId, sessionId };
      completed.set(sessionAddressKey(address), address);
    }
  }

  // Released `session.target.tracked.set` compatibility: Account Follow is the
  // durable owner; this attempt-local projection exists only for immediate
  // result presentation and explicit readback. It is not a disclosure,
  // catch-up, frontier, or transcript-consumption authority.
  const projection = publishTrackedSessionProjection(desiredByKey, state);
  return {
    ok: true,
    status: 'ok',
    ...projection,
  };
}
