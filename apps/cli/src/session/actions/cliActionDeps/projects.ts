import type { CliActionDepsParams } from './types';
import type { CliMachineActionCall, CliMachineActionServerScopeCurrent } from './machineTransport';
import type { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { readRpcRequestDisposition } from '@happier-dev/sync-client';
import { PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS, PROJECT_DEFINITION_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { ProjectWorkerActionInputSchemasV1, ProjectWorkerActionOutputSchemasV1 } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { updatePersonalProjectContextV1 } from '@happier-dev/protocol/projects/projectContextV1';
import type { readProjectAccountRows, createProjectAccountSnapshotMutation, mutateProjectAccountOrganization, mutateProjectAccountRows, OpenedProjectAccountRowMutationRequest, ProjectAccountRowsSelection } from '@/workspaces/projectAccountRows';
import type { readProjectLastOpenedMemoryMap } from '@/workspaces/projectLastOpenedMemory';
import { buildProjectLastOpenedMemoryKeyV1 } from '@happier-dev/protocol/account/authoringMemory';
import { projectProjectListV1 } from '@happier-dev/protocol/workspaces';
import { setProjectVisibilityV1 } from '@happier-dev/protocol/projects/projectVisibilityV1';
import { updateProjectOrganizationV1 } from '@happier-dev/protocol/projects/projectOrganizationV1';
import { setProjectSetupV1 } from '@happier-dev/protocol/projects/projectSetupSetV1';
import type { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import type { createCliProjectTrustAction } from '../projectTrustAction';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1, PROJECT_ACTION_OUTPUT_SCHEMAS_V1, PROJECT_FINITE_ACTION_RPC_METHODS_V1, isProjectSetupTrustRequestV1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { resolveProjectActionMachineV1 } from '@happier-dev/protocol/actions/executor/projectActionPlacement';
import type { withCliPromptLibraryArtifactReader } from '@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks';
import { randomUUID } from 'node:crypto';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { readHostAdmittedReviewedRootV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ProjectAccountWorkspaceRefV1Schema, type ProjectAccountRowPayloadV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { resolveProjectAccountWorkspaceRefRemovalV1 } from '@happier-dev/protocol/projects/projectAccountSnapshotV1';
import type { ProjectWorkspaceUpdateInputV1, ProjectWorkspaceUpdateOutputV1, ProjectWorkspaceForgetInputV1, ProjectWorkspaceForgetOutputV1 } from '@happier-dev/protocol/projects/projectWorkspaceActionsV1';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { listCurrentAccountMachines } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { dispatchOriginalAccountAction, readReviewedServiceMoveInput, isReviewedServiceMoveChild } from '@/api/externalActionExecutionAuthorization';
import { isProjectServiceMoveChildInputV1 } from '@happier-dev/protocol/workspaces/projectServiceRelocationV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { projectWorkspaceRefV1, resolveWorkspaceGroupingV1, resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { buildProjectAccountRowPhysicalKeyV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { CliProjectAdmission, CliProjectAdmissionFailure, CliAdmittedProjectRowsReader } from './projectAdmission';
import type { createCliApprovalsArtifactStore } from '../approvals/artifactStore';
import type { CliActionExactHomeTarget } from './types';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
function isOrganizationPayload(payload: ProjectAccountRowPayloadV1): payload is Extract<ProjectAccountRowPayloadV1, { key: { kind: 'project-organization' } }> {
  return payload.key.kind === 'project-organization';
}
export function createCliProjectActionDeps(
  params: Pick<CliActionDepsParams, 'serverId' | 'credentials' | 'isCredentialCurrent' | 'machineActionDirectTargetTransport' | 'onRequesterSessionCredentialDisclosure' | 'projectAction' | 'projectWorkerAccountAction' | 'projectDefinitionAction' | 'serverHttpBaseUrl' | 'serverIdentityId' | 'token'>,
  { readAdmittedProjectRows, actionOperationAction, callMachineAction, isMachineActionServerScopeCurrent, executionRunActionFailure, isExecutionRunActionAbort, projectAccountAdmission, projectRowsAuthority, readProjectRows, resolveProjectHomeIdentity, withProjectHome, admitProjectRows, readProjectRequesterArtifact, projectHomeId, widgetHomeId, homeAccountId, todoHomeBaseUrl, todoHomeServerId, approvalsStore, exactHome }: Readonly<{
    readAdmittedProjectRows: CliAdmittedProjectRowsReader;
    actionOperationAction: NonNullable<ActionExecutorDeps['actionOperationAction']>;
    callMachineAction: CliMachineActionCall;
    isMachineActionServerScopeCurrent: CliMachineActionServerScopeCurrent;
    executionRunActionFailure: (code: string, message?: string, details?: unknown) => CliProjectAdmissionFailure;
    isExecutionRunActionAbort: (error: unknown, signal?: AbortSignal) => boolean;
    projectAccountAdmission: CliProjectAdmission['projectAccountAdmission'];
    projectRowsAuthority: CliProjectAdmission['projectRowsAuthority'];
    readProjectRows: CliProjectAdmission['readProjectRows'];
    resolveProjectHomeIdentity: CliProjectAdmission['resolveProjectHomeIdentity'];
    withProjectHome: CliProjectAdmission['withProjectHome'];
    admitProjectRows: CliProjectAdmission['admitProjectRows'];
    readProjectRequesterArtifact: CliProjectAdmission['readProjectRequesterArtifact'];
    projectHomeId: string;
    widgetHomeId: string;
    homeAccountId: string | null;
    todoHomeBaseUrl: string;
    todoHomeServerId: string;
    approvalsStore: ReturnType<typeof createCliApprovalsArtifactStore> | null;
    exactHome: CliActionExactHomeTarget;
  }>,
): Pick<ActionExecutorDeps, 'projectsWorkspaceUpdate' | 'projectsServicesPin' | 'projectsWorkspaceForget' | 'projectsContextUpdate' | 'projectAction' | 'projectsOrganizationUpdate' | 'projectsSetupSet' | 'projectsVisibilitySet' | 'projectsList' | 'projectWorkspaceRefs' | 'projectWorkerAction' | 'projectDefinitionAction' | 'projectsOpen'> {
  return {
    projectsSetupSet: async ({ input, context, executeCanonicalAction }) => {
      const refused = await projectAccountAdmission(input.projectRef.serverId, context);
      if (refused) return { ok: false, errorCode: refused.errorCode,
        ...(refused.details === undefined ? {} : { details: refused.details }) };
      const serverId = await resolveProjectHomeIdentity();
      const rows = await readProjectRows({ key: { kind: 'workspace-ref', serverId, id: input.workspace.workspaceId } },
        context.signal, context, 'projects.setup.set');
      const resolved = resolveWorkspaceRefV1(rows.workspaceRefs, { ...input.workspace, serverId, id: input.workspace.workspaceId });
      if (resolved.kind !== 'resolved' || projectWorkspaceRefV1(resolved.ref).projectKey !== input.projectRef.projectKey) {
        return { ok: false, errorCode: 'project_workspace_association_mismatch' };
      }
      const { mutateProjectAccountOrganization } = await import('@/workspaces/projectAccountRows');
      return withProjectHome(() => setProjectSetupV1({ execute: executeCanonicalAction,
        mutateOrganization: mutation => mutateProjectAccountOrganization({ ...mutation,
          ...projectRowsAuthority(context, 'projects.setup.set', mutation.signal), serverId: mutation.serverId }),
      }, { ...input, projectRef: { ...input.projectRef, serverId }, workspace: { ...input.workspace, serverId } }, context));
    },
    projectsWorkspaceUpdate: async ({ serverId, workspaceId, label, pinned, projectKey }: ProjectWorkspaceUpdateInputV1,
      context?: ActionExecutorContext): Promise<ProjectWorkspaceUpdateOutputV1> => {
      const refused = await projectAccountAdmission(serverId, context);
      if (refused) return refused;
      serverId = await resolveProjectHomeIdentity();
      const operationSignal = context?.signal;
      try {
        // Grouping names another Project, so it reads the Home's checkouts; a label or pin reads only this one.
        const before = await readProjectRows(projectKey === undefined ? { key: { kind: 'workspace-ref', serverId, id: workspaceId } }
          : { kinds: ['workspace-ref'], serverId }, operationSignal, context, 'projects.workspace.update');
        const resolved = resolveWorkspaceRefV1(before.workspaceRefs, { serverId, id: workspaceId });
        if (resolved.kind !== 'resolved') return executionRunActionFailure(resolved.kind === 'missing' ? 'not_found' : `workspace_ref_${resolved.kind}`);
        const ref = resolved.ref;
        const mutations: OpenedProjectAccountRowMutationRequest['mutations'][number][] = [];
        const key = { kind: 'workspace-ref' as const, serverId: ref.serverId, id: ref.id };
        // The person's grouping (owner 11-08): the one protocol owner decides the explicit key.
        const grouping = projectKey === undefined ? null : resolveWorkspaceGroupingV1(before.workspaceRefs, ref, projectKey);
        if (grouping && !grouping.ok) return executionRunActionFailure(grouping.code);
        const workspaceRef = ProjectAccountWorkspaceRefV1Schema.parse({ ...ref,
          ...(label === undefined ? {} : { label }),
          ...(grouping ? { projectKey: grouping.projectKey } : {}),
        });
        const target = projectWorkspaceRefV1(workspaceRef);
        const organizationKey = { kind: 'project-organization' as const, ...target };
        const organizationRows = await readProjectRows({ key: organizationKey }, operationSignal, context, 'projects.workspace.update');
        const revisionFor = (rowKey: Parameters<typeof buildProjectAccountRowPhysicalKeyV1>[0]) => (rowKey.kind === 'project-organization'
          ? organizationRows.rows : before.rows).find(
          row => buildProjectAccountRowPhysicalKeyV1(row.key) === buildProjectAccountRowPhysicalKeyV1(rowKey),
        )?.revision ?? 'absent';
        if (workspaceRef.label !== ref.label || workspaceRef.projectKey !== ref.projectKey) {
          mutations.push({ key, expectedRevision: revisionFor(key), payload: { key, value: workspaceRef } });
        }
        const organization = organizationRows.organizations.find(row => row.key.serverId === target.serverId && row.key.projectKey === target.projectKey)?.value ?? {};
        let acknowledgedWorkspaceRef = ref;
        let acknowledgedOrganization = organization;
        if (pinned !== undefined && pinned !== (organization.pinned === true)) {
          mutations.push({ key: organizationKey, expectedRevision: revisionFor(organizationKey),
            payload: { key: organizationKey, value: { ...organization, pinned } } });
        }
        if (mutations.length > 0) {
          const { mutateProjectAccountRows } = await import("@/workspaces/projectAccountRows");
          const result = await withProjectHome(() => mutateProjectAccountRows({ ...projectRowsAuthority(context, 'projects.workspace.update', operationSignal),
            request: { mutations, expectedRefs: [], topologyChange: false }, ...(operationSignal ? { signal: operationSignal } : {}) }));
          if (result.status !== 'updated') return executionRunActionFailure(result.status === 'conflict' ? 'project_account_rows_conflict' : `project_account_rows_${result.status}`);
          for (const row of result.openedRows) {
            if (!row.payload) continue;
            if (row.key.kind === 'workspace-ref' && 'id' in row.payload.value) acknowledgedWorkspaceRef = row.payload.value;
            if (row.key.kind === 'project-organization' && isOrganizationPayload(row.payload)) {
              acknowledgedOrganization = row.payload.value;
            }
          }
        }
        return { ok: true, workspaceRef: acknowledgedWorkspaceRef, organization: acknowledgedOrganization };
      } catch (error) {
        if (isExecutionRunActionAbort(error, operationSignal)) return executionRunActionFailure('cancelled');
        return executionRunActionFailure(readRpcErrorCode(error) ?? 'project_account_rows_unavailable');
      }
    },
    /** Pin or unpin a service: the Home's one Services organization row, read by its key and written with its revision. */
    projectsServicesPin: async ({ serverId, environmentId, pinned }, context) => {
      const refused = await projectAccountAdmission(serverId, context);
      if (refused) return refused;
      serverId = await resolveProjectHomeIdentity();
      const operationSignal = context?.signal;
      const key = { kind: 'services-organization' as const, serverId };
      const identity = buildProjectAccountRowPhysicalKeyV1(key);
      try {
        const { mutateProjectAccountRows } = await import("@/workspaces/projectAccountRows");
        while (true) {
          const read = await readProjectRows({ key }, operationSignal, context, 'projects.services.pin');
          const row = read.rows.find(value => buildProjectAccountRowPhysicalKeyV1(value.key) === identity);
          const value = row?.payload?.value;
          const before: readonly string[] = value && 'pinnedEnvironmentIds' in value ? value.pinnedEnvironmentIds : [];
          if (before.includes(environmentId) === pinned) return { ok: true, pinnedEnvironmentIds: [...before] };
          const next = pinned ? [environmentId, ...before] : before.filter(id => id !== environmentId);
          const result = await withProjectHome(() => mutateProjectAccountRows({ ...projectRowsAuthority(context, 'projects.services.pin', operationSignal),
            request: { mutations: [{ key, expectedRevision: row?.revision ?? 'absent', payload: { key, value: { pinnedEnvironmentIds: next } } }],
              expectedRefs: [], topologyChange: false }, ...(operationSignal ? { signal: operationSignal } : {}) }));
          // A concurrent pin elsewhere moved the row: apply this one intent to its newer value.
          if (result.status === 'conflict') continue;
          if (result.status !== 'updated') return executionRunActionFailure(`project_account_rows_${result.status}`);
          return { ok: true, pinnedEnvironmentIds: next };
        }
      } catch (error) {
        if (isExecutionRunActionAbort(error, operationSignal)) return executionRunActionFailure('cancelled');
        return executionRunActionFailure(readRpcErrorCode(error) ?? 'project_account_rows_unavailable');
      }
    },
    projectsWorkspaceForget: async ({ serverId, workspaceId }: ProjectWorkspaceForgetInputV1,
      context?: ActionExecutorContext): Promise<ProjectWorkspaceForgetOutputV1> => {
      const refused = await projectAccountAdmission(serverId, context);
      if (refused) return refused;
      serverId = await resolveProjectHomeIdentity();
      try {
        const { createProjectAccountSnapshotMutation } = await import("@/workspaces/projectAccountRows");
        const result = await withProjectHome(() => createProjectAccountSnapshotMutation(projectRowsAuthority(context, 'projects.workspace.forget', context?.signal))(snapshot => {
          return { ...snapshot, workspaceRefs: resolveProjectAccountWorkspaceRefRemovalV1(snapshot,
            { serverId, workspaceRefId: workspaceId }) };
        }, context?.signal));
        if (result.status !== 'applied' && result.status !== 'unchanged') return executionRunActionFailure(`project_account_rows_${result.status}`);
        return { ok: true, workspaceId };
      } catch (error) {
        if (isExecutionRunActionAbort(error, context?.signal)) return executionRunActionFailure('cancelled');
        const details = error instanceof Error && 'relationshipIds' in error && Array.isArray(error.relationshipIds)
          && error.relationshipIds.every((id: unknown) => typeof id === 'string')
          ? { relationshipIds: error.relationshipIds } : undefined;
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code : readRpcErrorCode(error);
        return executionRunActionFailure(code ?? 'project_account_rows_unavailable', undefined, details);
      }
    },
    projectsContextUpdate: async (input, context) => {
      if (await projectAccountAdmission(input.target.serverId, context)) {
        return { ok: false, errorCode: 'project_context_access_denied' };
      }
      input = { ...input, target: { ...input.target,
        serverId: await resolveProjectHomeIdentity() } };
      const accountId = context?.externalActionExecutionAuthorization?.binding.accountId ?? homeAccountId;
      if (!accountId) return { ok: false, errorCode: 'project_context_access_denied' };
      const { mutateProjectAccountOrganization } = await import("@/workspaces/projectAccountRows");
      const run = () => updatePersonalProjectContextV1({
        accountScope: () => params.serverId === undefined && configuration.activeServerId !== projectHomeId
          ? null : { serverId: input.target.serverId, accountId },
        readArtifact: async (ref, options) => {
          if (context?.externalActionExecutionAuthorization) {
            const artifact = await readProjectRequesterArtifact({ ...ref, serverId: ref.serverId ?? input.target.serverId }, options, context);
            return artifact?.promptLibraryArtifact ?? null;
          }
          if (!approvalsStore) return null;
          const [{ isServerProfileHomeIdentity }, { withCliPromptLibraryArtifactReader }] = await Promise.all([import("@/server/serverProfiles"), import("@/agent/prompts/library/resolveCliPromptStackSystemAppendBlocks")]);
          if (!ref.serverId || await isServerProfileHomeIdentity(projectHomeId, ref.serverId)) return approvalsStore.promptLibraryStore.read(ref.artifactId, options);
          // Delegated provenance cannot borrow the user's saved foreign Home.
          if (context?.externalActionCredential || context?.externalActionExecutionAuthorization) return null;
          // The reader captures that Home's actual saved credential. Do not pass
          // this Action's credential override: the focused Home may be foreign.
          return withCliPromptLibraryArtifactReader(reader => reader.readArtifact(ref), {
            serverId: todoHomeServerId, signal: options?.signal,
          });
        },
        mutateOrganization: (mutation) => mutateProjectAccountOrganization({ ...mutation,
          ...projectRowsAuthority(context, 'projects.context.update', mutation.signal), serverId: mutation.serverId }),
      }, input, context);
      return runWithServerHttpBaseUrl(todoHomeBaseUrl, run);
    },
    projectAction: async (args) => {
      if (args.actionId === 'projects.trust.list' || args.actionId === 'projects.trust.revoke') {
        const { createCliProjectTrustAction } = await import("../projectTrustAction");
        return await createCliProjectTrustAction({ token: params.token, credentials: params.credentials,
          accountId: homeAccountId, ...exactHome })(args);
      }
      if (params.projectAction) return await params.projectAction(args);
      if (isProjectSetupTrustRequestV1(args.actionId, args.input)) {
        const request = PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.prepare'].safeParse(args.input);
        if (!request.success) return executionRunActionFailure('invalid_parameters');
        const { context } = args;
        // The approval owner admitted this Account effect. Re-dispatching prepare
        // would author a second signed origin for the same immutable approval.
        const denied = await projectAccountAdmission(request.data.workspace.serverId, context);
        if (denied) return denied;
        if (!params.credentials || !homeAccountId) return executionRunActionFailure('not_authenticated');
        const { ActionOperationGetV1ResponseSchema } = await import('@happier-dev/protocol/actions/operations/v1');
        const { readProjectSetupTrustRequestOperationV1 } = await import('@happier-dev/protocol/actions/projectActionFamily');
        const { rememberAdmittedProjectSetupConsentV1 } = await import('@happier-dev/protocol/workspaces/projectSetup/projectSetupConsent');
        const { createProjectSetupTrustClient } = await import('@/workspaces/projectSetup/projectSetupTrust');
        try {
          const refresh = async () => {
            const response = await actionOperationAction({ actionId: 'action.operations.get', input: {
              serverId: request.data.workspace.serverId, machineId: request.data.workspace.machineId,
              operationId: request.data.heldOperationId!, refreshSetupReview: true,
            }, context, signal: context.signal });
            const failure = ActionExecuteFailureSchema.safeParse(response);
            if (failure.success) throw Object.assign(new Error(failure.data.errorCode), { code: failure.data.errorCode });
            return ActionOperationGetV1ResponseSchema.parse(response);
          };
          const retained = readProjectSetupTrustRequestOperationV1(request.data, await refresh());
          const source = retained?.domainRef?.kind === 'projectCommand' ? retained.domainRef.sourceWorkspace : undefined;
          if (!retained || retained.scope.accountId !== homeAccountId || !source) return executionRunActionFailure('project_setup_review_unavailable');
          const rows = await readProjectRows({ key: { kind: 'workspace-ref', serverId: source.serverId, id: source.workspaceId } },
            context.signal, context, 'projects.prepare');
          const selected = resolveWorkspaceRefV1(rows.workspaceRefs, source);
          if (selected.kind !== 'resolved' || !selected.ref.projectKey) return executionRunActionFailure('project_unavailable');
          const client = createProjectSetupTrustClient({ credentials: params.credentials,
            serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(), signal: context.signal });
          const project = { serverId: source.serverId, projectId: selected.ref.projectKey };
          const result = await rememberAdmittedProjectSetupConsentV1({ scope: { serverId: source.serverId, accountId: homeAccountId },
            workspace: source, reviewedEffectDigest: request.data.expectedEffectDigest!, operation: retained, project,
            refreshOperation: async () => { const response = await refresh(); return response.kind === 'found' ? response.operation : null; },
            readTrust: () => client.read(project),
            rememberEffect: value => client.approveReviewedEffect({ ...value, authority: context.authority ?? 'account_automation' }),
          });
          return result.kind === 'remembered' ? { operation: result.operation } : executionRunActionFailure(
            result.kind === 'changed' ? 'project_setup_effect_changed' : result.code);
        } catch (error) {
          const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code : 'project_setup_requester_review_unavailable';
          return executionRunActionFailure(code);
        }
      }
      const { actionId, input, context } = args;
      const parsed = PROJECT_ACTION_INPUT_SCHEMAS_V1[actionId].safeParse(input);
      if (!parsed.success) return executionRunActionFailure('invalid_parameters');
      const workspace = parsed.data.workspace;
      if (!await isMachineActionServerScopeCurrent({ serverId: workspace.serverId, machineId: workspace.machineId, context, signal: context.signal })
        || !await isMachineActionServerScopeCurrent({ serverId: context.serverId, machineId: workspace.machineId, context, signal: context.signal })) {
        return executionRunActionFailure('server_scope_mismatch');
      }
      const originalAccount = params.credentials && !params.machineActionDirectTargetTransport
        && !context.externalActionCredential && !context.externalActionExecutionAuthorization
        && !context.rpcSessionAuthorization && (!context.actionCaller || context.actionCaller.kind === 'host');
      const placement = await resolveProjectActionMachineV1({ actionId, input: parsed.data, context,
        executeCanonicalAction: args.executeCanonicalAction, createRequestKey: randomUUID,
        ...(originalAccount && params.serverIdentityId ? { homeId: params.serverIdentityId } : {}) });
      if (!placement.ok) return placement;
      const { machineId } = placement;
      if (context.externalActionTarget && (context.externalActionTarget.kind !== 'machine'
        || context.externalActionTarget.machineId !== machineId)) return executionRunActionFailure('target_not_local');
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return executionRunActionFailure('not_authenticated');
      }
      context.signal?.throwIfAborted();
      if (originalAccount) {
        if (context.surface !== 'cli' || !context.actionRequestId
          || (context.runtimeAccountId && context.runtimeAccountId !== homeAccountId)) {
          return executionRunActionFailure('admission_unavailable');
        }
        const execution = await dispatchOriginalAccountAction({ actionId, input: parsed.data, requestId: context.actionRequestId,
          target: { kind: 'machine', machineId }, credentials: params.credentials!, authority: context.authority,
          invocation: { caller: { kind: 'host' }, surface: 'cli', authority: context.authority ?? 'account_automation' },
          serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
          ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
          ...(params.onRequesterSessionCredentialDisclosure
            ? { onRequesterSessionCredentialDisclosure: params.onRequesterSessionCredentialDisclosure } : {}),
          ...(params.isCredentialCurrent ? { isCurrent: params.isCredentialCurrent } : {}),
          ...(context.signal ? { signal: context.signal } : {}) });
        if (!execution.ok) return execution;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
        if (approval.success && approval.data.actionId === actionId) return approval.data;
        const output = PROJECT_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(execution.result);
        return output.success ? output.data : executionRunActionFailure('invalid_action_output');
      }
      if (params.machineActionDirectTargetTransport?.machineId !== machineId && !context.externalActionCredential
        && !context.externalActionExecutionAuthorization && !context.rpcSessionAuthorization) {
        return executionRunActionFailure('admission_unavailable');
      }
      const call = () => callMachineAction({ machineId, serverId: workspace.serverId,
        method: PROJECT_FINITE_ACTION_RPC_METHODS_V1[actionId], request: parsed.data, authority: context.authority,
        ...(context.rpcSessionAuthorization ? { authorization: context.rpcSessionAuthorization } : {}),
        exactMachine: true, context, effectActionId: actionId, timeoutMs: null,
        ...(context.signal ? { signal: context.signal } : {}) });
      const raw = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, call) : call());
      // A received finite acknowledgement retains its operation custody even
      // if observation is cancelled while consuming it. Cancellation before
      // issue and strict output validation remain unchanged; this is not Stop.
      const failure = ActionExecuteFailureSchema.safeParse(raw);
      if (failure.success) return failure.data;
      const approval = ActionApprovalRequestCreatedResultSchema.safeParse(raw);
      if (approval.success && approval.data.actionId === actionId) return approval.data;
      const output = PROJECT_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(raw);
      return output.success ? output.data : executionRunActionFailure('invalid_action_output');
    },
    projectsOrganizationUpdate: async (input, context) => {
      if (await projectAccountAdmission(input.projectRef.serverId, context)) {
        return { ok: false, errorCode: 'project_organization_access_denied' };
      }
      input = { ...input, projectRef: { ...input.projectRef, serverId: await resolveProjectHomeIdentity() } };
      const accountId = context?.externalActionExecutionAuthorization?.binding.accountId ?? homeAccountId;
      if (!accountId) return { ok: false, errorCode: 'project_organization_access_denied' };
      const { mutateProjectAccountOrganization, mutateProjectSessionDefaults } = await import("@/workspaces/projectAccountRows");
      return runWithServerHttpBaseUrl(todoHomeBaseUrl, () => updateProjectOrganizationV1({
        accountScope: () => params.serverId === undefined && configuration.activeServerId !== projectHomeId
          ? null : { serverId: input.projectRef.serverId, accountId },
        mutateOrganization: mutation => mutateProjectAccountOrganization({ ...mutation,
          ...projectRowsAuthority(context, 'projects.organization.update', mutation.signal), serverId: mutation.serverId }),
        mutateSessionDefaults: mutation => mutateProjectSessionDefaults({ ...mutation,
          ...projectRowsAuthority(context, 'projects.organization.update', mutation.signal), serverId: mutation.serverId }),
      }, input, context));
    },
    projectsVisibilitySet: async (input, context) => {
      if (await projectAccountAdmission(input.target.serverId, context)) {
        return { ok: false, errorCode: 'project_visibility_access_denied' };
      }
      input = { ...input, target: { ...input.target,
        serverId: await resolveProjectHomeIdentity() } };
      const accountId = context?.externalActionExecutionAuthorization?.binding.accountId ?? homeAccountId;
      if (!accountId) return { ok: false, errorCode: 'project_visibility_access_denied' };
      const { mutateProjectAccountOrganization } = await import("@/workspaces/projectAccountRows");
      return runWithServerHttpBaseUrl(todoHomeBaseUrl, () => setProjectVisibilityV1({
        accountScope: () => params.serverId === undefined && configuration.activeServerId !== projectHomeId
          ? null : { serverId: input.target.serverId, accountId },
        mutateOrganization: mutation => mutateProjectAccountOrganization({ ...mutation,
          ...projectRowsAuthority(context, 'projects.visibility.set', mutation.signal), serverId: mutation.serverId }),
      }, input, context));
    },
    projectsList: async (args, context) => {
      const requestedServerId = args.serverId ?? context?.serverId ?? projectHomeId;
      const admitted = await admitProjectRows(requestedServerId, context, 'projects.list', context?.signal);
      if (!admitted.ok) return admitted;
      const serverId = await resolveProjectHomeIdentity();
      return runWithServerHttpBaseUrl(todoHomeBaseUrl, async () => {
        const authority = { ...admitted.input, serverId };
        const [{ readProjectAccountRows }, { readProjectLastOpenedMemoryMap }] = await Promise.all([import("@/workspaces/projectAccountRows"), import("@/workspaces/projectLastOpenedMemory")]);
        const snapshot = await readProjectAccountRows({ ...authority, selection: { kinds: ['workspace-ref', 'project-organization'], serverId } });
        const recency = await readProjectLastOpenedMemoryMap(authority);
        const workspaceRefs = snapshot.workspaceRefs.map(ref => {
          const lastOpenedAtMs = recency.get(buildProjectLastOpenedMemoryKeyV1({ serverId: ref.serverId, projectKey: ref.projectKey ?? ref.id }));
          return lastOpenedAtMs === undefined ? ref : { ...ref, lastOpenedAtMs };
        });
        const projected = projectProjectListV1({ ...args, serverId, listing: args.includeUnlisted === true ? 'all' : 'listed',
          workspaceRefs, organizations: snapshot.organizations, coverage: 'complete' });
        let machines: Awaited<ReturnType<typeof listCurrentAccountMachines>> | null;
        const { listCurrentAccountMachines } = await import("@/api/machine/resolveCurrentAccountMachineTarget");
        try { machines = await listCurrentAccountMachines({ ...(authority.authorization
          ? { authorization: authority.authorization, effectActionId: authority.effectActionId }
          : { token: authority.credentials.token }), serverHttpBaseUrl: todoHomeBaseUrl, signal: context?.signal }); }
        catch { context?.signal?.throwIfAborted(); machines = null; }
        await admitted.assertCurrent();
        const items = projected.items.map(({ ref, ...item }) => {
          const machine = machines?.find(candidate => candidate.id === ref.machineId);
          return { ...item, serverId: ref.serverId, machineId: ref.machineId, rootPath: ref.rootPath,
            ...(ref.label ? { label: ref.label } : {}),
            reachable: machines === null ? null : Boolean(machine?.active && machine.revokedAt === null && machine.replacedByMachineId === null),
            ...(ref.repositoryIdentity ? { forge: ref.repositoryIdentity } : {}), worktrees: [] };
        });
        return { items, truncated: projected.truncated, coverage: projected.coverage };
      });
    },
    projectWorkspaceRefs: async (_args, context) => {
      const rows = await readAdmittedProjectRows({ kinds: ['workspace-ref', 'project-organization'], serverId: await resolveProjectHomeIdentity() },
        context?.signal, context, 'action.options.resolve');
      if (!rows) return { ok: false, errorCode: 'project_account_access_denied', error: 'project_account_access_denied' };
      const projected = projectProjectListV1({ serverId: widgetHomeId, workspaceRefs: rows.workspaceRefs, organizations: rows.organizations });
      return { workspaceRefs: projected.items.map(item => item.ref) };
    },
    projectWorkerAction: async (args) => {
      const { actionId, input, context, signal } = args;
      if (actionId !== 'projects.worker.status' && actionId !== 'projects.worker.copy.inspect' && actionId !== 'projects.worker.copy.retire') {
        return params.projectWorkerAccountAction ? await params.projectWorkerAccountAction(args)
          : { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      }
      const request = ProjectWorkerActionInputSchemasV1[actionId].parse(input);
      const machineId = 'destination' in request ? request.destination.machineId : request.machineId;
      if (!await isMachineActionServerScopeCurrent({ serverId: request.workspace.serverId, machineId, context, signal })
        || !await isMachineActionServerScopeCurrent({ serverId: context.serverId, machineId, context, signal })) {
        return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      }
      if (context.externalActionTarget && (context.externalActionTarget.kind !== 'machine'
        || context.externalActionTarget.machineId !== machineId)) {
        const authorization = context.externalActionExecutionAuthorization;
        const move = authorization && await readReviewedServiceMoveInput({ authorization,
          envelope: context.originalActionEnvelope, signal });
        if (!move || !isProjectServiceMoveChildInputV1(move, actionId, machineId, request)) {
          return { ok: false, errorCode: 'target_not_local', error: 'target_not_local' };
        }
      }
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== machineId) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      signal?.throwIfAborted();
      const spec = getActionSpec(actionId);
      const method = spec.bindings?.rpcMethod;
      if (!method) return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      // Worker observations and copy reconciliation share the containing Action's lifetime.
      const call = () => callMachineAction({ machineId, serverId: request.workspace.serverId, method,
        request, authority: context.authority, exactMachine: true, context, effectActionId: actionId, timeoutMs: null,
        ...(signal ? { signal } : {}) });
      // A standalone caller has no installed requester custody. Use the same
      // Home admission as original CLI work before the daemon reads private rows.
      const originalRead = spec.sideEffectClass === 'read' && params.credentials && !params.machineActionDirectTargetTransport
        && !context.externalActionCredential && !context.externalActionExecutionAuthorization && !context.rpcSessionAuthorization
        && !context.causalPermissionAuthority && (!context.actionCaller || context.actionCaller.kind === 'host')
        && (context.surface === undefined || context.surface === 'cli' || context.surface === 'mcp');
      const execution = originalRead ? await dispatchOriginalAccountAction({ actionId, input: request,
        requestId: context.actionRequestId ?? randomUUID(), target: { kind: 'machine', machineId },
        credentials: params.credentials!, authority: context.authority,
        serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
        ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
        ...(params.onRequesterSessionCredentialDisclosure ? { onRequesterSessionCredentialDisclosure: params.onRequesterSessionCredentialDisclosure } : {}),
        ...(params.isCredentialCurrent ? { isCurrent: params.isCredentialCurrent } : {}),
        ...(signal ? { signal } : {}) }) : null;
      const raw = execution ? execution.ok ? execution.result : execution
        : await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, call) : call());
      // Cancellation retires a read, not an already received write acknowledgement.
      if (spec.sideEffectClass === 'read') signal?.throwIfAborted();
      const failure = ActionExecuteFailureSchema.safeParse(raw);
      if (failure.success) return failure.data;
      const deferred = ActionApprovalRequestCreatedResultSchema.safeParse(raw);
      if (deferred.success && deferred.data.actionId === actionId) return deferred.data;
      const output = ProjectWorkerActionOutputSchemasV1[actionId].safeParse(raw);
      if (!output.success || ('candidate' in output.data && output.data.eligible
        && (output.data.candidate.serverId !== request.workspace.serverId || output.data.candidate.machineId !== machineId))
        || ('targetMachineId' in request && 'preview' in output.data && output.data.ok
          && (output.data.preview.targetMachineId !== request.targetMachineId || output.data.preview.workspaceRefId !== request.targetWorkspaceRefId))) {
        const errorCode = actionId === 'projects.worker.copy.retire' ? 'outcome_unknown' : 'invalid_action_output';
        return { ok: false, errorCode, error: errorCode };
      }
      return output.data;
    },
    projectDefinitionAction: async ({ actionId, input, context }) => {
      const parsed = PROJECT_DEFINITION_ACTION_INPUT_SCHEMAS[actionId].safeParse(input);
      if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      const workspace = parsed.data.workspace;
      // The installed owner handles its own checkout, including a reviewed
      // Move child delivered through the existing exact-Machine transport.
      const localDefinition = params.machineActionDirectTargetTransport
        ? params.machineActionDirectTargetTransport.machineId === workspace.machineId
        : !context.externalActionTarget || context.externalActionTarget.kind === 'machine'
          && context.externalActionTarget.machineId === workspace.machineId;
      const originalAccountInspection = actionId === 'projects.inspect' && params.credentials
        && !readHostAdmittedReviewedRootV1(context)
        && (!params.machineActionDirectTargetTransport || context.surface === 'cli' || context.surface === 'mcp')
        && !context.externalActionCredential && !context.externalActionExecutionAuthorization
        && !context.rpcSessionAuthorization && (!context.actionCaller || context.actionCaller.kind === 'host');
      // The installed executor already admitted this Action. A Session's public
      // authorization need not carry the private requester-context facet.
      if (!originalAccountInspection && params.projectDefinitionAction && localDefinition) {
        return await params.projectDefinitionAction({ actionId, input: parsed.data, context });
      }
      if (!await isMachineActionServerScopeCurrent({ serverId: workspace.serverId, machineId: workspace.machineId, context, signal: context.signal })
        || !await isMachineActionServerScopeCurrent({ serverId: context.serverId, machineId: workspace.machineId, context, signal: context.signal })) {
        return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
      }
      if (context.externalActionTarget && (context.externalActionTarget.kind !== 'machine'
        || context.externalActionTarget.machineId !== workspace.machineId)) {
        const authorization = context.externalActionExecutionAuthorization;
        if (actionId !== 'projects.inspect' || !authorization || !await isReviewedServiceMoveChild({ authorization,
          envelope: context.originalActionEnvelope, actionId, machineId: workspace.machineId, params: parsed.data,
          ...(context.signal ? { signal: context.signal } : {}) })) {
          return { ok: false, errorCode: 'target_not_local', error: 'target_not_local' };
        }
      }
      if (!params.credentials && params.machineActionDirectTargetTransport?.machineId !== workspace.machineId) {
        return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
      }
      context.signal?.throwIfAborted();
      if (originalAccountInspection) {
        // This new Home admission owns its request identity; an enclosing host
        // operation id can be longer than the external Action wire permits.
        const execution = await dispatchOriginalAccountAction({ actionId, input: parsed.data,
          requestId: randomUUID(), target: { kind: 'machine', machineId: workspace.machineId },
          credentials: params.credentials, authority: context.authority,
          serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
          ...(params.serverIdentityId ? { serverIdentityId: params.serverIdentityId } : {}),
          ...(params.onRequesterSessionCredentialDisclosure ? { onRequesterSessionCredentialDisclosure: params.onRequesterSessionCredentialDisclosure } : {}),
          ...(params.isCredentialCurrent ? { isCurrent: params.isCredentialCurrent } : {}),
          ...(context.signal ? { signal: context.signal } : {}) });
        return execution.ok ? execution.result : execution;
      }
      const call = () => callMachineAction({ machineId: workspace.machineId, serverId: workspace.serverId,
        method: getActionSpec(actionId).bindings!.rpcMethod!, request: parsed.data, authority: context.authority,
        exactMachine: true, context, effectActionId: actionId, timeoutMs: null,
        ...(context.signal ? { signal: context.signal } : {}) });
      const raw = await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, call) : call());
      context.signal?.throwIfAborted();
      const failure = ActionExecuteFailureSchema.safeParse(raw);
      if (failure.success) return failure.data;
      const deferred = ActionApprovalRequestCreatedResultSchema.safeParse(raw);
      if (deferred.success && deferred.data.actionId === actionId) return deferred.data;
      const output = PROJECT_DEFINITION_ACTION_OUTPUT_SCHEMAS[actionId].safeParse(raw);
      return output.success ? output.data : { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    },
    projectsOpen: async (input, context) => {
      const { OpenProjectResultV1Schema, readProjectOpenUnsentRefusalV1 } = await import('@happier-dev/protocol/projects/openProjectV1');
      const installed = params.machineActionDirectTargetTransport;
      const open = async () => OpenProjectResultV1Schema.parse(await (installed?.machineId === input.machineId
        && installed.openProject && context.originalActionEnvelope ? installed.openProject(input, context) : callMachineAction({
        machineId: input.machineId,
        serverId: input.serverId,
        method: RPC_METHODS.PROJECTS_OPEN,
        request: input,
        authority: context.authority,
        context,
        effectActionId: 'projects.open',
        exactMachine: true,
        timeoutMs: null,
        ...(context.signal ? { signal: context.signal } : {}),
      })));
      try { return await (params.serverHttpBaseUrl ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, open) : open()); }
      catch (error) {
        if (readRpcRequestDisposition(error) === 'notSent') return readProjectOpenUnsentRefusalV1(error);
        throw error;
      }
    },
  };
}
