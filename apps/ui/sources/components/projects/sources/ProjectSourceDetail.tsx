import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type {
  ProjectSourceGrantV1,
  ProjectSourceV1,
  SourceAttachmentV1,
} from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { PromptArtifactRefV1 } from '@happier-dev/protocol/prompts/library/promptArtifactRefsV1';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldValueItem } from '@/components/ui/forms/FieldValueItem';
import { showProjectSourceShareSheet } from '@/components/sharing/projects/showProjectSourceShareSheet';
import { Icon } from '@/components/ui/icons/Icon';
import { KeyboardStickyFooter } from '@/components/ui/keyboardAvoidance/KeyboardStickyFooter';
import { useChromeSafeAreaInsets } from '@/components/ui/layout/useChromeSafeAreaInsets';
import {
  PageHeader,
  type PageHeaderMetaFact,
} from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkSlot } from '@/components/ui/layout/PageHeaderMarkSlot';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import {
  useAllMachines,
  useArtifact,
  useArtifactsLoaded,
  useWorkspaceRefs,
} from '@/sync/domains/state/storage';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { t } from '@/text';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveWorkspaceRefByAddress } from '@/sync/domains/workspaces/workspaceRefs';
import { useViewportClass } from '@/utils/platform/useViewportClass';

import { ProjectRefSelect } from '../ProjectRefSelect';

import type {
  ProjectSourceDraft,
  ProjectSourcesController,
  ProjectSourcesState,
} from './projectSourcesController';
import { formatProjectSourceAddress } from './projectSourceAddress';
import {
  projectSourceDraftTitle,
  readSourceTeamId,
} from './ProjectSourcesRail';

function lastSegment(nameWithOwner: string): string {
  return nameWithOwner.split('/').filter(Boolean).pop() ?? nameWithOwner;
}

/** "Only me", "Acme · everyone", or how many people and teams can use it. */
function describeAudience(
  grants: readonly ProjectSourceGrantV1[],
  teamName: (teamId: string) => string | null,
): string {
  if (grants.length === 0) return t('projects.sources.onlyMe');
  const only = grants.length === 1 ? grants[0]!.principal : null;
  const team = only?.kind === 'team' ? teamName(only.teamId) : null;
  return team
    ? t('projects.sources.teamEveryone', { team })
    : t('projects.sources.audienceCount', { count: grants.length });
}

/**
 * "Who can see it" (lab `p-sources`): who can use this Source, opening the one Source share sheet
 * (Account, Team or group; view grants only). The disclosure above says exactly what they can read.
 */
const SourceAudienceRow = React.memo(function SourceAudienceRow(
  props: Readonly<{
    summary: string;
    /** The share sheet opens only on a saved Source this person may manage. */
    onShare: (() => void) | null;
    creating: boolean;
    testID: string;
  }>,
) {
  return (
    <Item
      testID={props.testID}
      title={t('projects.sources.sharedWith')}
      subtitle={
        props.creating
          ? t('projects.sources.shareAfterSave')
          : t('projects.sources.ownCredential')
      }
      detail={props.summary}
      showChevron={props.onShare !== null}
      {...(props.onShare ? { onPress: props.onShare } : {})}
    />
  );
});

