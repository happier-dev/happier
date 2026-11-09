import * as React from 'react';
import { Button, List, Stack, Text, useExecutePluginAction, type ListSectionData } from '@happier-dev/plugin-ui';
import { isNonEmptyString, isRecord, type Translate } from './conversationRows.js';
import type { SessionCandidate, useDiscussionCandidatePages } from './useSessionCandidatePages.js';

/** Facts projected by the Workflow target-list owner, never inferred here. */
export type BindingCreateAutomationExecution = Readonly<{
  targetType: 'new_session' | 'existing_session' | 'execution_run' | null;
  enabled: boolean;
}>;
export type BindingCreateAutomationCandidate = Readonly<{
  automationId: string;
  label: string;
  execution: BindingCreateAutomationExecution;
}>;

type BindingCreateAutomationPage = Readonly<{
  candidates: readonly BindingCreateAutomationCandidate[];
  nextCursor?: string;
}>;

function parseBindingCreateAutomationExecution(value: unknown): BindingCreateAutomationExecution | undefined {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return undefined;
  if (value.targetType !== null
    && value.targetType !== 'new_session'
    && value.targetType !== 'existing_session'
    && value.targetType !== 'execution_run') {
    return undefined;
  }
  return { targetType: value.targetType, enabled: value.enabled };
}

function parseBindingCreateAutomationPage(value: unknown): BindingCreateAutomationPage | undefined {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 100) return undefined;
  if (value.nextCursor !== null && !isNonEmptyString(value.nextCursor)) return undefined;
  const seen = new Set<string>();
  const candidates: BindingCreateAutomationCandidate[] = [];
  for (const entry of value.items) {
    if (!isRecord(entry)
      || !isNonEmptyString(entry.automationId)
      || !isNonEmptyString(entry.label)
      || seen.has(entry.automationId)) {
      continue;
    }
    // The delegated-authority disclosure is part of the target contract, so a
    // candidate without it is not offered rather than shown without it.
    const execution = parseBindingCreateAutomationExecution(entry.execution);
    if (execution === undefined) continue;
    seen.add(entry.automationId);
    candidates.push({ automationId: entry.automationId, label: entry.label, execution });
  }
  return { candidates, ...(value.nextCursor === null ? {} : { nextCursor: value.nextCursor }) };
}

