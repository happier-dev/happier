import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { getStorage, selectSessionDisplayNameSource, selectSessionReferenceTarget, useSessionDisplayNameSource } from '@/sync/domains/state/storage';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { getSessionName, isUntitledSessionName } from '@/utils/sessions/sessionUtils';
import { readableSessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { t } from '@/text';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';

/**
 * Who another Session is, as a transcript names it: its title and its agent mark. One owner for every
 * row that points at another Session (a returned answer, an Ask record's targets), qualified by the
 * transcript's own Home like the provenance label.
 */
export function useTranscriptSessionIdentity(sessionId: string | null, serverId: string | null) {
  const session = useSessionDisplayNameSource(sessionId ?? '', serverId);
  const isSessionVisible = useSessionRecordingVisibility();
  const visibleSession = sessionId && isSessionVisible({ sessionId, serverId }) ? session : null;
  return {
    name: visibleSession ? getSessionName(visibleSession, serverId) : t('message.provenanceSession'),
    agentId: visibleSession ? readSessionPresentationAgentId(visibleSession) : null,
  };
}

export type TranscriptSessionReferenceIdentity = Readonly<{
  /** The live, readable title; null keeps the label the author saw (unknown, untitled or unreadable target). */
  title: string | null;
  agentId: string | null;
  /** Positive evidence the target is gone for this Home ({@link selectSessionReferenceTarget}). */
  deleted: boolean;
}>;

const NO_IDENTITIES: readonly TranscriptSessionReferenceIdentity[] = Object.freeze([]);
const NO_FACTS: readonly unknown[] = Object.freeze([]);

/**
 * The same identity for a message's inline `@Session` chips, in input order, through one store
 * subscription that projects only these targets to primitives (title, Agent, deleted). A stream
 * on another Session, or a turn on these, leaves every value unchanged, so the message does not render.
 */
export function useTranscriptSessionReferenceIdentities(
  sessionIds: readonly string[],
  serverId: string | null | undefined,
): readonly TranscriptSessionReferenceIdentity[] {
  const enabled = sessionIds.length > 0;
  const activeServerId = useActiveServerSnapshot(enabled && !serverId?.trim()).serverId;
  const isSessionVisible = useSessionRecordingVisibility(enabled);
  const facts = getStorage()(useShallow((state) => {
    if (!enabled) return NO_FACTS;
    const out: unknown[] = [];
    for (const sessionId of sessionIds) {
      const source = selectSessionDisplayNameSource(state, sessionId, serverId);
      const title = readableSessionDisplayTitle(source);
      out.push(
        title && !isUntitledSessionName(title) ? title : null,
        source ? readSessionPresentationAgentId(source) : null,
        selectSessionReferenceTarget(state, sessionId, serverId, activeServerId).deleted,
      );
    }
    return out;
  }));
  return React.useMemo(() => {
    if (facts.length === 0) return NO_IDENTITIES;
    return sessionIds.map((sessionId, index): TranscriptSessionReferenceIdentity => {
      const deleted = facts[index * 3 + 2] === true;
      if (!isSessionVisible({ sessionId, serverId })) return { title: t('message.provenanceSession'), agentId: null, deleted };
      return { title: facts[index * 3] as string | null, agentId: facts[index * 3 + 1] as string | null, deleted };
    });
  }, [facts, isSessionVisible, serverId, sessionIds]);
}
