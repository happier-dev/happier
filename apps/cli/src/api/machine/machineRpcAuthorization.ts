import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import axios from 'axios';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { RequesterSessionCurrentnessPurposeV1Schema, type RequesterSessionCurrentnessPurposeV1 } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { MachineAccessLossCustodyRequestV1Schema, MachineAdmissionVerifyResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { isSocketRpcLocalServicesPreviewAdmissionServerOriginAuthorizationContext, isSocketRpcMachineAccessLossServerOriginAuthorizationContext, parseSocketRpcAuthorizationContext, resolveSocketRpcSessionWriteAuthorizationMethod, resolveSocketRpcSessionAuthorization } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import { SocketRpcMachineAdmissionContextV1Schema, type SocketRpcMachineAdmissionContextV1,
  WorkspaceSyncSourceRoutingV1Schema, type WorkspaceSyncSourceRoutingV1,
  WorkspaceSyncSourceExecutionV1Schema, type WorkspaceSyncSourceExecutionV1,
  WorkspaceSyncTargetRoutingV1Schema, type WorkspaceSyncTargetRoutingV1,
  WorkspaceSyncSeedRoutingV1Schema, type WorkspaceSyncSeedRoutingV1,
  WorkspaceSyncSourceWriterTargetRoutingV1Schema, type WorkspaceSyncSourceWriterTargetRoutingV1 } from '@happier-dev/protocol/socketRpc';
import { WorkspaceSyncHandoffSourcePhaseRequestV1Schema, HandoffTargetReplacementPreflightV1Schema,
  WorkspaceSyncTargetBootstrapPrepareV1Schema, WorkspaceSyncTargetBootstrapReleaseV1Schema,
  WorkspaceSyncSeedExportPrepareV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { ExternalActionExecutionAuthorizationV1Schema, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';

import type { RpcAuthorizationResult } from '@/api/rpc/types';
import { ManagedActivityReadRequestV1Schema, type ManagedActivityReadRequestV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { ManagedGuestCurrentOutputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { resolveExternalActionRootInvocationAuthority } from '@/api/externalActionExecutionAuthorization';
import { isExternalActionAuthorizationBoundToEnvelope } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { OpenProjectInputV1Schema } from '@happier-dev/protocol/projects/openProjectV1';

/** Local binding only; Home must independently verify the original root and current grants. */
export function doesWorkspaceSyncSourceRootMatchRouting(authorization: ExternalActionExecutionAuthorizationV1, source: WorkspaceSyncSourceRoutingV1): boolean {
  const binding = authorization.binding;
  const context = source.sourceContext;
  const handoff = binding.handoffAdmission;
  if (binding.actionId === 'projects.open') {
    const envelope = source.originalActionEnvelope;
    const constraints = 'grant' in binding ? { models: binding.grant.models, permissionModes: binding.grant.permissionModes } : undefined;
    return !!context && !!envelope && source.phase === 'prepare' && source.sourceSessionId === undefined
      && source.accountServerId === binding.serverIdentityId
      && context.machineAdmission.machineId === source.sourceMachineId
      && context.machineAdmission.actorAccountId === binding.accountId
      && (context.callerAuthority === 'account_automation' || context.callerAuthority === resolveExternalActionRootInvocationAuthority(authorization))
      && sameStrictJsonValue(binding.sessionActionOrigin ?? null, context.sessionActionOrigin ?? null)
      && sameStrictJsonValue(constraints ?? null, context.callerInputConstraints ?? null)
      && isExternalActionAuthorizationBoundToEnvelope(binding, { actionId: 'projects.open', machineId: binding.machineId, envelope });
  }
  if (!context || !handoff) return false;
  const admission = context.machineAdmission;
  const constraints = 'grant' in binding ? { models: binding.grant.models, permissionModes: binding.grant.permissionModes } : undefined;
  return binding.actionId === 'session.handoff' && !binding.handoffContinuation
    && (source.phase === 'prepare' || source.phase === 'finalize')
    && binding.machineId === handoff.sourceMachineId && binding.installationId === handoff.sourceInstallationId
    && admission.machineId === binding.machineId && admission.installationId === binding.installationId
    && admission.actorAccountId === binding.accountId && admission.custodianAccountId === binding.custodianAccountId
    && binding.target.kind === 'machine' && binding.target.machineId === binding.machineId
    && source.sourceMachineId === handoff.sourceMachineId && source.sourceSessionId === handoff.sessionId
    && source.operationId === binding.requestId && source.accountServerId === binding.serverIdentityId
    && (context.callerAuthority === 'account_automation' || context.callerAuthority === resolveExternalActionRootInvocationAuthority(authorization))
    && sameStrictJsonValue(binding.sessionActionOrigin ?? null, context.sessionActionOrigin ?? null)
    && sameStrictJsonValue(constraints ?? null, context.callerInputConstraints ?? null);
}

/** The named Project SOURCE body retains its original chosen child and namespace. */
export function doesWorkspaceSyncProjectSourceRequestMatchRouting(params: unknown, authorization: ExternalActionExecutionAuthorizationV1,
  source: WorkspaceSyncSourceRoutingV1): boolean {
  const input = OpenProjectInputV1Schema.safeParse(params);
  if (!input.success || !doesWorkspaceSyncSourceRootMatchRouting(authorization, source)
    || input.data.machineId !== authorization.binding.machineId || input.data.serverId !== source.accountServerId
    || input.data.materialization.kind !== 'sync'
    || !['copy_once', 'create_relationship'].includes(input.data.materialization.workspaceAction.kind)) return false;
  const selected = input.data.source.kind === 'workspace' ? input.data.source.checkout
    : input.data.source.kind === 'source' ? input.data.source.checkout : undefined;
  if (!selected || selected.serverId !== source.accountServerId
    || selected.machineId !== source.sourceMachineId || selected.rootPath !== source.sourceRootPath) return false;
  const envelope = source.originalActionEnvelope!;
  return envelope.v !== 1 || sameStrictJsonValue(envelope.input, input.data);
}

export function doesWorkspaceSyncSourceWriterTargetRootMatchRouting(authorization: ExternalActionExecutionAuthorizationV1,
  routing: WorkspaceSyncSourceWriterTargetRoutingV1, admission?: SocketRpcMachineAdmissionContextV1): boolean {
  if (authorization.binding.actionId === 'projects.open') {
    return doesWorkspaceSyncSourceRootMatchRouting(authorization, routing.source)
      && routing.target.targetMachineId === authorization.binding.machineId
      && routing.target.accountServerId === authorization.binding.serverIdentityId
      && (!admission || admission.machineId === authorization.binding.machineId
        && admission.installationId === authorization.binding.installationId
        && admission.actorAccountId === authorization.binding.accountId);
  }
  const handoff = authorization.binding.handoffAdmission;
  return doesWorkspaceSyncSourceRootMatchRouting(authorization, routing.source) && !!handoff
    && routing.target.targetMachineId === handoff.targetMachineId
    && routing.target.accountServerId === authorization.binding.serverIdentityId
    && (!admission || admission.machineId === handoff.targetMachineId
      && admission.installationId === handoff.targetInstallationId && admission.actorAccountId === authorization.binding.accountId);
}

/** The second hop keeps the writer's snapshot and the chosen child's exact admitted caller ceiling. */
export function doesWorkspaceSyncTargetRoutingMatchWriterTarget(target: WorkspaceSyncTargetRoutingV1,
  writer: WorkspaceSyncSourceWriterTargetRoutingV1): boolean {
  const { targetContext, ...purpose } = target;
  const sourceContext = writer.source.sourceContext;
  return sameStrictJsonValue(purpose, writer.target)
    && targetContext.machineAdmission.machineId === writer.target.targetMachineId
    && (['callerAuthority', 'sessionActionOrigin', 'callerInputConstraints', 'callerPermissionMode',
      'causalPermissionAuthority', 'workspaceWrites'] as const)
      .every(key => sameStrictJsonValue(targetContext[key] ?? null, sourceContext[key] ?? null));
}

/** Seed retains the independently verified Project root and chosen child's original SOURCE packet. */
export function doesWorkspaceSyncSeedRootMatchRouting(authorization: ExternalActionExecutionAuthorizationV1,
  seed: WorkspaceSyncSeedRoutingV1, execution: WorkspaceSyncSourceExecutionV1): boolean {
  return authorization.binding.actionId === 'projects.open'
    && doesWorkspaceSyncSourceWriterTargetRootMatchRouting(authorization, seed.sourceWriterTarget,
      seed.target.targetContext.machineAdmission)
    && doesWorkspaceSyncTargetRoutingMatchWriterTarget(seed.target, seed.sourceWriterTarget)
    && execution.method === `${seed.sourceWriterTarget.sourceWriter.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`
    && execution.externalActionExecution.effectActionId === 'projects.open'
    && execution.externalActionExecution.installationId === authorization.binding.installationId
    && sameStrictJsonValue(execution.externalActionExecution.authorization, authorization);
}

/** Local installation facts and the current Home verification boundary. */
export type MachineRpcAdmissionBoundary = Readonly<{
  machineId: string;
  resolveCustodianAccountId: (signal?: AbortSignal) => Promise<string | null>;
  resolveInstallationId: () => string | null;
  verifyMachineAdmission: (input: Readonly<{
    context: SocketRpcMachineAdmissionContextV1;
    method: string;
    custodySubjectAccountId?: string;
    workspaceSyncSourceRouting?: WorkspaceSyncSourceRoutingV1;
    workspaceSyncSourceExecution?: WorkspaceSyncSourceExecutionV1;
    workspaceSyncTargetRouting?: WorkspaceSyncTargetRoutingV1;
    workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
    workspaceSyncSeedRouting?: WorkspaceSyncSeedRoutingV1;
    callerInputAuthorization?: ExternalActionExecutionAuthorizationV1;
    signal?: AbortSignal;
  }>) => Promise<boolean>;
}>;

/** This read proves current access; the signed context is not a reusable admission ticket. */
export type MachineRpcAdmissionCurrentInput = Readonly<{
  context: SocketRpcMachineAdmissionContextV1;
  custodySubjectAccountId?: string;
  workspaceSyncSourceRouting?: WorkspaceSyncSourceRoutingV1;
  workspaceSyncSourceExecution?: WorkspaceSyncSourceExecutionV1;
  workspaceSyncTargetRouting?: WorkspaceSyncTargetRoutingV1;
  workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
  workspaceSyncSeedRouting?: WorkspaceSyncSeedRoutingV1;
  callerInputAuthorization?: ExternalActionExecutionAuthorizationV1;
  /** Actual local signer, usable only for the exact private physical SOURCE purpose. */
  workspaceSyncSourceReceiver?: Readonly<{ machineId: string; installationId: string;
    /** Installed original Project target discovers only its verified physical SOURCE recipient. */
    destinationMachineId?: string; accountId?: string }>;
  /** Actual local signer, usable only for the exact private physical TARGET purposes. */
  workspaceSyncTargetReceiver?: Readonly<{ machineId: string; installationId: string;
    /** Outgoing installed D -> P2 joint purpose; the proof remains signed by D. */
    destinationMachineId?: string }>;
  /** Actual installed writer/receiver; its own Account is independent of the retained actor. */
  workspaceSyncSourceWriterTargetReceiver?: Readonly<{ machineId: string; installationId: string; accountId: string; destinationMachineId?: string }>;
  /** Actual installed seed sender/receiver; Home verifies both physical writers independently. */
  workspaceSyncSeedReceiver?: Readonly<{ machineId: string; installationId: string; accountId: string; destinationMachineId?: string }>;
  privateKey: string | Uint8Array;
  daemonToken: string;
  serverHttpBaseUrl: string;
  signal?: AbortSignal;
}> & (Readonly<{ method: string; purpose?: never }> | Readonly<{ purpose: RequesterSessionCurrentnessPurposeV1; method?: never }>);

export async function verifyMachineRpcAdmissionCurrent(input: MachineRpcAdmissionCurrentInput): Promise<boolean> {
  return await readMachineRpcAdmissionCurrent(input) !== null;
}

/** Same verification owner, retaining the Home-proven destination identity for the physical writer. */
export async function readMachineRpcAdmissionCurrent(input: MachineRpcAdmissionCurrentInput): Promise<ReturnType<typeof MachineAdmissionVerifyResponseV1Schema.parse> | null> {
  try {
    const context = SocketRpcMachineAdmissionContextV1Schema.parse(input.context);
    const purpose = input.purpose === undefined ? undefined : RequesterSessionCurrentnessPurposeV1Schema.parse(input.purpose);
    if (purpose && (input.custodySubjectAccountId !== undefined || input.workspaceSyncSourceRouting !== undefined || input.workspaceSyncSourceExecution !== undefined
      || input.workspaceSyncTargetRouting !== undefined || input.workspaceSyncSourceReceiver !== undefined
      || input.workspaceSyncTargetReceiver !== undefined || input.callerInputAuthorization !== undefined
      || input.workspaceSyncSeedRouting !== undefined || input.workspaceSyncSeedReceiver !== undefined
      || input.workspaceSyncSourceWriterTargetRouting !== undefined || input.workspaceSyncSourceWriterTargetReceiver !== undefined)) return null;
    const admissionPurpose = purpose ? { purpose } : { method: input.method! };
    const custody = input.custodySubjectAccountId === undefined ? {} : { custodySubjectAccountId: input.custodySubjectAccountId };
    const sourceRouting = input.workspaceSyncSourceRouting === undefined
      ? undefined : WorkspaceSyncSourceRoutingV1Schema.parse(input.workspaceSyncSourceRouting);
    const sourceExecution = input.workspaceSyncSourceExecution === undefined ? undefined
      : WorkspaceSyncSourceExecutionV1Schema.parse(input.workspaceSyncSourceExecution);
    const originalRoot = input.callerInputAuthorization === undefined
      ? undefined : ExternalActionExecutionAuthorizationV1Schema.parse(input.callerInputAuthorization);
    const seed = input.workspaceSyncSeedRouting === undefined ? undefined
      : WorkspaceSyncSeedRoutingV1Schema.parse(input.workspaceSyncSeedRouting);
    const seedReceiver = input.workspaceSyncSeedReceiver;
    if (seed && (!seedReceiver || !originalRoot || !sourceExecution
      || input.workspaceSyncSourceRouting || input.workspaceSyncTargetRouting || input.workspaceSyncSourceWriterTargetRouting
      || input.workspaceSyncSourceReceiver || input.workspaceSyncTargetReceiver || input.workspaceSyncSourceWriterTargetReceiver
      || input.custodySubjectAccountId
      || input.method !== `${seedReceiver.destinationMachineId ?? seedReceiver.machineId}:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`
      || (seedReceiver.destinationMachineId ?? seedReceiver.machineId) !== seed.sourceWriterTarget.sourceWriter.machineId
      || !seedReceiver.destinationMachineId && seedReceiver.installationId !== seed.sourceWriterTarget.sourceWriter.installationId
      || !sameStrictJsonValue(context, seed.sourceWriterTarget.source.sourceContext.machineAdmission)
      || !doesWorkspaceSyncSeedRootMatchRouting(originalRoot, seed, sourceExecution))
      || seedReceiver && !seed) return null;
    const projectSource = originalRoot?.binding.actionId === 'projects.open' && sourceRouting !== undefined;
    const sourceReceiver = input.workspaceSyncSourceReceiver;
    if (sourceRouting && (!sourceReceiver
      || input.method !== `${sourceReceiver.destinationMachineId ?? sourceReceiver.machineId}:${projectSource
        ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN : RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`
      || sourceRouting.sourceMachineId !== context.machineId)
      || sourceReceiver && !sourceRouting) return null;
    if (sourceReceiver?.destinationMachineId !== undefined && (!projectSource || !originalRoot
      || originalRoot.binding.machineId !== sourceReceiver.machineId || originalRoot.binding.installationId !== sourceReceiver.installationId
      || !doesWorkspaceSyncSourceRootMatchRouting(originalRoot, sourceRouting!))) return null;
    const writerTarget = input.workspaceSyncSourceWriterTargetRouting === undefined ? undefined
      : WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(input.workspaceSyncSourceWriterTargetRouting);
    const writerTargetReceiver = input.workspaceSyncSourceWriterTargetReceiver;
    if (sourceExecution && (!(seed || projectSource || writerTarget && originalRoot?.binding.actionId === 'projects.open')
      || sourceReceiver?.destinationMachineId !== undefined)) return null;
    const targetRouting = input.workspaceSyncTargetRouting === undefined
      ? undefined : WorkspaceSyncTargetRoutingV1Schema.parse(input.workspaceSyncTargetRouting);
    const targetReceiver = input.workspaceSyncTargetReceiver;
    if (targetReceiver?.destinationMachineId !== undefined && (!writerTarget || !targetRouting
      || typeof targetReceiver.destinationMachineId !== 'string' || !targetReceiver.destinationMachineId.trim()
      || targetReceiver.destinationMachineId !== targetReceiver.destinationMachineId.trim()
      || targetReceiver.machineId !== targetRouting.targetMachineId
      || targetReceiver.installationId !== targetRouting.targetContext.machineAdmission.installationId
      || !sameStrictJsonValue(context, targetRouting.targetContext.machineAdmission))) return null;
    const targetMethodMachineId = targetReceiver?.destinationMachineId ?? targetReceiver?.machineId;
    if (writerTarget && (sourceRouting || sourceReceiver
      || targetRouting && (!targetReceiver || writerTargetReceiver || !doesWorkspaceSyncTargetRoutingMatchWriterTarget(targetRouting, writerTarget))
      || !targetRouting && targetReceiver
      || input.method !== `${targetMethodMachineId ?? writerTargetReceiver?.destinationMachineId ?? writerTargetReceiver?.machineId ?? context.machineId}:${readWorkspaceSyncTargetMethod(writerTarget.target.phase)}`
      || writerTarget.target.phase !== 'release' && (!originalRoot || !doesWorkspaceSyncSourceWriterTargetRootMatchRouting(originalRoot, writerTarget)))
      || writerTargetReceiver && !writerTarget) return null;
    if (writerTargetReceiver?.destinationMachineId && (!writerTarget
      || writerTargetReceiver.machineId !== writerTarget.sourceWriter.machineId
      || writerTargetReceiver.installationId !== writerTarget.sourceWriter.installationId
      || !sameStrictJsonValue(context, writerTarget.source.sourceContext.machineAdmission))) return null;
    if (originalRoot && !writerTarget && !seed && (!sourceRouting || !sourceReceiver
      || sourceRouting.phase !== 'prepare' && sourceRouting.phase !== 'finalize'
      || !['session.handoff', 'projects.open'].includes(originalRoot.binding.actionId))) return null;
    const retainedRoot = originalRoot ? { callerInputAuthorization: originalRoot } : {};
    if (sourceRouting && targetRouting || sourceReceiver && targetReceiver
      || targetRouting && (!targetReceiver || targetRouting.targetMachineId !== context.machineId
        || input.method !== `${targetMethodMachineId}:${readWorkspaceSyncTargetMethod(targetRouting.phase)}`)
      || targetReceiver && !targetRouting) return null;
    const signer = seedReceiver ?? writerTargetReceiver ?? sourceReceiver ?? targetReceiver ?? { machineId: context.machineId, installationId: context.installationId };
    const routing = { ...(sourceRouting ? { workspaceSyncSourceRouting: sourceRouting } : {}),
      ...(sourceExecution ? { workspaceSyncSourceExecution: sourceExecution } : {}),
      ...(targetRouting ? { workspaceSyncTargetRouting: targetRouting } : {}),
      ...(writerTarget ? { workspaceSyncSourceWriterTargetRouting: writerTarget } : {}),
      ...(seed ? { workspaceSyncSeedRouting: seed } : {}) };
    const proof = signMachineInstallationProof({ payload: {
      version: 1, machineId: signer.machineId, installationId: signer.installationId,
      accountId: seedReceiver?.accountId ?? writerTargetReceiver?.accountId ?? sourceReceiver?.accountId ?? context.custodianAccountId, rpcAdmission: { context, ...admissionPurpose, ...custody, ...routing, ...retainedRoot },
    }, privateKey: input.privateKey });
    const response = await axios.post<unknown>(
      `${input.serverHttpBaseUrl}/v1/machines/${encodeURIComponent(signer.machineId)}/admission/verify`,
      { v: 1, context, ...admissionPurpose, proof, ...custody, ...routing, ...retainedRoot },
      { headers: { Authorization: `Bearer ${input.daemonToken}`, 'Content-Type': 'application/json' },
        timeout: 15_000, validateStatus: () => true,
        ...(input.signal ? { signal: input.signal } : {}) },
    );
    const result = MachineAdmissionVerifyResponseV1Schema.safeParse(response.data);
    return !input.signal?.aborted && response.status >= 200 && response.status < 300 && result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Retention decisions require the guest and current controller to agree on the same retained row. */
export async function verifyManagedActivityTargetCurrent(input: Readonly<{
  context: SocketRpcMachineAdmissionContextV1;
  managedTarget: ManagedActivityReadRequestV1;
  method: string;
  privateKey: string | Uint8Array;
  daemonToken: string;
  serverHttpBaseUrl: string;
  signal?: AbortSignal;
}>): Promise<boolean> {
  try {
    const context = SocketRpcMachineAdmissionContextV1Schema.parse(input.context);
    const managedTarget = ManagedActivityReadRequestV1Schema.parse(input.managedTarget);
    const method = `${context.machineId}:${input.method}`;
    const proof = signMachineInstallationProof({ payload: {
      version: 1, machineId: context.machineId, installationId: context.installationId,
      accountId: context.custodianAccountId, rpcAdmission: { context, method, managedTarget },
    }, privateKey: input.privateKey });
    const response = await axios.post<unknown>(`${input.serverHttpBaseUrl}/v1/machines/managed/guest/current`,
      { v: 1, context, method, managedTarget, proof },
      { headers: { Authorization: `Bearer ${input.daemonToken}`, 'Content-Type': 'application/json' },
        validateStatus: () => true, ...(input.signal ? { signal: input.signal } : {}) });
    const parsed = ManagedGuestCurrentOutputV1Schema.safeParse(response.data);
    return !input.signal?.aborted && response.status >= 200 && response.status < 300
      && parsed.success && parsed.data.current;
  } catch { return false; }
}

function readSessionIdFromParams(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const sessionId = (params as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.trim().length > 0 ? sessionId.trim() : null;
}

function forbidden(): RpcAuthorizationResult {
  return {
    ok: false,
    error: RPC_ERROR_MESSAGES.FORBIDDEN,
    errorCode: RPC_ERROR_CODES.FORBIDDEN,
  };
}

export function readWorkspaceSyncTargetMethod(phase: WorkspaceSyncTargetRoutingV1['phase']): string {
  switch (phase) {
    case 'preflight': return RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT;
    case 'prepare': return RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE;
    case 'release': return RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_RELEASE;
  }
}

/** One strict binding for both the installed child sender and physical receiver. */
export function doesWorkspaceSyncTargetRequestMatchRouting(params: unknown, routing: WorkspaceSyncTargetRoutingV1): boolean {
  if (routing.phase === 'preflight') {
    const body = HandoffTargetReplacementPreflightV1Schema.safeParse(params);
    return body.success && body.data.operationId === routing.operationId && body.data.serverId === routing.accountServerId
      && body.data.machineId === routing.targetMachineId && body.data.targetPath === routing.targetRootPath;
  }
  const body = routing.phase === 'prepare' ? WorkspaceSyncTargetBootstrapPrepareV1Schema.safeParse(params)
    : WorkspaceSyncTargetBootstrapReleaseV1Schema.safeParse(params);
  return body.success && body.data.bootstrapOperationId === routing.operationId;
}

export async function authorizeMachineRpcRequest(request: Readonly<{
  method: string;
  params: unknown;
  authorization?: SocketRpcAuthorizationContext;
  transportResponseEnvelopeVersion?: 1;
  machineAdmission?: SocketRpcMachineAdmissionContextV1;
  workspaceSyncSourceRouting?: WorkspaceSyncSourceRoutingV1;
  workspaceSyncSourceExecution?: WorkspaceSyncSourceExecutionV1;
  workspaceSyncTargetRouting?: WorkspaceSyncTargetRoutingV1;
  workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
  workspaceSyncSeedRouting?: WorkspaceSyncSeedRoutingV1;
  callerInputAuthorization?: ExternalActionExecutionAuthorizationV1;
  signal?: AbortSignal;
}>, machine?: MachineRpcAdmissionBoundary): Promise<RpcAuthorizationResult> {
  const isSourcePhase = request.method === RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE
    || request.method.endsWith(`:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`);
  const isProjectSource = request.method.endsWith(`:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`);
  let sourceRouting: WorkspaceSyncSourceRoutingV1 | undefined;
  let targetRouting: WorkspaceSyncTargetRoutingV1 | undefined;
  let writerTargetRouting: WorkspaceSyncSourceWriterTargetRoutingV1 | undefined;
  let seedRouting: WorkspaceSyncSeedRoutingV1 | undefined;
  if (request.workspaceSyncSeedRouting !== undefined) {
    const seed = WorkspaceSyncSeedRoutingV1Schema.safeParse(request.workspaceSyncSeedRouting);
    const execution = WorkspaceSyncSourceExecutionV1Schema.safeParse(request.workspaceSyncSourceExecution);
    const body = WorkspaceSyncSeedExportPrepareV1Schema.safeParse(request.params);
    if (!machine || !request.machineAdmission || !seed.success || !execution.success || !body.success
      || !request.callerInputAuthorization || request.workspaceSyncSourceRouting || request.workspaceSyncTargetRouting
      || request.workspaceSyncSourceWriterTargetRouting
      || request.method !== `${machine.machineId}:${RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE}`
      || seed.data.sourceWriterTarget.sourceWriter.machineId !== machine.machineId
      || !sameStrictJsonValue(request.machineAdmission, seed.data.sourceWriterTarget.source.sourceContext.machineAdmission)
      || body.data.operationId !== seed.data.sourceWriterTarget.source.operationId
      || !doesWorkspaceSyncSeedRootMatchRouting(request.callerInputAuthorization, seed.data, execution.data)) return forbidden();
    seedRouting = seed.data;
  }
  if (request.workspaceSyncSourceWriterTargetRouting !== undefined) {
    const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.safeParse(request.workspaceSyncSourceWriterTargetRouting);
    if (!machine || !request.machineAdmission || !routing.success || request.workspaceSyncSourceRouting
      || request.method !== `${machine.machineId}:${readWorkspaceSyncTargetMethod(routing.data.target.phase)}`
      || !doesWorkspaceSyncTargetRequestMatchRouting(request.params, { ...routing.data.target, targetContext: routing.data.source.sourceContext })
      || routing.data.target.phase !== 'release' && (!request.callerInputAuthorization
        || !doesWorkspaceSyncSourceWriterTargetRootMatchRouting(request.callerInputAuthorization, routing.data, request.machineAdmission))) return forbidden();
    if (routing.data.target.phase === 'release' && !request.workspaceSyncTargetRouting && (request.machineAdmission.machineId !== routing.data.sourceWriter.machineId
      || request.machineAdmission.installationId !== routing.data.sourceWriter.installationId
      || request.machineAdmission.actorAccountId !== request.machineAdmission.custodianAccountId
      || request.machineAdmission.custodianAccountId !== routing.data.source.sourceContext.machineAdmission.custodianAccountId)) return forbidden();
    writerTargetRouting = routing.data;
  }
  if (request.workspaceSyncSourceRouting !== undefined && request.workspaceSyncTargetRouting !== undefined) return forbidden();
  if (isProjectSource) {
    const routing = WorkspaceSyncSourceRoutingV1Schema.safeParse(request.workspaceSyncSourceRouting);
    const execution = WorkspaceSyncSourceExecutionV1Schema.safeParse(request.workspaceSyncSourceExecution);
    if (!machine || !request.machineAdmission || !routing.success || !execution.success || !request.callerInputAuthorization
      || request.method !== `${machine.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_MATERIALIZE_FOR_OPEN}`
      || execution.data.method !== request.method
      || !sameStrictJsonValue(execution.data.externalActionExecution.authorization, request.callerInputAuthorization)
      || routing.data.sourceMachineId !== request.machineAdmission.machineId
      || !sameStrictJsonValue(routing.data.sourceContext?.machineAdmission, request.machineAdmission)
      || !doesWorkspaceSyncProjectSourceRequestMatchRouting(request.params, request.callerInputAuthorization, routing.data)) return forbidden();
    sourceRouting = routing.data;
  } else if (isSourcePhase || request.workspaceSyncSourceRouting !== undefined) {
    const routing = WorkspaceSyncSourceRoutingV1Schema.safeParse(request.workspaceSyncSourceRouting);
    const phase = WorkspaceSyncHandoffSourcePhaseRequestV1Schema.safeParse(request.params);
    if (!machine || !request.machineAdmission || !routing.success || !phase.success
      || request.method !== `${machine.machineId}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_HANDOFF_SOURCE_PHASE}`
      || routing.data.phase !== phase.data.phase
      || routing.data.operationId !== phase.data.input.operationId
      || routing.data.accountServerId !== phase.data.input.accountServerId
      || routing.data.sourceMachineId !== phase.data.input.sourceMachineId
      || routing.data.sourceRootPath !== phase.data.input.sourceRootPath
      || routing.data.sourceSessionId !== phase.data.input.sourceSessionId
      || routing.data.sourceMachineId !== request.machineAdmission.machineId
      || routing.data.sourceContext && !sameStrictJsonValue(routing.data.sourceContext.machineAdmission, request.machineAdmission)) return forbidden();
    sourceRouting = routing.data;
  }
  if (request.workspaceSyncTargetRouting !== undefined) {
    const routing = WorkspaceSyncTargetRoutingV1Schema.safeParse(request.workspaceSyncTargetRouting);
    if (!machine || !request.machineAdmission || !routing.success
      || request.method !== `${machine.machineId}:${readWorkspaceSyncTargetMethod(routing.data.phase)}`
      || routing.data.targetMachineId !== request.machineAdmission.machineId
      || !sameStrictJsonValue(routing.data.targetContext.machineAdmission, request.machineAdmission)
      || writerTargetRouting && !doesWorkspaceSyncTargetRoutingMatchWriterTarget(routing.data, writerTargetRouting)) return forbidden();
    if (!doesWorkspaceSyncTargetRequestMatchRouting(request.params, routing.data)) return forbidden();
    // The canonical TARGET owner resolves the selected child to this exact physical WorkspaceRef before effects.
    targetRouting = routing.data;
  }
  const isPreviewAdmission = request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION
    || request.method.endsWith(`:${RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION}`);
  if (isPreviewAdmission && (!machine
    || request.method !== `${machine.machineId}:${RPC_METHODS.DAEMON_LOCAL_SERVICES_PREVIEW_ADMISSION}`
    || !request.machineAdmission
    || !isSocketRpcLocalServicesPreviewAdmissionServerOriginAuthorizationContext(request.authorization))) return forbidden();
  const isAccessLoss = request.method.endsWith(`:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`);
  const custodyRequest = isAccessLoss ? MachineAccessLossCustodyRequestV1Schema.safeParse(request.params) : null;
  if (isAccessLoss && (!custodyRequest?.success || !request.machineAdmission
    || !isSocketRpcMachineAccessLossServerOriginAuthorizationContext(request.authorization))) return forbidden();
  if (request.machineAdmission !== undefined) {
    const admission = SocketRpcMachineAdmissionContextV1Schema.safeParse(request.machineAdmission);
    if (!admission.success || !machine) return forbidden();
    const context = admission.data;
    if (isAccessLoss && context.actorAccountId !== context.custodianAccountId) return forbidden();
    try {
      const installationId = machine.resolveInstallationId();
      if (request.signal?.aborted
        || !installationId
        || !sourceRouting && !targetRouting && !writerTargetRouting && !seedRouting && context.machineId !== machine.machineId
        || !request.method.startsWith(`${machine.machineId}:`)
        || !sourceRouting && !targetRouting && !writerTargetRouting && !seedRouting && context.installationId !== installationId
        || !writerTargetRouting && !seedRouting && context.custodianAccountId !== await machine.resolveCustodianAccountId(request.signal)
        || !await machine.verifyMachineAdmission({ context, method: request.method,
          ...(sourceRouting ? { workspaceSyncSourceRouting: sourceRouting } : {}),
          ...((seedRouting || isProjectSource || writerTargetRouting && request.callerInputAuthorization?.binding.actionId === 'projects.open')
            && request.workspaceSyncSourceExecution ? { workspaceSyncSourceExecution: request.workspaceSyncSourceExecution } : {}),
          ...(targetRouting ? { workspaceSyncTargetRouting: targetRouting } : {}),
          ...(writerTargetRouting ? { workspaceSyncSourceWriterTargetRouting: writerTargetRouting } : {}),
          ...(seedRouting ? { workspaceSyncSeedRouting: seedRouting } : {}),
          ...((sourceRouting || writerTargetRouting || seedRouting) && request.callerInputAuthorization ? { callerInputAuthorization: request.callerInputAuthorization } : {}),
          ...(custodyRequest?.success && 'subjectAccountId' in custodyRequest.data
            ? { custodySubjectAccountId: custodyRequest.data.subjectAccountId } : {}),
          ...(request.signal ? { signal: request.signal } : {}) })
        || installationId !== machine.resolveInstallationId()
        || request.signal?.aborted) return forbidden();
    } catch {
      return forbidden();
    }
  }
  const sessionRule = resolveSocketRpcSessionAuthorization(request.method);
  if (sessionRule?.optionalSessionScope) {
    if (request.authorization === undefined) return { ok: true };
    return parseSocketRpcAuthorizationContext(request.authorization)?.kind === 'session.write' ? { ok: true } : forbidden();
  }
  const authorizationMethod = resolveSocketRpcSessionWriteAuthorizationMethod(request.method);
  if (!authorizationMethod) {
    return { ok: true };
  }

  const requestedSessionId = readSessionIdFromParams(request.params);
  if (
    authorizationMethod === RPC_METHODS.STOP_SESSION
    && !request.authorization
    && request.transportResponseEnvelopeVersion === undefined
    && requestedSessionId
  ) {
    // `server-v0.2.1` (4913c1e533c872a0712ba1c25b3104fd470aacc2)
    // forwarded encrypted Stop params only after authenticating both sockets,
    // before session-write proof and response envelopes existed. Keep exactly
    // that released direction working. Current servers always stamp the proof
    // and envelope, so a current request missing proof still fails closed.
    return { ok: true };
  }

  const authorization = parseSocketRpcAuthorizationContext(request.authorization);
  if (!authorization) return forbidden();

  if (!requestedSessionId || requestedSessionId !== authorization.sessionId) {
    return forbidden();
  }

  return { ok: true };
}
