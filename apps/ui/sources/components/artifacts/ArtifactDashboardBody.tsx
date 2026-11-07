import * as React from 'react';
import {
  flattenWidgetLayoutWidgetsV1,
  readWidgetSurfaceArtifactV1,
  type WidgetAreaLayoutV1,
  type WidgetInstanceV1,
} from '@happier-dev/protocol/widgets';

import { useAppShellPluginUiProjectionCurrentness } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { useOpenProject } from '@/components/projects/useOpenProject';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider, useListPresentation } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useWidgetInstanceDescriptors } from '@/components/widgets/surface/useWidgetInstanceDescriptor';
import {
  readWidgetDescriptor,
  readWidgetSourcePluginName,
  resolveWidgetInstanceTitle,
} from '@/components/widgets/widgetCatalog';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { getStorage } from '@/sync/domains/state/storage';
import { readProjectBaselineRef } from '@/sync/domains/workspaces/projectGroupDisplay';
import {
  readCurrentProjectAccountRows,
  readProjectWorkspaceRefs,
} from '@/sync/store/domains/projectAccountRows';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readWidgetAreaTitles } from '@/sync/ops/actions/widgetAreaActionDeps';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * A dashboard opened as an Artifact (a link or a tab): the widgets it holds, and its Project when that
 * Project is still here. The page or pane header already names it. Its layout is changed on the
 * Project's own dashboard, never as text.
 */
export function ArtifactDashboardBody(
  props: Readonly<{ artifact: DecryptedArtifact; onRetry: () => void }>,
) {
  const { artifact } = props;
  const presentation = useListPresentation();
  const layout = React.useMemo(
    () => {
      const header = artifact.rawHeader ?? artifact.header;
      return header ? readWidgetSurfaceArtifactV1({
        artifactId: artifact.id,
        header,
        body: artifact.body ?? null,
      }) : null;
    },
    [artifact.id, artifact.rawHeader, artifact.header, artifact.body],
  );
  if (!layout)
    return (
      <SurfaceStateCard
        testID="artifact:bodyFailed"
        kind="error"
        title={t('artifacts.error')}
        reason={t('artifacts.browser.loadFailedBody')}
        action={{ label: t('common.retry'), onPress: props.onRetry }}
      />
    );
  // The page column already holds this body; its sections share that edge instead of adding a second inset.
  return (
    <ListPresentationProvider value={presentation} pageInsets="contained">
      {layout.surface.owner.kind === 'project' ? (
        <DashboardProject
          serverId={layout.surface.serverId}
          projectKey={layout.surface.owner.projectId}
          layoutId={layout.surface.owner.layoutId ?? null}
        />
      ) : null}
      <DashboardWidgets layout={layout} />
    </ListPresentationProvider>
  );
}

/** One way back to where the dashboard lives; nothing when its Project is gone (an orphaned default). */
function DashboardProject(
  props: Readonly<{
    serverId: string;
    projectKey: string;
    layoutId: string | null;
  }>,
) {
  const { serverId, projectKey } = props;
  const ref = getStorage()((state) =>
    readProjectBaselineRef(readProjectWorkspaceRefs(state), {
      serverId,
      projectKey,
    }),
  );
  const label = getStorage()(
    (state) =>
      readCurrentProjectAccountRows(state)?.organizations.find(
        (row) =>
          row.key.serverId === serverId && row.key.projectKey === projectKey,
      )?.value.label,
  );
  const openProject = useOpenProject();
  if (!ref) return null;
  return (
    <ItemGroup testID="artifact:dashboard.project">
      <Item
        testID="artifact:dashboard.open"
        title={t('projects.dashboard.openInProject')}
        detail={label ?? resolveWorkspaceRefDisplayName(ref)}
        icon={<Icon name="folder" />}
        onPress={() =>
          fireAndForget(
            openProject(ref.id, {
              serverId: ref.serverId,
              layoutId: props.layoutId,
            }),
            { tag: 'ArtifactDashboard.openProject' },
          )
        }
      />
    </ItemGroup>
  );
}

/** Each widget by the name its card shows, and the widget it is (or where it comes from). */
function DashboardWidgets(props: Readonly<{ layout: WidgetAreaLayoutV1 }>) {
  const { surface } = props.layout;
  const runtime = useAppShellPluginUiProjectionCurrentness();
  const localize = usePluginLocalizedTextResolver({
    projection: runtime.pluginUiProjection,
  });
  const instances = React.useMemo(
    () =>
      flattenWidgetLayoutWidgetsV1(props.layout.items).map(
        (entry) => entry.instance,
      ),
    [props.layout.items],
  );
  const installed = React.useMemo(
    () =>
      instances.flatMap((instance) => {
        const candidate = readWidgetDescriptor(
          runtime.pluginUiProjection,
          instance.definition,
          instance.displayName ? undefined : localize,
        );
        return candidate ? [candidate] : [];
      }),
    [instances, runtime.pluginUiProjection, localize],
  );
  const descriptors = useWidgetInstanceDescriptors(
    surface,
    instances,
    installed,
  );
  const savedNames = useSavedWidgetNames(surface, instances);
  return (
    <ItemGroup
      testID="artifact:dashboard"
      title={t('projects.dashboard.widgets')}
      description={
        instances.length === 0 ? t('projects.dashboard.empty') : undefined
      }
    >
      {instances.map((instance, index) => {
        const descriptor = descriptors[index] ?? null;
        const title =
          savedNames?.get(instance.id) ??
          resolveWidgetInstanceTitle(instance, descriptor, {
            pluginUiProjection: runtime.pluginUiProjection,
          });
        const kind =
          descriptor && descriptor.title !== title
            ? descriptor.title
            : readWidgetSourcePluginName(
                runtime.pluginUiProjection,
                descriptor,
              );
        return (
          <Item
            key={instance.id}
            testID={`artifact:dashboard.widget:${instance.id}`}
            mode="info"
            title={title}
            subtitle={kind}
            icon={<Icon name={descriptor?.icon ?? 'squares-four'} />}
          />
        );
      })}
    </ItemGroup>
  );
}

/**
 * A saved widget's name lives in its own definition's header, which this page has not opened. The
 * layout's title owner (the one sharing uses) names them in one batched header read per open.
 */
function useSavedWidgetNames(
  surface: WidgetAreaLayoutV1['surface'],
  instances: readonly WidgetInstanceV1[],
): ReadonlyMap<string, string> | null {
  const [named, setNamed] = React.useState<Readonly<{
    instances: readonly WidgetInstanceV1[];
    titles: ReadonlyMap<string, string>;
  }> | null>(null);
  React.useEffect(() => {
    const saved = instances.filter(
      (instance) =>
        instance.definition.kind === 'artifact' &&
        instance.displayName === undefined,
    );
    if (saved.length === 0) return;
    const controller = new AbortController();
    void (async () => {
      const account = await captureLazyActionAccountContext(
        surface.serverId,
        controller.signal,
      );
      try {
        if (account.accountId !== surface.accountId) return;
        const titles = await readWidgetAreaTitles(
          account,
          saved,
          controller.signal,
        );
        if (!controller.signal.aborted) setNamed({ instances, titles });
      } finally {
        account.dispose();
      }
    })().catch(() => {});
    return () => controller.abort();
  }, [instances, surface.serverId, surface.accountId]);
  return named?.instances === instances ? named.titles : null;
}
