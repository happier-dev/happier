import * as React from 'react';

import type { View } from 'react-native';
import type { PromptArtifactRefV1, PromptDocArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { describeProjectSourceRow } from '@/components/projects/sources/projectSourceAddress';
import { presentProjectSourceIssue } from '@/components/projects/sources/projectSourceIssue';
import { PROJECT_SOURCES_ROUTE, projectSourceRoute } from '@/components/projects/sources/projectSourceNavigation';
import { PromptStackDocumentMenu } from '@/components/settings/prompts/stacks/PromptStackDocumentMenu';
import {
  promptStackEntryHref,
  promptStackEntryTitle,
  usePromptStackEntryPresentations,
} from '@/components/settings/prompts/stacks/promptStackEntryPresentation';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { usePrivateAttachedDocumentShareOffer } from '@/components/sharing/documents/usePrivateAttachedDocumentShareOffer';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { readCurrentServerCredentialAccountScopeLifetime } from '@/sync/domains/scope/serverCredentialAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';

import type { TeamSectionContext } from '../teamSectionContext';
import { mayAuthorNewMembersSetup } from './newMembersAuthoring';
import { useTeamSetupAuthoringReferences } from './useTeamSetupAuthoringReferences';

export type TeamNewMembersSourceRows = ReturnType<typeof useTeamSetupAuthoringReferences>['rows'];
type SetSuggestedTask = ReturnType<typeof useTeamSetupAuthoringReferences>['setSuggestedTask'];

/**
 * L5's Source-backed sections: the repositories shared with this Team and the first task attached
 * to one of them. Both read the one Source owner through `useTeamSetupAuthoringReferences`; prompt
 * bodies are never read here, only the attached reference.
 */
export function TeamNewMembersSources(
  props: Readonly<{ context: TeamSectionContext; keys?: React.ReactNode }>,
) {
  const { scope, team } = props.context;
  const { binding, resolution } = useServerCredentialAccountScopeBinding(
    scope.serverId,
  );
  const owner = binding ?? (resolution.kind === 'resolving'
    ? readCurrentServerCredentialAccountScopeLifetime(scope.serverId) : null);
  const lifetime =
    owner?.isCurrent() && areServerAccountScopesEqual(owner.scope, scope)
      ? owner
      : null;
  const references = useTeamSetupAuthoringReferences(scope, team.id, {
    enabled: lifetime !== null && lifetime === binding,
    lifetime,
  });
  const { rows, controller, setSuggestedTask } = references;
  const status = references.state.status;
  const retry = React.useCallback(() => controller.load(), [controller]);
  const settled = references.state.hasLoaded || rows.length > 0;
  const loading =
    !settled &&
    (resolution.kind === 'resolving' ||
      status === 'initial' ||
      status === 'loading');
  const failed = !settled && !loading;

  return (
    <TeamNewMembersSourcesView
      teamName={team.name}
      rows={rows}
      loading={loading}
      failed={failed}
      onRetry={status === 'offline' ? retry : undefined}
      homeServerId={scope.serverId}
      onSetSuggestedTask={mayAuthorNewMembersSetup(props.context) ? setSuggestedTask : undefined}
      homeName={props.context.homeName}
      keys={props.keys}
    />
  );
}

/** The two sections as drawn from an already-read Source list; `TeamNewMembersSources` owns the read. */
export function TeamNewMembersSourcesView(
  props: Readonly<{
    teamName: string;
    rows: TeamNewMembersSourceRows;
    loading: boolean;
    failed: boolean;
    /** Offered only when the Home was unreachable; a refusal has nothing to retry. */
    onRetry?: () => void;
    homeServerId: string;
    /** Names the Home in a Source refusal ("this Home is unreachable"). */
    homeName?: string;
    /** Present only for people who may change what new members get; the Source owner decides each write. */
    onSetSuggestedTask?: SetSuggestedTask;
    /** The Keys section sits between Repositories and the first task, as the lab orders them. */
    keys?: React.ReactNode;
  }>,
) {
  const { rows, loading, failed, onRetry } = props;
  const settled = !loading && !failed;
  const router = useRouter();
  const authoring = props.onSetSuggestedTask !== undefined;
  const openSource = React.useCallback(
    (sourceId: string) => router.push(projectSourceRoute(sourceId) as never),
    [router],
  );
  return (
    <>
      <ItemGroup
        testID="team-new-members-repositories"
        title={t('teams.newMembers.repositories.title')}
        description={t('teams.newMembers.repositories.description', {
          team: props.teamName,
        })}
        action={authoring ? (
          <SectionActionButton
            testID="team-new-members-repositories-share"
            icon="plus"
            title={t('teams.newMembers.repositories.share', { team: props.teamName })}
            onPress={() => router.push(PROJECT_SOURCES_ROUTE as never)}
          />
        ) : undefined}
      >
        {loading ? (
          <ItemLoadStateRows
            testID="team-new-members-repositories-loading"
            state={{ kind: 'loading' }}
            rows={3}
            lines={2}
          />
        ) : null}
        {failed ? (
          <ItemLoadStateRows
            testID="team-new-members-repositories-failed"
            state={{
              kind: 'failed',
              reason: t('teams.newMembers.repositories.loadFailed'),
              ...(onRetry
                ? { onRetry, homeServerIds: [props.homeServerId] }
                : {}),
            }}
          />
        ) : null}
        {settled && rows.length === 0 ? (
          <SurfaceStateCard
            testID="team-new-members-repositories-empty"
            kind="empty"
            size="line"
            // The section description already names the Team; the empty state does not repeat it.
            title={t('teams.newMembers.repositories.emptyTitle')}
            reason={t('teams.newMembers.repositories.emptyBody')}
          />
        ) : null}
        {rows.map((row) => (
          <RepositoryRow
            key={row.source.id}
            row={row}
            onOpen={openSource}
          />
        ))}
      </ItemGroup>
      {props.keys}
      {/* The task comes from the same Source read; when that read failed, the notice above says so once. */}
      {failed ? null : (
        <ItemGroup
          testID="team-new-members-first-task"
          title={t('teams.newMembers.firstTask.title')}
          description={t('teams.newMembers.firstTask.description')}
        >
          {settled ? (
            <FirstTaskRows
              rows={rows}
              teamName={props.teamName}
              homeName={props.homeName ?? ''}
              serverId={props.homeServerId}
              onSetSuggestedTask={props.onSetSuggestedTask}
            />
          ) : null}
          {loading ? (
            <ItemLoadStateRows state={{ kind: 'loading' }} rows={1} lines={1} />
          ) : null}
        </ItemGroup>
      )}
    </>
  );
}

const RepositoryRow = React.memo(function RepositoryRow(
  props: Readonly<{ row: TeamNewMembersSourceRows[number]; onOpen: (sourceId: string) => void }>,
) {
  const { source, taskReference } = props.row;
  const subtitle = [
    describeProjectSourceRow(source),
    taskReference ? t('teams.newMembers.repositories.hasFirstTask') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Item
      testID={`team-new-members-repository:${source.id}`}
      icon={<Icon name="git-branch" />}
      title={source.name}
      subtitle={subtitle}
      // Sharing and ownership are changed in the Source's own editor; this page never keeps a second list.
      onPress={() => props.onOpen(source.id)}
    />
  );
});

type FirstTaskPicking = Readonly<{ kind: 'source' }> | Readonly<{ kind: 'prompt'; sourceId: string }>;

/**
 * The suggested first task: the prompt attached to a Source as its `onboarding_task`. Choosing and removing go
 * through the Source owner's attachment writer; the task's words are edited in the prompt's own editor.
 */
function FirstTaskRows(props: Readonly<{
  rows: TeamNewMembersSourceRows;
  teamName: string;
  homeName: string;
  serverId: string;
  onSetSuggestedTask?: SetSuggestedTask;
}>) {
  const router = useRouter();
  const { rows, serverId, onSetSuggestedTask } = props;
  const { attached, candidates, entries } = React.useMemo(() => {
    const withTask = rows.filter((row) => row.taskReference !== null);
    return {
      attached: withTask,
      candidates: rows.filter((row) => row.taskReference === null),
      // The prompt owner's title and editor link are read per reference; nothing else of the prompt is read here.
      entries: withTask.map((row) => ({
        id: row.source.id,
        ref: row.taskReference!.ref,
        enabled: true,
        placement: 'system_append' as const,
      })),
    };
  }, [rows]);
  const presentations = usePromptStackEntryPresentations(entries, serverId);
  const chooseRef = React.useRef<View | null>(null);
  const [picking, setPicking] = React.useState<FirstTaskPicking | null>(null);
  // A change the Source owner refused says so here until the next attempt (never a dialog).
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const shareOffers = usePrivateAttachedDocumentShareOffer({
    serverId,
    hostKey: serverId,
    sheetSubtitle: t('teams.newMembers.firstTask.title'),
  });
  const write = React.useCallback(async (source: ProjectSourceV1, ref: PromptDocArtifactRefV1 | null) => {
    if (!onSetSuggestedTask) return false;
    setRefusal(null);
    const result = await onSetSuggestedTask(source, ref);
    if (result?.ok) return true;
    // No result means the owner did not send it (busy, conflicted, unreachable); a refusal names its cause.
    setRefusal(result && !result.ok ? result.error : 'unavailable');
    return false;
  }, [onSetSuggestedTask]);
  const choose = React.useCallback(() => {
    if (candidates.length === 1) setPicking({ kind: 'prompt', sourceId: candidates[0]!.source.id });
    else if (candidates.length > 1) setPicking({ kind: 'source' });
  }, [candidates]);
  const pick = React.useCallback((ref: PromptArtifactRefV1, title: string) => {
    const target = picking?.kind === 'prompt' ? rows.find((row) => row.source.id === picking.sourceId) : undefined;
    setPicking(null);
    if (!target || ref.kind !== 'doc') return;
    // Attaching grants nothing: a private prompt is offered for sharing, or new members could not read it.
    const pending = shareOffers.beginAttach(ref);
    void write(target.source, { ...ref, kind: 'doc' }).then((ok) => ok && pending
      ? pending.afterApplied({ title, kind: 'prompt_doc.v2' }) : undefined);
  }, [picking, rows, shareOffers.beginAttach, write]);
  const issue = refusal ? presentProjectSourceIssue(refusal, props.homeName) : null;
  const chooser = onSetSuggestedTask && candidates.length > 0 ? (
    <Item
      testID="team-new-members-first-task-choose"
      pressableRef={chooseRef}
      icon={<Icon name="plus" />}
      title={t('teams.newMembers.firstTask.choose')}
      showChevron={false}
      onPress={choose}
    />
  ) : null;
  return (
    <>
      {attached.length === 0 && !chooser ? (
        <SurfaceStateCard
          testID="team-new-members-first-task-empty"
          kind="empty"
          size="line"
          title={t('teams.newMembers.firstTask.emptyTitle')}
          reason={t('teams.newMembers.firstTask.emptyBody')}
        />
      ) : null}
      {attached.map((row, index) => {
        const entry = entries[index]!;
        const href = promptStackEntryHref(entry, presentations(entry).kind, serverId);
        return (
          <Item
            key={row.source.id}
            testID={`team-new-members-first-task:${row.source.id}`}
            icon={<Icon name="file-text" />}
            title={promptStackEntryTitle(entry, presentations)}
            subtitle={t('teams.newMembers.firstTask.attachedTo', { source: row.source.name })}
            onPress={href ? () => router.push(href as never) : undefined}
            showChevron={href !== null && !onSetSuggestedTask}
            rightElement={onSetSuggestedTask ? (
              <RoundButton
                testID={`team-new-members-first-task:${row.source.id}.remove`}
                size="small"
                display="inverted"
                title={t('teams.newMembers.firstTask.remove')}
                accessibilityLabel={t('teams.newMembers.firstTask.removeFrom', { source: row.source.name })}
                onPress={() => {
                  shareOffers.clear(row.taskReference!.ref.artifactId);
                  void write(row.source, null);
                }}
              />
            ) : undefined}
          />
        );
      })}
      {chooser}
      {refusal ? (
        <SurfaceStateCard
          testID="team-new-members-first-task-refused"
          kind="error"
          size="line"
          title={issue?.title ?? t('common.unavailable')}
          reason={issue?.description}
        />
      ) : null}
      {shareOffers.offer ? (
        <AttentionBanner
          testID="team-new-members-first-task-share-offer"
          tone="neutral"
          placement="inline"
          icon={<Icon name="users" />}
          title={t('teams.newMembers.firstTask.onlyYoursNote', { task: shareOffers.offer.title, team: props.teamName })}
          action={{
            label: t('contextPages.project.shareWith', { team: props.teamName }),
            onPress: (event?: unknown) => shareOffers.offer && shareOffers.open(shareOffers.offer, resolvePressTriggerAnchor(event)),
          }}
          onDismiss={shareOffers.dismiss}
        />
      ) : null}
      {picking?.kind === 'source' ? (
        <DropdownMenu
          testID="team-new-members-first-task-source"
          open
          onOpenChange={(next) => { if (!next) setPicking(null); }}
          items={candidates.map((row) => ({ id: row.source.id, title: row.source.name,
            subtitle: describeProjectSourceRow(row.source), icon: <Icon name="git-branch" /> }))}
          selectedId={null}
          popoverAnchorRef={chooseRef}
          popoverAccessibilityLabel={t('teams.newMembers.firstTask.chooseSource')}
          matchTriggerWidth={false}
          onSelect={(id) => setPicking({ kind: 'prompt', sourceId: String(id) })}
        />
      ) : null}
      {picking?.kind === 'prompt' ? (
        <PromptStackDocumentMenu
          testID="team-new-members-first-task-picker"
          anchorRef={chooseRef}
          serverId={serverId}
          purpose="instructions"
          onClose={() => setPicking(null)}
          onPick={pick}
        />
      ) : null}
    </>
  );
}
