import { readHostAdmittedReviewedChildHttpProofV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { isReviewedMachineSetupCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { randomBytes } from 'node:crypto';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions';
import type { ActionExecutorContext, ExternalActionExecutionAuthorizationV1, ExternalActionRequestEnvelope,
  ExternalActionTargetV1 } from '@happier-dev/protocol';
import { ExternalActionWorkflowSessionLeafV1Schema, type InstalledWorkflowSessionLeafAdmission } from '@happier-dev/protocol/actions/externalActionApi';
import { WorkflowActionIdV1Schema } from '@happier-dev/protocol/actions/actionIds';
import { resolveAccountContentSecretKey } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { decodeJwtPayload, readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { prepareExternalActionRequesterAccountAuthorizationWithEnvelope, prepareExternalActionRequesterAccountAuthorizationResult, deliverExternalActionRequest,
  type dispatchOriginalAccountAction,
  type ExternalActionMachineRequestSigningKey } from './externalActionExecutionAuthorization';

type InstalledWorkflowActionInput = Readonly<{
  credentials: StoredCredentials;
  context: ActionExecutorContext;
  /** FIN supplies its captured admission, never defaultSessionId or Action input. */
  sessionLeaf?: InstalledWorkflowSessionLeafAdmission;
  actionId: string;
  input: unknown;
  target: ExternalActionTargetV1;
  machineId: string;
  serverId: string;
  serverIdentityId: string;
  serverHttpBaseUrl: string;
  installationId: string;
  privateKey: ExternalActionMachineRequestSigningKey;
  /** Existing WorkflowRun callers may supply their incumbent custody signal. */
  isCurrent?: () => Promise<boolean>;
}>;

/** The existing installed-source issuer binds admitted Run facts to the exact child envelope. */
export async function prepareInstalledWorkflowActionAuthorizationWithEnvelope(input: InstalledWorkflowActionInput):
  Promise<Readonly<{ authorization: ExternalActionExecutionAuthorizationV1; envelope: ExternalActionRequestEnvelope }> | null> {
  const caller = input.context.actionCaller;
  const requestId = input.context.actionRequestId;
  const accountId = readAccountIdFromToken(input.credentials.token);
  const leaf = input.sessionLeaf;
  const runId = leaf?.runId ?? (caller?.kind === 'workflowRun' ? caller.runId : undefined);
  if (!requestId || !accountId || !runId || input.context.executionRunWorkflowRunId !== runId) return null;
  if (leaf && (caller?.kind !== 'session' || caller.sessionId !== leaf.sessionId
    || leaf.accountId !== accountId || !WorkflowActionIdV1Schema.safeParse(input.actionId).success)) return null;
  if (!leaf && caller?.kind !== 'workflowRun') return null;
  const sessionLeaf = leaf ? ExternalActionWorkflowSessionLeafV1Schema.safeParse({
    invocationId: leaf.invocationId, caller, authorization: leaf.authorization,
    workspaceWrites: input.context.workspaceWrites ?? 'deny', actionRequestAttributionV1: leaf.actionRequestAttributionV1,
  }) : undefined;
  if (sessionLeaf && !sessionLeaf.success) return null;
  const start = input.context.agentStartContext;
  const sessionAuthority = !leaf && caller?.kind === 'workflowRun' && input.target.kind === 'session'
    && start?.caller.kind === 'originless' && start.caller.runId === caller.runId && start.baseline.machineId === input.machineId
    ? { authorization: caller.authorization, runDepth: start.caller.runDepth,
      ...(start.caller.runOriginSessionId ? { runOriginSessionId: start.caller.runOriginSessionId } : {}),
      directory: start.baseline.directory, workspaceWrites: input.context.workspaceWrites ?? 'deny' as const }
    : undefined;
  if (!leaf && input.target.kind === 'session' && !sessionAuthority) return null;
  const payload = decodeJwtPayload(input.credentials.token);
  const extras = payload?.extras;
  const tokenEpochHint = payload?.tokenEpoch ?? (extras && typeof extras === 'object' && 'tokenEpoch' in extras ? extras.tokenEpoch : undefined) ?? 0;
  if (typeof tokenEpochHint !== 'number' || !Number.isSafeInteger(tokenEpochHint) || tokenEpochHint < 0) return null;
  const encryptionRequest = { credentials: input.credentials, token: input.credentials.token,
    serverBaseUrl: input.serverHttpBaseUrl, signal: input.context.signal };
  const encryption = await fetchAccountEncryptionCurrentness(encryptionRequest);
  const material = input.credentials.encryption?.type === 'legacy'
    ? { type: 'dataKey' as const, machineKey: resolveAccountContentSecretKey(input.credentials.encryption) }
    : input.credentials.encryption;
  return prepareExternalActionRequesterAccountAuthorizationWithEnvelope({ ...input, accountId,
    requestId, token: input.credentials.token, tokenEpochHint, accountEncryptionMode: encryption.mode,
    workflowActionOrigin: { runId, requestId, ...(sessionAuthority ? { sessionAuthority } : {}),
      ...(sessionLeaf?.success ? { sessionLeaf: sessionLeaf.data } : {}) },
    ...(material ? { material } : {}), signal: input.context.signal });
}

/** Existing authorization-only callers keep the same issuer and contract. */
export async function prepareInstalledWorkflowActionAuthorization(input: InstalledWorkflowActionInput): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  return (await prepareInstalledWorkflowActionAuthorizationWithEnvelope(input))?.authorization ?? null;
}

/** The existing confirmed Run spends its captured parent; only invocation codec leaves this host. */
export async function dispatchInstalledWorkflowNativeSetupAction(input: Parameters<typeof dispatchOriginalAccountAction>[0]): Promise<ActionExecuteResult> {
  const refused = { ok: false as const, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
  const installed = input.installedWorkflow;
  const context = installed?.context;
  const caller = context?.actionCaller;
  const parent = caller?.kind === 'workflowRun' ? caller.authorization.externalActionExecutionAuthorization : undefined;
  // A reviewed child's Run is named by its own reviewed child, which Home derives the Run from.
  // A root's own Run has none, so it carries the live Run reader's private exact leaf proof.
  const admittedChild = readHostAdmittedReviewedChildHttpProofV1(context);
  const runReviewedChild = caller?.kind === 'workflowRun' ? caller.authorization.reviewedChild : undefined;
  const reviewedChild = runReviewedChild ?? (admittedChild?.actionId === input.actionId
    ? admittedChild : undefined);
  const binding = parent?.binding;
  if (!installed || !context || caller?.kind !== 'workflowRun' || !parent || !binding
    || !isReviewedMachineSetupCodecV1({ actionId: input.actionId, workflowActionOrigin: {
      runId: caller.runId, requestId: input.requestId, reviewedChild } })
    || ('authentication' in binding ? binding.accountId : binding.custodianAccountId) !== readAccountIdFromToken(input.credentials.token)
    || binding.machineId !== installed.machineId || binding.installationId !== installed.installationId
    || binding.serverIdentityId !== input.serverIdentityId || !binding.accountEncryptionMode
    || input.target.kind !== 'machine'
    || context.executionRunWorkflowRunId !== caller.runId || context.actionRequestId !== input.requestId) return refused;
  // This is an invocation key, distinct from the requester's Account machine key.
  const material = { type: 'dataKey' as const, machineKey: new Uint8Array(randomBytes(32)) };
  const isCurrent = async () => !input.signal?.aborted && (!input.isCurrent || await input.isCurrent());
  const prepared = await prepareExternalActionRequesterAccountAuthorizationResult({ actionId: input.actionId,
    input: input.input, requestId: input.requestId, target: input.target, machineId: installed.machineId,
    accountId: binding.accountId, accountEncryptionMode: binding.accountEncryptionMode,
    tokenEpochHint: 'authentication' in binding ? binding.authentication.tokenEpoch : 0, token: input.credentials.token,
    executionAuthorization: parent, workflowActionOrigin: { runId: caller.runId, requestId: input.requestId,
      ...(reviewedChild ? { reviewedChild } : {}) },
    material, controllerCodecMaterial: material, serverId: context.serverId ?? input.serverIdentityId!,
    serverIdentityId: input.serverIdentityId!, serverHttpBaseUrl: input.serverHttpBaseUrl,
    installationId: installed.installationId, privateKey: installed.privateKey, isCurrent,
    ...(input.signal ? { signal: input.signal } : {}) });
  if ('ok' in prepared) {
    const errorCode = prepared.code ?? refused.errorCode;
    return { ...refused, errorCode, error: errorCode,
      ...(prepared.details ? { details: prepared.details } : {}),
      ...(prepared.failureCause ? { failureCause: prepared.failureCause } : {}) };
  }
  return await deliverExternalActionRequest({ actionId: input.actionId, serverHttpBaseUrl: input.serverHttpBaseUrl,
    envelope: prepared.envelope, body: { v: 1, machineId: input.target.machineId,
      envelope: prepared.envelope, executionAuthorization: prepared.authorization },
    headers: { Authorization: `Bearer ${input.credentials.token}`, 'Content-Type': 'application/json',
      [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' }, isCurrent,
    ...(prepared.envelope.v === 2 ? { material, binding: {
      serverIdentityId: binding.serverIdentityId, accountId: binding.accountId,
      ...('authentication' in binding ? { authentication: binding.authentication } : { credentialId: binding.credentialId }),
      actionId: input.actionId, requestId: input.requestId, target: input.target,
    } } : {}), ...(input.signal ? { signal: input.signal } : {}) });
}
