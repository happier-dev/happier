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
  useServerScopedMachineLabelState,
  useSessionListRowSelector,
  useWorkflowRun,
} from '@/sync/store/hooks';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ExecutionRunHeaderReference } from '@/sync/runtime/executionRuns/executionRunHeaderReads';
import type { WorkflowActivityFact } from '@/sync/domains/workflows/workflowActivityTypes';
import type { WorkflowActivityProjection } from '@/sync/engine/workflows/workflowActivityProjection';
import type { WorkflowRunSummaryV1 } from '@happier-dev/protocol/workflows/workflowProgressV1';
import { formatWorkflowMachineEventTitle, readWorkflowEventStartedRuns } from './workflowEventFacts';
import { createMachineExecutionRunRoute, createWorkflowRunRoute } from '@/sync/domains/workflows/workflowRunRoute';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { readSessionRowPresentationAgentId as readSessionRowAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { formatSessionPath } from '@/utils/sessions/formatPathRelativeToHome';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { t } from '@/text';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

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
  /** The Agent whose mark stands for a Session event (lab `events:A`), drawn in place of the glyph; null when unknown. */
  agentId: string | null;
  /**
   * A list row's title in two parts when the sentence names a long subject: the row titles the subject and its line
   * leads with the verb ("NLDW3-5-36-33 · 9eee" / "went offline · 8:08 PM"). The page header keeps the whole sentence.
   */
  rowTitle: Readonly<{ subject: string; verb: string }> | null;
  needsYou: boolean;
  sessionMachineId?: string | null;
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
  const sessionAgentId = useSessionListRowSelector(
    serverId,
    sessionId,
    readSessionRowPresentationAgentId,
  );
  const machineLabel = useServerScopedMachineLabelState(
    serverId,
    fact?.kind === 'machine' ? fact.machineId : executionSource?.machineId ?? sessionMachineId,
  );
  const machineName = machineLabel ?? null;
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
        const glyph = readSessionEventGlyph(fact.event);
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
            value: sessionPath,
            mono: true,
          });
        // The Agent names what its turn did ("Claude finished a turn", "Codex needs you"), as a Machine names its own
        // event (M5); with its Agent unknown the sentence says "An agent".
        const agent = sessionAgentId === null ? t('workflows.events.someAgent') : resolveAgentCatalogTitle(sessionAgentId);
        return {
          fact,
          runsStarted,
          glyph,
          agentId: sessionAgentId,
          rowTitle: null,
          needsYou: fact.event === 'userActionRequired',
          sessionMachineId,
          subtitle: sessionName,
          lines,
          title: formatSessionEventTitle(fact.event, agent),
          open: {
            label: t('workflows.events.openSession'),
            href: `/session/${encodeURIComponent(fact.sessionId)}`,
          },
        };
      }
      case 'machine': {
        if (machineLabel === undefined) return null;
        const machine = machineName ?? t('workflows.events.someMachine');
        return {
          fact,
          runsStarted,
          // Online and offline read apart at a glance, not only by their verb.
          glyph: fact.event === 'online' ? 'desktop' : 'cloud-slash',
          agentId: null,
          rowTitle: machineName === null ? null : {
            subject: machineName,
            verb: t(fact.event === 'online' ? 'workflows.events.cameOnline' : 'workflows.events.wentOffline'),
          },
          needsYou: false,
          subtitle: formatAsOfTime(fact.occurredAt),
          title: formatWorkflowMachineEventTitle(fact, machineName),
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
        const result = fact.coverage === 'retained_cause' ? null : formatWorkflowRunStateLabel(fact.state);
        // The row is named by its workflow (lab events-A, "Nightly dependency check"); the line under it says how it
        // ended, or that it needs you, and where a retained native cause ran. A long name truncates; the outcome never does (F3).
        const outcome = result ?? t(fact.event === 'needs_attention' ? 'workflows.events.needsYouLine' : 'workflows.events.finishedLine');
        const subtitle = joinHappierFacts(outcome,
          executionSource === null ? null : joinHappierFacts(sessionName, machineName) || null) || null;
        const href = executionSource === null ? createWorkflowRunRoute(fact.runId, serverId)
          : createMachineExecutionRunRoute(serverId ?? '', executionSource.machineId, executionSource.runId);
        return {
          fact,
          runsStarted,
          glyph: 'tree-structure',
          agentId: null,
          rowTitle: null,
          needsYou: fact.event === 'needs_attention',
          subtitle,
          title: workflow,
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
  }, [fact, executionSource, machineLabel, machineName, sessionName, sessionMachineId, sessionPath, sessionAgentId, workflowName, executionTitle, serverId, retainedRuns]);
}

type SessionEvent = Extract<WorkflowActivityFact, { kind: 'session' }>['event'];

function readSessionEventGlyph(event: SessionEvent): IconName {
  switch (event) {
    case 'started': return TRIGGER_LIFECYCLE_GLYPHS.sessionStarts;
    case 'archived': return TRIGGER_LIFECYCLE_GLYPHS.sessionArchived;
    case 'userActionRequired': return TRIGGER_LIFECYCLE_GLYPHS.needsYou;
    case 'parentTurnStarted': return TRIGGER_LIFECYCLE_GLYPHS.turnStarts;
    default: return TRIGGER_LIFECYCLE_GLYPHS.turnEnds;
  }
}

/** One sentence per Session event, led by its Agent where a turn is concerned (lab events:A). */
function formatSessionEventTitle(event: SessionEvent, agent: string): string {
  switch (event) {
    case 'started': return t('workflows.events.sessionStarted');
    case 'archived': return t('workflows.events.sessionArchived');
    case 'userActionRequired': return t('workflows.events.agentNeedsYou', { agent });
    case 'parentTurnStarted': return t('workflows.events.agentTurnStarted', { agent });
    case 'parentTurnCompleted': return t('workflows.events.agentTurnFinished', { agent });
    case 'parentTurnFailed': return t('workflows.events.agentTurnFailed', { agent });
    case 'parentTurnCancelled': return t('workflows.events.agentTurnStopped', { agent });
  }
}

function readSessionRowPresentationAgentId(row: SessionListRenderableSession | null): string | null {
  return row === null ? null : readSessionRowAgentId(row);
}

function readSessionMachineId(
  row: SessionListRenderableSession | null,
): string | null {
  return row?.metadata?.machineId ?? null;
}

/** The Session's folder as every Session row says it: home-relative on its own Machine's home (F9c). */
function readSessionPath(
  row: SessionListRenderableSession | null,
): string | null {
  const path = row?.metadata?.path;
  return path ? formatSessionPath(path, row?.metadata?.homeDir ?? undefined) : null;
}
