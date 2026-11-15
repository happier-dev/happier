import * as React from 'react';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployment-protocol/v1';

import { useCurrentRouteParamsSelector } from '@/components/appShell/workspace/currentRouteLocation';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { retainDeep, retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';

import { isSameDeploymentName, useDeploymentEnvironmentRowParts } from './deployments/DeploymentEnvironmentCollection';
import { deploymentWorkStatus } from './deployments/deploymentPresentation';
import { useDeploymentPresentationDemand } from './deployments/useDeploymentPresentationDemand';
import { groupDeploymentRowsByProject } from './deployments/deploymentProjectGroups';
import { useDeploymentInventory } from './deployments/useDeploymentProject';
import type {
  ProjectsTreeEnvironment,
  ProjectsTreeProject,
} from './projectsTreeRows';

type EnvironmentItem = DeploymentEnvironmentCollectionV1['items'][number];
const NO_ITEMS: readonly EnvironmentItem[] = Object.freeze([]);

/**
 * The Projects tree's Environments (pfc-redesign dProject, reach board "One tree"): each tree Project whose Source
 * deploys gets its Environments, read as the one environment row at rail density, and a Project that only deploys
 * (no checkout on this Home; lab rdProj: plausible, status) is listed with its Environments after them, grouped by
 * the owner Services groups through. One read serves the whole tree: the Account's Environment collection Services
 * already demands (the same owner and push invalidation), only while the tree is presented. Unchanged Projects keep
 * their identity.
 */
export function useProjectsTreeEnvironments(
  projects: readonly ProjectsTreeProject[],
): readonly ProjectsTreeProject[] {
  const lifetime = useActiveServerAccountScopeLifetime();
  const demand = useDeploymentPresentationDemand(useLayoutPresentationActive());
  const read = useDeploymentInventory(lifetime, demand);
  const items = read.snapshot.value?.items ?? NO_ITEMS;
  const parts = useDeploymentEnvironmentRowParts(items, 'projects-tree.environment', lifetime, 'rail');
  const serverId = lifetime?.scope.serverId ?? null;
  const previous = React.useRef<readonly ProjectsTreeProject[] | null>(null);
  return React.useMemo(() => {
    const projectBySource = new Map<string, ProjectsTreeProject>();
    for (const project of projects) {
      const id = project.source?.source.id;
      if (id && !projectBySource.has(id)) projectBySource.set(id, project);
    }
    // The Machine each deployed Environment runs on, as the read says: opened, it reads what runs there. One never
    // deployed runs nothing yet, so it has nothing to disclose.
    const machineByEnvironment = new Map(items.flatMap((item) => item.currentDeployment
      ? [[item.environment.id, item.environment.controllerMachineId] as const] : []));
    const itemById = new Map(items.map((item) => [item.environment.id, item] as const));
    const bySource = new Map<string, ProjectsTreeEnvironment[]>();
    const deployOnly: Array<Readonly<{ projectSourceId: string; projectName: string | null; environment: ProjectsTreeEnvironment }>> = [];
    for (const part of parts) {
      const project = projectBySource.get(part.projectSourceId);
      const environmentServerId = project?.source?.serverId ?? serverId;
      if (!environmentServerId) continue;
      const environment: ProjectsTreeEnvironment = {
        serverId: environmentServerId,
        projectSourceId: part.projectSourceId,
        environmentId: part.environmentId,
        title: part.title,
        titleQualifier: part.titleQualifier ?? null,
        // One fact at the row's end (lab rdProj): trouble's own word, a running deploy's state word, else the live
        // version when it says more than the name, else the one row's own age.
        fact: environmentFact(part, itemById.get(part.environmentId)),
        // The one row's own reading: trouble needs you; a deploy's step glyph means it is working.
        attention: part.needsYouStatus ? 'needs-you' : part.subtitleLeading ? 'working' : null,
        needsYouStatus: part.needsYouStatus,
        machineId: machineByEnvironment.get(part.environmentId) ?? null,
      };
      if (!project) { deployOnly.push({ projectSourceId: part.projectSourceId, projectName: part.projectName, environment }); continue; }
      const list = bySource.get(part.projectSourceId);
      if (list) list.push(environment);
      else bySource.set(part.projectSourceId, [environment]);
    }
    const before = new Map(previous.current?.map((project) => [project.key, project] as const));
    const withEnvironments = (project: ProjectsTreeProject, incoming: readonly ProjectsTreeEnvironment[]): ProjectsTreeProject => {
      const prior = before.get(project.key);
      const environments = retainKeyedRows(prior?.environments, incoming, (environment) => environment.environmentId);
      return retainDeep(prior, { ...project, environments });
    };
    const joined = projects.map((project) => {
      const incoming = project.source ? bySource.get(project.source.source.id) : undefined;
      return incoming ? withEnvironments(project, incoming) : project;
    });
    // Environments whose Project name the read withholds stay in Services only: one placeholder never names a Project.
    const deployOnlyProjects = groupDeploymentRowsByProject(deployOnly).named.map((group) => withEnvironments({
      key: `deployments:${group.key}`, name: group.title, checkouts: [],
      deploymentSource: { serverId: group.rows[0]!.environment.serverId, projectSourceId: group.key },
    }, group.rows.map((row) => row.environment)));
    const output = deployOnlyProjects.length === 0 ? joined : [...joined, ...deployOnlyProjects];
    previous.current = output;
    return output;
  }, [items, parts, projects, serverId]);
}

function environmentFact(part: Readonly<{ title: string; detail: string; needsYouStatus: Readonly<{ word: string }> | null }>,
  item: EnvironmentItem | undefined): string | null {
  if (part.needsYouStatus) return part.needsYouStatus.word;
  const deployment = item?.currentDeployment;
  if (deployment && (deployment.state === 'queued' || deployment.state === 'running')) return deploymentWorkStatus(deployment.state).word;
  const version = item?.liveVersionTitle;
  return version && !isSameDeploymentName(version, part.title) ? version : part.detail || null;
}

const selectOpenEnvironmentId = (params: Readonly<Record<string, string | string[] | undefined>>): string | null =>
  typeof params.deploymentEnvironment === 'string' ? params.deploymentEnvironment : null;

/** The Environment on screen (the Environment route's own param), so its tree row is selected and its Project open. */
export function useProjectsTreeOpenEnvironmentId(): string | null {
  return useCurrentRouteParamsSelector(selectOpenEnvironmentId);
}
