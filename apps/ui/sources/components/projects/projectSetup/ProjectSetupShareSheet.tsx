import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { Modal } from '@/modal';
import type {
  CustomModalChromeCardConfig,
  CustomModalInjectedProps,
} from '@/modal/types';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { CodeView } from '@/components/ui/media/CodeView';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import type { ServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useProjectAccountWorkspaceRef } from '@/sync/domains/workspaces/projectAccountRows';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import { presentShareAudience } from '@/components/sharing/sharePrincipalPresentation';
import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';

import { describeProjectCommandSource } from './projectScriptPresentation';
import type {
  ProjectSetupShareResult,
  ProjectSetupSharingSnapshot,
} from './projectSetupSharing';
import { useProjectSetupSharing } from './useProjectSetupSharing';

export type ProjectSetupShareInput = Readonly<{
  workspace: WorkspaceAddressV1;
  binding: ServerCredentialAccountScopeBinding;
  /** The Source this checkout was opened from: whoever opens it gets the setup. */
  source: Readonly<{ id: string; name: string; revision: number }>;
  /** Who the Source reaches, in the Source page's own words ("Acme · everyone"). */
  audience: string;
  /** Opens the Source's own sharing; the setup follows it rather than having its own audience. */
  onOpenSourceSharing: () => void;
}>;

function shareChrome(sourceName: string): CustomModalChromeCardConfig {
  return {
    kind: 'card',
    material: 'solid',
    title: t('projects.scripts.share.title'),
    subtitle: t('projects.scripts.share.subtitle', { source: sourceName }),
    subtitleLines: 1,
    testID: 'project-setup-share',
    scrollHost: 'bounded',
    dimensions: {
      width: HAPPIER_PAGE_METRICS.dialogWidthPx.wide,
      maxHeightRatio: 0.86,
      size: 'lg',
    },
    phonePresentation: 'sheet',
  };
}

/** "Share setup…" (lab L6 share): publishes this checkout's setup through the Source it was opened from. */
export function openProjectSetupShare(input: ProjectSetupShareInput) {
  Modal.show({
    component: ProjectSetupShareModal,
    props: input,
    chrome: shareChrome(input.source.name),
  });
}

/**
 * "Share setup…" is offered only for a checkout opened from a Source this person manages: the Source
 * owner admits the attachment, so the menu never shows a share that cannot succeed.
 */
export function useProjectSetupShareEntry(
  workspace: WorkspaceAddressV1,
  binding: ServerCredentialAccountScopeBinding | null,
  onOpenSource: (sourceId: string) => void,
): (() => void) | null {
  const sourceId = useProjectAccountWorkspaceRef(workspace.workspaceId, workspace.serverId)?.source?.sourceId ?? null;
  const read = useProjectSource(binding, sourceId);
  const source = read.source?.source ?? null;
  const manageable = source !== null && read.audience !== undefined;
  const serverIds = React.useMemo(() => [workspace.serverId], [workspace.serverId]);
  // Team names only label the audience of a Source this person can share; nobody else's page reads them.
  const teams = useTeamsDirectory({ serverIds, enabled: manageable });
  const teamName = React.useCallback((teamId: string) =>
    teams.rows.find(row => row.address.serverId === workspace.serverId && row.team.id === teamId)?.team.name ?? null,
  [teams.rows, workspace.serverId]);
  return React.useMemo(() => binding && source && manageable ? () => openProjectSetupShare({
    workspace, binding,
    source: { id: source.id, name: source.name, revision: source.revision },
    audience: presentShareAudience({ owner: source.owner, grants: source.audience, teamName }),
    onOpenSourceSharing: () => onOpenSource(source.id),
  }) : null, [binding, source, manageable, workspace, teamName, onOpenSource]);
}

function ProjectSetupShareModal(
  props: CustomModalInjectedProps & ProjectSetupShareInput,
) {
  const approval = useActionApprovalContinuation({
    scopeKey: `${props.workspace.serverId}:${props.workspace.workspaceId}:share`,
    serverId: props.workspace.serverId,
    onExecuted: () => {},
  });
  const sharing = useProjectSetupSharing(props.workspace, props.binding, {
    onApprovalPending: approval.requestApproval,
  });
  const controller = sharing.controller;
  // Opening the sheet is the demand; mounting the Scripts page reads nothing.
  React.useEffect(() => {
    void controller?.load();
  }, [controller]);
  const [result, setResult] = React.useState<ProjectSetupShareResult | null>(
    null,
  );
  const { onClose, source } = props;
  // The Source read follows pushes, so a retry after a conflict attaches at the revision it now has.
  const live = useProjectSource(props.binding, source.id).source?.source ?? null;
  const revision = live?.revision ?? source.revision;
  const share = React.useCallback(async () => {
    if (!controller) return;
    // The warning sits above the button that shares; pressing it is the acknowledgement.
    controller.acknowledgeWarning(true);
    const next = await controller.publish({
      sourceId: source.id,
      expectedRevision: revision,
      title: t('projects.scripts.share.artifactTitle', { source: source.name }),
    });
    setResult(next);
    if (next.kind !== 'attached') return;
    onClose();
    publishPresentationNotice({
      key: `project-setup-share:${source.id}`,
      severity: 'info',
      message: t('projects.scripts.share.shared', { source: source.name }),
    });
  }, [controller, onClose, source, revision]);
  return (
    <ProjectSetupShareView
      snapshot={sharing.snapshot}
      sourceName={source.name}
      audience={props.audience}
      result={result}
      approval={
        approval.approvalPending
          ? { summary: approval.approvalSummary, open: approval.openApproval }
          : null
      }
      onRetryRead={() => {
        void controller?.load();
      }}
      onShare={() => {
        void share();
      }}
      onOpenSourceSharing={() => {
        onClose();
        props.onOpenSourceSharing();
      }}
      onClose={onClose}
    />
  );
}

