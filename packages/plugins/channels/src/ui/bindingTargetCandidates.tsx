import * as React from 'react';
import { Button, List, Stack, Text, type ListSectionData } from '@happier-dev/plugin-ui';
import type { Translate } from './conversationRows.js';
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
