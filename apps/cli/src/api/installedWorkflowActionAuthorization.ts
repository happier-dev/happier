import type { ActionExecutorContext, ExternalActionExecutionAuthorizationV1, ExternalActionRequestEnvelope,
  ExternalActionTargetV1 } from '@happier-dev/protocol';
import { ExternalActionWorkflowSessionLeafV1Schema, type InstalledWorkflowSessionLeafAdmission } from '@happier-dev/protocol/actions/externalActionApi';
import { WorkflowActionIdV1Schema } from '@happier-dev/protocol/actions/actionIds';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { decodeJwtPayload, readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { StoredCredentials } from '@/persistence';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { prepareExternalActionRequesterAccountAuthorizationWithEnvelope,
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
    ? { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(input.credentials.encryption.secret) }
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
