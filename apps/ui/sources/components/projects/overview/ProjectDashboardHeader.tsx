import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { buildWidgetSurfaceArtifactIdV1, type WidgetAreaLayoutSummaryV1 } from '@happier-dev/protocol/widgets';

import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { showDocumentShareSheet } from '@/components/sharing/documents/showDocumentShareSheet';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { Modal } from '@/modal';
import { readProjectWidgetAreaContextV1 } from '@/sync/domains/widgets/projectWidgetAreaContext';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useDeviceType } from '@/utils/platform/responsive';
import { t } from '@/text';

import { useProjectSources } from '../sources/useProjectSources';
import { formatProjectSourceAddress } from '../sources/projectSourceAddress';
import { readSourceTeamId } from '../sources/ProjectSourcesRail';
import {
  WidgetAreaLayoutBar,
  type WidgetAreaLayoutActions,
  type WidgetAreaLayoutLabels,
  type WidgetAreaLayoutOption,
} from '@/components/widgets/area/WidgetAreaLayoutBar';
import { resolveProjectOverviewArrangement } from './ProjectOverviewLayout';
import { useProjectDashboards } from './useProjectDashboards';
import type { ProjectAttachedDashboardSelection } from '../detail/projectRouteState';
import type { ProjectAttachedDashboardRead } from '@/components/widgets/area/useProjectWidgetAreaBinding';

/** A Project calls its named layouts dashboards. */
const DASHBOARD_LABELS: WidgetAreaLayoutLabels = {
  get list() { return t('projects.dashboard.label'); },
  current: (name) => t('projects.dashboard.current', { name }),
  get create() { return t('projects.dashboard.create'); },
  get createEllipsis() { return t('projects.dashboard.createEllipsis'); },
  get defaultLayout() { return t('projects.dashboard.default'); },
  actions: (name) => t('projects.dashboard.actions', { name }),
  get rename() { return t('projects.dashboard.rename'); },
  moveBefore: (name) => t('projects.dashboard.moveBefore', { name }),
  moveAfter: (name) => t('projects.dashboard.moveAfter', { name }),
  get delete() { return t('projects.dashboard.delete'); },
  get deleteLabel() { return t('projects.dashboard.deleteLabel'); },
};