/** One attached dashboard: its name and access come from the admitted document, never the Source. */
const DashboardAttachmentRow = React.memo(function DashboardAttachmentRow(
  props: Readonly<{
    reference: PromptArtifactRefV1;
    /** The Home this page reads; a reference qualified to another Home is never read from this one's cache. */
    serverId: string;
    canDetach: boolean;
    onDetach: (reference: PromptArtifactRefV1) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const elsewhere =
    props.reference.serverId !== undefined &&
    !areServerProfileIdentifiersEquivalent(
      props.reference.serverId,
      props.serverId,
    );
  const cached = useArtifact(props.reference.artifactId);
  const artifact = elsewhere ? null : cached;
  const loaded = useArtifactsLoaded() || elsewhere;
  const readable = artifact !== null && artifact.isDecrypted;
  const access =
    artifact?.access === 'edit'
      ? t('shareSheet.documents.levels.canEdit')
      : artifact?.access === 'view'
        ? t('shareSheet.documents.levels.canRead')
        : null;
  return (
    <Item
      testID={`projects.sources.dashboard.${props.reference.serverId ?? props.serverId}:${props.reference.artifactId}`}
      icon={
        <Icon
          name={readable || !loaded ? 'squares-four' : 'lock'}
          size={18}
          color={theme.colors.text.secondary}
        />
      }
      title={
        readable
          ? (artifact.title ?? t('projects.sources.dashboardUnavailableTitle'))
          : loaded
            ? t('projects.sources.dashboardUnavailableTitle')
            : ' '
      }
      subtitle={
        readable
          ? (access ?? undefined)
          : elsewhere
            ? t('projects.sources.dashboardOtherHome')
            : loaded
              ? t('projects.dashboard.unavailable')
              : undefined
      }
      showChevron={false}
      rightElement={
        props.canDetach ? (
          <RoundButton
            testID={`projects.sources.dashboard.${props.reference.serverId ?? props.serverId}:${props.reference.artifactId}.detach`}
            size="small"
            display="secondary"
            title={t('projects.sources.detach')}
            onPress={() => props.onDetach(props.reference)}
          />
        ) : undefined
      }
    />
  );
});

/** "Your checkouts": the exact Project checkouts this Source was opened into, per machine. */
const SourceCheckouts = React.memo(function SourceCheckouts(
  props: Readonly<{
    sourceId: string;
    serverId: string;
    onOpenCheckout: (workspaceRefId: string) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const refs = useWorkspaceRefs();
  const machines = useAllMachines();
  const rows = React.useMemo(() => {
    const list = (Array.isArray(refs) ? refs : []).filter(
      (ref) =>
        ref.source?.sourceId === props.sourceId &&
        areServerProfileIdentifiersEquivalent(ref.serverId, props.serverId),
    );
    return list.map((primary) => {
      const machineId = primary.machineId;
      const machine =
        machines.find((candidate) => candidate.id === machineId) ?? null;
      return {
        machineId,
        name: getMachineDisplayName(machine) ?? machineId,
        homeDir: machine?.metadata?.homeDir ?? undefined,
        primary,
      };
    });
  }, [machines, props.sourceId, props.serverId, refs]);
  if (rows.length === 0) return null;
  return (
    <ItemGroup title={t('projects.sources.checkoutsTitle')}>
      {rows.map((row) => (
        <Item
          key={`${row.primary.serverId}:${row.primary.machineId}:${row.primary.id}:${row.primary.rootPath}`}
          testID={`projects.sources.checkout.${row.machineId}`}
          icon={
            <Icon
              name="desktop"
              size={18}
              color={theme.colors.text.secondary}
            />
          }
          title={row.name}
          subtitle={formatPathRelativeToHome(row.primary.rootPath, row.homeDir)}
          onPress={() => {
            const resolved = resolveWorkspaceRefByAddress(refs, {
              serverId: row.primary.serverId,
              workspaceId: row.primary.id,
              machineId: row.primary.machineId,
              rootPath: row.primary.rootPath,
            });
            if (resolved.kind === 'resolved')
              props.onOpenCheckout(resolved.ref.id);
          }}
        />
      ))}
    </ItemGroup>
  );
});

export type ProjectSourceDetailProps = Readonly<{
  state: ProjectSourcesState;
  controller: ProjectSourcesController;
  accountId: string;
  homeName: string;
  teamName: (teamId: string) => string | null;
  /** The new-source editor rather than a saved Source. */
  creating: boolean;
  onCreated: (sourceId: string) => void;
  onDiscardCreate: () => void;
  onOpen: (source: ProjectSourceV1) => void;
  onOpenCheckout: (workspaceRefId: string) => void;
  onDeleted: () => void;
}>;

function issueBanner(
  issue: string | null,
  homeName: string,
): Readonly<{
  title: string;
  description?: string;
  tone: 'warning' | 'neutral' | 'danger';
}> | null {
  switch (issue) {
    case null:
      return null;
    case 'source_unavailable':
      return {
        title: t('projects.sources.unavailable'),
        description: t('projects.sources.unavailableBody'),
        tone: 'neutral',
      };
    case 'source_access_denied':
      return {
        title: t('projects.sources.unavailable'),
        description: t('projects.sources.unavailableBody'),
        tone: 'neutral',
      };
    case 'outcome_unknown':
      return {
        title: t('projects.sources.outcomeUnknown'),
        description: t('projects.sources.outcomeUnknownBody'),
        tone: 'warning',
      };
    case 'home_unreachable':
      return {
        title: t('projects.sources.offline', { home: homeName }),
        tone: 'warning',
      };
    case 'source_backend_unavailable':
      return {
        title: t('projects.sources.backendUnavailable'),
        tone: 'neutral',
      };
    case 'source_invalid':
      return { title: t('projects.sources.addressInvalid'), tone: 'warning' };
    case 'source_conflict':
      return null;
    default:
      return { title: t('projects.sources.saveFailed'), tone: 'warning' };
  }
}

/**
 * What the new Source's address check says under the field. Save stays disabled until the address
 * resolves; the controller names the reason (A3b), and this only words it.
 */
function describeAddressResolution(
  state: ProjectSourcesState,
  address: string,
  machineName: (machineId: string) => string,
): Readonly<{ tone: 'info' | 'error'; text: string }> | null {
  const resolution = state.addressResolution;
  if (!address || resolution.kind === 'idle') return null;
  if (resolution.kind === 'resolving')
    return {
      tone: 'info',
      text: t('projects.sources.addressResolving', {
        machine: machineName(resolution.machineId),
      }),
    };
  if (resolution.kind === 'resolved')
    return {
      tone: 'info',
      text: formatProjectSourceAddress(resolution.selector),
    };
  return state.addressSaveDisabledReason
    ? { tone: 'error', text: t(state.addressSaveDisabledReason) }
    : null;
}

/**
 * One Source's page (lab `p-sources` LIST): identity, then Repository, Who can see it, Dashboards
 * and Your checkouts, and Delete last. Edits stay a draft until Save; a revision that moved under
 * the draft says so and keeps the edits (expected revision, never last-write-wins).
 */
export const ProjectSourceDetail = React.memo(function ProjectSourceDetail(
  props: ProjectSourceDetailProps,
) {
  const { theme } = useUnistyles();
  const { state, controller } = props;
  const current = props.creating ? null : state.current;
  const newDraft = state.creationDraft;
  const machines = useAllMachines();
  // A phone reads the page as summaries that push their editor (lab `SOURCESp`), with Open pinned below.
  const compact = useViewportClass() === 'compact';
  const insets = useChromeSafeAreaInsets();
  const [titleDraft, setTitleDraft] = React.useState<string | null>(null);
  const [addressError, setAddressError] = React.useState<string | null>(null);
  // Unconfirmed create (outcome unknown): a complete inspection of every Source decides whether Save may run again.
  const [inspection, setInspection] = React.useState<
    'idle' | 'checking' | 'absent' | 'found'
  >('idle');
  const retryReady = inspection === 'absent';
  const inspect = React.useCallback(async () => {
    setInspection('checking');
    await controller.load('', undefined, undefined);
    if (controller.confirmCreateRetryAfterInspection()) setInspection('absent');
    else
      setInspection(
        controller.getSnapshot().coverage.complete ? 'found' : 'idle',
      );
  }, [controller]);

  React.useEffect(() => {
    if (!props.creating) return undefined;
    if (!controller.getSnapshot().creationDraft) controller.beginCreate();
    projectSourceDraftTitle.publish('');
    return () => projectSourceDraftTitle.publish('');
  }, [controller, props.creating]);

  // A saved Source's editable fields read through the controller's draft once edited.
  const draft: ProjectSourceDraft | null = props.creating ? null : state.draft;
  const view = draft ?? current;
  // The Home decides who may change a Source (its author, a Team admin); the page follows its answer.
  const canEdit = props.creating || (current !== null && state.canManage);
  const saving = state.mutation === 'saving';
  const addressText = props.creating
    ? (newDraft?.address ?? '')
    : state.addressResolution.kind !== 'idle'
      ? state.addressResolution.address
      : view
        ? formatProjectSourceAddress(view.repository)
        : '';
  // A new Source's address names its Git host only once a Machine on this Home has resolved it (A3b).
  const resolution = state.addressResolution;
  const parsedNew =
    props.creating &&
    resolution.kind === 'resolved' &&
    resolution.address === newDraft?.address.trim()
      ? resolution.selector
      : null;
  const newName = props.creating
    ? newDraft?.name ||
      (parsedNew ? lastSegment(parsedNew.repository.nameWithOwner) : '')
    : '';

  React.useEffect(() => {
    if (props.creating) projectSourceDraftTitle.publish(newName);
  }, [newName, props.creating]);

  const commitAddress = React.useCallback(
    (text: string) => {
      if (props.creating) {
        controller.editCreation({ address: text });
        setAddressError(null);
        void controller.resolveAddress(text);
        return text;
      }
      setAddressError(null);
      void controller.resolveAddress(text);
      return text;
    },
    [controller, props.creating],
  );

  const save = React.useCallback(async () => {
    if (props.creating) {
      // An unconfirmed create retries only its sealed intent, after the explicit inspection below.
      if (!retryReady && !parsedNew) return;
      await controller.save();
      const saved = controller.getSnapshot();
      if (retryReady && !saved.uncertainCreate) setInspection('idle');
      if (saved.current && !saved.draft) props.onCreated(saved.current.id);
      return;
    }
    await controller.save();
  }, [controller, parsedNew, props, retryReady]);

  const remove = React.useCallback(async () => {
    if (!current) return;
    const confirmed = await Modal.confirm(
      t('projects.sources.deleteConfirmTitle', { name: current.name }),
      t('projects.sources.deleteConsequence'),
      { confirmText: t('projects.sources.delete'), destructive: true },
    );
    if (!confirmed) return;
    await controller.remove();
    if (!controller.getSnapshot().current) props.onDeleted();
  }, [controller, current, props]);

  const detach = React.useCallback(
    (reference: PromptArtifactRefV1) => {
      void controller.updateSource({
        attachment: { kind: 'detach', purpose: 'dashboard', ref: reference },
      });
    },
    [controller],
  );

  if (!props.creating && !current) {
    const banner = issueBanner(state.issue, props.homeName);
    if (!banner) {
      return (
        <ItemList testID="projects.sources.detail.loading">
          <SurfaceStateCard
            kind="loading"
            title={t('projects.sources.loading')}
          />
        </ItemList>
      );
    }
    return (
      <ItemList testID="projects.sources.detail.unavailable">
        {banner ? (
          <AttentionBanner
            testID="projects.sources.detail.issue"
            title={banner.title}
            description={banner.description}
            tone={banner.tone}
          />
        ) : null}
      </ItemList>
    );
  }

  const teamId = view ? readSourceTeamId({ audience: view.audience }) : null;
  const team = teamId ? props.teamName(teamId) : null;
  const meta: PageHeaderMetaFact[] = current
    ? [
        {
          key: 'address',
          text: formatProjectSourceAddress(current.repository),
          mono: true,
        },
        ...(team
          ? [
              {
                key: 'audience',
                text: t('projects.sources.sharedWithTeam', { team }),
                icon: 'users' as const,
              },
            ]
          : []),
        ...(current.createdByAccountId === props.accountId
          ? [{ key: 'author', text: t('projects.sources.addedByYou') }]
          : []),
      ]
    : [];
  const banner = issueBanner(state.issue, props.homeName);
  const dashboards = (current?.attachments ?? []).filter(
    (
      attachment,
    ): attachment is Extract<SourceAttachmentV1, { purpose: 'dashboard' }> =>
      attachment.purpose === 'dashboard',
  );
  // Confirming the inspection clears the controller's flag; the banner stays until the retry is sent.
  const retryingCreate =
    props.creating && (state.uncertainCreate || retryReady);
  const dirty = props.creating
    ? parsedNew !== null || (retryingCreate && retryReady)
    : draft !== null;
  const addressStatus =
    props.creating || resolution.kind !== 'idle'
      ? describeAddressResolution(
          state,
          addressText.trim(),
          (machineId) =>
            getMachineDisplayName(
              machines.find((machine) => machine.id === machineId) ?? null,
            ) ?? machineId,
        )
      : null;

  return (
    <View style={styles.page}>
    <ItemList testID="projects.sources.detail">
      <PageHeader
        testID="projects.sources.detail.header"
        title={
          props.creating
            ? newName || t('projects.sources.new')
            : (view?.name ?? '')
        }
        alwaysShowTitle
        leading={
          <PageHeaderMarkSlot>
            <Icon
              name="git-branch"
              size={22}
              color={theme.colors.text.secondary}
            />
          </PageHeaderMarkSlot>
        }
        {...(canEdit && (props.creating || view)
          ? {
              titleEditor: {
                value: props.creating
                  ? (newDraft?.name ?? '')
                  : (titleDraft ?? view!.name),
                placeholder: t('projects.sources.name'),
                accessibilityLabel: t('projects.sources.name'),
                onChangeText: props.creating
                  ? (name: string) => controller.editCreation({ name })
                  : setTitleDraft,
                onCommit: () => {
                  if (props.creating) return;
                  const name = (titleDraft ?? '').trim();
                  setTitleDraft(null);
                  if (name && name !== view!.name) controller.edit({ name });
                },
              },
            }
          : {})}
        meta={meta}
        primaryAction={
          dirty || props.creating
            ? {
                title: t('common.save'),
                onPress: save,
                disabled:
                  !dirty ||
                  saving ||
                  state.addressSaveDisabledReason !== null ||
                  (retryingCreate && !retryReady),
                loading: saving,
                testID: 'projects.sources.detail.save',
              }
            : current && !compact
              ? {
                  title: t('projects.sources.open'),
                  onPress: () => props.onOpen(current),
                  testID: 'projects.sources.detail.open',
                }
              : undefined
        }
        {...(dirty || props.creating
          ? {
              cancelAction: {
                title: t('common.discard'),
                onPress: () => {
                  controller.discard();
                  if (props.creating) props.onDiscardCreate();
                  setAddressError(null);
                },
                testID: 'projects.sources.detail.discard',
              },
            }
          : {})}
      />
      {retryingCreate ? (
        <AttentionBanner
          testID="projects.sources.detail.outcomeUnknown"
          tone="warning"
          title={t('projects.sources.outcomeUnknown')}
          description={
            inspection === 'absent'
              ? t('projects.sources.outcomeNotSaved')
              : inspection === 'found'
                ? t('projects.sources.outcomeFound')
                : t('projects.sources.outcomeUnknownBody')
          }
          action={
            inspection === 'absent'
              ? {
                  label: t('projects.sources.saveAgain'),
                  onPress: () => {
                    void save();
                  },
                }
              : inspection === 'checking'
                ? undefined
                : {
                    label: t('projects.sources.checkSources'),
                    onPress: () => {
                      void inspect();
                    },
                  }
          }
        />
      ) : state.conflict && !props.creating ? (
        <AttentionBanner
          testID="projects.sources.detail.conflict"
          title={t('projects.sources.changed')}
          description={t('projects.sources.changedBody')}
          action={{
            label: t('projects.sources.reload'),
            onPress: () => controller.acceptCurrentRevision(),
          }}
        />
      ) : banner ? (
        <AttentionBanner
          testID="projects.sources.detail.issue"
          title={banner.title}
          description={banner.description}
          tone={banner.tone}
          // An unconfirmed update or delete is decided by re-reading this exact Source, never by repeating it.
          {...(state.issue === 'outcome_unknown' && current
            ? {
                action: {
                  label: t('projects.dashboard.check'),
                  onPress: () => {
                    void controller.select(current.id);
                  },
                },
              }
            : {})}
        />
      ) : null}
      <ItemGroup
        title={t('projects.sources.repositoryTitle')}
        description={
          props.creating
            ? undefined
            : t('projects.sources.repositoryDescription')
        }
      >
        {compact && !props.creating ? (
          // The address changes rarely, so a phone keeps it one step deeper (lab `SOURCESp`).
          <Item
            testID="projects.sources.detail.address"
            title={t('projects.sources.address')}
            subtitle={addressStatus?.text ?? addressError ?? addressText}
            disabled={!canEdit}
            onPress={() => {
              void (async () => {
                const typed = await Modal.prompt(t('projects.sources.address'), undefined, {
                  defaultValue: addressText,
                  placeholder: t('projects.sources.addressPlaceholder'),
                  confirmText: t('common.done'),
                });
                if (typed !== null && typed.trim() !== addressText.trim()) commitAddress(typed.trim());
              })();
            }}
          />
        ) : (
          <FieldValueItem
            testID="projects.sources.detail.address"
            fieldTestID="projects.sources.detail.address.field"
            title={t('projects.sources.address')}
            value={addressText}
            placeholder={t('projects.sources.addressPlaceholder')}
            autoCapitalize="none"
            autoFocus={props.creating}
            error={
              addressError ??
              (addressStatus?.tone === 'error' ? addressStatus.text : null)
            }
            {...(addressStatus?.tone === 'info'
              ? { subtitle: addressStatus.text }
              : {})}
            // The creation draft takes the address on commit, so `value` stays the last committed text and
            // the field's commit-if-changed rule resolves every newly typed address.
            onCommit={commitAddress}
            disabled={!canEdit}
          />
        )}
        <ProjectRefSelect
          testID="projects.sources.detail.defaultRef"
          title={t('projects.sources.defaultRef')}
          value={(props.creating ? newDraft?.defaultRef : view?.defaultRef) || null}
          defaultLabel={t('projects.sources.repositoryDefault')}
          disabled={!canEdit}
          onChange={(value) => {
            if (props.creating) controller.editCreation({ defaultRef: value ?? '' });
            else controller.edit({ defaultRef: value ?? undefined });
          }}
        />
        {compact && !props.creating ? (
          <Item
            testID="projects.sources.detail.folder"
            title={t('projects.sources.folder')}
            subtitle={view?.subdir || t('projects.sources.wholeRepository')}
            disabled={!canEdit}
            onPress={() => {
              void (async () => {
                const typed = await Modal.prompt(t('projects.sources.folder'), t('projects.sources.folderDescription'), {
                  defaultValue: view?.subdir ?? '',
                  placeholder: t('projects.sources.wholeRepository'),
                  confirmText: t('common.done'),
                });
                if (typed !== null) controller.edit({ subdir: typed.trim() || undefined });
              })();
            }}
          />
        ) : (
          <FieldValueItem
            testID="projects.sources.detail.folder"
            title={t('projects.sources.folder')}
            subtitle={t('projects.sources.folderDescription')}
            value={
              props.creating ? (newDraft?.subdir ?? '') : (view?.subdir ?? '')
            }
            placeholder={t('projects.sources.wholeRepository')}
            allowEmpty
            autoCapitalize="none"
            disabled={!canEdit}
            onCommit={(text) => {
              const value = text.trim();
              if (props.creating) controller.editCreation({ subdir: value });
              else controller.edit({ subdir: value || undefined });
            }}
          />
        )}
      </ItemGroup>
      <ItemGroup
        title={t('projects.sources.audience')}
        description={t('projects.sources.disclosure')}
      >
        <SourceAudienceRow
          testID="projects.sources.detail.audience"
          creating={props.creating}
          summary={describeAudience(
            (props.creating ? newDraft?.audience : view?.audience) ?? [],
            props.teamName,
          )}
          onShare={
            current && canEdit && !state.conflict
              ? () =>
                  showProjectSourceShareSheet({
                    controller,
                    name: current.name,
                  })
              : null
          }
        />
      </ItemGroup>
      {current && dashboards.length > 0 ? (
        <ItemGroup
          title={t('projects.sources.dashboardsTitle')}
          titleAccessory={
            <Text style={[styles.count, { color: theme.colors.text.tertiary }]}>
              {String(dashboards.length)}
            </Text>
          }
          description={
            team
              ? t('projects.sources.dashboardsDescription', {
                  team,
                  project: current.name,
                })
              : t('projects.sources.dashboardsDescriptionPersonal')
          }
        >
          {dashboards.map((attachment) => (
            <DashboardAttachmentRow
              key={`${attachment.ref.serverId ?? props.controller.scope.serverId}:${attachment.ref.artifactId}`}
              reference={attachment.ref}
              serverId={props.controller.scope.serverId}
              canDetach={canEdit}
              onDetach={detach}
            />
          ))}
        </ItemGroup>
      ) : null}
      {current ? (
        <SourceCheckouts
          sourceId={current.id}
          serverId={props.controller.scope.serverId}
          onOpenCheckout={props.onOpenCheckout}
        />
      ) : null}
      {current && canEdit ? (
        <ItemGroup surface="none">
          <SectionContentRow>
            <View style={styles.deleteRow}>
              <RoundButton
                testID="projects.sources.detail.delete"
                size="small"
                display="destructive"
                title={t('projects.sources.delete')}
                loading={state.mutation === 'deleting'}
                onPress={remove}
              />
              <Text
                style={[
                  styles.consequence,
                  { color: theme.colors.text.secondary },
                ]}
              >
                {t('projects.sources.deleteConsequence')}
              </Text>
            </View>
          </SectionContentRow>
        </ItemGroup>
      ) : null}
    </ItemList>
    {compact && current && !dirty ? (
      <KeyboardStickyFooter style={[styles.phoneFooter, { borderTopColor: theme.colors.border.subtle, paddingBottom: Math.max(insets.bottom, 12) }]}>
        <RoundButton
          testID="projects.sources.detail.open"
          title={t('projects.sources.open')}
          onPress={() => props.onOpen(current)}
        />
      </KeyboardStickyFooter>
    ) : null}
    </View>
  );
});

const styles = StyleSheet.create(() => ({
  page: { flex: 1, minHeight: 0 },
  phoneFooter: {
    paddingHorizontal: 16,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  count: { ...Typography.default(), fontVariant: ['tabular-nums'] },
  deleteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  consequence: { ...Typography.default(), flexShrink: 1 },
}));
