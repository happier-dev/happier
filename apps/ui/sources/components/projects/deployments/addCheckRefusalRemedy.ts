import type { PluginUiActionFailureV1 } from '@happier-dev/protocol/plugins/ui/client';
import { WorkflowValidationIssueV1Schema } from '@happier-dev/protocol/workflows/workflowValidationIssueV1';

/** The trigger write's refusal for a source that another saved trigger already watches from a different Machine. */
const WATCHER_ISSUE_PATH = '/trigger/observationTransport';

type SavedHealthSource = Readonly<{ automationId: string; triggerId: string }>;

function refusesWatcher(failure: PluginUiActionFailureV1): boolean {
  const details = failure.details;
  const issues =
    details !== null && typeof details === 'object'
      ? Reflect.get(details, 'issues')
      : undefined;
  return (
    Array.isArray(issues) &&
    issues.some((issue) => {
      const parsed = WorkflowValidationIssueV1Schema.safeParse(issue);
      return (
        parsed.success &&
        parsed.data.severity === 'error' &&
        parsed.data.path === WATCHER_ISSUE_PATH
      );
    })
  );
}

/**
 * Where "Edit the saved source to change its Machine" leads: the saved source that holds the other Machine, among the
 * Environment's saved health sources, other than the one this sheet is updating. None when the refusal is about
 * something else or no such source is known.
 */
export function readAddCheckRefusalRemedyTarget(
  failure: PluginUiActionFailureV1,
  sources: readonly SavedHealthSource[],
  updating: SavedHealthSource | null,
): SavedHealthSource | undefined {
  if (!refusesWatcher(failure)) return undefined;
  return sources.find(
    (source) =>
      updating === null ||
      source.automationId !== updating.automationId ||
      source.triggerId !== updating.triggerId,
  );
}
