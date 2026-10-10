import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { StoredPluginUiNewSessionSeedOriginV1Schema, type PluginUiNewSessionSeedOriginV1 } from '@happier-dev/protocol/plugins/ui';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { readProjectSessionAuthoringOrigin } from '@/components/projects/detail/projectRouteState';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { isMobileLayoutWidth } from '@/components/sessions/layout/isMobileLayoutWidth';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { storage, useMachine } from '@/sync/domains/state/storage';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useSessionSelector } from '@/sync/store/hooks';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { t } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

import { useProjectDefinitionInspection } from './useProjectDefinitionInspection';
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

/** "5 scripts · 2 services" from the checkout's definition (plan 20's passive owner), or no project file yet. */
function useDefinitionSummary(
  origin: PluginUiNewSessionSeedOriginV1 | null,
): string | null {
  const { binding } = useServerCredentialAccountScopeBinding(origin?.workspace.serverId);
  const { read } = useProjectDefinitionInspection(
    origin?.workspace ?? null,
    binding?.accountId === origin?.accountId ? binding : null,
  );
  if (!read || 'error' in read) return null;
  const document = read.value.definition.document;
  if (document === null) return t('projects.widgets.noProjectFile');
  if (document.status !== 'valid') return null;
  const scripts = Object.keys(document.manifest.scripts ?? {}).length;
  const services = Object.keys(document.manifest.services ?? {}).length;
  return [
    t('projects.authoring.scriptsCount', { count: scripts }),
    ...(services > 0
      ? [t('projects.authoring.servicesCount', { count: services })]
      : []),
  ].join(' · ');
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
  const summary = useDefinitionSummary(props.origin);
  if (scripts.destination.kind !== 'ready') return null;
  const project = resolveWorkspaceRefDisplayName(
    scripts.destination.workspaceRef,
  );
  return (
    <View style={styles.card} testID="project-setup-return">
      <ItemGroup>
        <Item
          testID="project-setup-return.item"
          icon={
            <Icon name="play" size={18} color={theme.colors.text.secondary} />
          }
          title={`${project} · ${t('projects.pages.scripts')}`}
          subtitle={summary ?? undefined}
          showChevron={false}
          accessoryLayout="adaptive"
          rightElement={
            <View style={styles.actions}>
              {changes.destination.kind === 'ready' ? (
                <RoundButton
                  testID="project-setup-return.changes"
                  size="small"
                  display="inverted"
                  title={t('projects.authoring.reviewChanges')}
                  onPress={() => {
                    changes.onReturnToProject();
                  }}
                />
              ) : null}
              <RoundButton
                testID="project-setup-return.scripts"
                size="small"
                display="secondary"
                title={t('projects.authoring.returnScripts')}
                onPress={() => {
                  scripts.onReturnToProject();
                }}
              />
            </View>
          }
        />
      </ItemGroup>
    </View>
  );
}

/** The draft's checkout and Machine, admitted through the same qualified-return owner as its way back. */
function useProjectSetupDraftTarget(origin: PluginUiNewSessionSeedOriginV1) {
  const scripts = useProjectAuthoringReturn(origin);
  const machine = useMachine(origin.workspace.machineId);
  if (scripts.destination.kind !== 'ready') return null;
  return {
    project: resolveWorkspaceRefDisplayName(scripts.destination.workspaceRef),
    machine: getMachineDisplayName(machine) ?? origin.workspace.machineId,
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
    const page =
      props.origin.page === 'changes'
        ? t('projects.pages.changes')
        : t('projects.pages.scripts');
    return (
      <View testID="project-setup-draft-origin" style={styles.draftHeader}>
        <View style={styles.eyebrow}>
          <Icon name="sparkle" size={14} color={theme.colors.text.tertiary} />
          <Text style={[styles.eyebrowText, { color: theme.colors.text.tertiary }]}>
            {t('projects.authoring.fromPage', { project: target.project, page })}
          </Text>
        </View>
        <Text accessibilityRole="header" style={[styles.draftTitle, { color: theme.colors.text.primary }]}>
          {t('projects.authoring.draftTitle', { project: target.project })}
        </Text>
        <Text style={[styles.draftDescription, { color: theme.colors.text.secondary }]}>
          {t('projects.authoring.draftDescription')}
        </Text>
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
    if (!target) return null;
    return (
      <View testID="project-setup-draft-footnote" style={styles.footnote}>
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
  draftHeader: { gap: 6, paddingBottom: 20 },
  eyebrow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  eyebrowText: { ...Typography.default('regular'), ...happierPageTextMetrics('meta') },
  draftTitle: { ...Typography.default('bold'), ...happierPageTextMetrics('heroTitle') },
  draftDescription: { ...Typography.default('regular'), ...happierPageTextMetrics('pageDescription') },
  footnote: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, paddingTop: 12 },
  authored: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 },
  authoredSession: { ...Typography.default('semiBold') },
  authoredText: { ...Typography.default('regular'), ...happierPageTextMetrics('meta'), flex: 1, minWidth: 0 },
  footnoteText: { ...Typography.default('regular'), ...happierPageTextMetrics('meta'), flex: 1, minWidth: 0 },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
}));