type ShareRow = Readonly<{ key: string; title: string; subtitle: string }>;

/** What the share carries, as the person recognises it: commands and names, never values. */
export function listProjectSetupShareRows(
  manifest: ProjectManifestV1,
): readonly ShareRow[] {
  const counted = (items: readonly string[]) =>
    `${items.length} · ${items.join(', ')}`;
  const commands = (
    sources: NonNullable<NonNullable<ProjectManifestV1['workspace']>['setup']>,
  ) => sources.map((source) => describeProjectCommandSource(source).reference);
  const rows: ShareRow[] = [];
  const setup = manifest.workspace?.setup ?? [];
  if (setup.length)
    rows.push({
      key: 'setup',
      title: t('projects.scripts.share.setupSteps'),
      subtitle: counted(commands(setup)),
    });
  const scripts = Object.keys(manifest.scripts ?? {});
  if (scripts.length)
    rows.push({
      key: 'scripts',
      title: t('projects.scripts.share.scripts'),
      subtitle: counted(scripts),
    });
  const services = Object.keys(manifest.services ?? {});
  if (services.length)
    rows.push({
      key: 'services',
      title: t('projects.scripts.share.services'),
      subtitle: counted(services),
    });
  const names = (manifest.environmentVariables ?? []).map(
    (variable) => variable.name,
  );
  if (names.length)
    rows.push({
      key: 'environment',
      title: t('projects.scripts.share.environment'),
      subtitle: `${names.join(', ')} · ${t('projects.scripts.share.namesOnly')}`,
    });
  const teardown = manifest.workspace?.teardown ?? [];
  if (teardown.length)
    rows.push({
      key: 'teardown',
      title: t('projects.scripts.share.cleanupSteps'),
      subtitle: counted(commands(teardown)),
    });
  const options = [
    // The tool itself (as the setup review names it), not the word "Tools".
    manifest.toolchain && manifest.toolchain.kind !== 'host'
      ? manifest.toolchain.kind === 'toolchain' ? manifest.toolchain.tool : manifest.toolchain.adapter.localId
      : null,
    manifest.devcontainer
      ? t('projects.scripts.sharedUpdate.devcontainer')
      : null,
    manifest.worktreePorts ? t('projects.scripts.sharedUpdate.ports') : null,
    manifest.workspace?.setupInputs?.length
      ? t('projects.scripts.sharedUpdate.inputs')
      : null,
  ].filter((value): value is string => value !== null);
  if (options.length)
    rows.push({
      key: 'options',
      title: t('projects.scripts.share.options'),
      subtitle: options.join(', '),
    });
  return rows;
}

