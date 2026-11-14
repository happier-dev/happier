import * as React from 'react';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployment-protocol/v1';

import { useCurrentRouteParamsSelector } from '@/components/appShell/workspace/currentRouteLocation';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';

import { useDeploymentEnvironmentRowParts } from './deployments/DeploymentEnvironmentCollection';
import { useDeploymentPresentationDemand } from './deployments/useDeploymentPresentationDemand';
import { useDeploymentInventory } from './deployments/useDeploymentProject';
import type {
  ProjectsTreeEnvironment,
  ProjectsTreeProject,
} from './projectsTreeRows';

type EnvironmentItem = DeploymentEnvironmentCollectionV1['items'][number];
const NO_ITEMS: readonly EnvironmentItem[] = Object.freeze([]);

/**
 * The Projects tree's Environments (pfc-redesign dProject, reach board "One tree"): each tree Project whose Source
 * deploys gets its Environments, read as the one environment row at rail density. One read serves the whole tree:
 * the Account's Environment collection Services already demands (the same owner and push invalidation), and only
 * while the tree is presented and some Project has a Source. Projects without Environments keep their identity.
 */
export function useProjectsTreeEnvironments(
  projects: readonly ProjectsTreeProject[],
): readonly ProjectsTreeProject[] {
  const lifetime = useActiveServerAccountScopeLifetime();
  const demand = useDeploymentPresentationDemand(useLayoutPresentationActive());
  const sourceIds = React.useMemo(
    () =>
      new Set(
        projects.flatMap((project) =>
          project.source ? [project.source.source.id] : [],
        ),
      ),
    [projects],
  );
  const read = useDeploymentInventory(
    sourceIds.size > 0 ? lifetime : null,
    demand,
  );
  const allItems = read.snapshot.value?.items ?? NO_ITEMS;
  const items = React.useMemo(
    () =>
      allItems.filter((item) =>
        sourceIds.has(item.environment.projectSourceId),
      ),
    [allItems, sourceIds],
  );
  const parts = useDeploymentEnvironmentRowParts(
    items,
    'projects-tree.environment',
    lifetime,
    'rail',
  );
  const previous = React.useRef<Readonly<{
    input: readonly ProjectsTreeProject[];
    output: ProjectsTreeProject[];
  }> | null>(null);
  return React.useMemo(() => {
    const projectBySource = new Map<string, ProjectsTreeProject>();
    for (const project of projects) {
      const id = project.source?.source.id;
      if (id && !projectBySource.has(id)) projectBySource.set(id, project);
    }
    const bySource = new Map<string, ProjectsTreeEnvironment[]>();
    for (const part of parts) {
      const project = projectBySource.get(part.projectSourceId);
      if (!project?.source) continue;
      const environment: ProjectsTreeEnvironment = {
        serverId: project.source.serverId,
        projectSourceId: part.projectSourceId,
        environmentId: part.environmentId,
        title: part.title,
        titleQualifier: part.titleQualifier ?? null,
        subtitle: part.subtitle ?? null,
        // The one row's own reading: trouble needs you; a deploy's step glyph means it is working.
        attention: part.needsYouStatus
          ? 'needs-you'
          : part.subtitleLeading
            ? 'working'
            : null,
        needsYouStatus: part.needsYouStatus,
      };
      const list = bySource.get(part.projectSourceId);
      if (list) list.push(environment);
      else bySource.set(part.projectSourceId, [environment]);
    }
    const before = new Map(
      previous.current?.output.map(
        (project) => [project.key, project] as const,
      ),
    );
    const inputBefore = new Map(
      previous.current?.input.map((project) => [project.key, project] as const),
    );
    const output = projects.map((project) => {
      const incoming = project.source
        ? bySource.get(project.source.source.id)
        : undefined;
      if (!incoming) return project;
      const prior = before.get(project.key);
      const environments = retainKeyedRows(
        prior?.environments,
        incoming,
        (environment) => environment.environmentId,
      );
      return prior &&
        inputBefore.get(project.key) === project &&
        prior.environments === environments
        ? prior
        : { ...project, environments };
    });
    previous.current = { input: projects, output };
    return output;
  }, [parts, projects]);
}

const selectOpenEnvironmentId = (params: Readonly<Record<string, string | string[] | undefined>>): string | null =>
  typeof params.deploymentEnvironment === 'string' ? params.deploymentEnvironment : null;

/** The Environment on screen (the Environment route's own param), so its tree row is selected and its Project open. */
export function useProjectsTreeOpenEnvironmentId(): string | null {
  return useCurrentRouteParamsSelector(selectOpenEnvironmentId);
}
