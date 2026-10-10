import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { getStorage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';
import type { SessionListRowStateByServerId } from '@/sync/domains/session/listing/sessionListRowStateLookup';

import { selectSessionRelationRecords } from './reportSubtree';

/** A lead above a Session in the `reportsTo` tree (ORC §3.1), named as this device can name it. */
export type SessionLineageAncestor = Readonly<{
  sessionId: string;
  title: string;
}>;

/** The immediate lead, worded identically in headers, breadcrumbs and peeks. */
export function describeSessionLineage(lineage: readonly SessionLineageAncestor[]): string | null {
  const lead = lineage[lineage.length - 1];
  return lead ? t('sessionWork.peek.reportsTo', { lead: lead.title }) : null;
}

/**
 * The leads above a Session, root first, through `reportsTo` on the same Home (lab `session-E`: the
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
  const ancestors: SessionLineageAncestor[] = [];
  const visited = new Set([sessionId]);
  let leadId = records[sessionId]?.reportsTo?.sessionId ?? null;
  while (leadId && !visited.has(leadId)) {
    const lead = records[leadId];
    if (!lead) break;
    visited.add(leadId);
    ancestors.unshift({ sessionId: leadId, title: getSessionName(lead) });
    leadId = lead.reportsTo?.sessionId ?? null;
  }
  return ancestors;
}

/**
 * The live lineage of a Session. The selector returns a flat id/title list so an unrelated store
 * update keeps the previous array (shallow equality) and the header does not re-render.
 */
export function useSessionLineage(
  sessionId: string,
  serverId: string | null,
): readonly SessionLineageAncestor[] {
  const flat = getStorage()(
    useShallow((state) =>
      readSessionLineage(state.sessions, sessionId, serverId, state.sessionListRowsByServerId).flatMap((ancestor) => [
        ancestor.sessionId,
        ancestor.title,
      ]),
    ),
  );
  return React.useMemo(() => {
    const ancestors: SessionLineageAncestor[] = [];
    for (let index = 0; index + 1 < flat.length; index += 2) {
      ancestors.push({ sessionId: flat[index]!, title: flat[index + 1]! });
    }
    return ancestors;
  }, [flat]);
}
