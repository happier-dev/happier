import { randomUUID } from 'node:crypto';
import { createAccountWorkflowTriggerActions } from '@happier-dev/protocol/actions/executor/workflowTriggerAccountHost';
import { resolveValidatedAutomationAccountEncryptionV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import type { WorkflowDefinitionV1, WorkflowTriggerActionsDependencies } from '@happier-dev/protocol';

import { createAutomationDefinition, deleteAutomationDefinition, getAutomationDefinition,
  listAutomationDefinitions, reconcileAutomationDefinition, runAutomationNowReceipt } from '@/api/automations';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { getRandomBytes } from '@/api/encryption';
import type { StoredCredentials } from '@/persistence';
import { createAutomationAccountEncryptionMaterialSnapshotV1 } from '@/plugins/runtime/automations/automationAccountCurrentness';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { resolveAutomationTemplateRetainedSession } from '@/daemon/automation/automationRetainedSession';
import { readManagedMachine } from '@/machines/managed/readManagedMachine';
import { configuration } from '@/configuration';

/** CLI adapts canonical Account currentness/crypto and Automation transport, not trigger semantics. */
export function createCliWorkflowTriggerActions(params: Readonly<{
  credentials: StoredCredentials;
  serverHttpBaseUrl?: string;
  resolveWorkflow: (ref: string) => Promise<WorkflowDefinitionV1>;
  resolveWorkflowTeamIds?: WorkflowTriggerActionsDependencies['resolveWorkflowTeamIds'];
  sessionList?: WorkflowTriggerActionsDependencies['sessionList'];
  resolveSession?: WorkflowTriggerActionsDependencies['resolveSession'];
  resolveRunTrigger?: WorkflowTriggerActionsDependencies['resolveRunTrigger'];
  resolveRunSource?: WorkflowTriggerActionsDependencies['resolveRunSource'];
  resolveMaterializer?: WorkflowTriggerActionsDependencies['resolveMaterializer'];
  pullRequests?: WorkflowTriggerActionsDependencies['pullRequests'];
}>) {
  const onServer = <T>(operation: () => Promise<T>): Promise<T> => params.serverHttpBaseUrl
    ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, operation) : operation();
  const token = params.credentials.token;
  return createAccountWorkflowTriggerActions({
    automations: {
      list: (input) => onServer(() => listAutomationDefinitions({ token, ...input })),
      get: (automationId) => onServer(() => getAutomationDefinition({ token, automationId })),
      create: (input) => onServer(() => createAutomationDefinition({ token, input })),
      reconcile: (automationId, input) => onServer(() => reconcileAutomationDefinition({ token, automationId, input })),
      delete: (automationId) => onServer(() => deleteAutomationDefinition({ token, automationId })),
      runNow: (automationId, options) => onServer(() => runAutomationNowReceipt({ token, automationId, ...options })),
    },
    resolveEncryption: async () => {
      const resolved = await resolveValidatedAutomationAccountEncryptionV1({
        signal: new AbortController().signal,
        resolveAccountEncryptionCurrentness: (signal) => fetchAccountEncryptionCurrentness({
          token, signal,
          ...(params.serverHttpBaseUrl ? { serverBaseUrl: params.serverHttpBaseUrl } : {}),
        }),
        resolveAccountEncryptionMaterial: async () => createAutomationAccountEncryptionMaterialSnapshotV1(params.credentials),
      });
      if (resolved.kind !== 'available') throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
      return resolved;
    },
    resolveRetainedSession: (sessionId) => onServer(() => resolveAutomationTemplateRetainedSession({
      credentials: params.credentials, sessionId,
    })),
    randomBytes: getRandomBytes,
    newId: () => randomUUID(),
    ...(params.sessionList ? { sessionList: params.sessionList } : {}),
    ...(params.resolveSession ? { resolveSession: params.resolveSession } : {}),
    ...(params.resolveRunTrigger ? { resolveRunTrigger: params.resolveRunTrigger } : {}),
    ...(params.resolveRunSource ? { resolveRunSource: params.resolveRunSource } : {}),
    resolveManagedMachine: (input, caller) => readManagedMachine({ ...input, credentials: params.credentials,
      serverHttpBaseUrl: params.serverHttpBaseUrl ?? configuration.apiServerUrl,
      ...(caller?.signal ? { signal: caller.signal } : {}),
      ...(caller?.externalActionExecutionAuthorization ? { authorization: caller.externalActionExecutionAuthorization } : {}),
    }),
    ...(params.resolveMaterializer ? { resolveMaterializer: params.resolveMaterializer } : {}),
    ...(params.pullRequests ? { pullRequests: params.pullRequests } : {}),
    resolveWorkflow: (ref) => onServer(() => params.resolveWorkflow(ref)),
    resolveWorkflowTeamIds: (artifactId) => onServer(async () => {
      if (params.resolveWorkflowTeamIds) return params.resolveWorkflowTeamIds(artifactId);
      const artifacts = createCredentialedAccountArtifactStore(params.credentials);
      const result = await artifacts.accessGrants.list({ artifactId });
      return result.grants.flatMap((grant) => grant.principal.kind === 'team' ? [grant.principal.teamId] : []);
    }),
  });
}
