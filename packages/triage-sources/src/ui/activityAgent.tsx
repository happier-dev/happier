import * as React from 'react';

import type { TriageActivityEventV1 } from './activityTimeline.js';
import { resolveTriageCrossCopyContext } from './crossCopyContext.js';

/**
 * The Triage target's half of an entry's Activity (lab c7 "merged-activity"): what its linked Session did, as
 * events in the same stream as the source's own, and the stream's last word (the live agent card and "Next:").
 *
 * The source keeps its reads and its composer; Triage owns the Session facts. Neither re-reads the other: the
 * target hands over what it already holds, and the one Activity owner orders and draws both.
 */
export type TriageActivityAgentV1 = Readonly<{
  events: readonly TriageActivityEventV1[];
  /** After the last event and before the source's composer: the live agent card, then what happens next. */
  tail: React.ReactNode;
  /**
   * Bumped once each time the person refreshes the page (its one refresh control). The Activity re-reads its
   * source once per bump through the source's own re-read; it never polls and draws no refresh of its own.
   */
  refreshGeneration?: number;
}>;

const NO_AGENT: TriageActivityAgentV1 = Object.freeze({
  events: Object.freeze([]),
  tail: null,
});

/** The target installing this and the source detail reading it are separate plugin artifacts; see `crossCopyContext.ts`. */
const TRIAGE_ACTIVITY_AGENT_CONTEXT_KEY = Symbol.for(
  'happier.triageSources.privateActivityAgentContext.v1',
);

const TriageActivityAgentContext =
  resolveTriageCrossCopyContext<TriageActivityAgentV1>(
    TRIAGE_ACTIVITY_AGENT_CONTEXT_KEY,
    NO_AGENT,
  );

export function TriageActivityAgentProvider(
  props: Readonly<{
    value: TriageActivityAgentV1;
    children: React.ReactNode;
  }>,
): React.ReactElement {
  return (
    <TriageActivityAgentContext.Provider value={props.value}>
      {props.children}
    </TriageActivityAgentContext.Provider>
  );
}

export function useTriageActivityAgent(): TriageActivityAgentV1 {
  return React.useContext(TriageActivityAgentContext);
}

/**
 * The agent tail on its own, for a source whose Activity is not a `TriageActivityTimeline` (a comments-only list):
 * place it after the last remark and before the comment box, as the timeline does.
 */
export function TriageActivityAgentTail(): React.ReactElement | null {
  const { tail } = useTriageActivityAgent();
  return tail === null || tail === undefined ? null : <>{tail}</>;
}
