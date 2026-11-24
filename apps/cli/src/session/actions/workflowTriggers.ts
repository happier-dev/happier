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
import { readPublishedMachineRowWithLegacyOwnerProof } from '@/api/machine/readPublishedMachineRow';
import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { encodeRequesterCredentials, hasStoredSessionCredentialProvenance } from '@/persistence';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealSessionRequesterBootstrapRpcRequestV1 } from
  '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';

type CliTriggerRequesterCustodyOptions = Readonly<{
  serverId: string;
  serverIdentityId?: string;
  isCredentialCurrent?: () => boolean | Promise<boolean>;
}>;

function createCliTriggerRequesterCustody(params: Readonly<{
  credentials: StoredCredentials; serverHttpBaseUrl?: string; options: CliTriggerRequesterCustodyOptions;
}>): NonNullable<Parameters<typeof createAccountWorkflowTriggerActions>[0]['workflowRequesterCustody']> {
  const { credentials, options } = params;
  const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
  // One public refusal; its cause names which owner refused, in the existing code vocabulary.
  const unavailable = (cause: string): never => { throw Object.assign(new Error('requester_custody_unavailable'), {
    code: 'requester_custody_unavailable',
    failureCause: projectActionFailureCauseV1({ code: cause }, 'workflow.trigger.add', { allowUnknownErrorCode: true }) }); };
  return {
    retain: async ({ scopeId, machineId, automationId }, { signal } = {}) => {
      const serverUrl = params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
      const observed = await runWithServerHttpBaseUrl(serverUrl,
        () => readPublishedMachineRowWithLegacyOwnerProof(machineId, credentials, { signal }));
      const accountId = readAccountIdFromToken(credentials.token);
      const custodian = observed?.row.access?.custodian;
      if (observed?.legacyOwnerOnly || (accountId && custodian?.accountId === accountId)) return;
      const { installationId, installationPublicKey } = observed?.row ?? {};
      if (!accountId || !custodian || !installationId || !installationPublicKey || observed?.row.id !== machineId) {
        return unavailable('admission_unavailable');
      }
      if (!hasStoredSessionCredentialProvenance(credentials)) return refuse('requester_account_material_unavailable');
      // Another person's Machine receives the sign-in as ordinary use (owner ruling 2026-11-23).
      signal?.throwIfAborted();
      if (options.isCredentialCurrent && !await options.isCredentialCurrent()) return unavailable('not_authenticated');
      const publicKey = decodeBase64(installationPublicKey, 'base64');
      if (encodeBase64(publicKey, 'base64') !== installationPublicKey) return unavailable('admission_unavailable');
      // The receiving Machine has its own saved profile id for this Home; only the Home identity is shared.
      const serverId = options.serverIdentityId ?? await resolveServerProfileHomeIdentityId(options.serverId) ?? options.serverId;
      const deliver = async (operation: 'retain' | 'retire', requestSignal?: AbortSignal) => {
        const request = sealSessionRequesterBootstrapRpcRequestV1({ installationId, installationPublicKey: publicKey,
          randomBytes: getRandomBytes, request: { kind: 'requester_session_bootstrap_v1', scope: 'workflow_trigger',
            input: { executionTarget: { serverId, machineId }, scopeId,
              ...(automationId ? { automationId } : {}), operation },
            requesterBootstrap: { v: 1, disposition: 'ordinary_requester', credentials: encodeRequesterCredentials(credentials) } } });
        const result = await callExactMachineRpc({ credentials, serverUrl, machineId, method: RPC_METHODS.DAEMON_WORKFLOW_REQUESTER_CUSTODY,
          request, requireCurrentMachine: true, requiredMachineKind: 'persistent', timeoutMs: null,
          waitForResultOnCancel: true, signal: requestSignal });
        if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
          const receiverCode = result && typeof result === 'object' && 'errorCode' in result ? result.errorCode : undefined;
          return unavailable(typeof receiverCode === 'string' ? receiverCode : 'target_unavailable');
        }
      };
      await deliver('retain', signal);
      return () => deliver('retire');
    },
    // The receiving daemon retires its own scope from the Account change stream
    // and reconnect reconciliation. Removal never sends the sign-in again.
    retire: async () => {},
  };
}

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
  requesterCustody?: CliTriggerRequesterCustodyOptions;
  serverHttpBaseUrl?: string;
  resolveWorkflow: WorkflowTriggerActionsDependencies['resolveWorkflow'];
  resolveWorkflowTeamIds?: WorkflowTriggerActionsDependencies['resolveWorkflowTeamIds'];
  sessionList?: WorkflowTriggerActionsDependencies['sessionList'];
  sessionRead?: WorkflowTriggerActionsDependencies['sessionRead'];
  resolveAgentStartContext?: WorkflowTriggerActionsDependencies['resolveAgentStartContext'];
  resolveSession?: WorkflowTriggerActionsDependencies['resolveSession'];
  resolveRunTrigger?: WorkflowTriggerActionsDependencies['resolveRunTrigger'];
  resolveRunSource?: WorkflowTriggerActionsDependencies['resolveRunSource'];
  resolveMaterializer?: WorkflowTriggerActionsDependencies['resolveMaterializer'];
  pullRequests?: WorkflowTriggerActionsDependencies['pullRequests'];
  nativeAccount?: WorkflowTriggerActionsDependencies['nativeAccount'];
  deploymentAction?: WorkflowTriggerActionsDependencies['deploymentAction'];
  listContributedActionDefinitions?: WorkflowTriggerActionsDependencies['listContributedActionDefinitions'];
}>) {
  const onServer = <T>(operation: () => Promise<T>): Promise<T> => params.serverHttpBaseUrl
    ? runWithServerHttpBaseUrl(params.serverHttpBaseUrl, operation) : operation();
  const token = params.credentials.token;
  const workflowRequesterCustody = params.workflowRequesterCustody ?? (params.requesterCustody
    ? createCliTriggerRequesterCustody({ ...params, options: params.requesterCustody }) : undefined);
  return createAccountWorkflowTriggerActions({
    ...(params.listContributedActionDefinitions ? { listContributedActionDefinitions: params.listContributedActionDefinitions } : {}),
    ...(workflowRequesterCustody ? { workflowRequesterCustody } : {}),
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
    ...(params.resolveAgentStartContext ? { resolveAgentStartContext: params.resolveAgentStartContext } : {}),
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
    readWorkflowChildBodyVersions: (artifactIds, signal) => onServer(async () => {
      const headers = await createCredentialedAccountArtifactStore(params.credentials).readHeaders(artifactIds, { signal, prepareRecipients: false });
      return headers.map(header => header.status === 'fulfilled' ? header.value?.bodyVersion : undefined);
    }),
    resolveWorkflowContent: (workflowId) => onServer(async () => {
      const opened = await createCredentialedAccountArtifactStore(params.credentials).readForUpdate(workflowId,
        { prepareRecipients: false, includeSharedAudience: false });
      if (!opened) throw Object.assign(new Error('content_unavailable'), { code: 'content_unavailable' });
      const binding = { artifactId: opened.artifact.artifactId, expectedRevision: opened.artifact.revision };
      return {
        revision: opened.artifact.revision,
        sealAssociatedContent: async value => opened.sealAssociatedContent({ ...binding, value }),
        openAssociatedContent: async content => opened.openAssociatedContent({ ...binding, content }),
      };
    }),
    resolveWorkflowTeamIds: (artifactId) => onServer(async () => {
      if (params.resolveWorkflowTeamIds) return params.resolveWorkflowTeamIds(artifactId);
      const artifacts = createCredentialedAccountArtifactStore(params.credentials);
      const result = await artifacts.accessGrants.list({ artifactId });
      return result.grants.flatMap((grant) => grant.principal.kind === 'team' ? [grant.principal.teamId] : []);
    }),
  });
}
