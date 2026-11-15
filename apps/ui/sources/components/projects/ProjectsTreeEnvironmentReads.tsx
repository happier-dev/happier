import * as React from 'react';

import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { useMachineServicesList } from '@/components/machines/services/useMachineServicesList';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';

import { databaseEngineTitle } from './deployments/databasePresentation';
import { useDeploymentPresentationDemand } from './deployments/useDeploymentPresentationDemand';
import { useDeploymentAccountController } from './deployments/useDeploymentProject';
import { useDeploymentEnvironmentRecord } from './deployments/useDeploymentReads';
import {
  buildProjectsTreeEnvironmentChildren,
  type ProjectsTreeEnvironment,
  type ProjectsTreeEnvironmentChild,
  type ProjectsTreeProject,
} from './projectsTreeRows';

type ChildrenById = ReadonlyMap<
  string,
  readonly ProjectsTreeEnvironmentChild[]
>;
const NO_CHILDREN: ChildrenById = new Map();

/**
 * What each opened Environment in the Projects tree runs (lab rdProj tree, reach board "One tree"): folded Environments
 * read nothing; an opened one on a Machine reads that Machine's services for it and its own record's declared
 * databases, the reads the Environment page's What runs uses. The column and the phone list keep the result here and
 * hand it to the rows owner.
 */
export function useProjectsTreeEnvironmentChildren() {
  const [children, setChildren] = React.useState<ChildrenById>(NO_CHILDREN);
  const publish = React.useCallback(
    (
      environmentId: string,
      next: readonly ProjectsTreeEnvironmentChild[] | null,
    ) => {
      setChildren((current) => {
        if (
          current.get(environmentId) === next ||
          (next === null && !current.has(environmentId))
        )
          return current;
        const copy = new Map(current);
        if (next === null) copy.delete(environmentId);
        else copy.set(environmentId, next);
        return copy;
      });
    },
    [],
  );
  return [children, publish] as const;
}

/** The opened Environments' reads, one reader each; renders nothing. */
export const ProjectsTreeEnvironmentReads = React.memo(
  function ProjectsTreeEnvironmentReads(
    props: Readonly<{
      projects: readonly ProjectsTreeProject[];
      expandedKeys: ReadonlySet<string>;
      collapsedKeys?: ReadonlySet<string>;
      onChildren: (
        environmentId: string,
        children: readonly ProjectsTreeEnvironmentChild[] | null,
      ) => void;
    }>,
  ) {
    const opened = React.useMemo(
      () =>
        props.projects.flatMap((project) =>
          (project.environments ?? []).filter((environment) => {
            const key = `${project.key}/environment/${environment.environmentId}`;
            return (
              Boolean(environment.machineId) &&
              props.expandedKeys.has(key) &&
              props.collapsedKeys?.has(key) !== true
            );
          }),
        ),
      [props.projects, props.expandedKeys, props.collapsedKeys],
    );
    return (
      <>
        {opened.map((environment) => (
          <ProjectsTreeEnvironmentRead
            key={environment.environmentId}
            environment={environment}
            onChildren={props.onChildren}
          />
        ))}
      </>
    );
  },
);

/**
 * One opened Environment's read of what it runs (its Machine's services, its declared databases), published to the
 * caller's children state. The Projects tree and the Services column both read an opened Environment through here.
 */
export function ProjectsTreeEnvironmentRead(
  props: Readonly<{
    environment: Pick<ProjectsTreeEnvironment, 'environmentId' | 'serverId' | 'machineId'>;
    onChildren: (
      environmentId: string,
      children: readonly ProjectsTreeEnvironmentChild[] | null,
    ) => void;
  }>,
) {
  const { environment, onChildren } = props;
  const presented = useLayoutPresentationActive();
  const machineId = environment.machineId ?? '';
  const services = useMachineServicesList({
    serverId: environment.serverId,
    machineId,
    environmentId: environment.environmentId,
    active: presented,
  });
  const { binding: lifetime } = useServerCredentialAccountScopeBinding(
    environment.serverId,
  );
  const demand = useDeploymentPresentationDemand(presented);
  const controller = useDeploymentAccountController(lifetime, true, demand);
  const record = useDeploymentEnvironmentRecord(
    controller,
    environment.environmentId,
    demand,
  );
  const declared = record.snapshot.value?.content.template?.data;
  const built = React.useMemo(() => {
    if (!services.rows && !declared) return null;
    return buildProjectsTreeEnvironmentChildren({
      services: (services.rows ?? []).map((row) => ({
        serviceId: row.serviceId,
        name: row.name,
        composeService: row.deployment?.service.composeService ?? null,
      })),
      databases: (declared ?? []).map((data) => ({
        service: data.service,
        engine: databaseEngineTitle(data),
      })),
      serviceHref: (serviceId) =>
        machinePageHref({
          door: 'rail',
          target: { machineId, serverId: environment.serverId },
          tab: { id: 'services', page: 'service', service: serviceId },
        }),
    });
  }, [services.rows, declared, machineId, environment.serverId]);
  // Unchanged rows keep their identity, so a service-state push that changes nothing here redraws nothing.
  const previous = React.useRef<readonly ProjectsTreeEnvironmentChild[] | null>(null);
  const children = built ? retainKeyedRows(previous.current, built, (child) => child.key, { freeze: false }) : null;
  previous.current = children;
  React.useEffect(() => {
    onChildren(environment.environmentId, children);
  }, [children, environment.environmentId, onChildren]);
  // Folding the Environment again drops what it ran; opening it reads again through the same owners.
  React.useEffect(
    () => () => onChildren(environment.environmentId, null),
    [environment.environmentId, onChildren],
  );
  return null;
}
