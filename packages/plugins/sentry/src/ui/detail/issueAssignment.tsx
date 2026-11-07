import * as React from 'react';
import type { PluginUiActionControlExecution } from '@happier-dev/plugin-sdk/ui';
import { Button, PropertyList, Row, Stack, Text, useExecutePluginAction, usePluginTranslation, useTabPanelActivity } from '@happier-dev/plugin-ui';
import { useTriageDetailRequest, type TriageSourceWriteSettlementV1 } from '@happier-dev/triage-sources/ui';
import type { TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';
import { SentryReadIssueResultV1Schema } from '../../detail/detailContracts.js';
import type { SentryAssigneeV1, SentryIssueAssignmentProjectionV1 } from '../../detail/assignment.js';
import { SENTRY_ACTION_IDS, SENTRY_PLUGIN_ID } from '../../sentryContracts.js';

/** Assignment choices live only while this source's changes section is consumed. */
export function SentryIssueAssignment({ input, current, held, settle }: Readonly<{
  input: TriageDetailSurfaceInputV1;
  current: SentryAssigneeV1 | null | undefined;
  held: boolean;
  settle: (id: string, execution: PluginUiActionControlExecution) => TriageSourceWriteSettlementV1 | null;
}>): React.ReactElement {
  const text = usePluginTranslation();
  const request = useTriageDetailRequest(input);
  const { active, activeSignal } = useTabPanelActivity();
  const readAction = React.useMemo(() => ({ pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_ACTION_IDS.readIssue }), []);
  const assignAction = React.useMemo(() => ({ pluginId: SENTRY_PLUGIN_ID, localId: SENTRY_ACTION_IDS.assign }), []);
  const { execute: read } = useExecutePluginAction(readAction);
  const { execute: assign } = useExecutePluginAction(assignAction);
  const [revision, refresh] = React.useReducer(value => value + 1, 0);
  const [result, setResult] = React.useState<SentryIssueAssignmentProjectionV1 | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    if (!active || activeSignal.aborted) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    activeSignal.addEventListener('abort', abort);
    setLoading(true);
    void (async () => {
      try {
        const execution = await read({ v: 1, ...request, projection: 'assignment' }, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const parsed = execution.status === 'success' ? SentryReadIssueResultV1Schema.safeParse(execution.result) : null;
        if (parsed?.success && parsed.data.kind === 'assignment') {
          setResult(parsed.data);
          setFailed(parsed.data.failure !== undefined || parsed.data.omittedCandidateCount > 0);
        } else setFailed(true);
      } catch { if (!controller.signal.aborted) setFailed(true); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    })();
    return () => { controller.abort(); activeSignal.removeEventListener('abort', abort); };
  }, [active, activeSignal, read, request, revision]);

  const assignee = result === null ? current : result.assignee;
  const candidates = result?.candidates ?? [];
  const known = assignee == null ? assignee : candidates.find(candidate => candidate.type === assignee.type && candidate.id === assignee.id) ?? assignee;
  const unassigned = text('plugins.sentry.ui.assignment.unassigned', 'Unassigned');
  // A removed person remains the checked current value; only directory candidates can be assigned.
  const displayed = known != null && !candidates.some(candidate => candidate.type === known.type && candidate.id === known.id)
    ? [known, ...candidates] : candidates;
  const choices = displayed.flatMap(candidate => candidate.name === undefined ? [] : [{
    id: `${candidate.type}:${candidate.id}`, label: candidate.name,
    subtitle: candidate.type === 'user' ? text('plugins.sentry.ui.assignment.member', 'Member')
      : candidate.memberCount === undefined ? text('plugins.sentry.ui.assignment.team', 'Team')
        : text('plugins.sentry.ui.assignment.teamCount', 'Team · {count} people', { count: candidate.memberCount }),
  }]);
  return <Stack gap="small">
    {known === undefined || (known !== null && known.name === undefined) ? null : <PropertyList disabled={held || loading || failed || candidates.length === 0} items={[{
      id: 'assignee', label: text('plugins.sentry.ui.assignment.label', 'Assignee'),
      value: known === null ? unassigned : known.name!, clearLabel: unassigned,
      editor: { kind: 'choice', searchable: true, value: assignee === null ? null : `${assignee!.type}:${assignee!.id}`, choices,
        onCommit: async next => {
          if (held || loading || failed) return;
          const selected = next === null ? null : candidates.find(candidate => `${candidate.type}:${candidate.id}` === next);
          if (selected === undefined) return;
          const execution = await assign({ v: 1, ...request, assignee: selected === null ? null : { type: selected.type, id: selected.id } });
          if (activeSignal.aborted) return;
          const outcome = execution.status === 'success'
            ? settle('assignment', { ok: true, result: execution.result })
            : execution.status === 'error' || execution.status === 'outcomeUnknown'
              ? settle('assignment', { ok: false, errorCode: execution.code, error: execution.message,
                ...(execution.status === 'outcomeUnknown' ? { effectAttempted: true } : {}) }) : null;
          if (outcome?.kind === 'applied' || outcome?.kind === 'uncertain') refresh();
          // The group renders the outcome once and owns any uncertain hold.
          return undefined;
        } },
    }]} />}
    {loading ? <Text variant="meta" tone="secondary">{text('plugins.sentry.ui.assignment.loading', 'Loading people…')}</Text>
      : failed ? <Row gap="small"><Text variant="meta">{text('plugins.sentry.ui.assignment.failed', 'Could not load people.')}</Text>
        <Button variant="plain" title={text('plugins.sentry.ui.assignment.retry', 'Retry')} onPress={refresh} /></Row>
        : candidates.length === 0 ? <Text variant="meta" tone="secondary">{text('plugins.sentry.ui.assignment.empty', 'No one to assign in {project}', { project: result?.projectName ?? input.observation.snapshot.scopeLabel })}</Text> : null}
  </Stack>;
}