/** The latest Session started from setup authoring for this exact checkout, as one primitive key. */
function useProjectLastAuthoringSessionId(workspace: WorkspaceAddressV1): string | null {
  return storage((state) => {
    let latest: { id: string; at: number } | null = null;
    for (const session of Object.values(state.sessions)) {
      if (session.metadata?.machineId !== workspace.machineId) continue;
      const origin = readProjectSessionAuthoringOrigin(readSessionOwnerMetadataView(session));
      if (!origin || origin.workspace.workspaceId !== workspace.workspaceId
        || origin.workspace.serverId !== workspace.serverId) continue;
      const at = session.updatedAt;
      if (!latest || at > latest.at) latest = { id: session.id, at };
    }
    return latest?.id ?? null;
  });
}

/**
 * Back on Scripts after setup authoring (lab `s-setup` RESULT): which Session last authored this
 * checkout's project file and when, with the way to its changes. It states provenance only; setup
 * readiness stays on the Setup row's own operation.
 */
export const ProjectSetupAuthoredLine = React.memo(function ProjectSetupAuthoredLine(
  props: Readonly<{ workspace: WorkspaceAddressV1; compact?: boolean }>,
) {
  const sessionId = useProjectLastAuthoringSessionId(props.workspace);
  if (!sessionId) return null;
  return <ProjectSetupAuthoredLineBody sessionId={sessionId} compact={props.compact === true} />;
});

function ProjectSetupAuthoredLineBody(props: Readonly<{ sessionId: string; compact: boolean }>) {
  const { theme } = useUnistyles();
  const session = storage((state) => state.sessions[props.sessionId] ?? null);
  const origin = React.useMemo(
    () => (session ? readProjectSessionAuthoringOrigin(readSessionOwnerMetadataView(session)) : null),
    [session],
  );
  const changesOrigin = React.useMemo(() => (origin ? { ...origin, page: 'changes' as const } : null), [origin]);
  const changes = useProjectAuthoringReturn(changesOrigin);
  // Phones keep the provenance line alone (lab `s-setup` RESULTp); Changes is a tab away there.
  const { width } = useWindowDimensions();
  const compact = props.compact || isMobileLayoutWidth(width);
  if (!session) return null;
  const sessionName = getSessionName(session);
  const text = t('projects.authoring.lastSession', {
    session: sessionName,
    time: formatAsOfTime(session.updatedAt),
  });
  // The Session's name carries the line (lab RESULT); every locale places it, so emphasize it where it falls.
  const at = text.indexOf(sessionName);
  return (
    <ItemGroup surface="none">
    <View
      testID="project-setup-authored"
      style={[styles.authored, { backgroundColor: theme.colors.surface.inset }]}
    >
      <Icon name="sparkle" size={14} color={theme.colors.text.tertiary} />
      <Text style={[styles.authoredText, { color: theme.colors.text.secondary }]} numberOfLines={compact ? 1 : 2}>
        {at < 0 ? text : (
          <>
            {text.slice(0, at)}
            <Text style={[styles.authoredText, styles.authoredSession, { color: theme.colors.text.primary }]}>{sessionName}</Text>
            {text.slice(at + sessionName.length)}
          </>
        )}
      </Text>
      {!compact && changes.destination.kind === 'ready' ? (
        <RoundButton
          testID="project-setup-authored.changes"
          size="small"
          display="inverted"
          title={t('projects.authoring.reviewChanges')}
          onPress={() => { changes.onReturnToProject(); }}
        />
      ) : null}
    </View>
    </ItemGroup>
  );
}
