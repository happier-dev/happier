import type { PromptArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';
import type { PromptStackEntryV1 } from '@happier-dev/protocol/prompts/library/promptStacksV1';
import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import * as React from 'react';
import { View } from 'react-native';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ContextMemorySection } from '@/components/settings/prompts/context/ContextMemorySection';
import { PromptStackDocumentMenu } from '@/components/settings/prompts/stacks/PromptStackDocumentMenu';
import { PromptStackEntryRow } from '@/components/settings/prompts/stacks/PromptStackEntryRow';
import {
  promptStackEntryHref,
  promptStackEntryTitle,
  usePromptStackEntryPresentations,
} from '@/components/settings/prompts/stacks/promptStackEntryPresentation';
import { usePrivateAttachedDocumentShareOffer } from '@/components/sharing/documents/usePrivateAttachedDocumentShareOffer';
import { resolvePressTriggerAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import {
  PageHeader,
  type PageHeaderMetaFact,
} from '@/components/ui/layout/PageHeader';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { CheckoutReachabilityLine } from '@/components/workspaces/reachability/checkoutReachability';
import { checkoutMachineScopeOfProject } from '@/components/workspaces/reachability/checkoutReachabilityModel';
import { resolveWorkspaceRefDisplayName } from '../resolveWorkspaceRefDisplayName';
import { ProjectCapabilitiesSection } from './ProjectCapabilitiesSection';
import { selectProjectMemoryEntry } from './projectMemoryEntry';
import {
  useProjectContext,
  type ProjectContextOutcome,
} from './useProjectContext';

type Layer = 'shared' | 'personal';

/**
 * Project → Context (plan 65 §2, lab `c-ctx` P/R): what sessions and workers in this Project read
 * before they start. Project memory first (the shared memory renderer), then the Source's documents
 * — editable by whoever manages the Source, read-only "From the team project" for a teammate, with a
 * document they were not granted shown as one honest row — then the viewer's own layer. Attaching a
 * private document you own to a Team Project offers "Share with {Team}", which opens the one share sheet;
 * attaching never grants anything by itself.
 */
export const ProjectContextBody = React.memo(function ProjectContextBody(
  props: Readonly<{
    workspaceRef: WorkspaceRefV1;
    testID?: string;
  }>,
) {
  const testID = props.testID ?? 'project-context';
  const router = useRouter();
  const model = useProjectContext(props.workspaceRef);
  const projectRef = React.useMemo(() => projectWorkspaceRefV1(props.workspaceRef), [props.workspaceRef]);
  const memorySearchScope = React.useMemo(() => ({ type: 'project' as const, projectRef }), [projectRef]);
  const { shared, personal, teamName } = model;
  const entries = React.useMemo(() => [...shared.entries, ...personal.entries], [shared.entries, personal.entries]);
  const presentations = usePromptStackEntryPresentations(entries, projectRef.serverId);
  const projectName = resolveWorkspaceRefDisplayName(props.workspaceRef);
  const shareOffers = usePrivateAttachedDocumentShareOffer({
    serverId: projectRef.serverId,
    hostKey: JSON.stringify([projectRef.serverId, projectRef.projectKey]),
    sheetSubtitle: t('contextPages.project.attachedTo', { project: projectName }),
  });
  const shareOffer = shareOffers.offer;
  const [picking, setPicking] = React.useState<Layer | null>(null);
  // A change that did not land says so on the page until the next attempt (never a dialog).
  const [refusal, setRefusal] = React.useState<'conflict' | 'refused' | null>(null);
  const sharedAddRef = React.useRef<View>(null);
  const personalAddRef = React.useRef<View>(null);


  const hasSource = shared.status !== 'none';
  const { entry: memory, layer: memoryLayer, resolved: memoryResolved,
    attachmentStatus: memoryAttachmentStatus } = React.useMemo(
    () => selectProjectMemoryEntry({ hasSource, sharedEntries: shared.entries, personalEntries: personal.entries, presentations }),
    [hasSource, personal.entries, presentations, shared.entries],
  );
  const sharedDocuments = React.useMemo(
    () => shared.entries.filter((entry) => entry.id !== memory?.id),
    [memory?.id, shared.entries],
  );
  const personalDocuments = React.useMemo(
    () => personal.entries.filter((entry) => entry.id !== memory?.id),
    [memory?.id, personal.entries],
  );

  const settle = React.useCallback(
    (run: Promise<ProjectContextOutcome>, tag: string) => {
      setRefusal(null);
      fireAndForget(
        run.then((outcome) => {
          if (outcome === 'conflict' || outcome === 'refused') setRefusal(outcome);
        }),
        { tag },
      );
    },
    [],
  );

  const attach = React.useCallback(
    (layer: Layer, ref: PromptArtifactRefV1, title: string) => {
      setPicking(null);
      const entry = {
        id: randomUUID(),
        ref,
        enabled: true,
        placement: 'system_append' as const,
      };
      if (layer === 'personal') {
        settle(
          personal.update({ kind: 'attach', entry }),
          'ProjectContext.attach',
        );
        return;
      }
      setRefusal(null);
      // Captured before the writer, so the "only yours" check reads the same Account's audience.
      const pending = shareOffers.beginAttach(ref);
      fireAndForget(
        shared
          .update({ kind: 'attach', attachment: { purpose: 'context', entry } })
          .then(async (outcome) => {
            if (outcome === 'conflict' || outcome === 'refused') setRefusal(outcome);
            if (outcome !== 'applied' || !teamName || !pending) return;
            await pending.afterApplied({ title, kind: presentations(entry).headerKind });
          }),
        { tag: 'ProjectContext.attachShared' },
      );
    },
    [presentations, personal, settle, shareOffers.beginAttach, shared, teamName],
  );

  const openShare = shareOffers.open;

  const remove = React.useCallback(
    (layer: Layer, entry: PromptStackEntryV1, title: string) => {
      fireAndForget(
        (async () => {
          const confirmed = await Modal.confirm(
            t('contextPages.project.removeTitle', { document: title }),
            t('contextPages.project.removeBody'),
            {
              confirmText: t('common.remove'),
              destructive: true,
            },
          );
          if (!confirmed) return;
          shareOffers.clear(entry.ref.artifactId);
          settle(
            layer === 'shared'
              ? shared.update({
                  kind: 'detach',
                  purpose: 'context',
                  attachmentId: entry.id,
                })
              : personal.update({ kind: 'detach', entryId: entry.id }),
            'ProjectContext.detach',
          );
        })(),
        { tag: 'ProjectContext.remove' },
      );
    },
    [personal, settle, shareOffers.clear, shared],
  );

  const move = React.useCallback(
    (
      layer: Layer,
      documents: readonly PromptStackEntryV1[],
      index: number,
      delta: -1 | 1,
    ) => {
      const entry = documents[index];
      const sibling = documents[index + delta];
      if (!entry || !sibling) return;
      if (layer === 'personal') {
        settle(
          personal.update({
            kind: 'reorder',
            entryId: entry.id,
            siblingId: sibling.id,
            position: delta < 0 ? 'before' : 'after',
          }),
          'ProjectContext.reorder',
        );
        return;
      }
      // The Source's reorder names the attachment this one lands before (null: the end).
      const beforeId =
        delta < 0 ? sibling.id : (documents[index + 2]?.id ?? null);
      settle(
        shared.update({ kind: 'reorder', attachmentId: entry.id, beforeId }),
        'ProjectContext.reorderShared',
      );
    },
    [personal, settle, shared],
  );

  const setMemoryBudget = React.useCallback(
    (maxChars: number | null) => {
      if (!memory) return;
      settle(
        memoryLayer === 'shared'
          ? shared.update({ kind: 'budget', attachmentId: memory.id, maxChars })
          : personal.update({
              kind: 'set_budget',
              entryId: memory.id,
              maxChars,
            }),
        'ProjectContext.budget',
      );
    },
    [memory, memoryLayer, personal, settle, shared],
  );

  const describeAccess = React.useCallback(
    (entry: PromptStackEntryV1): string | undefined => {
      const access = presentations(entry).access;
      if (access === 'view') return t('contextPages.project.canRead');
      if (access === 'edit' || access === 'admin')
        return t('contextPages.project.canEdit');
      return undefined;
    },
    [presentations],
  );

  const renderRows = (
    layer: Layer,
    documents: readonly PromptStackEntryV1[],
    editable: boolean,
  ) =>
    documents.map((entry, index) => {
      const presentation = presentations(entry);
      const presentationStatus = presentations.status(entry);
      const rowTestID = `${testID}.${layer}.${entry.id}`;
      // A document this viewer was not granted: one honest row, without its title or contents.
      if (presentationStatus === 'unavailable') {
        return (
          <PromptStackEntryRow
            key={entry.id}
            testID={rowTestID}
            entry={entry}
            title={t('contextPages.project.privateDocument')}
            note={
              layer === 'shared' && !editable
                ? t('contextPages.project.ownerPrivate')
                : t('contextPages.project.unreadable')
            }
            unavailable
            onRemove={
              editable
                ? () =>
                    remove(
                      layer,
                      entry,
                      t('contextPages.project.privateDocument'),
                    )
                : undefined
            }
          />
        );
      }
      const title = promptStackEntryTitle(entry, presentations);
      const owned = presentation.access === 'owner';
      return (
        <PromptStackEntryRow
          key={entry.id}
          testID={rowTestID}
          entry={entry}
          title={title}
          access={describeAccess(entry)}
          loading={presentationStatus === 'loading'}
          disabled={layer === 'shared' && shared.busy}
          onOpen={presentationStatus === 'ready' ? () => {
            const href = promptStackEntryHref(entry, presentations(entry).kind, projectRef.serverId);
            if (href) router.push(href as never);
          } : undefined}
          onShare={
            layer === 'shared' && owned && teamName
              ? (anchor) =>
                  openShare({
                    artifactId: entry.ref.artifactId,
                    kind: presentation.headerKind,
                    title,
                  }, anchor)
              : undefined
          }
          onMove={
            editable
              ? (delta) => move(layer, documents, index, delta)
              : undefined
          }
          canMoveUp={index > 0}
          canMoveDown={index < documents.length - 1}
          onRemove={editable ? () => remove(layer, entry, title) : undefined}
          onEnabledChange={editable ? (enabled) => settle(layer === 'shared'
            ? shared.update({ kind: 'set_enabled', attachmentId: entry.id, enabled })
            : personal.update({ kind: 'set_enabled', entryId: entry.id, enabled }), 'ProjectContext.enabled') : undefined}
          onBudgetChange={editable ? (maxChars) => settle(layer === 'shared'
            ? shared.update({ kind: 'budget', attachmentId: entry.id, maxChars })
            : personal.update({ kind: 'set_budget', entryId: entry.id, maxChars }), 'ProjectContext.budget') : undefined}
        />
      );
    });

  const attachedRefs = React.useMemo(() => entries.map(entry => entry.ref), [entries]);
  const meta = React.useMemo((): PageHeaderMetaFact[] => {
    const facts: PageHeaderMetaFact[] = [];
    if (teamName) {
      facts.push({
        key: 'team',
        icon: 'users',
        text: shared.canManage
          ? t('contextPages.project.metaTeamShared', { team: teamName })
          : t('contextPages.project.metaTeam', { team: teamName }),
      });
    }
    const count = shared.entries.length + personal.entries.length;
    if (count > 0)
      facts.push({
        key: 'documents',
        icon: 'file-text',
        text: t('contextPages.project.documentCount', { count }),
      });
    return facts;
  }, [
    personal.entries.length,
    shared.canManage,
    shared.entries.length,
    teamName,
  ]);

  const memoryReadOnly = memory ? presentations(memory).access === 'view' : false;
  const memoryBudgetEditable =
    memory !== null && (memoryLayer === 'personal' || shared.canManage);

  return (
    <ItemList testID={testID}>
      <PageHeader
        testID={`${testID}.header`}
        title={t('projects.pages.context')}
        description={t('contextPages.project.description', {
          project: projectName,
        })}
        meta={meta}
      />
      <CheckoutReachabilityLine scope={checkoutMachineScopeOfProject(props.workspaceRef)} testID="project-checkout-reachability" />
      {refusal ? (
        <SurfaceFreshnessLine
          testID={`${testID}.${refusal}`}
          tone="warning"
          reason={t(refusal === 'conflict' ? 'contextPages.project.conflict' : 'contextPages.project.refused')}
        />
      ) : null}
      <ContextMemorySection
        testID={`${testID}.memory`}
        title={t('contextPages.project.memoryTitle')}
        description={t('contextPages.project.memoryDescription')}
        serverId={model.serverId}
        entry={memory}
        attachmentStatus={!memoryResolved ? memoryAttachmentStatus : shared.status === 'none' ? personal.status : shared.status}
        searchScope={memorySearchScope}
        searchScopeName={projectName}
        scopeTarget={(!hasSource && personal.available) || (hasSource && shared.canManage)
          ? { scope: 'project', projectRef }
          : undefined}
        footer={shared => shared === null ? undefined : shared
          ? `${t('memoryContext.memory.accessShared')} · ${t('memoryContext.memory.writesAskFirst')}`
          : t('memoryContext.memory.accessPrivate')}
        emptyText={t('contextPages.project.memoryEmpty')}
        readOnly={memoryReadOnly}
        onBudgetChange={memoryBudgetEditable ? setMemoryBudget : undefined}
        disabled={memoryLayer === 'shared' && shared.busy}
        onEnabledChange={memory && memoryBudgetEditable ? (enabled) => settle(memoryLayer === 'shared'
          ? shared.update({ kind: 'set_enabled', attachmentId: memory.id, enabled })
          : personal.update({ kind: 'set_enabled', entryId: memory.id, enabled }), 'ProjectContext.memoryEnabled') : undefined}
        onDetach={
          memory && (memoryLayer === 'personal' || shared.canManage)
            ? () => remove(memoryLayer, memory, t('contextPages.project.memoryTitle'))
            : undefined
        }
      />
      <ProjectCapabilitiesSection
        testID={`${testID}.capabilities`}
        projectKey={projectRef.projectKey}
        projectName={projectName}
        teamName={teamName}
      />
      {hasSource ? (
        <ItemGroup
          title={
            shared.canManage
              ? t('contextPages.project.attachedTitle')
              : t('contextPages.project.fromTeamTitle')
          }
          description={
            shared.canManage
              ? t('contextPages.project.attachedDescription')
              : t('contextPages.project.fromTeamDescription')
          }
          action={
            shared.canManage ? (
              <View ref={sharedAddRef} collapsable={false}>
                <SectionActionButton
                  testID={`${testID}.shared.add`}
                  title={t('contextPages.addDocument')}
                  icon="plus"
                  disabled={shared.busy}
                  expanded={picking === 'shared'}
                  onPress={() => setPicking('shared')}
                />
              </View>
            ) : undefined
          }
        >
          {shared.status === 'loading' ? (
            <SurfaceFreshnessLine
              testID={`${testID}.shared.loading`}
              busy
              reason={t('contextPages.project.sharedLoading')}
            />
          ) : shared.status === 'unavailable' ? (
            <SurfaceFreshnessLine
              testID={`${testID}.shared.unavailable`}
              tone="warning"
              reason={t('contextPages.project.sharedUnavailable')}
              action={{ label: t('common.retry'), onPress: shared.retry }}
            />
          ) : null}
          {renderRows('shared', sharedDocuments, shared.canManage)}
          {shared.status === 'ready' && sharedDocuments.length === 0 ? (
            <Item
              testID={`${testID}.shared.empty`}
              mode="info"
              showChevron={false}
              title={
                shared.canManage
                  ? t('contextPages.project.attachedEmpty')
                  : t('contextPages.project.fromTeamEmpty')
              }
            />
          ) : null}
        </ItemGroup>
      ) : null}
      {shareOffer && teamName ? (
        <AttentionBanner
          testID={`${testID}.shareOffer`}
          tone="neutral"
          icon={<Icon name="users" />}
          title={t('contextPages.project.onlyYoursNote', {
            document: shareOffer.title,
            team: teamName,
          })}
          action={{
            label: t('contextPages.project.shareWith', { team: teamName }),
            onPress: (event?: unknown) => openShare(shareOffer, resolvePressTriggerAnchor(event)),
          }}
          onDismiss={shareOffers.dismiss}
        />
      ) : null}
      {/* "Only yours" is a teammate's own layer beside the team's (lab `c-ctx R`). Whoever manages the
          team project adds to the team list above, so the section appears for them only while it
          still holds documents they once kept here: those must stay reachable. */}
      {hasSource && shared.canManage && personalDocuments.length === 0 ? null : <ItemGroup
        title={
          hasSource
            ? t('contextPages.project.onlyYoursTitle')
            : t('contextPages.project.attachedTitle')
        }
        description={
          hasSource
            ? t('contextPages.project.onlyYoursDescription', {
                project: projectName,
              })
            : t('contextPages.project.attachedDescriptionPersonal')
        }
        action={
          personal.available ? (
            <View ref={personalAddRef} collapsable={false}>
              <SectionActionButton
                testID={`${testID}.personal.add`}
                title={t('contextPages.addDocument')}
                icon="plus"
                expanded={picking === 'personal'}
                onPress={() => setPicking('personal')}
              />
            </View>
          ) : undefined
        }
      >
        {renderRows('personal', personalDocuments, personal.available)}
        {personalDocuments.length === 0 ? (
          <Item
            testID={`${testID}.personal.empty`}
            mode="info"
            showChevron={false}
            title={
              hasSource
                ? t('contextPages.project.onlyYoursEmpty')
                : t('contextPages.project.attachedEmpty')
            }
          />
        ) : null}
      </ItemGroup>}
      {picking ? (
        <PromptStackDocumentMenu
          testID={`${testID}.${picking}.picker`}
          anchorRef={picking === 'shared' ? sharedAddRef : personalAddRef}
          serverId={model.serverId}
          attachedRefs={attachedRefs}
          onClose={() => setPicking(null)}
          onPick={(ref, title) => attach(picking, ref, title)}
        />
      ) : null}
    </ItemList>
  );
});
