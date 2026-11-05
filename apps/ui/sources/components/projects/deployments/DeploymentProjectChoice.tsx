import * as React from 'react';
import type { DeploymentNewProjectV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';

import { useProjectSources } from '@/components/projects/sources/useProjectSources';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import { randomUUID } from '@/platform/randomUUID';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

/** The Project a new Environment is listed in: an existing one, or a new repository-free one created with it. */
export type DeploymentProjectSelection =
  | Readonly<{ projectSourceId: string; sourceRevision: number }>
  | Readonly<{ newProject: DeploymentNewProjectV1 }>;

/**
 * One Project choice for every flow that creates an Environment outside a Project page (a Store App, an adopted
 * Compose project): the Account's Projects, or a new one named here and owned by the person or a Team they are in.
 * The new Project's request key is stable per name and owner, so a retried review keeps the Source creator's identity.
 */
export function useDeploymentProjectChoice(input: Readonly<{ lifetime: ServerAccountScopeLifetime; initialNewProjectName?: string;
  initiallyNew?: boolean }>) {
  const { serverId, accountId } = input.lifetime.scope;
  const sources = useProjectSources(input.lifetime.scope).state;
  const [sourceId, setSourceId] = React.useState<string | null>(null);
  const [newProject, setNewProject] = React.useState(input.initiallyNew === true);
  const [newProjectName, setNewProjectName] = React.useState(input.initialNewProjectName ?? '');
  const [ownerId, setOwnerId] = React.useState('account');
  const teamsDirectory = useTeamsDirectory({ serverIds: [serverId], enabled: newProject });
  const owner = React.useMemo(() => ownerId.startsWith('team:')
    ? { kind: 'team' as const, teamId: ownerId.slice('team:'.length) }
    : { kind: 'account' as const, accountId }, [accountId, ownerId]);
  const newProjectKey = React.useRef<Readonly<{ identity: string; requestKey: string }> | null>(null);
  const source = newProject ? null : sources.rows.find((row) => row.id === sourceId) ?? null;
  const selection = React.useMemo((): DeploymentProjectSelection | null => {
    if (newProject) {
      const name = newProjectName.trim();
      if (!name) return null;
      const identity = JSON.stringify([name, owner]);
      if (newProjectKey.current?.identity !== identity) newProjectKey.current = { identity, requestKey: randomUUID() };
      return { newProject: { name, owner, requestKey: newProjectKey.current.requestKey } };
    }
    return source ? { projectSourceId: source.id, sourceRevision: source.revision } : null;
  }, [newProject, newProjectName, owner, source]);
  const missing = newProject
    ? !newProjectName.trim() ? t('capabilities.store.appPage.nameProject') : null
    : !source ? t('capabilities.store.appPage.chooseProject') : null;
  return { selection, missing, newProject, newProjectName, setNewProject, setNewProjectName, sourceId, setSourceId,
    ownerId, setOwnerId, sources, teams: teamsDirectory.rows, serverId };
}

export type DeploymentProjectChoiceModel = ReturnType<typeof useDeploymentProjectChoice>;

/** Above this many choices a select offers search, as the Machine field does. */
const SEARCH_FROM = 8;
/** The Project field's choice id for a new Project; a Source id is never this word. */
const NEW_PROJECT = 'new';

/**
 * The Project field (a select: an Account can hold many Projects), then a new Project's own inputs directly
 * beneath it in the same section, so choosing New project shows its name and owner where the eye already is.
 */
export function DeploymentProjectChoiceGroups(props: Readonly<{
  model: DeploymentProjectChoiceModel;
  testIDPrefix: string;
  description: string;
  newProjectHint: string;
}>) {
  const { model, testIDPrefix } = props;
  const [projectMenuOpen, setProjectMenuOpen] = React.useState(false);
  const [ownerMenuOpen, setOwnerMenuOpen] = React.useState(false);
  const projectItems = React.useMemo((): DropdownMenuItem[] => [
    { id: NEW_PROJECT, title: t('capabilities.store.appPage.projectNew'), subtitle: props.newProjectHint,
      checked: model.newProject },
    ...model.sources.rows.map((row): DropdownMenuItem => ({ id: row.id, title: row.name,
      checked: !model.newProject && model.sourceId === row.id })),
  ], [model.newProject, model.sourceId, model.sources.rows, props.newProjectHint]);
  const ownerItems = React.useMemo((): DropdownMenuItem[] => [
    { id: 'account', title: t('capabilities.store.appPage.projectOwnerYou'), checked: model.ownerId === 'account' },
    ...model.teams
      .filter((row) => row.address.serverId === model.serverId)
      .map((row): DropdownMenuItem => ({ id: `team:${row.team.id}`, title: row.team.name, checked: model.ownerId === `team:${row.team.id}` })),
  ], [model.ownerId, model.serverId, model.teams]);
  const selectedId = model.newProject ? NEW_PROJECT : model.sourceId ?? '';
  return (
    <ItemGroup testID={`${testIDPrefix}.group`} title={t('capabilities.store.appPage.projectTitle')} description={props.description}>
      <DropdownMenu
        testID={testIDPrefix}
        open={projectMenuOpen}
        onOpenChange={setProjectMenuOpen}
        search={projectItems.length > SEARCH_FROM}
        items={projectItems}
        selectedId={selectedId}
        onSelect={(id) => {
          setProjectMenuOpen(false);
          if (id === NEW_PROJECT) { model.setNewProject(true); model.setSourceId(null); }
          else if (id) { model.setNewProject(false); model.setSourceId(id); }
        }}
        itemTrigger={{
          title: t('capabilities.store.appPage.projectTitle'),
          placeholder: model.sources.status === 'loading' && model.sources.rows.length === 0
            ? t('capabilities.store.appPage.projectsLoading')
            : t('capabilities.store.appPage.projectPlaceholder'),
          showSelectedSubtitle: false,
        }}
      />
      {model.newProject ? (
        <Item
          title={t('capabilities.store.appPage.projectNameLabel')}
          accessoryLayout="stacked"
          rightElement={
            <FieldTextInput
              testID={`${testIDPrefix}.newName`}
              value={model.newProjectName}
              onChangeText={model.setNewProjectName}
              accessibilityLabel={t('capabilities.store.appPage.projectNameLabel')}
            />
          }
          showChevron={false}
        />
      ) : null}
      {/* Owner is offered only when there is a choice: the person's Account or a Team they belong to. */}
      {model.newProject && ownerItems.length > 1 ? (
        <DropdownMenu
          testID={`${testIDPrefix}.owner`}
          open={ownerMenuOpen}
          onOpenChange={setOwnerMenuOpen}
          items={ownerItems}
          selectedId={model.ownerId}
          onSelect={(id) => { setOwnerMenuOpen(false); if (id) model.setOwnerId(id); }}
          itemTrigger={{ title: t('capabilities.store.appPage.projectOwnerLabel') }}
        />
      ) : null}
    </ItemGroup>
  );
}
