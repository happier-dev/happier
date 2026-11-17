import * as React from 'react';

import type { IconName } from '@/components/ui/icons/Icon';
import { TRIGGER_LIFECYCLE_GLYPHS } from '@/components/workflows/triggers/triggerEventGroups';
import { formatWorkflowRunStateLabel } from '@/components/workflows/run/workflowRunDetailPresentation';
import {
  formatWorkflowRunDisplayName,
  resolveWorkflowRunDisplayName,
} from '@/components/workflows/presentation/workflowRunDisplayName';
import {
  useServerScopedMachineLabel,
  useSessionListRowSelector,
  useWorkflowRun,
} from '@/sync/store/hooks';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { WorkflowActivityLiveFact } from '@/sync/domains/workflows/workflowActivityTypes';
import type { WorkflowActivityProjection } from '@/sync/engine/workflows/workflowActivityProjection';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { readWorkflowEventStartedRuns } from './workflowEventFacts';
import { createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { formatSessionPath } from '@/utils/sessions/formatPathRelativeToHome';
import { t } from '@/text';

export type WorkflowEventFactLine = Readonly<{
  key: string;
  label: string;
  value: string;
  mono?: boolean;
}>;

/** How one observed fact reads: its sentence title, the thing it is about, its mark, and what it carries. */
export type WorkflowEventPresentation = Readonly<{
  fact: WorkflowActivityLiveFact;
  title: string;
  subtitle: string | null;
  glyph: IconName;
  needsYou: boolean;
  lines: readonly WorkflowEventFactLine[];
  open: Readonly<{ label: string; href: string }> | null;
  /** Exact immutable causes from the retained page; names stay with the Run label owner. */
  runsStarted: readonly WorkflowRunSummaryV1[];
}>;

const NO_RUNS: readonly WorkflowRunSummaryV1[] = Object.freeze([]);

/** One row's fact, subscribed by its own key: a new event elsewhere re-renders only the key list. */
export function useWorkflowEventFact(
  projection: WorkflowActivityProjection,
  key: string | null,
): WorkflowActivityLiveFact | undefined {
  const subscribe = React.useCallback(
    (listener: () => void) =>
      key === null ? () => {} : projection.subscribeRow(key, listener),
    [projection, key],
  );
  const read = React.useCallback(
    () => (key === null ? undefined : projection.getRow(key)),
    [projection, key],
  );
  return React.useSyncExternalStore(subscribe, read, read);
}

/**
 * Names resolve at the leaf through the canonical selectors (Session list row, Machine label, Run row), so the
 * shared feed stays a list of facts and each row re-renders only for its own subject.
 */
export function useWorkflowEventPresentation(
  fact: WorkflowActivityLiveFact | undefined,
  scope: ServerAccountScope | null,
  retainedRuns?: readonly WorkflowRunSummaryV1[],
): WorkflowEventPresentation | null {
  const serverId = scope?.serverId ?? null;
  const sessionId = fact?.kind === 'session' ? fact.sessionId : '';
  const selectName = React.useCallback(
    (row: SessionListRenderableSession | null) =>
      row === null ? null : getSessionName(row, serverId),
    [serverId],
  );
  const sessionName = useSessionListRowSelector(
    serverId,
    sessionId,
    selectName,
  );
  const sessionMachineId = useSessionListRowSelector(
    serverId,
    sessionId,
    readSessionMachineId,
  );
  const sessionPath = useSessionListRowSelector(
    serverId,
    sessionId,
    readSessionPath,
  );
  const machineName = useServerScopedMachineLabel(
    serverId,
    fact?.kind === 'machine' ? fact.machineId : sessionMachineId,
  );
  const run = useWorkflowRun(fact?.kind === 'run' ? fact.runId : null, {
    scope,
  });
  const workflowName =
    run === null
      ? null
      : formatWorkflowRunDisplayName(
          resolveWorkflowRunDisplayName(run.metadata),
        );
  return React.useMemo((): WorkflowEventPresentation | null => {
    if (fact === undefined) return null;
    const runsStarted = retainedRuns === undefined ? NO_RUNS : readWorkflowEventStartedRuns(fact, retainedRuns);
    switch (fact.kind) {
      case 'session': {
        const glyph =
          fact.event === 'started'
            ? TRIGGER_LIFECYCLE_GLYPHS.sessionStarts
            : fact.event === 'turn_started'
              ? TRIGGER_LIFECYCLE_GLYPHS.turnStarts
              : TRIGGER_LIFECYCLE_GLYPHS.sessionArchived;
        const lines: WorkflowEventFactLine[] = [];
        if (sessionName !== null)
          lines.push({
            key: 'session',
            label: t('workflows.events.session'),
            value: sessionName,
          });
        if (machineName !== null)
          lines.push({
            key: 'machine',
            label: t('workflows.events.machine'),
            value: machineName,
          });
        if (sessionPath)
          lines.push({
            key: 'folder',
            label: t('workflows.events.folder'),
            value: formatSessionPath(sessionPath),
            mono: true,
          });
        return {
          fact,
          runsStarted,
          glyph,
          needsYou: false,
          subtitle: sessionName,
          lines,
          title: t(
            fact.event === 'started'
              ? 'workflows.events.sessionStarted'
              : fact.event === 'turn_started'
                ? 'workflows.events.turnStarted'
                : 'workflows.events.sessionArchived',
          ),
          open: {
            label: t('workflows.events.openSession'),
            href: `/session/${encodeURIComponent(fact.sessionId)}`,
          },
        };
      }
      case 'machine': {
        const machine = machineName ?? t('workflows.events.someMachine');
        return {
          fact,
          runsStarted,
          glyph: 'desktop',
          needsYou: false,
          subtitle: null,
          title: t(
            fact.event === 'online'
              ? 'workflows.events.machineOnline'
              : 'workflows.events.machineOffline',
            { machine },
          ),
          lines: [
            {
              key: 'machine',
              label: t('workflows.events.machine'),
              value: machine,
            },
          ],
          open: null,
        };
      }
      case 'run': {
        const workflow = workflowName ?? t('workflows.events.someWorkflow');
        const result = formatWorkflowRunStateLabel(fact.state);
        return {
          fact,
          runsStarted,
          glyph: 'tree-structure',
          needsYou: fact.event === 'needs_attention',
          subtitle: result,
          title: t(
            fact.event === 'needs_attention'
              ? 'workflows.events.runNeedsYou'
              : 'workflows.events.runFinished',
            { workflow },
          ),
          lines: [
            {
              key: 'workflow',
              label: t('workflows.events.workflow'),
              value: workflow,
            },
            {
              key: 'result',
              label: t('workflows.events.result'),
              value: result,
            },
          ],
          open: {
            label: t('workflows.events.openRun'),
            href: createWorkflowRunRoute(fact.runId, serverId),
          },
        };
      }
    }
  }, [fact, machineName, sessionName, sessionPath, workflowName, serverId, retainedRuns]);
}

function readSessionMachineId(
  row: SessionListRenderableSession | null,
): string | null {
  return row?.metadata?.machineId ?? null;
}

function readSessionPath(
  row: SessionListRenderableSession | null,
): string | null {
  return row?.metadata?.path ?? null;
}
