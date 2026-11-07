import * as React from 'react';

import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

import {
  useSessionInfoAddToFacts,
  type SessionInfoHeldSectionSummary,
} from './useSessionInfoAddToFacts';

/**
 * The parts of an Info section whose read is already held by the section's own mounted owner.
 * Habits is two reads (what starts here; what writes here, with scheduled work); Another machine is
 * the Workspace sync relationship list.
 */
export type SessionInfoSectionPart =
  | 'habits.startsHere'
  | 'habits.writesHere'
  | 'anotherMachine';

type Reporter = (
  part: SessionInfoSectionPart,
  summary: SessionInfoHeldSectionSummary | null,
) => void;

const SessionInfoSectionSummaryContext = React.createContext<Readonly<{ report: Reporter; sessionId: string }> | null>(
  null,
);

/** The Info body's reporter; sections outside Info report to nothing. */
export const SessionInfoSectionSummaryProvider =
  SessionInfoSectionSummaryContext.Provider;

/** Identity supplied by the containing Info host, without acquiring Session data. */
export function useSessionInfoSectionSummarySessionId(): string | null {
  return React.useContext(SessionInfoSectionSummaryContext)?.sessionId ?? null;
}

/**
 * A mounted section owner tells Info what its own read already holds (no extra read). Reported before
 * paint, so a section that turns out known empty folds without first drawing its empty state.
 */
export function useReportSessionInfoSectionSummary(
  part: SessionInfoSectionPart,
  summary: SessionInfoHeldSectionSummary | null,
): void {
  const report = React.useContext(SessionInfoSectionSummaryContext)?.report ?? null;
  const scope = summary?.scope ?? null;
  const sessionId = summary?.sessionId ?? null;
  const status = summary?.status ?? null;
  const coverage = summary?.coverage ?? null;
  const count = summary?.count ?? null;
  React.useLayoutEffect(() => {
    if (!report) return;
    report(
      part,
      scope && sessionId !== null && status && coverage && count !== null
        ? { scope, sessionId, status, coverage, count }
        : null,
    );
    return () => report(part, null);
  }, [report, part, scope, sessionId, status, coverage, count]);
}

function combineParts(
  parts: readonly (SessionInfoHeldSectionSummary | undefined)[],
): SessionInfoHeldSectionSummary | null {
  const first = parts[0];
  if (
    !first ||
    parts.some(
      (part) =>
        !part ||
        part.scope !== first.scope ||
        part.sessionId !== first.sessionId,
    )
  )
    return null;
  const held = parts as readonly SessionInfoHeldSectionSummary[];
  const notReady = held.find((part) => part.status !== 'ready');
  return {
    scope: first.scope,
    sessionId: first.sessionId,
    status: notReady ? notReady.status : 'ready',
    coverage: held.every((part) => part.coverage === 'complete')
      ? 'complete'
      : 'partial',
    count: held.reduce((sum, part) => sum + part.count, 0),
  };
}

/** The Info body's side: collects what its sections hold and reads the fold facts from it. */
export function useSessionInfoSectionSummaryHost(
  input: Readonly<{
    address: SessionAddress;
    scope: ServerAccountScope | null;
  }>,
) {
  const [held, setHeld] = React.useState<
    Partial<Record<SessionInfoSectionPart, SessionInfoHeldSectionSummary>>
  >({});
  const report = React.useCallback<Reporter>((part, summary) => {
    setHeld((current) => {
      if ((current[part] ?? null) === summary) return current;
      if (!summary) {
        if (!(part in current)) return current;
        const { [part]: _removed, ...rest } = current;
        return rest;
      }
      return { ...current, [part]: summary };
    });
  }, []);
  const facts = useSessionInfoAddToFacts({
    address: input.address,
    scope: input.scope,
    habits: combineParts([
      held['habits.startsHere'],
      held['habits.writesHere'],
    ]),
    anotherMachine: held.anotherMachine ?? null,
  });
  const host = React.useMemo(() => ({ report, sessionId: input.address.sessionId }), [input.address.sessionId, report]);
  return { host, facts };
}
