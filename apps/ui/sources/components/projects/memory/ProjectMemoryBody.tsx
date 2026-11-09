import { projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import * as React from 'react';

import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import {
  MemoryDocumentScreen,
  type MemoryDocumentProjectPage,
} from '@/components/memory/MemoryDocumentScreen';
import { ContextMemorySection } from '@/components/settings/prompts/context/ContextMemorySection';
import { usePromptStackEntryPresentations } from '@/components/settings/prompts/stacks/promptStackEntryPresentation';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveProjectRoutePathForSurface } from '@/components/workspaceCockpit/project/projectCockpitState';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';
import { t } from '@/text';

import { selectProjectMemoryEntry } from '../context/projectMemoryEntry';
import { useProjectContext } from '../context/useProjectContext';
import { resolveWorkspaceRefDisplayName } from '../resolveWorkspaceRefDisplayName';

const FACT_ROUTE_PARAMS = new Set(['fact', 'edit']);

/**
 * Project › Memory (lab K2 `A`): the Project's own memory document as a page of the Project — the
 * same document screen Settings opens, with the Project and its Team named, search scoped to the
 * Project, and facts selected on this route. Before the Project has memory, the same section the
 * Context page shows offers the first fact (the document is created by that first save).
 */
export const ProjectMemoryBody = React.memo(function ProjectMemoryBody(
  props: Readonly<{
    workspaceRef: WorkspaceRefV1;
    testID?: string;
  }>,
) {
  const testID = props.testID ?? 'project-memory';
  const params = useLocalSearchParams<Record<string, string | string[]>>();
  const model = useProjectContext(props.workspaceRef);
  const projectRef = React.useMemo(
    () => projectWorkspaceRefV1(props.workspaceRef),
    [props.workspaceRef],
  );
  const { shared, personal } = model;
  const entries = React.useMemo(
    () => [...shared.entries, ...personal.entries],
    [shared.entries, personal.entries],
  );
  const presentations = usePromptStackEntryPresentations(
    entries,
    projectRef.serverId,
  );
  const hasSource = shared.status !== 'none';
  const { entry, resolved: memoryResolved, attachmentStatus: memoryAttachmentStatus } = React.useMemo(
    () =>
      selectProjectMemoryEntry({
        hasSource,
        sharedEntries: shared.entries,
        personalEntries: personal.entries,
        presentations,
      }),
    [hasSource, personal.entries, presentations, shared.entries],
  );
  const projectName = resolveWorkspaceRefDisplayName(props.workspaceRef);
  const readParam = (key: string) => {
    const raw = params[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return value?.trim() ? value : undefined;
  };
  const factId = readParam('fact');
  const editFactId = readParam('edit');
  const page = React.useMemo(
    (): MemoryDocumentProjectPage => ({
      name: projectName,
      searchScope: { type: 'project', projectRef },
      href: (options) => {
        const routeParams: Record<string, string | string[] | undefined> = {};
        for (const [key, value] of Object.entries(params))
          if (!FACT_ROUTE_PARAMS.has(key)) routeParams[key] = value;
        if (options.factId) routeParams.fact = options.factId;
        if (options.editFactId) routeParams.edit = options.editFactId;
        return resolveProjectRoutePathForSurface({
          workspaceRefId: props.workspaceRef.id,
          surface: 'memory',
          serverId: props.workspaceRef.serverId,
          routeParams,
        });
      },
    }),
    [
      params,
      projectName,
      projectRef,
      props.workspaceRef.id,
      props.workspaceRef.serverId,
    ],
  );

  if (entry && entry.ref.kind === 'doc') {
    return (
      <MemoryDocumentScreen
        artifactId={entry.ref.artifactId}
        serverId={entry.ref.serverId ?? model.serverId}
        factId={factId}
        editFactId={editFactId}
        project={page}
      />
    );
  }
  const header = (
    <PageHeader
      testID={`${testID}.header`}
      title={t('projects.pages.memory')}
      description={t('memoryContext.memory.projectPageDescription', {
        project: projectName,
      })}
      meta={[
        {
          key: 'scope',
          icon: 'folder',
          text: t('memoryContext.memory.projectScope', {
            project: projectName,
          }),
        },
      ]}
    />
  );
  if (shared.status === 'loading') {
    return (
      <ItemList testID={testID}>
        {header}
        <SurfaceStateCard
          testID={`${testID}.loading`}
          kind="loading"
          title={t('common.loading')}
        />
      </ItemList>
    );
  }
  const canWrite =
    (!hasSource && personal.available) || (hasSource && shared.canManage);
  return (
    <ItemList testID={testID}>
      {header}
      <ContextMemorySection
        testID={`${testID}.memory`}
        title={t('memoryContext.memory.keyFactsTitle')}
        description={t('contextPages.project.memoryDescription')}
        serverId={model.serverId}
        entry={entry}
        attachmentStatus={!memoryResolved ? memoryAttachmentStatus : shared.status === 'none' ? personal.status : shared.status}
        searchScope={page.searchScope}
        searchScopeName={page.name}
        scopeTarget={canWrite ? { scope: 'project', projectRef } : undefined}
        footer={() => undefined}
        emptyText={t('contextPages.project.memoryEmpty')}
        firstUse={{
          title: t('memoryContext.memory.projectFirstUseTitle'),
          reason: t('memoryContext.memory.projectFirstUseReason', { project: projectName }),
        }}
        readOnly={!canWrite}
      />
    </ItemList>
  );
});