/** Create and retarget share one Workflow target acquisition and cursor owner. */
export function useBindingAutomationTargetPages(options: Readonly<{
  signal: AbortSignal;
  isLocked: () => boolean;
  onStarted: () => void;
  onUnavailable: () => void;
}>) {
  const action = useExecutePluginAction('automation.conversation.targets.list');
  const optionsRef = React.useRef(options);
  optionsRef.current = options;
  const mountedRef = React.useRef(true);
  const [candidates, setCandidates] = React.useState<readonly BindingCreateAutomationCandidate[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | undefined>();
  React.useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const execute = action.execute;
  const load = React.useCallback(async (cursor?: string) => {
    const current = optionsRef.current;
    if (current.isLocked() || current.signal.aborted) return;
    current.onStarted();
    const settled = await execute({ limit: 100, ...(cursor === undefined ? {} : { cursor }) });
    if (!mountedRef.current || current.signal.aborted) return;
    if (settled.status !== 'success') {
      current.onUnavailable();
      return;
    }
    const page = parseBindingCreateAutomationPage(settled.result);
    if (page === undefined || (cursor === undefined && page.candidates.length === 0)) {
      current.onUnavailable();
      return;
    }
    setCandidates(previous => {
      if (cursor === undefined) return page.candidates;
      const seen = new Set(previous.map(candidate => candidate.automationId));
      return [...previous, ...page.candidates.filter(candidate => {
        if (seen.has(candidate.automationId)) return false;
        seen.add(candidate.automationId);
        return true;
      })];
    });
    setNextCursor(page.nextCursor);
  }, [execute]);
  const reset = React.useCallback(() => { setCandidates([]); setNextCursor(undefined); }, []);
  return { candidates, nextCursor, load, reset, loading: action.execution.status === 'pending' };
}

/** Keep Workflow load controls and their cursor identical in both journeys. */
export function BindingAutomationTargetControls(props: Readonly<{
  pages: ReturnType<typeof useBindingAutomationTargetPages>;
  disabled: boolean;
  t: Translate;
}>): React.ReactElement {
  const { pages, t } = props;
  return <>
    {pages.candidates.length === 0 ? <Button
      title={t('plugins.channels.surface.bindingCreateAutomationLoad', 'Show Workflows')}
      variant="secondary"
      busy={pages.loading}
      disabled={props.disabled}
      onPress={() => { void pages.load(); }}
    /> : null}
    {pages.nextCursor === undefined ? null : <Button
      title={t('plugins.channels.surface.bindingCreateAutomationLoadMore', 'Show more Workflows')}
      variant="plain"
      busy={pages.loading}
      disabled={props.disabled}
      onPress={() => { void pages.load(pages.nextCursor); }}
    />}
  </>;
}

type TargetRow =
  | Readonly<{ kind: 'session' | 'discussion'; candidate: SessionCandidate }>
  | Readonly<{ kind: 'automation'; candidate: BindingCreateAutomationCandidate }>;

/** One virtualized collection for every paged binding target family. */
export function BindingTargetCandidateList(props: Readonly<{
  sessionCandidates: readonly SessionCandidate[];
  discussionCandidates: readonly SessionCandidate[];
  automationCandidates: readonly BindingCreateAutomationCandidate[];
  viewportHeight: number;
  disabled: boolean;
  onSession: (candidate: SessionCandidate) => void;
  onDiscussion: (candidate: SessionCandidate) => void;
  onAutomation: (candidate: BindingCreateAutomationCandidate) => void;
  t: Translate;
}>): React.ReactElement {
  const sections = React.useMemo<readonly ListSectionData<TargetRow>[]>(() => [
    { key: 'session', title: props.t('plugins.channels.surface.bindingCreateSession', 'Session'),
      data: props.sessionCandidates.map(candidate => ({ kind: 'session' as const, candidate })) },
    { key: 'discussion', title: props.t('plugins.channels.surface.bindingTargetDiscussion', 'Discussion'),
      data: props.discussionCandidates.map(candidate => ({ kind: 'discussion' as const, candidate })) },
    { key: 'automation', title: props.t('plugins.channels.surface.bindingCreateAutomation', 'Workflow'),
      data: props.automationCandidates.map(candidate => ({ kind: 'automation' as const, candidate })) },
  ], [props.automationCandidates, props.discussionCandidates, props.sessionCandidates, props.t]);
  const renderItem = React.useCallback((row: TargetRow) => (
    <List.Item
      testID={`channels-binding-target-${row.kind}:${row.kind === 'automation' ? row.candidate.automationId : row.candidate.id}`}
      title={row.candidate.label}
      disabled={props.disabled}
      onPress={() => {
        if (row.kind === 'automation') props.onAutomation(row.candidate);
        else if (row.kind === 'discussion') props.onDiscussion(row.candidate);
        else props.onSession(row.candidate);
      }}
    />
  ), [props.disabled, props.onAutomation, props.onDiscussion, props.onSession]);
  const targetSearchText = React.useCallback((row: TargetRow) => ({ label: row.candidate.label }), []);
  return (
    <List
      sections={sections}
      keyForItem={row => `${row.kind}:${row.kind === 'automation' ? row.candidate.automationId : row.candidate.id}`}
      renderItem={renderItem}
      search={{
        label: props.t('plugins.channels.surface.bindingCreateTargetSearch', 'Search loaded targets'),
        placeholder: props.t('plugins.channels.surface.bindingCreateTargetSearchPlaceholder', 'Search Sessions, Discussions and Workflows'),
        testID: 'channels-binding-target-search', text: targetSearchText,
      }}
      accessibilityLabel={props.t('plugins.channels.surface.bindingCreateTarget', 'Choose a target')}
      testID="channels-binding-target-candidates"
      style={{ height: props.viewportHeight }}
    />
  );
}

/** The same explicit load and recovery controls in create and retarget. */
export function BindingDiscussionTargetControls(props: Readonly<{
  pages: ReturnType<typeof useDiscussionCandidatePages>;
  disabled: boolean;
  t: Translate;
}>): React.ReactElement {
  const { pages, t } = props;
  return (
    <Stack gap="small">
      {pages.unavailable ? <Text tone="warning" value={t('plugins.channels.surface.bindingDiscussionUnavailable', 'Discussions could not be loaded. Try again.')} /> : null}
      {pages.incomplete ? <Text tone="secondary" value={t('plugins.channels.surface.bindingDiscussionIncomplete', 'Some Discussions could not be opened.')} /> : null}
      {pages.loaded && !pages.unavailable && !pages.incomplete && pages.candidates.length === 0 && pages.nextCursor === undefined
        ? <Text tone="secondary" value={t('plugins.channels.surface.bindingDiscussionEmpty', 'There are no active Discussions you can post to.')} /> : null}
      <Button
        variant="plain"
        title={pages.unavailable
          ? t('plugins.channels.surface.bindingDiscussionRetry', 'Retry Discussions')
          : pages.loaded
            ? t('plugins.channels.surface.bindingDiscussionReload', 'Reload Discussions')
            : t('plugins.channels.surface.bindingDiscussionLoad', 'Show Discussions')}
        busy={pages.loading}
        disabled={props.disabled}
        onPress={() => { void (pages.unavailable ? pages.retry() : pages.load()); }}
      />
      {pages.nextCursor === undefined ? null : <Button
        variant="plain"
        title={t('plugins.channels.surface.bindingDiscussionLoadMore', 'Show more Discussions')}
        busy={pages.loading}
        disabled={props.disabled}
        onPress={() => { void pages.load(pages.nextCursor); }}
      />}
    </Stack>
  );
}
