import type { RetainedCheckoutTeardownDataV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { resolveWorkspaceSyncExecutionMachineIdV1 } from '@happier-dev/protocol/workspaces/workspaceSyncTopology';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { resolveProjectSecretReferenceEnvironment } from '@/settings/secrets/secretReferenceOverlay';
import { readProjectAccountRows, type ProjectAccountRowsInput } from '@/workspaces/projectAccountRows';
import { resolveWorkspaceRefById } from '@/workspaces/workspaceRefsV1';
import { readAcceptedProjectSetupForProject } from './projectAcceptedSetup';
import { readProjectEffectiveDefinition } from './projectEffectiveDefinition';
import type { ProjectFiniteActionRuntime } from './projectFiniteAction';
import { resolveProjectRequesterSecretEnvironment, selectProjectRequesterSecretBindings } from './projectSetupRequesterInputs';
import { createProjectSetupTrustClient } from './projectSetupTrust';

/** Only the bound controller opens Account data. The target receives this invocation's selected values. */
export async function captureRetainedCheckoutTeardown(input: Readonly<{
  runtime: ProjectFiniteActionRuntime;
  workspace: WorkspaceRefV1;
  sourceRoot: string;
  skipCleanup: boolean;
  signal: AbortSignal;
}>): Promise<RetainedCheckoutTeardownDataV1 | null> {
  const { runtime, workspace, signal } = input;
  const authorization = runtime.accountAuthorization;
  const requester = readRequesterAccountActionContext(authorization);
  if (!authorization || !requester || authorization.binding.machineId !== runtime.machineId
    || authorization.binding.accountId !== runtime.accountId || authorization.binding.serverIdentityId !== workspace.serverId) {
    throw Object.assign(new Error('project_requester_authority_unavailable'), { code: 'project_requester_authority_unavailable' });
  }
  // Private Account rows are opened on the requester's own controller only.
  const account: ProjectAccountRowsInput = { credentials: requester.credentials, sessionCustody: {
    serverId: workspace.serverId, accountId: runtime.accountId, serverHttpBaseUrl: runtime.serverHttpBaseUrl,
    isCurrent: () => Promise.resolve(!signal.aborted),
  } };
  const rows = await readProjectAccountRows({ ...account, serverId: workspace.serverId, signal,
    selection: { key: { kind: 'workspace-ref', serverId: workspace.serverId, id: workspace.id } } });
  const current = resolveWorkspaceRefById(rows.workspaceRefs, workspace.id, workspace.serverId);
  if (!current || current.rootPath !== workspace.rootPath
    || resolveWorkspaceSyncExecutionMachineIdV1(current) !== resolveWorkspaceSyncExecutionMachineIdV1(workspace)) {
    throw Object.assign(new Error('project_workspace_changed'), { code: 'project_workspace_changed' });
  }
  if (!current.projectKey) return null;
  const project = { serverId: workspace.serverId, projectId: current.projectKey };
  if (input.skipCleanup) return { project, organization: null, acceptedSetup: { kind: 'ready' }, trust: null, selectedEnvironment: {} };
  const organizationRows = await readProjectAccountRows({ ...account, serverId: project.serverId, signal,
    selection: { key: { kind: 'project-organization', serverId: project.serverId, projectKey: project.projectId } } });
  const row = organizationRows.organizations[0];
  const organization = row ? { key: row.key, value: row.value } : null;
  const acceptedSetup = await readAcceptedProjectSetupForProject({ account, project, serverHttpBaseUrl: runtime.serverHttpBaseUrl,
    signal, organization: organization?.value ?? null });
  if (acceptedSetup.kind === 'unavailable') throw Object.assign(new Error(acceptedSetup.code), { code: acceptedSetup.code });
  const trust = await createProjectSetupTrustClient({ authorization, serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal })
    .readCheckoutTeardownTrust(project);
  const { effectiveDefinition } = await readProjectEffectiveDefinition({ root: input.sourceRoot, acceptedSetup,
    account, project, serverHttpBaseUrl: runtime.serverHttpBaseUrl, signal });
  const requirements = effectiveDefinition.effectiveManifest?.environmentVariables ?? [];
  const overlay = selectProjectRequesterSecretBindings(organization?.value.environmentBindings, requirements);
  const material = overlay ? await resolveProjectRequesterSecretEnvironment(runtime, overlay, signal) : undefined;
  const selectedEnvironment = resolveProjectSecretReferenceEnvironment({
    ...(material ?? { accountSettings: {}, settingsSecretsReadKeys: [], savedSecretMaterializer: null }), requirements,
    ...(overlay ? { secretReferenceOverlay: overlay } : {}),
  });
  return { project, organization, acceptedSetup, trust, selectedEnvironment };
}
