import * as React from 'react';

import type { IconName } from '@/components/ui/icons/Icon';
import { resolveExecutionRunTitle } from '@/components/sessions/runs/resolveExecutionRunTitle';
import { useExecutionRunHeaders } from '@/hooks/session/useExecutionRunHeaders';
import { TRIGGER_LIFECYCLE_GLYPHS } from '@/components/workflows/triggers/triggerEventGroups';
import { formatWorkflowRunStateLabel } from '@/components/workflows/run/workflowRunDetailPresentation';
import {
  formatWorkflowRunDisplayName,
  resolveWorkflowRunDisplayName,
} from '@/components/workflows/presentation/workflowRunDisplayName';
import {
  useActiveServerAccountScopeLifetime,
  useServerScopedMachineLabel,
  useSessionListRowSelector,
  useWorkflowRun,
} from '@/sync/store/hooks';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ExecutionRunHeaderReference } from '@/sync/runtime/executionRuns/executionRunHeaderReads';
import type { WorkflowActivityFact } from '@/sync/domains/workflows/workflowActivityTypes';
import type { WorkflowActivityProjection } from '@/sync/engine/workflows/workflowActivityProjection';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { readWorkflowEventStartedRuns } from './workflowEventFacts';
import { createMachineExecutionRunRoute, createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { formatSessionPath } from '@/utils/sessions/formatPathRelativeToHome';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { t } from '@/text';

export type WorkflowEventFactLine = Readonly<{
  key: string;
  label: string;
  value: string;
  mono?: boolean;
}>;

/** How one observed fact reads: its sentence title, the thing it is about, its mark, and what it carries. */
export type WorkflowEventPresentation = Readonly<{
  fact: WorkflowActivityFact;
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
const NO_EXECUTION_RUN_HEADERS: readonly ExecutionRunHeaderReference[] = Object.freeze([]);

/** One row's fact, subscribed by its own key: a new event elsewhere re-renders only the key list. */
export function useWorkflowEventFact(
  projection: WorkflowActivityProjection,
  key: string | null,
): WorkflowActivityFact | undefined {
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
  fact: WorkflowActivityFact | undefined,
  scope: ServerAccountScope | null,
  retainedRuns?: readonly WorkflowRunSummaryV1[],
  active = false,
): WorkflowEventPresentation | null {
  const lifetime = useActiveServerAccountScopeLifetime();
  const serverId = scope?.serverId ?? null;
  const executionSource = fact?.coverage === 'retained_cause' && fact.evidence.source.kind === 'execution_run' ? fact.evidence.source : null;
  // A retained native cause is about its Session and Machine: the row names them, as a live Session event does.
  const sessionId = fact?.kind === 'session' ? fact.sessionId : executionSource?.sessionId ?? '';
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
    fact?.kind === 'machine' ? fact.machineId : executionSource?.machineId ?? sessionMachineId,
  );
  const executionReferences = React.useMemo(() => executionSource === null ? NO_EXECUTION_RUN_HEADERS : [{
    source: executionSource, demanded: active, refreshKey: String(fact?.sourceRevision),
  }], [executionSource, active, fact?.sourceRevision]);
  const executionHeaders = useExecutionRunHeaders(
    executionSource !== null && areServerAccountScopesEqual(scope, lifetime?.scope) ? lifetime : null,
    executionReferences,
  );
  const executionTitle = executionSource === null ? null
    : resolveExecutionRunTitle(executionHeaders.owner?.read(executionSource).run ?? {});
  const run = useWorkflowRun(fact?.kind === 'run' && executionSource === null ? fact.runId : null, {
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
        // Like a Session event, the title says what happened and the line under it which Machine: a long,
        // disambiguated Machine name ("NLDW3-5-36-33 · e8ba") must never truncate the "came online" away.
        return {
          fact,
          runsStarted,
          glyph: 'desktop',
          needsYou: false,
          subtitle: machineName,
          title: t(
            fact.event === 'online'
              ? 'workflows.events.machineOnline'
              : 'workflows.events.machineOffline',
            { machine: t('workflows.events.someMachine') },
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
        const workflow = executionSource === null ? workflowName ?? t('workflows.events.someWorkflow') : executionTitle!;
        const result = fact.coverage === 'live' ? formatWorkflowRunStateLabel(fact.state) : null;
        // What the row is about after the title: how the Run ended, else where a retained native cause ran.
        const subtitle = result ?? (executionSource === null ? null : joinHappierFacts(sessionName, machineName) || null);
        const href = executionSource === null ? createWorkflowRunRoute(fact.runId, serverId)
          : createMachineExecutionRunRoute(serverId ?? '', executionSource.machineId, executionSource.runId);
        return {
          fact,
          runsStarted,
          glyph: 'tree-structure',
          needsYou: fact.event === 'needs_attention',
          subtitle,
          title: t(
            fact.event === 'needs_attention'
              ? 'workflows.events.runNeedsYou'
              : 'workflows.events.runFinished',
            { workflow },
          ),
          lines: [
            {
              key: 'workflow',
              label: executionSource === null ? t('workflows.events.workflow') : t('runPage.menu.run'),
              value: workflow,
            },
            ...(result === null ? [] : [{
              key: 'result',
              label: t('workflows.events.result'),
              value: result,
            }]),
          ],
          open: href === null ? null : { label: t('workflows.events.openRun'), href },
        };
      }
    }
  }, [fact, executionSource, machineName, sessionName, sessionPath, workflowName, executionTitle, serverId, retainedRuns]);
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
