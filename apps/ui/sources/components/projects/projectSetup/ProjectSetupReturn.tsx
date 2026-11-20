import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { StoredPluginUiNewSessionSeedOriginV1Schema, type PluginUiNewSessionSeedOriginV1 } from '@happier-dev/protocol/plugins/ui';
import { resolveWorkspacePathBasenameV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

import { readProjectSessionAuthoringOrigin } from '@/components/projects/detail/projectRouteState';
import { projectPageGlyph, projectPageLabel } from '@/components/projects/shell/ProjectShellHeader';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { HAPPIER_PAGE_METRICS, happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Icon } from '@/components/ui/icons/Icon';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { useLayoutMaxWidthStyle } from '@/components/ui/layout/layout';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useSessionSelector, useServerScopedMachine } from '@/sync/store/hooks';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
export { ProjectSetupAuthoredLine } from './ProjectSetupAuthoredLine';

import { useProjectSetupReturnInspection } from './useProjectSetupReturnInspection';
import { projectSetupReadinessLine } from './projectSetupReadinessLine';
import { useProjectAuthoringReturn } from './useProjectSetupAuthoring';

/**
 * Both return destinations of one setup origin, through the one qualified-return owner: Scripts and
 * Changes of the admitted original checkout (its comparison kept), never the launch Machine/folder.
 */
function useProjectSetupReturn(origin: PluginUiNewSessionSeedOriginV1 | null) {
  const scriptsOrigin = React.useMemo(
    () => (origin ? { ...origin, page: 'scripts' as const } : null),
    [origin],
  );
  const changesOrigin = React.useMemo(
    () => (origin ? { ...origin, page: 'changes' as const } : null),
    [origin],
  );
  const scripts = useProjectAuthoringReturn(scriptsOrigin);
  const changes = useProjectAuthoringReturn(changesOrigin);
  return { scripts, changes };
}

/**
 * The end of a Session started from Project setup (lab `s-setup` DONE): which Project it came from,
 * what its definition holds now, then Review changes and Back to Scripts. Nothing renders for a
 * Session without a stored Project origin or when that checkout is no longer this Account's.
 */
export const ProjectSetupSessionReturn = React.memo(function ProjectSetupSessionReturn(
  props: Readonly<{ sessionId: string; serverId?: string | null }>,
) {
  // A primitive projection of the owner view: unrelated metadata writes never re-render this footer.
  const originKey = useSessionSelector(props.sessionId, props.serverId, (session) => {
    if (!session) return null;
    const origin = readProjectSessionAuthoringOrigin(readSessionOwnerMetadataView(session));
    return origin ? JSON.stringify(origin) : null;
  });
  const origin = React.useMemo(
    () => (originKey ? StoredPluginUiNewSessionSeedOriginV1Schema.parse(JSON.parse(originKey)) : null),
    [originKey],
  );
  if (!origin) return null;
  return <ProjectSetupSessionReturnCard origin={origin} />;
});

function ProjectSetupSessionReturnCard(
  props: Readonly<{ origin: PluginUiNewSessionSeedOriginV1 }>,
) {
  const { theme } = useUnistyles();
  const { scripts, changes } = useProjectSetupReturn(props.origin);
  const original = useProjectAuthoringReturn(props.origin);
  // Setup authoring returns to Scripts; Explain/Ask from a review returns to that comparison only.
  const ordinary = props.origin.purpose === 'session' || (props.origin.page !== 'scripts' && props.origin.page !== 'changes');
  const fromChanges = props.origin.page === 'changes';
  const { summary, setupReadiness } = useProjectSetupReturnInspection(!ordinary && !fromChanges ? props.origin : null);
  const facts = [summary, projectSetupReadinessLine(setupReadiness)].filter((fact): fact is string => Boolean(fact)).join(' · ');
  const home = ordinary ? original : fromChanges ? changes : scripts;
  if (home.destination.kind !== 'ready') return null;
  const project = resolveWorkspaceRefDisplayName(home.destination.workspaceRef);
  return (
    <View style={styles.card} testID="project-setup-return">
      <ItemGroup>
        <Item
          testID="project-setup-return.item"
          icon={
            <Icon
              name={projectPageGlyph(props.origin.page)}
              size={18}
              color={theme.colors.text.secondary}
            />
          }
          title={`${project} · ${projectPageLabel(props.origin.page)}`}
          subtitle={facts || undefined}
          showChevron={false}
          accessoryLayout="adaptive"
          rightElement={
            <View style={styles.actions}>
              {ordinary ? (
                <RoundButton
                  testID="project-setup-return.origin"
                  size="small"
                  display="secondary"
                  title={projectPageLabel(props.origin.page)}
                  onPress={() => { original.onReturnToProject(); }}
                />
              ) : changes.destination.kind === 'ready' ? (
                <RoundButton
                  testID="project-setup-return.changes"
                  size="small"
                  display={fromChanges ? 'secondary' : 'inverted'}
                  title={t('projects.authoring.reviewChanges')}
                  onPress={() => {
                    changes.onReturnToProject();
                  }}
                />
              ) : null}
              {ordinary || fromChanges ? null : (
                <RoundButton
                  testID="project-setup-return.scripts"
                  size="small"
                  display="secondary"
                  title={t('projects.authoring.returnScripts')}
                  onPress={() => {
                    scripts.onReturnToProject();
                  }}
                />
              )}
            </View>
          }
        />
      </ItemGroup>
    </View>
  );
}

