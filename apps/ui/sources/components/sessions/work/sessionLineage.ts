import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { getStorage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { sessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { t } from '@/text';
import { resolveSessionListHomeKey, type SessionListRowStateByServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';
import { EMPTY_SESSION_RELATION_FACTS } from '@/sync/store/domains/sessionRelations';

import { selectSessionRelationRecords, readSessionRelationFacts, readSessionRelationRecord, selectSessionAncestorIds } from './reportSubtree';
import { readSessionPresentationInputDisplay } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';

/** A lead above a Session in the `manager` tree (ORC §3.1), named as this device can name it. */
export type SessionLineageAncestor = Readonly<{
  sessionId: string;
  title: string;
}>;

/** The immediate lead, worded identically in headers, breadcrumbs and peeks. */
export function describeSessionLineage(lineage: readonly SessionLineageAncestor[]): string | null {
  const lead = lineage[lineage.length - 1];
  return lead ? t('sessionWork.peek.manager', { lead: lead.title }) : null;
}

/**
 * The leads above a Session, root first, through `manager` on the same Home (lab `session-E`: the
 * breadcrumb and "Reports to"). Qualified list rows name unopened leads through the same relation
 * owner as Work. The walk ends at an unavailable lead; a transient cycle stops at its first repeat.
 */
export function readSessionLineage(
  sessions: Readonly<Record<string, Session>>,
  sessionId: string,
  serverId: string | null,
  rowsByServerId?: SessionListRowStateByServerId,
): SessionLineageAncestor[] {
  const records = selectSessionRelationRecords(sessions, serverId, rowsByServerId);
  return selectSessionAncestorIds(readSessionRelationFacts(records), sessionId).map(id => ({
    sessionId: id,
    title: sessionDisplayTitle(readSessionPresentationInputDisplay(records[id]!), serverId),
  }));
}

/**
 * The live lineage of a Session. Subscribe to the admitted relationship inputs before walking them,
 * so message/settings publications and another Home's list changes do no inventory work.
 */
export function useSessionLineage(
  sessionId: string,
  serverId: string | null,
): readonly SessionLineageAncestor[] {
  const relations = getStorage()((state) => {
    const key = resolveSessionListHomeKey(state.sessionRelationsByServerId, serverId);
    return key ? state.sessionRelationsByServerId[key] ?? EMPTY_SESSION_RELATION_FACTS : EMPTY_SESSION_RELATION_FACTS;
  });
  const ancestorIds = React.useMemo(() => selectSessionAncestorIds(relations, sessionId), [relations, sessionId]);
  // Titles may also use the display target or localized fallback. Keep that narrow read live
  // over the selected ancestor chain without rebuilding the relationship inventory.
  const flat = getStorage()(useShallow((state) => ancestorIds.flatMap(id => {
    const input = readSessionRelationRecord(state.sessions, id, serverId, state.sessionListRowsByServerId);
    return input ? [id, sessionDisplayTitle(readSessionPresentationInputDisplay(input), serverId)] : [];
  })));
  return React.useMemo(() => {
    const ancestors: SessionLineageAncestor[] = [];
    for (let index = 0; index + 1 < flat.length; index += 2) {
      ancestors.push({ sessionId: flat[index]!, title: flat[index + 1]! });
    }
    return ancestors;
  }, [flat]);
}