/** What the share sheet shows for one sharing state; the specimen mounts it with fixture snapshots. */
export function ProjectSetupShareView(
  props: Readonly<{
    snapshot: ProjectSetupSharingSnapshot | null;
    sourceName: string;
    audience: string;
    result: ProjectSetupShareResult | null;
    approval: Readonly<{ summary: string | null; open: () => void }> | null;
    onRetryRead: () => void;
    onShare: () => void;
    onOpenSourceSharing: () => void;
    onClose: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { snapshot, result } = props;
  const [exact, setExact] = React.useState(false);
  const manifest = snapshot?.preview?.manifest ?? null;
  const rows = React.useMemo(
    () => (manifest ? listProjectSetupShareRows(manifest) : []),
    [manifest],
  );
  const ready = snapshot?.status === 'ready' && snapshot.preview !== null;
  const pending = snapshot?.pending === true;

  let content: React.ReactNode;
  if (
    !snapshot ||
    snapshot.status === 'initial' ||
    snapshot.status === 'loading'
  ) {
    content = (
      <ItemGroup surface="none">
        <Item
          mode="info"
          testID="project-setup-share.reading"
          showChevron={false}
          title={t('projects.scripts.share.reading')}
        />
      </ItemGroup>
    );
  } else if (!ready) {
    content = (
      <AttentionBanner
        testID="project-setup-share.unreadable"
        tone="warning"
        title={t('projects.scripts.share.unreadable')}
        action={{ label: t('common.retry'), onPress: props.onRetryRead }}
      />
    );
  } else {
    content = (
      <>
        <Text style={[styles.lead, { color: theme.colors.text.secondary }]}>
          {t('projects.scripts.share.lead', { source: props.sourceName })}
        </Text>
        <ItemGroup
          title={t('projects.scripts.share.whatItShares')}
          description={t('projects.scripts.share.warning')}
          testID="project-setup-share.contents"
        >
          {rows.length === 0 ? (
            <Item
              mode="info"
              testID="project-setup-share.empty"
              showChevron={false}
              title={t('projects.scripts.share.empty')}
            />
          ) : (
            rows.map((row, index) => (
              <Item
                key={row.key}
                mode="info"
                testID={`project-setup-share.row:${row.key}`}
                title={row.title}
                subtitle={row.subtitle}
                subtitleLines={2}
                showChevron={false}
                showDivider={index < rows.length - 1}
              />
            ))
          )}
        </ItemGroup>
        {snapshot.personalOmitted > 0 ? (
          <Text
            testID="project-setup-share.personal"
            style={[styles.fact, { color: theme.colors.text.secondary }]}
          >
            {t('projects.scripts.share.personalOmitted', {
              count: snapshot.personalOmitted,
            })}
          </Text>
        ) : null}
        <ItemGroup
          title={t('projects.scripts.share.whoGetsIt')}
          testID="project-setup-share.audience"
        >
          <Item
            testID="project-setup-share.audience.row"
            title={t('projects.sources.sharedWith')}
            subtitle={t('projects.scripts.share.fromSource')}
            detail={props.audience}
            onPress={props.onOpenSourceSharing}
          />
        </ItemGroup>
        <View style={styles.exact}>
          <TextLinkButton
            testID="project-setup-share.exact"
            label={
              exact
                ? t('projects.scripts.share.hideExact')
                : t('projects.scripts.share.showExact')
            }
            expanded={exact}
            onPress={() => setExact((value) => !value)}
          />
          {exact && snapshot.preview ? (
            <View testID="project-setup-share.bytes" style={styles.bytes}>
              <CodeView code={snapshot.preview.bytes} language="json" wrap />
            </View>
          ) : null}
        </View>
        {props.approval ? (
          <ActionApprovalPendingNotice
            testID="project-setup-share.approval"
            message={t('approvals.waitingForYou')}
            summary={props.approval.summary}
            onOpenApproval={props.approval.open}
          />
        ) : null}
        {result?.kind === 'savedNotAttached' ||
        result?.kind === 'unavailable' ? (
          <AttentionBanner
            testID="project-setup-share.failure"
            tone="warning"
            title={
              result.kind === 'savedNotAttached'
                ? t('projects.scripts.share.notAttached', {
                    source: props.sourceName,
                  })
                : t('projects.scripts.share.unreadable')
            }
            description={
              result.kind === 'savedNotAttached'
                ? t('projects.scripts.share.notAttachedBody')
                : undefined
            }
            details={[result.code]}
          />
        ) : null}
      </>
    );
  }
  return (
    <View style={styles.body}>
      {/* The lab draws the sheet's sections with page anatomy: description above, hairline rows. */}
      <ListPresentationProvider value="page">{content}</ListPresentationProvider>
      <View style={styles.footer}>
        <View style={styles.note}>
          <Icon name="lock" size={14} color={theme.colors.text.tertiary} />
          <Text
            variant="meta"
            style={[styles.noteText, { color: theme.colors.text.secondary }]}
          >
            {t('projects.scripts.share.note')}
          </Text>
        </View>
        <View style={styles.actions}>
          <RoundButton
            size="normal"
            display="secondary"
            testID="project-setup-share.cancel"
            title={t('common.cancel')}
            disabled={pending}
            onPress={props.onClose}
          />
          <RoundButton
            size="normal"
            testID="project-setup-share.share"
            title={t('projects.scripts.share.share')}
            loading={pending}
            disabled={!ready || rows.length === 0 || pending}
            onPress={props.onShare}
          />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.space.s16, paddingBottom: theme.space.s8 },
  // Free text and the footer stand on the sections' text edge, not the sheet's.
  lead: { ...happierPageTextMetrics('sectionDescription'), paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx },
  fact: {
    ...happierPageTextMetrics('sectionDescription'),
    paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx,
    marginTop: -theme.space.s8,
  },
  exact: { gap: theme.space.s8, alignItems: 'flex-start', paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx },
  bytes: { alignSelf: 'stretch' },
  footer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: theme.space.s12,
    paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx,
  },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 240,
  },
  noteText: { flex: 1, minWidth: 0 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.space.s8,
  },
}));
