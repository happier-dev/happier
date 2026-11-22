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
import type { ProjectSetupExportPathV1, ProjectSetupExportUnitV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectSetupExportV1';
import { SelectionCheckGlyph } from '@/components/ui/selection/SelectionCheckGlyph';

const NO_UNITS: readonly ProjectSetupExportUnitV1[] = Object.freeze([]);
const NO_SELECTION: readonly ProjectSetupExportPathV1[] = Object.freeze([]);
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
      onSelect={(selection) => controller?.select(selection)}
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

type ShareRowKind = 'setup' | 'scripts' | 'services' | 'environment' | 'teardown' | 'options';
type ShareRow = Readonly<{
  key: string;
  title: string;
  subtitle: string;
  layer: ProjectSetupExportUnitV1['layer'];
  paths: readonly ProjectSetupExportPathV1[];
  selected: boolean;
}>;
const ROW_ORDER: readonly ShareRowKind[] = ['setup', 'scripts', 'services', 'environment', 'teardown', 'options'];
const LAYER_ORDER: readonly ProjectSetupExportUnitV1['layer'][] = ['shared', 'personal', 'repository'];
const samePath = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((part, index) => part === b[index]);

function shareRowKind(path: readonly string[]): ShareRowKind {
  if (path[0] === 'workspace') return path[1] === 'setup' ? 'setup' : path[1] === 'teardown' ? 'teardown' : 'options';
  if (path[0] === 'scripts' || path[0] === 'services') return path[0];
  return path[0] === 'environmentVariables' ? 'environment' : 'options';
}

/**
 * What the share can carry, as the person recognises it: one row per kind and origin, commands and
 * names, never values. A kind decided by two layers splits so the repository's own lines can stay out.
 */
export function listProjectSetupShareRows(
  manifest: ProjectManifestV1,
  units: readonly ProjectSetupExportUnitV1[],
  selection: readonly ProjectSetupExportPathV1[],
): readonly ShareRow[] {
  const counted = (items: readonly string[]) => `${items.length} · ${items.join(', ')}`;
  const commands = (sources: NonNullable<NonNullable<ProjectManifestV1['workspace']>['setup']>) =>
    sources.map((source) => describeProjectCommandSource(source).reference);
  const option = (path: readonly string[]): string | null => {
    const [field, key] = path;
    if (field === 'toolchain') return manifest.toolchain && manifest.toolchain.kind !== 'host'
      ? manifest.toolchain.kind === 'toolchain' ? manifest.toolchain.tool : manifest.toolchain.adapter.localId
      : t('projects.scripts.share.hostTools');
    if (field === 'devcontainer') return t('projects.scripts.sharedUpdate.devcontainer');
    if (field === 'worktreePorts') return t('projects.scripts.sharedUpdate.ports');
    if (field === 'workspace' && key === 'setupInputs') return t('projects.scripts.sharedUpdate.inputs');
    return null;
  };
  const groups = new Map<string, { kind: ShareRowKind; layer: ProjectSetupExportUnitV1['layer']; paths: ProjectSetupExportPathV1[] }>();
  for (const unit of units) {
    const kind = shareRowKind(unit.path);
    const key = `${kind}:${unit.layer}`;
    const group = groups.get(key) ?? { kind, layer: unit.layer, paths: [] };
    group.paths.push(unit.path);
    groups.set(key, group);
  }
  const rows: ShareRow[] = [];
  for (const kind of ROW_ORDER) for (const layer of LAYER_ORDER) {
    const group = groups.get(`${kind}:${layer}`);
    if (!group) continue;
    const names = group.paths.map((path) => path[1] ?? path[0]!);
    const what = kind === 'setup' ? counted(commands(manifest.workspace?.setup ?? []))
      : kind === 'teardown' ? counted(commands(manifest.workspace?.teardown ?? []))
        : kind === 'environment' ? `${names.join(', ')} · ${t('projects.scripts.share.namesOnly')}`
          : kind === 'options' ? group.paths.map(option).filter((value): value is string => value !== null).join(', ')
            : counted(names);
    const origin = layer === 'repository' ? t('projects.scripts.share.fromRepository')
      : layer === 'personal' ? t('projects.scripts.share.justForYou') : t('projects.scripts.share.fromShared');
    rows.push({
      key: `${kind}:${layer}`,
      title: t(`projects.scripts.share.${kind === 'setup' ? 'setupSteps' : kind === 'teardown' ? 'cleanupSteps' : kind}`),
      subtitle: what ? `${what} · ${origin}` : origin,
      layer,
      paths: group.paths,
      selected: group.paths.every((path) => selection.some((chosen) => samePath(chosen, path))),
    });
  }
  return rows;
}

/** Toggles one row's declarations in the selection, keeping every other choice as it was. */
export function toggleProjectSetupShareRow(
  selection: readonly ProjectSetupExportPathV1[],
  row: Pick<ShareRow, 'paths' | 'selected'>,
): ProjectSetupExportPathV1[] {
  const rest = selection.filter((chosen) => !row.paths.some((path) => samePath(chosen, path)));
  return row.selected ? rest : [...rest, ...row.paths];
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
    onSelect: (selection: ProjectSetupExportPathV1[]) => void;
    onShare: () => void;
    onOpenSourceSharing: () => void;
    onClose: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const { snapshot, result } = props;
  const [exact, setExact] = React.useState(false);
  const manifest = snapshot?.manifest ?? null;
  const units = snapshot?.units ?? NO_UNITS;
  const selection = snapshot?.selection ?? NO_SELECTION;
  const rows = React.useMemo(
    () => (manifest ? listProjectSetupShareRows(manifest, units, selection) : []),
    [manifest, units, selection],
  );
  const chosen = rows.some((row) => row.selected);
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
                testID={`project-setup-share.row:${row.key}`}
                accessibilityRole="checkbox"
                selected={row.selected}
                disabled={pending}
                icon={<SelectionCheckGlyph state={row.selected ? 'checked' : 'unchecked'} />}
                title={row.title}
                subtitle={row.subtitle}
                subtitleLines={2}
                showChevron={false}
                showDivider={index < rows.length - 1}
                onPress={() => props.onSelect(toggleProjectSetupShareRow(selection, row))}
              />
            ))
          )}
        </ItemGroup>
        {rows.some((row) => row.layer === 'repository' && !row.selected) ? (
          <Text
            testID="project-setup-share.repository"
            style={[styles.fact, { color: theme.colors.text.secondary }]}
          >
            {t('projects.scripts.share.repositoryLeftOut')}
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
            disabled={!ready || !chosen || pending}
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
