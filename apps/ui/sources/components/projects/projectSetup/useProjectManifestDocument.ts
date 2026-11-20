import * as React from 'react';
import type { ProjectDefinitionWorkspace, ProjectEnvironmentImportV1 } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { readActionErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ProjectManifestFileSnapshot } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import type { ProjectAccountOrganizationV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { ProjectSetupSetInputV1 } from '@happier-dev/protocol/projects/projectSetupSetV1';
import type { EnvVarRequirement } from '@happier-dev/protocol/profiles/environmentVariables';
import { buildWorkspaceCacheKey } from '@/sync/domains/workspaces/workspaceScope';
import type { ProjectManifestActionClient } from './projectManifestActionClient';
import { createProjectManifestEditorModel, type ProjectManifestEditorModel } from './projectManifestEditorModel';

export type ProjectManifestEditorTarget = 'repository' | 'personal';
export type ProjectManifestDocumentInput = Readonly<{
  workspace: ProjectDefinitionWorkspace;
  accountId: string;
  client: ProjectManifestActionClient;
  repositoryDefinition: ProjectManifestFileSnapshot;
  /** Selected Account's captured row; its revision identifies the complete organization body. */
  personal: Readonly<{
    projectRef: ProjectSetupSetInputV1['projectRef'];
    revision: ProjectSetupSetInputV1['expectedRevision'];
    organization: ProjectAccountOrganizationV1;
  }> | null;
  inheritedRequirements?: readonly EnvVarRequirement[];
}>;

type EnvironmentImportState = Readonly<{
  model: ProjectManifestEditorModel;
  offer: ProjectEnvironmentImportV1 | null;
  pending: boolean;
  error: string | null;
}>;

type PersonalRead = Readonly<{
  key: string;
  model: ProjectManifestEditorModel | null;
  error: string | null;
}>;

/** Target selection owns demand; each existing draft model continues to own edits and CAS saves. */
export function useProjectManifestDocument(input: ProjectManifestDocumentInput) {
  const { client, personal } = input;
  const latestInput = React.useRef(input);
  React.useLayoutEffect(() => { latestInput.current = input; }, [input]);
  const workspaceKey = buildWorkspaceCacheKey(input.workspace);
  const models = React.useMemo(() => ({
    repository: createProjectManifestEditorModel({ workspace: input.workspace, expectedAccountId: input.accountId,
      definition: input.repositoryDefinition, inheritedRequirements: input.inheritedRequirements,
      actions: { update: request => client.update(request) } }),
    personal: null as Readonly<{ projectRef: ProjectSetupSetInputV1['projectRef']; model: ProjectManifestEditorModel }> | null,
    loaded: null as PersonalRead | null,
  }), [client, input.accountId, workspaceKey]);
  const [target, setTarget] = React.useState<ProjectManifestEditorTarget>('repository');
  const [personalRead, setPersonalRead] = React.useState<Readonly<{ models: typeof models; result: PersonalRead }> | null>(null);
  const [retry, setRetry] = React.useState(0);
  const [importState, setImportState] = React.useState<EnvironmentImportState | null>(null);
  const personalKey = personal ? JSON.stringify([personal.projectRef.serverId, personal.projectRef.projectKey, personal.revision]) : null;

  React.useEffect(() => { models.repository.receiveDefinition(input.repositoryDefinition); }, [models, input.repositoryDefinition]);
  React.useEffect(() => {
    const current = latestInput.current;
    const capturedPersonal = current.personal;
    if (target !== 'personal' || !capturedPersonal || !personalKey) return;
    if (models.loaded?.key === personalKey) {
      const loaded = models.loaded;
      setPersonalRead(previous => previous?.models === models && previous.result === loaded ? previous : { models, result: loaded });
      return;
    }
    let active = true;
    setPersonalRead(null);
    void client.loadPersonalSetup(capturedPersonal).then(result => {
      if (!active) return;
      if (result.kind === 'ready') {
        if (models.personal?.projectRef.serverId === capturedPersonal.projectRef.serverId
          && models.personal.projectRef.projectKey === capturedPersonal.projectRef.projectKey) {
          models.personal.model.receiveDefinition(result.definition);
        } else models.personal = { projectRef: capturedPersonal.projectRef,
          model: createProjectManifestEditorModel({ target: 'personal', projectRef: capturedPersonal.projectRef, workspace: current.workspace,
            expectedAccountId: current.accountId, definition: result.definition, inheritedRequirements: current.inheritedRequirements,
            actions: { update: request => client.updatePersonalSetup({ ...request, projectRef: capturedPersonal.projectRef }) } }) };
        models.loaded = { key: personalKey, model: models.personal.model, error: null };
      } else models.loaded = { key: personalKey, model: null, error: result.code };
      setPersonalRead({ models, result: models.loaded });
    }).catch(error => {
      if (!active) return;
      models.loaded = { key: personalKey, model: null, error: readActionErrorCodeV1(error) ?? 'action_failed' };
      setPersonalRead({ models, result: models.loaded });
    });
    return () => { active = false; };
  }, [client, models, target, personalKey, retry]);

  const selectedRead = personalRead?.models === models && personalRead.result.key === personalKey ? personalRead.result : null;
  const model = target === 'repository' ? models.repository : selectedRead?.model ?? null;
  const loading = target === 'personal' && personal !== null && selectedRead === null;
  const selectedImport = importState?.model === model ? importState : null;
  const environmentImport = selectedImport?.offer ?? null;
  const importing = selectedImport?.pending ?? false;
  const importError = selectedImport?.error ?? null;
  const error = target === 'personal' ? selectedRead?.error ?? importError : importError;
  const selectTarget = React.useCallback((next: ProjectManifestEditorTarget) => {
    if (next === 'personal' && !personal) return false;
    setImportState(previous => previous?.model === model ? { ...previous, error: null } : previous);
    setTarget(next);
    return true;
  }, [personal, model]);
  const reloadPersonal = React.useCallback(() => {
    models.loaded = null;
    setPersonalRead(null);
    setRetry(value => value + 1);
  }, [models]);
  const importEnvironmentNames = React.useCallback(async () => {
    if (!model || importing) return false;
    setImportState({ model, offer: environmentImport, pending: true, error: null });
    try {
      const inspected = await client.inspect({ kind: 'imports' });
      const offer = inspected.environmentImport ?? null;
      const imported = offer ? model.importEnvironmentRequirements(offer.requirements, input.inheritedRequirements) : false;
      setImportState(previous => previous?.model === model ? { model, offer, pending: false, error: null } : previous);
      return imported;
    } catch (error) {
      const code = readActionErrorCodeV1(error) ?? 'action_failed';
      setImportState(previous => previous?.model === model ? { ...previous, pending: false, error: code } : previous);
      return false;
    }
  }, [model, importing, environmentImport, client, input.inheritedRequirements]);
  const save = React.useCallback(() => model ? model.save() : Promise.resolve(null), [model]);
  // A settled import with no offer means this checkout has no example file to read names from.
  const environmentImportChecked = selectedImport !== null && !importing && selectedImport.error === null;
  return { target, model, loading, error, canEditPersonal: personal !== null,
    environmentImport, environmentImportChecked, importing, selectTarget, reloadPersonal, importEnvironmentNames, save };
}