/** A retained draft keeps its identity while Project rows load; return admission remains separate. */
function useProjectSetupDraftTarget(origin: PluginUiNewSessionSeedOriginV1) {
  const scripts = useProjectAuthoringReturn(origin);
  const { binding } = useServerCredentialAccountScopeBinding(origin.workspace.serverId);
  const machineId = origin.workspace.kind === 'managed' ? origin.workspace.controller.machineId : origin.workspace.machineId;
  const machine = useServerScopedMachine(origin.workspace.serverId, machineId);
  if (scripts.destination.kind !== 'ready'
    && (!binding?.isCurrent() || binding.accountId !== origin.accountId)) return null;
  return {
    project: scripts.destination.kind === 'ready'
      ? resolveWorkspaceRefDisplayName(scripts.destination.workspaceRef)
      : resolveWorkspacePathBasenameV1(origin.workspace.rootPath) ?? origin.workspace.rootPath,
    machine: machine ? getMachineSentenceName(machine) : machineId,
  };
}

/**
 * Above the seeded composer (lab `s-setup` ENTRY): where the draft came from, what it is, and that it
 * is editable. The ordinary composer below owns every option and the explicit Send; the way back is the
 * screen's own navigation, not a second button.
 */
export const ProjectSetupDraftHeader = React.memo(
  function ProjectSetupDraftHeader(
    props: Readonly<{ origin: PluginUiNewSessionSeedOriginV1 }>,
  ) {
    const { theme } = useUnistyles();
    const target = useProjectSetupDraftTarget(props.origin);
    if (!target) return null;
    const setup = props.origin.page === 'scripts' && props.origin.purpose !== 'session';
    const origin = t('projects.authoring.fromPage', { project: target.project, page: projectPageLabel(props.origin.page) });
    return (
      <View testID="project-setup-draft-origin" style={styles.draftHeader}>
        {setup ? (
          <PageHeader
            testID="project-setup-draft-origin.header"
            title={t('projects.authoring.draftTitle', { project: target.project })}
            alwaysShowTitle
            description={t('projects.authoring.draftDescription')}
            meta={[{ key: 'origin', icon: 'sparkle', text: origin }]}
          />
        ) : (
          <View style={styles.eyebrow}>
            <Icon name="sparkle" size={14} color={theme.colors.text.tertiary} />
            <Text style={[styles.eyebrowText, { color: theme.colors.text.tertiary }]}>{origin}</Text>
          </View>
        )}
      </View>
    );
  },
);

/** Below the seeded composer: the exact authoring target, and that nothing starts before Send. */
export const ProjectSetupDraftFootnote = React.memo(
  function ProjectSetupDraftFootnote(
    props: Readonly<{ origin: PluginUiNewSessionSeedOriginV1 }>,
  ) {
    const { theme } = useUnistyles();
    const target = useProjectSetupDraftTarget(props.origin);
    // The composer's own column: the note starts where the composer's text and the header above it start.
    const column = useLayoutMaxWidthStyle();
    if (!target) return null;
    return (
      <View testID="project-setup-draft-footnote" style={[styles.footnote, column]}>
        <Icon name="info" size={14} color={theme.colors.text.tertiary} />
        <Text style={[styles.footnoteText, { color: theme.colors.text.tertiary }]}>
          {t('projects.authoring.draftFootnote', { workspace: target.project, machine: target.machine })}
        </Text>
      </View>
    );
  },
);

const styles = StyleSheet.create(() => ({
  card: { marginTop: 12 },
  draftHeader: { paddingBottom: 16 },
  eyebrow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx, paddingTop: HAPPIER_PAGE_METRICS.pageHeaderPaddingTopPx },
  eyebrowText: { ...Typography.default('regular'), ...happierPageTextMetrics('meta') },
  footnote: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingTop: 12, paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx, width: '100%', alignSelf: 'center' },
  footnoteText: { ...Typography.default('regular'), ...happierPageTextMetrics('meta'), flex: 1, minWidth: 0 },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
}));
