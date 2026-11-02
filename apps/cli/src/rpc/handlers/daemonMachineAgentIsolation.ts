import { MACHINE_AGENT_ISOLATION_ACTION_IDS, MACHINE_AGENT_ISOLATION_ACTION_INPUT_SCHEMAS,
  MachineAgentIsolationPreviewResultV1Schema, MachineAgentIsolationSetResultV1Schema,
  MachineAgentIsolationOwnStatusV1Schema, type MachineAgentIsolationOwnStatusV1,
  agentIsolationMetadataFieldV1, readMachineAgentIsolationPolicyV1,
  type MachineAgentIsolationStatusV1, type MachineAgentIsolationPolicyV1 } from '@happier-dev/protocol';
import { mutateMachineMetadataFieldV1, type MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { doesMachineRpcTargetMatchAdmission } from '@/api/machine/machineRpcAuthorization';
import type { AgentIsolationSnapshot } from '@/daemon/agentIsolation/agentIsolationPolicy';
import { prepareAgentIsolationEffects, resolveAgentIsolationEffectIntent, type AgentIsolationEffectDependencies,
  type PreparedAgentIsolationEffects } from '@/daemon/agentIsolation/agentIsolationProvisioner';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { runElevatedEffect } from '@/machines/adminAccess/runElevatedEffect';
import { observeAgentIsolationNativeReadiness } from '@/daemon/agentIsolation/agentIsolationReadiness';
import { selectHostRequesterExecutionIdentity, isHostRequesterUnrestrictedOwner,
  type HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';

export function registerDaemonMachineAgentIsolationRpcHandlers(rpc: RpcHandlerRegistrar, options: Readonly<{
  target: () => Readonly<{ serverId: string; machineId: string; installationId: string; custodianAccountId: string }> | null;
  read: () => AgentIsolationSnapshot;
  /** Authenticated connection's held canonical Home, never a saved-profile id or network lookup. */
  readCanonicalHomeServerIdentityId?: () => string | null;
  captureMetadataPort?: () => MachineMetadataFieldPortV1;
  effects?: AgentIsolationEffectDependencies;
  /** Exact own read at P11's native readiness owner. It must not provision,
   * publish status, scan members or promote account/binding existence to separation. */
  inspectOwn?: (input: Readonly<{
    requesterIdentity: Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }>;
    homeServerIdentityId: string;
    signal?: AbortSignal;
  }>) => Promise<Exclude<MachineAgentIsolationOwnStatusV1, { protection: 'trusted_administrator' }>>;
}>): void {
  for (const actionId of MACHINE_AGENT_ISOLATION_ACTION_IDS) {
    rpc.registerHandler(actionId, async (raw, context) => {
      const request = MACHINE_AGENT_ISOLATION_ACTION_INPUT_SCHEMAS[actionId].parse(raw);
      const target = options.target();
      const homeServerIdentityId = options.readCanonicalHomeServerIdentityId?.() ?? null;
      const matches = () => {
        const current = options.target();
        const admission = context?.machineAdmission;
        return !!target && !!current && !!admission && !context?.signal.aborted
          && current.serverId === target.serverId && current.machineId === target.machineId
          && current.installationId === target.installationId && current.custodianAccountId === target.custodianAccountId
          && (request.serverId === undefined || request.serverId === current.serverId || request.serverId === homeServerIdentityId)
          && (actionId === 'machines.agentIsolation.status' || admission.role === 'manage')
          && doesMachineRpcTargetMatchAdmission(request, admission, current);
      };
      const verify = async () => matches() && (actionId === 'machines.agentIsolation.preview'
        || !!context?.verifyMachineAdmissionCurrent && await context.verifyMachineAdmissionCurrent()) && matches();
      if (!await verify()) {
        throw new RpcError('Current Machine admission is required', RPC_ERROR_CODES.FORBIDDEN);
      }
      const snapshot = options.read();
      if (actionId === 'machines.agentIsolation.status') {
        const bootstrap = context?.requesterSessionBootstrap;
        const identity = selectHostRequesterExecutionIdentity({ rpcContext: context,
          hostHomeServerIdentityId: homeServerIdentityId, hostCustodianAccountId: target!.custodianAccountId,
          hostExecutionTarget: target!, ...(bootstrap ? { sessionRequester: bootstrap.attribution,
            sessionRequesterHomeServerIdentityId: bootstrap.homeServerIdentityId,
            sessionCustodianAccountId: target!.custodianAccountId } : {}) });
        let result: MachineAgentIsolationOwnStatusV1;
        if (identity.kind === 'unknown' || !homeServerIdentityId) result = { protection: 'unavailable',
          status: { kind: 'unavailable', code: 'metadata_unavailable' } };
        else if (isHostRequesterUnrestrictedOwner(identity)) result = { protection: 'trusted_administrator', status: snapshot.status };
        else if (snapshot.status.kind === 'unavailable'
          && (snapshot.status.code === 'metadata_unavailable' || snapshot.status.code === 'unsupported_platform'))
          result = { protection: 'unavailable', status: snapshot.status };
        else if (!snapshot.enabled) result = { protection: 'setup_pending', status: { kind: 'disabled' } };
        else if (snapshot.status.kind === 'applying') result = { protection: 'setup_pending', status: snapshot.status };
        else if (identity.kind === 'isolated' && options.inspectOwn) result = await options.inspectOwn({
          requesterIdentity: identity, homeServerIdentityId, signal: context?.signal });
        else if (snapshot.status.kind === 'unavailable') result = { protection: 'unavailable', status: snapshot.status };
        else if (snapshot.status.kind !== 'effective') result = { protection: 'setup_pending', status: snapshot.status };
        else result = { protection: 'shared_user', status: snapshot.status };
        // The finite read already passed ingress. Cancellation stays local;
        // no second Home check or setup/materialization is part of status.
        context?.signal.throwIfAborted();
        return MachineAgentIsolationOwnStatusV1Schema.parse(result);
      }
      const desired = actionId === 'machines.agentIsolation.preview'
        ? MACHINE_AGENT_ISOLATION_ACTION_INPUT_SCHEMAS['machines.agentIsolation.preview'].parse(raw)
        : MACHINE_AGENT_ISOLATION_ACTION_INPUT_SCHEMAS['machines.agentIsolation.set'].parse(raw);
      const unavailable = () => MachineAgentIsolationPreviewResultV1Schema.parse({
        kind: 'unavailable', status: snapshot.status.kind === 'unavailable' ? snapshot.status
          : { kind: 'unavailable', code: 'provisioning_unavailable' },
      });
      const effects = options.effects;
      if (!effects || !options.captureMetadataPort) return actionId === 'machines.agentIsolation.preview' ? unavailable()
        : MachineAgentIsolationSetResultV1Schema.parse({ kind: 'failed', code: 'unavailable' });
      const port = options.captureMetadataPort();
      const operationId = context?.localActionContext?.operationAcceptance?.operationId
        ?? context?.localActionContext?.actionRequestId ?? context?.transportRequestId;
      const prepare = (expectedPolicy?: MachineAgentIsolationPolicyV1) => prepareAgentIsolationEffects({ machineId: request.machineId,
        enabled: desired.enabled, port, status: options.read().status, operationId, signal: context?.signal,
        ...(desired.memberProvisioning ? { memberProvisioning: desired.memberProvisioning } : {}),
        verifyCurrent: verify, ...(expectedPolicy ? { expectedPolicy } : {}) }, effects);
      if (actionId === 'machines.agentIsolation.preview') {
        const prepared = await prepare().catch(() => null);
        if (!await verify()) throw new RpcError('Current Machine admission is required', RPC_ERROR_CODES.FORBIDDEN);
        return prepared?.preview ?? unavailable();
      }
      const mutation = MACHINE_AGENT_ISOLATION_ACTION_INPUT_SCHEMAS['machines.agentIsolation.set'].parse(raw);
      const desiredPolicy: MachineAgentIsolationPolicyV1 = { enabled: mutation.enabled,
        ...(mutation.enabled && mutation.memberProvisioning ? { memberProvisioning: mutation.memberProvisioning } : {}) };
      const failed = (code: 'cancelled' | 'denied' | 'locked' | 'invalid' | 'unavailable' | 'outcome_unknown', operationId?: string) =>
        MachineAgentIsolationSetResultV1Schema.parse({ kind: 'failed', code, ...(operationId ? { operationId } : {}) });
      const requireReview = async (prepared: PreparedAgentIsolationEffects) => {
        // A concurrent desired write may satisfy an older field request. The
        // new review's digest must bind its returned policy, not that old basis.
        const review = prepared.setupPlan.basis.kind === 'agentIsolation'
          && agentIsolationMetadataFieldV1.equal(prepared.setupPlan.basis.expectedPolicy, prepared.preview.policy)
          ? prepared : await prepare().catch(() => null);
        if (!review) return failed('unavailable', operationId);
        if (!await verify()) throw new RpcError('Current Machine admission is required', RPC_ERROR_CODES.FORBIDDEN);
        context?.localActionContext?.operationOwnerUpdate?.update({ state: 'running', observation: {
          kind: 'review_required', code: 'agent_isolation_effect_changed', machineId: mutation.machineId,
          enabled: mutation.enabled, current: review.preview,
        } });
        return MachineAgentIsolationSetResultV1Schema.parse({ kind: 'plan_changed', ...(operationId ? { operationId } : {}), current: review.preview });
      };
      const before = await port.read();
      if (before.status !== 'ready') return failed(before.status);
      const previous = readMachineAgentIsolationPolicyV1(before.metadata);
      if (previous.status !== 'ready') return failed(previous.status);
      // The verified retained-creation marker narrows automatic defaults. A
      // deliberate later disable must survive rejoining creation or Retry.
      const creationDefault = !!(context?.localActionContext?.externalActionExecutionAuthorization?.binding.managedContinuation
        || context?.callerInputAuthorization?.binding.managedContinuation);
      if (creationDefault && previous.source === 'stored' && !previous.policy.enabled) {
        return MachineAgentIsolationSetResultV1Schema.parse({ kind: 'conflict', policy: previous.policy,
          metadataVersion: before.metadataVersion });
      }
      if ((!agentIsolationMetadataFieldV1.equal(previous.policy, mutation.expectedPolicy)
        && !agentIsolationMetadataFieldV1.equal(previous.policy, desiredPolicy))
        || before.metadataVersion < mutation.expectedMetadataVersion) return MachineAgentIsolationSetResultV1Schema.parse({
          kind: 'conflict', policy: previous.policy, metadataVersion: before.metadataVersion });
      let prepared = await prepare(mutation.expectedPolicy).catch(() => null);
      if (!prepared) return failed('unavailable');
      if (prepared.preview.plan.planDigest !== mutation.expectedPlanDigest) return await requireReview(prepared);
      if (!operationId) return failed('unavailable');
      let changed: NonNullable<typeof prepared> | null = null;
      let creationConflictVersion: number | undefined;
      const result = await mutateMachineMetadataFieldV1({ expectedMetadataVersion: mutation.expectedMetadataVersion,
        expectedPolicy: mutation.expectedPolicy, policy: desiredPolicy, comparison: 'field' }, {
        read: port.read,
        compareAndSwap: async input => {
          if (!await verify()) return { status: 'unavailable' };
          if (creationDefault) {
            const snapshot = await port.read();
            if (snapshot.status !== 'ready') return { status: snapshot.status };
            const currentPolicy = readMachineAgentIsolationPolicyV1(snapshot.metadata);
            if (currentPolicy.status !== 'ready') return { status: currentPolicy.status };
            if (currentPolicy.source === 'stored' && !currentPolicy.policy.enabled) {
              creationConflictVersion = snapshot.metadataVersion;
              return { status: 'unavailable' };
            }
          }
          const current = await prepare(mutation.expectedPolicy).catch(() => null);
          if (!current) return { status: 'unavailable' };
          if (current.preview.plan.planDigest !== mutation.expectedPlanDigest) { changed = current; return { status: 'unavailable' }; }
          prepared = current;
          return await verify() ? port.compareAndSwap(input) : { status: 'unavailable' };
        },
      }, agentIsolationMetadataFieldV1, { signal: context?.signal });
      if (creationConflictVersion !== undefined) return MachineAgentIsolationSetResultV1Schema.parse({ kind: 'conflict',
        policy: { enabled: false }, metadataVersion: creationConflictVersion });
      if (changed) return await requireReview(changed);
      if (result.status === 'conflict') return MachineAgentIsolationSetResultV1Schema.parse({ kind: 'conflict', policy: result.policy, metadataVersion: result.metadataVersion });
      if (result.status !== 'applied' && result.status !== 'satisfied' && result.status !== 'unchanged') {
        return failed(result.status === 'outcomeUnknown' ? 'outcome_unknown' : result.status);
      }
      const publish = async (status: MachineAgentIsolationStatusV1) => {
        if (!await verify()) throw new RpcError('Current Machine admission is required', RPC_ERROR_CODES.FORBIDDEN);
        await effects.publishStatus(status);
        const label = status.kind === 'applying' ? ({ account: 'Preparing separate Agent user', sudoers: 'Configuring Agent launch',
          workspace: 'Preparing workspace access', runtime_replacement: 'Waiting for Agent runtime replacement' } as const)[status.phase]
          : status.kind === 'disabled' ? 'Agent isolation turned off' : status.kind === 'effective'
            ? 'Agent isolation ready' : 'Agent isolation unavailable';
        context?.localActionContext?.operationProgress?.update({ phase: status.kind === 'applying' ? status.phase : status.kind, label });
      };
      const parkForReview = async () => {
        await publish({ kind: 'applying', phase: 'workspace' });
        const fresh = await prepare().catch(() => null);
        if (!fresh) return failed('unavailable', operationId);
        return await requireReview(fresh);
      };
      // Preserve the reviewed pre-CAS basis. Its own desired write is not drift.
      const verifyEffect = async () => {
        if (!await verify()) return false;
        const current = await port.read();
        if (current.status !== 'ready') return false;
        const policy = readMachineAgentIsolationPolicyV1(current.metadata);
        if (policy.status !== 'ready' || !agentIsolationMetadataFieldV1.equal(policy.policy, desiredPolicy)) return false;
        const intent = await resolveAgentIsolationEffectIntent(mutation.enabled, effects).catch(() => null);
        return !!intent && prepared?.setupPlan.basis.kind === 'agentIsolation'
          && sameStrictJsonValue({ roots: intent.roots, ancestorAcls: intent.ancestorAcls, sessionsToReplace: intent.sessionsToReplace,
            ...(mutation.enabled && mutation.memberProvisioning ? { memberProvisioning: mutation.memberProvisioning } : {}) }, prepared.setupPlan.basis.review)
          && sameStrictJsonValue(intent.steps, prepared.setupPlan.steps);
      };
      if (!await verifyEffect()) {
        return await parkForReview();
      }
      const currentStatus = options.read().status;
      const waitingForReplacement = currentStatus.kind === 'applying' && currentStatus.phase === 'runtime_replacement'
        && (prepared.preview.plan.sessionsToReplace > 0 || mutation.enabled && !effects.nativeReadiness);
      const settled = prepared.preview.plan.sessionsToReplace === 0
        && (mutation.enabled ? currentStatus.kind === 'effective' : currentStatus.kind === 'disabled');
      if (result.status !== 'applied' && !prepared.preview.plan.requiresAdmin && (waitingForReplacement || settled)) {
        return MachineAgentIsolationSetResultV1Schema.parse({ kind: 'unchanged', metadataVersion: result.metadataVersion,
          status: currentStatus });
      }
      const applying = { kind: 'applying', phase: mutation.enabled ? 'account' : 'runtime_replacement' } as const;
      await publish(applying);
      if (prepared.preview.plan.requiresAdmin) {
        const effect = await runElevatedEffect({ machineId: mutation.machineId, operationId, signal: context?.signal,
          effect: { kind: 'setupOperation', plans: [{ plan: prepared.setupPlan }] } },
        { ...effects.elevation, verifyCurrent: verifyEffect,
          emit: event => { effects.elevation.emit?.(event); context?.localActionContext?.operationProgress?.update({
            phase: event.type, label: 'Applying reviewed Agent isolation changes' }); } });
        if (effect.outcome !== 'applied') {
          if (effect.outcome === 'not_applied' && effect.reasonCode === 'plan_stale') return await parkForReview();
          await publish({ kind: 'unavailable', code: 'provisioning_unavailable' });
          if (effect.outcome === 'outcome_unknown') context?.localActionContext?.operationOwnerUpdate?.update({ state: 'running',
            outcome: { ok: false, errorCode: 'outcome_unknown', error: 'Elevated isolation effects could not be confirmed' } });
          return failed(effect.outcome === 'outcome_unknown' ? 'outcome_unknown'
            : effect.outcome === 'not_applied' && effect.reasonCode === 'cancelled' ? 'cancelled' : 'denied', operationId);
        }
      }
      // Setup is not effectiveness. Only the current daemon's finite native
      // qualification may publish it; existing Sessions must first be replaced.
      let status: MachineAgentIsolationStatusV1 = !mutation.enabled && effects.readSessionsToReplace() === 0
        ? { kind: 'disabled' } : { kind: 'applying', phase: 'runtime_replacement' };
      if (mutation.enabled && effects.readSessionsToReplace() === 0 && effects.nativeReadiness) {
        const ready = await prepare().catch(() => null);
        if (!ready || ready.preview.plan.requiresAdmin) return await parkForReview();
        status = await observeAgentIsolationNativeReadiness({ installedCli: effects.installedCli,
          roots: ready.preview.plan.roots.map(root => root.path), signal: context?.signal,
          privateRoots: effects.nativeReadiness.privateRoots, system: effects.nativeReadiness.system });
        // Neither a revoked target, changed policy/Workspace census nor a newly
        // admitted predecessor Session can inherit the completed native proof.
        if (!await verifyEffect()) return await parkForReview();
        if (effects.readSessionsToReplace() !== 0) status = { kind: 'applying', phase: 'runtime_replacement' };
      }
      await publish(status);
      return MachineAgentIsolationSetResultV1Schema.parse({ kind: 'accepted', operationId, metadataVersion: result.metadataVersion, status });
    });
  }
}