/** The route's dashboard id for a summary: omitted for the default Overview (its stable identity). */
export function projectDashboardRouteId(
  dashboard: WidgetAreaLayoutSummaryV1,
): string | null {
  return dashboard.surface.owner.kind === 'project'
    ? (dashboard.surface.owner.layoutId ?? null)
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
    layoutId: string | null;
    attachedDashboard?: ProjectAttachedDashboardSelection;
    sharedDashboard?: ProjectAttachedDashboardRead;
    onSelectDashboard: (layoutId: string | null) => void;
  }>,
) {
  const serverId = props.workspaceRef.serverId;
  const projectKey = React.useMemo(
    () => readProjectWidgetAreaContextV1({ serverId, projectRef: props.workspaceRef }).projectIdentity?.projectKey ?? null,
    [props.workspaceRef, serverId],
  );
  // The destination controller preserves the admitted checkout and selected pane resource.
  const phone = useDeviceType() === 'phone';
    const scope = useActiveServerAccountScope(serverId);
    const dashboards = useProjectDashboards({
      serverId: serverId,
      projectKey,
    });
    const destination = React.useMemo(() => ({}), [scope?.accountId, scope?.serverId, projectKey,
      props.workspaceRef.id, props.workspaceRef.serverId, props.workspaceRef.machineId,
      props.activeRootPath, props.activeWorktreeId, props.layoutId,
      props.attachedDashboard?.sourceId, props.attachedDashboard?.artifactId]);
    const currentDestination = React.useRef(destination);
    currentDestination.current = destination;
    const mounted = React.useRef(true);
    React.useEffect(() => {
      mounted.current = true;
      return () => { mounted.current = false; };
    }, []);
    const captureDestination = React.useCallback(() => {
      const lifetime = captureActiveServerAccountScopeLifetime();
      if (!scope || !lifetime?.isCurrent() || lifetime.scope.accountId !== scope.accountId
        || !areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, scope.serverId)) return null;
      const isCurrent = () => mounted.current && currentDestination.current === destination && lifetime.isCurrent();
      return isCurrent() ? { isCurrent } : null;
    }, [destination, scope]);
    const [width, setWidth] = React.useState<number | null>(null);
    const [unconfirmedDelete, setUnconfirmedDelete] = React.useState<
      Readonly<{ name: string; destination: object }> | null
    >(null);
    const [sourcesDemanded, setSourcesDemanded] = React.useState(false);
    const sources = useProjectSources(
      scope ?? { serverId: serverId, accountId: '' },
      { enabled: sourcesDemanded && scope !== null },
    );
    const list = dashboards.state.dashboards;
    const selected = props.attachedDashboard ? null :
      list.find(
        (entry) => projectDashboardRouteId(entry) === props.layoutId,
      ) ??
      null;
    const unavailableId = !props.attachedDashboard && props.layoutId !== null && scope && projectKey ? buildWidgetSurfaceArtifactIdV1({
      ...scope, owner: { kind: 'project', projectId: projectKey, layoutId: props.layoutId },
    }) : null;

    // The default Overview is always an entry, even before the inventory answers: nothing jumps on arrival.
  // A preset this viewer has made their own carries the quiet dot (lab wgsaved R).
  const options = React.useMemo((): readonly WidgetAreaLayoutOption[] => [
    ...(list.length > 0
      ? list.map((entry) => ({ id: entry.artifactId, name: entry.name, isDefault: entry.isDefault, ...(entry.isEdited ? { edited: true } : {}) }))
      : [{ id: 'default', name: t('projects.pages.overview'), isDefault: true }]),
    ...(!selected && unavailableId ? [{ id: unavailableId, name: t('projects.dashboard.unavailable'), unavailable: true }] : []),
    ...(props.attachedDashboard && !list.some(entry => entry.artifactId === props.attachedDashboard?.artifactId)
      ? [{ id: props.attachedDashboard.artifactId, name: props.sharedDashboard?.name ?? t('projects.dashboard.unavailable'),
          ...(props.sharedDashboard ? {} : { unavailable: true }) }] : []),
  ], [list, selected, unavailableId, props.attachedDashboard?.artifactId, props.sharedDashboard]);

  const select = React.useCallback(
      async (artifactId: string) => {
        const captured = captureDestination();
        if (!captured) return;
        const entry = list.find(
          (candidate) => candidate.artifactId === artifactId,
        );
        if (entry) await dashboards.select(entry);
      },
      [captureDestination, dashboards, list],
    );

    const create = React.useCallback(async () => {
      const captured = captureDestination();
      if (!captured) return;
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
      if (!name || !captured.isCurrent()) return;
      const outcome = await dashboards.create(name);
      if (outcome.ok && outcome.dashboard && captured.isCurrent())
        await dashboards.select(outcome.dashboard);
    }, [captureDestination, dashboards, props.projectName]);

    const actions = React.useMemo((): WidgetAreaLayoutActions | null => {
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
        share: () => {
          if (!captureDestination()) return;
          showDocumentShareSheet({
            kind: 'widget-area-layout.v1',
            artifactId: selected.artifactId,
            name: selected.name,
            subtitle: `${t('projects.dashboard.label')} · ${props.projectName}`,
          });
        },
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
            if (!captureDestination()) return;
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
            void sources.controller.updateSource({
                attachment: attached
                  ? { kind: 'detach', purpose: 'dashboard', ref }
                  : {
                      kind: 'attach',
                      attachment: { purpose: 'dashboard', ref },
                    },
              }, source);
          },
          onDemand: () => setSourcesDemanded(true),
        },
        rename: async () => {
          const captured = captureDestination();
          if (!captured) return;
          const name = (
            await Modal.prompt(t('projects.dashboard.renameTitle'), undefined, {
              defaultValue: selected.name,
              placeholder: t('projects.dashboard.namePlaceholder'),
              confirmText: t('common.rename'),
            })
          )?.trim();
          if (name && name !== selected.name && captured.isCurrent())
            await dashboards.rename(selected, name);
        },
        ...(previous
          ? {
              moveBefore: {
                name: previous.name,
                onPress: () => {
                  if (!captureDestination()) return;
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
                  if (!captureDestination()) return;
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
                const captured = captureDestination();
                if (!captured) return;
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
                if (!confirmed || !captured.isCurrent()) return;
                const outcome = await dashboards.remove(selected);
                if (!captured.isCurrent()) return;
                if (!outcome.ok) {
                  setUnconfirmedDelete({ name: selected.name, destination });
                  return;
                }
                setUnconfirmedDelete(null);
                // Only after the acknowledged delete does the page return to the retained default.
                const defaultLayout = list.find(entry => entry.isDefault);
                if (defaultLayout) await dashboards.select(defaultLayout);
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
      captureDestination,
      destination,
      dashboards,
      list,
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
        <WidgetAreaLayoutBar
          layouts={options}
          labels={DASHBOARD_LABELS}
          selectedId={props.attachedDashboard?.artifactId ?? selected?.artifactId ?? unavailableId ?? 'default'}
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
        {unconfirmedDelete?.destination === destination ? (
          <AttentionBanner
            testID="project-dashboards.deleteUnknown"
            placement="inline"
            title={t('projects.dashboard.deleteUnknown', {
              name: unconfirmedDelete.name,
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
          <SurfaceFreshnessLine
            testID="project-dashboards.offline"
            reason={t('projects.widgets.offline')}
          />
        ) : null}
      </View>
    );
  },
);

const styles = StyleSheet.create(() => ({
  header: { gap: 12, minWidth: 0 },
}));
