import type { OpenedSessionFollowRuleV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleOccurrenceV1';
import { readCliSessionListFilterFactsV1 } from '@/cli/output/session/sessionListFilterFacts';

/** One source snapshot's supplemental facts, shared by its ordered original pass. */
export function createSessionFollowSourceFactsRead(input: Omit<Parameters<typeof readCliSessionListFilterFactsV1>[0], 'filters' | 'nowMs'>) {
  let prepared: Readonly<{
    rules: readonly OpenedSessionFollowRuleV1[];
    result: ReturnType<typeof readCliSessionListFilterFactsV1>;
  }> | undefined;
  return (rules: readonly OpenedSessionFollowRuleV1[]) => {
    // The canonical rule owner preserves its admitted snapshot until a real
    // configuration change. Such a change prepares the newly required facts.
    if (prepared?.rules !== rules) prepared = { rules,
      result: readCliSessionListFilterFactsV1({ ...input, nowMs: Date.now(),
        filters: rules.filter(rule => rule.definition.enabled).map(rule => rule.definition.filter) }) };
    return prepared.result;
  };
}
