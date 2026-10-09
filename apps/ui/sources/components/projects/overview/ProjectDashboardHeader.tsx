import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { WidgetDashboardSummaryV1 } from '@happier-dev/protocol/widgets';

import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { showDocumentShareSheet } from '@/components/sharing/documents/showDocumentShareSheet';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Modal } from '@/modal';
import { readProjectWidgetAreaContextV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';

import { useProjectSources } from '../sources/useProjectSources';
import { formatProjectSourceAddress } from '../sources/projectSourceAddress';
import { readSourceTeamId } from '../sources/ProjectSourcesRail';
import {
  ProjectDashboardBar,
  type ProjectDashboardActions,
  type ProjectDashboardOption,
} from './ProjectDashboardBar';
import { resolveProjectOverviewArrangement } from './ProjectOverviewLayout';
import { useProjectDashboards } from './useProjectDashboards';

/** The route's dashboard id for a summary: omitted for the default Overview (its stable identity). */
export function projectDashboardRouteId(
  dashboard: WidgetDashboardSummaryV1,
): string | null {
  return dashboard.surface.owner.kind === 'project'
    ? (dashboard.surface.owner.dashboardId ?? null)
    : null;
}

/**
 * The Overview's dashboard header (12s3): the bar bound to the canonical dashboard Actions and the
 * route's selection, plus the one place an unconfirmed delete says so (lab `p-overview` STATES D4).
 * Switching is route navigation only; it writes no layout and grants nothing.
 */
export const ProjectDashboardHeader = React.memo(function ProjectDashboardHeader(
  props: Readonly<{
    workspaceRef: WorkspaceRefV1;
    activeRootPath: string;
    activeWorktreeId?: string | null;
    projectName: string;
    /** The route's selected named dashboard; null is the default Overview. */
    dashboardId: string | null;
    onSelectDashboard: (dashboardId: string | null) => void;
  }>,
) {
  const serverId = props.workspaceRef.serverId;
  const projectKey = React.useMemo(
    () => readProjectWidgetAreaContextV1({ serverId, projectRef: props.workspaceRef }).projectIdentity?.projectKey ?? null,
    [props.workspaceRef, serverId],
  );
  // The destination controller preserves the admitted checkout and selected pane resource.
  const onSelectDashboard = props.onSelectDashboard;
  const phone = useDeviceType() === 'phone';
    const scope = useActiveServerAccountScope(serverId);
    const dashboards = useProjectDashboards({
      serverId: serverId,
      projectKey,
    });
    const [width, setWidth] = React.useState<number | null>(null);
    const [unconfirmedDelete, setUnconfirmedDelete] = React.useState<
      string | null
    >(null);
    const [sourcesDemanded, setSourcesDemanded] = React.useState(false);
    const sources = useProjectSources(
      scope ?? { serverId: serverId, accountId: '' },
      { enabled: sourcesDemanded && scope !== null },
    );
    const list = dashboards.state.dashboards;
    const selected =
      list.find(
        (entry) => projectDashboardRouteId(entry) === props.dashboardId,
      ) ??
      list.find((entry) => entry.isDefault) ??
      null;

    // The default Overview is always an entry, even before the inventory answers: nothing jumps on arrival.
  const options = React.useMemo((): readonly ProjectDashboardOption[] => (list.length > 0
    ? list.map((entry) => ({ id: entry.artifactId, name: entry.name, isDefault: entry.isDefault }))
    : [{ id: 'default', name: t('projects.pages.overview'), isDefault: true }]), [list]);

  const select = React.useCallback(
      (artifactId: string) => {
        const entry = list.find(
          (candidate) => candidate.artifactId === artifactId,
        );
        if (entry) onSelectDashboard(projectDashboardRouteId(entry));
      },
      [list, onSelectDashboard],
    );

    const create = React.useCallback(async () => {
      const name = (
        await Modal.prompt(
          t('projects.dashboard.create'),
          t('projects.dashboard.createBody', { project: props.projectName }),
          {
            placeholder: t('projects.dashboard.namePlaceholder'),
            confirmText: t('common.create'),
          },
        )
      )?.trim();
      if (!name) return;
      const outcome = await dashboards.create(name);
      if (outcome.ok && outcome.dashboard)
        onSelectDashboard(projectDashboardRouteId(outcome.dashboard));
    }, [dashboards, onSelectDashboard, props.projectName]);

    const actions = React.useMemo((): ProjectDashboardActions | null => {
      if (!selected || !scope) return null;
      const at = list.indexOf(selected);
      const previous = at > 0 ? list[at - 1] : null;
      const next = at >= 0 && at < list.length - 1 ? list[at + 1] : null;
      const teamSources = sources.state.rows.filter(
        (source) =>
          readSourceTeamId(source) !== null &&
          source.createdByAccountId === scope.accountId,
      );
      return {
        share: () =>
          showDocumentShareSheet({
            kind: 'widget-area-layout.v1',
            artifactId: selected.artifactId,
            name: selected.name,
            subtitle: `${t('projects.dashboard.label')} · ${props.projectName}`,
          }),
        attach: {
          header: t('projects.dashboard.attachHeaderAny'),
          sources: teamSources.map((source) => ({
            id: source.id,
            name: source.name,
            address: formatProjectSourceAddress(source.repository),
            attached: (source.attachments ?? []).some(
              (attachment) =>
                attachment.purpose === 'dashboard' &&
                attachment.ref.artifactId === selected.artifactId,
            ),
          })),
          onToggle: (sourceId) => {
            const source = teamSources.find(
              (candidate) => candidate.id === sourceId,
            );
            if (!source) return;
            const attached = (source.attachments ?? []).some(
              (attachment) =>
                attachment.purpose === 'dashboard' &&
                attachment.ref.artifactId === selected.artifactId,
            );
            const ref = {
              kind: 'doc' as const,
              artifactId: selected.artifactId,
            };
            void sources.controller.select(source.id).then(() =>
              sources.controller.updateSource({
                attachment: attached
                  ? { kind: 'detach', purpose: 'dashboard', ref }
                  : {
                      kind: 'attach',
                      attachment: { purpose: 'dashboard', ref },
                    },
              }),
            );
          },
          onDemand: () => setSourcesDemanded(true),
        },
        rename: async () => {
          const name = (
            await Modal.prompt(t('projects.dashboard.renameTitle'), undefined, {
              defaultValue: selected.name,
              placeholder: t('projects.dashboard.namePlaceholder'),
              confirmText: t('common.rename'),
            })
          )?.trim();
          if (name && name !== selected.name)
            await dashboards.rename(selected, name);
        },
        ...(previous
          ? {
              moveBefore: {
                name: previous.name,
                onPress: () => {
                  void dashboards.reorder(selected, {
                    anchorId: previous.artifactId,
                    placement: 'before',
                  });
                },
              },
            }
          : {}),
        ...(next
          ? {
              moveAfter: {
                name: next.name,
                onPress: () => {
                  void dashboards.reorder(selected, {
                    anchorId: next.artifactId,
                    placement: 'after',
                  });
                },
              },
            }
          : {}),
        delete: selected.isDefault
          ? { disabledReason: t('projects.dashboard.defaultProtected') }
          : {
              onPress: async () => {
                const confirmed = await Modal.confirm(
                  t('projects.dashboard.deleteConfirmTitle', {
                    name: selected.name,
                  }),
                  t('projects.dashboard.deleteConfirmBody'),
                  {
                    confirmText: t('projects.dashboard.deleteLabel'),
                    destructive: true,
                  },
                );
                if (!confirmed) return;
                const outcome = await dashboards.remove(selected);
                if (!outcome.ok) {
                  setUnconfirmedDelete(selected.name);
                  return;
                }
                setUnconfirmedDelete(null);
                // Only after the acknowledged delete does the page return to the retained default.
                onSelectDashboard(null);
                publishPresentationNotice({
                  key: `dashboard-deleted:${selected.artifactId}`,
                  message: t('projects.dashboard.deleted', {
                    name: selected.name,
                  }),
                  severity: 'info',
                });
              },
            },
      };
    }, [
      dashboards,
      list,
      onSelectDashboard,
      props,
      scope,
      selected,
      sources.controller,
      sources.state.rows,
    ]);

    const narrow =
      phone || resolveProjectOverviewArrangement(width) === 'stacked';
    return (
      <View
        style={styles.header}
        onLayout={(event: LayoutChangeEvent) => {
          const next = event.nativeEvent.layout.width;
          setWidth((current) => (current === next ? current : next));
        }}
      >
        <ProjectDashboardBar
          dashboards={options}
          selectedId={selected?.artifactId ?? ''}
          onSelect={select}
          narrow={narrow}
          onCreate={
            scope
              ? () => {
                  void create();
                }
              : null
          }
          actions={actions}
          testID="project-dashboards"
        />
        {unconfirmedDelete ? (
          <AttentionBanner
            testID="project-dashboards.deleteUnknown"
            placement="inline"
            title={t('projects.dashboard.deleteUnknown', {
              name: unconfirmedDelete,
            })}
            description={t('projects.dashboard.deleteUnknownBody')}
            action={{
              label: t('projects.dashboard.check'),
              onPress: () => {
                setUnconfirmedDelete(null);
                void dashboards.reload();
              },
            }}
          />
        ) : null}
        {dashboards.state.status === 'offline' ? (
          <AttentionBanner
            testID="project-dashboards.offline"
            placement="inline"
            tone="neutral"
            title={t('projects.widgets.offline')}
          />
        ) : null}
      </View>
    );
  },
);

const styles = StyleSheet.create(() => ({
  header: { gap: 12, minWidth: 0 },
}));
