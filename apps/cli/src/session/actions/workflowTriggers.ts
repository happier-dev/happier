import { randomUUID } from 'node:crypto';
import { createAccountHealthCheckSourceReaderV1, createAccountHealthCheckSourceSnapshotReaderV1,
  createAccountWorkflowTriggerActions } from '@happier-dev/protocol/actions/executor/workflowTriggerAccountHost';
import { resolveValidatedAutomationAccountEncryptionV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import type { WorkflowTriggerActionsDependencies } from '@happier-dev/protocol';

import { createAutomationDefinition, deleteAutomationDefinition, getAutomationDefinition,
  listAutomationDefinitionDetails, listAutomationDefinitions, readAutomationTriggerEventDeclarations, reconcileAutomationDefinition, runAutomationNowReceipt } from '@/api/automations';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { getRandomBytes } from '@/api/encryption';
import type { StoredCredentials } from '@/persistence';
import { createAutomationAccountEncryptionMaterialSnapshotV1 } from '@/plugins/runtime/automations/automationAccountCurrentness';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { resolveAutomationTemplateRetainedSession } from '@/daemon/automation/automationRetainedSession';
import { readManagedMachine } from '@/machines/managed/readManagedMachine';

/** Shared authenticated Account-mode adapter for retained trigger reads and writes. */
export function createCliAutomationEncryptionResolver(params: Readonly<{
  credentials: StoredCredentials; serverHttpBaseUrl?: string; signal?: AbortSignal;
}>) {
  const token = params.credentials.token;
  return async () => {
      const resolved = await resolveValidatedAutomationAccountEncryptionV1({
        signal: params.signal ?? new AbortController().signal,
        resolveAccountEncryptionCurrentness: (signal) => fetchAccountEncryptionCurrentness({
          token, signal,
          ...(params.serverHttpBaseUrl ? { serverBaseUrl: params.serverHttpBaseUrl } : {}),
        }),
        resolveAccountEncryptionMaterial: async () => createAutomationAccountEncryptionMaterialSnapshotV1(params.credentials),
      });
      if (resolved.kind === 'unavailable' && 'cause' in resolved
        && classifyServerEndpointError(resolved.cause).retryable) throw resolved.cause;
      if (resolved.kind !== 'available') throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
      return resolved;
  };
}

/** The receiving controller shares the retained Event reader without constructing Workflow execution dependencies. */
export function createCliHealthCheckSourceReader(params: Readonly<{
  credentials: StoredCredentials; serverHttpBaseUrl: string; signal?: AbortSignal;
}>) {
  return createAccountHealthCheckSourceReaderV1({
    automations: { listDetails: input => runWithServerHttpBaseUrl(params.serverHttpBaseUrl,
      () => listAutomationDefinitionDetails({ token: params.credentials.token, ...input,
        ...(params.signal ? { signal: params.signal } : {}) })) },
    resolveEncryption: createCliAutomationEncryptionResolver(params),
  });
}

/** The existing automation assembly borrows the complete typed source projection. */
export function createCliHealthCheckSourceSnapshotReader(params: Readonly<{
  credentials: StoredCredentials; serverHttpBaseUrl: string; signal?: AbortSignal;
}>) {
  return createAccountHealthCheckSourceSnapshotReaderV1({
    automations: { listDetails: input => runWithServerHttpBaseUrl(params.serverHttpBaseUrl,
      () => listAutomationDefinitionDetails({ token: params.credentials.token, ...input,
        ...(params.signal ? { signal: params.signal } : {}) })) },
    resolveEncryption: createCliAutomationEncryptionResolver(params),
  });
}

/** CLI adapts canonical Account currentness/crypto and Automation transport, not trigger semantics. */
export function createCliWorkflowTriggerActions(params: Readonly<{
  credentials: StoredCredentials;
  workflowRequesterCustody?: Parameters<typeof createAccountWorkflowTriggerActions>[0]['workflowRequesterCustody'];
  serverHttpBaseUrl?: string;
  resolveWorkflow: WorkflowTriggerActionsDependencies['resolveWorkflow'];
  resolveWorkflowTeamIds?: WorkflowTriggerActionsDependencies['resolveWorkflowTeamIds'];
  sessionList?: WorkflowTriggerActionsDependencies['sessionList'];
  sessionRead?: WorkflowTriggerActionsDependencies['sessionRead'];
  resolveSession?: WorkflowTriggerActionsDependencies['resolveSession'];
  resolveRunTrigger?: WorkflowTriggerActionsDependencies['resolveRunTrigger'];
  resolveRunSource?: WorkflowTriggerActionsDependencies['resolveRunSource'];
  resolveMaterializer?: WorkflowTriggerActionsDependencies['resolveMaterializer'];
  pullRequests?: WorkflowTriggerActionsDependencies['pullRequests'];
  nativeAccount?: WorkflowTriggerActionsDependencies['nativeAccount'];
  deploymentAction?: WorkflowTriggerActionsDependencies['deploymentAction'];
}>) {
  const onServer = <T>(operation: () => Promise<T>): Promise<T> => params.serverHttpBaseUrl
    ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, operation) : operation();
  const token = params.credentials.token;
  return createAccountWorkflowTriggerActions({
    ...(params.workflowRequesterCustody ? { workflowRequesterCustody: params.workflowRequesterCustody } : {}),
    automations: {
      list: (input) => onServer(() => listAutomationDefinitions({ token, ...input })),
      listDetails: (input) => onServer(() => listAutomationDefinitionDetails({ token, ...input })),
      readTriggerEventDeclarations: (input) => onServer(() => readAutomationTriggerEventDeclarations({ token, input })),
      get: (automationId) => onServer(() => getAutomationDefinition({ token, automationId })),
      create: (input) => onServer(() => createAutomationDefinition({ token, input })),
      reconcile: (automationId, input) => onServer(() => reconcileAutomationDefinition({ token, automationId, input })),
      delete: (automationId) => onServer(() => deleteAutomationDefinition({ token, automationId })),
      runNow: (automationId, options, caller) => onServer(() => runAutomationNowReceipt({ token, automationId, ...options,
        ...(caller?.externalActionExecutionAuthorization ? { authorization: caller.externalActionExecutionAuthorization } : {}),
        ...(caller?.externalActionCredential ? { requiresRequesterCustody: true } : {}),
        ...(caller?.signal ? { signal: caller.signal } : {}),
      })),
    },
    resolveEncryption: createCliAutomationEncryptionResolver(params),
    resolveRetainedSession: (sessionId) => onServer(() => resolveAutomationTemplateRetainedSession({
      credentials: params.credentials, sessionId,
    })),
    randomBytes: getRandomBytes,
    newId: () => randomUUID(),
    ...(params.sessionList ? { sessionList: params.sessionList } : {}),
    ...(params.sessionRead ? { sessionRead: params.sessionRead } : {}),
    ...(params.resolveSession ? { resolveSession: params.resolveSession } : {}),
    ...(params.resolveRunTrigger ? { resolveRunTrigger: params.resolveRunTrigger } : {}),
    ...(params.resolveRunSource ? { resolveRunSource: params.resolveRunSource } : {}),
    resolveManagedMachine: (input, caller) => readManagedMachine({ ...input, credentials: params.credentials,
      serverHttpBaseUrl: params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(),
      ...(caller?.signal ? { signal: caller.signal } : {}),
      ...(caller?.externalActionExecutionAuthorization ? { authorization: caller.externalActionExecutionAuthorization } : {}),
    }),
    ...(params.resolveMaterializer ? { resolveMaterializer: params.resolveMaterializer } : {}),
    ...(params.pullRequests ? { pullRequests: params.pullRequests } : {}),
    ...(params.nativeAccount ? { nativeAccount: params.nativeAccount } : {}),
    ...(params.deploymentAction ? { deploymentAction: params.deploymentAction } : {}),
    resolveWorkflow: (ref) => onServer(() => params.resolveWorkflow(ref)),
    resolveWorkflowTeamIds: (artifactId) => onServer(async () => {
      if (params.resolveWorkflowTeamIds) return params.resolveWorkflowTeamIds(artifactId);
      const artifacts = createCredentialedAccountArtifactStore(params.credentials);
      const result = await artifacts.accessGrants.list({ artifactId });
      return result.grants.flatMap((grant) => grant.principal.kind === 'team' ? [grant.principal.teamId] : []);
    }),
  });
}
