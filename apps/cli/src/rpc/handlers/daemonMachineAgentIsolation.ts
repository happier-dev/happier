import { MACHINE_AGENT_ISOLATION_ACTION_IDS, MACHINE_AGENT_ISOLATION_ACTION_INPUT_SCHEMAS,
  MachineAgentIsolationPreviewResultV1Schema, MachineAgentIsolationSetResultV1Schema,
  MachineAgentIsolationOwnStatusV1Schema, type MachineAgentIsolationOwnStatusV1,
  agentIsolationMetadataFieldV1, readMachineAgentIsolationPolicyV1, resolveMachineAgentExecutionPlacementV1,
  type MachineAgentIsolationStatusV1, type MachineAgentIsolationPolicyV1, type MachineElevatedNotAppliedResultV1,
  type ActionExecutorDeps } from '@happier-dev/protocol';
import { mutateMachineMetadataFieldV1, type MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import { projectMachineAgentIsolationUnavailableStatusV1 } from '@happier-dev/protocol/machines/agentIsolationV1';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { buildActionExecutorContextForRpc } from '@/rpc/handlers/_actionDispatchAdapter';
import { doesMachineRpcTargetMatchAdmission } from '@/api/machine/machineRpcAuthorization';
import type { AgentIsolationSnapshot } from '@/daemon/agentIsolation/agentIsolationPolicy';
import { prepareAgentIsolationEffectsResult, projectAgentIsolationPendingNativeStatus, resolveAgentIsolationEffectIntent, type AgentIsolationEffectDependencies,
  type PreparedAgentIsolationEffects } from '@/daemon/agentIsolation/agentIsolationProvisioner';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { compareMachineSetupEffectPlansV1 } from '@happier-dev/cli-common/machineSetup';
import { logger } from '@/ui/logger';
import { runElevatedEffect } from '@/machines/adminAccess/runElevatedEffect';
import { observeAgentIsolationNativeReadiness } from '@/daemon/agentIsolation/agentIsolationReadiness';
import { selectHostRequesterExecutionIdentity, isHostRequesterUnrestrictedOwner, resolveHostRequesterAgentExecutionIdentity,
  type HostRequesterExecutionIdentity } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';

export function registerDaemonMachineAgentIsolationRpcHandlers(rpc: RpcHandlerRegistrar, options: Readonly<{
  target: () => Readonly<{ serverId: string; machineId: string; installationId: string; custodianAccountId: string }> | null;
  read: () => AgentIsolationSnapshot;
  /** Authenticated connection's held canonical Home, never a saved-profile id or network lookup. */
  readCanonicalHomeServerIdentityId?: () => string | null;
  captureMetadataPort?: () => MachineMetadataFieldPortV1;
  effects?: AgentIsolationEffectDependencies;
  runActionOperation?: NonNullable<ActionExecutorDeps['runActionOperation']>;
  /** Exact own read at P11's native readiness owner. It must not provision,
   * publish status, scan members or promote account/binding existence to separation. */
  inspectOwn?: (input: Readonly<{
    requesterIdentity: Extract<HostRequesterExecutionIdentity, { kind: 'isolated' }>;
    homeServerIdentityId: string;
    signal?: AbortSignal;
  }>) => Promise<Exclude<MachineAgentIsolationOwnStatusV1, { protection: 'trusted_administrator' }>>;
}>): void {
  for (const actionId of MACHINE_AGENT_ISOLATION_ACTION_IDS) {
    const run = async (raw: unknown, context?: RpcHandlerContext) => {
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
        const personIdentity = selectHostRequesterExecutionIdentity({ rpcContext: context,
          hostHomeServerIdentityId: homeServerIdentityId, hostCustodianAccountId: target!.custodianAccountId,
          hostExecutionTarget: target!, ...(bootstrap ? { sessionRequester: bootstrap.attribution,
            sessionRequesterHomeServerIdentityId: bootstrap.homeServerIdentityId,
            sessionCustodianAccountId: target!.custodianAccountId } : {}) });
        const identity = resolveMachineAgentExecutionPlacementV1({ policy: snapshot, platform: process.platform }) === 'member'
          ? resolveHostRequesterAgentExecutionIdentity(personIdentity) : personIdentity;
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
      const desiredPolicy: MachineAgentIsolationPolicyV1 = { enabled: desired.enabled,
        ...(desired.enabled && desired.memberProvisioning ? { memberProvisioning: desired.memberProvisioning } : {}) };
      const unavailable = () => MachineAgentIsolationPreviewResultV1Schema.parse({
        kind: 'unavailable', status: snapshot.status.kind === 'unavailable' ? snapshot.status
          : { kind: 'unavailable', code: 'provisioning_unavailable' },
      });
      const effects = options.effects;
      if (!effects || !options.captureMetadataPort) return actionId === 'machines.agentIsolation.preview' ? unavailable()
        : MachineAgentIsolationSetResultV1Schema.parse({ kind: 'failed', code: 'unavailable' });
      const port = options.captureMetadataPort();
      const acceptance = context?.localActionContext?.operationAcceptance;
      // Preview's finite native check needs correlation, but a mutation may only
      // expose an operation id created by the retained operation owner.
      const operationId = acceptance?.actionId === actionId ? acceptance.operationId
        : actionId === 'machines.agentIsolation.preview'
          ? context?.localActionContext?.actionRequestId ?? context?.transportRequestId : undefined;
      const prepareResult = (expectedPolicy?: MachineAgentIsolationPolicyV1) => prepareAgentIsolationEffectsResult({ machineId: request.machineId,
        enabled: desired.enabled, port, status: options.read().status, operationId, signal: context?.signal,
        ...(desired.memberProvisioning ? { memberProvisioning: desired.memberProvisioning } : {}),
        verifyCurrent: verify, ...(expectedPolicy ? { expectedPolicy } : {}) }, effects);
      const prepare = async (expectedPolicy?: MachineAgentIsolationPolicyV1) => {
        const result = await prepareResult(expectedPolicy);
        return 'preview' in result ? result : null;
      };
      if (actionId === 'machines.agentIsolation.preview') {
        const prepared = await prepareResult().catch(() => null);
        const preview = MachineAgentIsolationPreviewResultV1Schema.parse(prepared && 'preview' in prepared
          ? prepared.preview : prepared ?? unavailable());
        // Reinstall withdraws runtime proof, not native setup. An explicit CHECK
        // can qualify that unknown shared identity without repeating APPLY.
        const pendingStatus = preview.kind === 'ready' && preview.plan.requiresAdmin && preview.status.kind === 'unavailable'
          && preview.status.prerequisite?.reason === 'native_effect_pending'
          && agentIsolationMetadataFieldV1.equal(preview.policy, desiredPolicy) ? preview.status : undefined;
        const status = pendingStatus ?? (preview.kind === 'ready' && preview.status.kind === 'unavailable'
          && preview.status.code === 'provisioning_unavailable'
          && agentIsolationMetadataFieldV1.equal(preview.policy, desiredPolicy)
          && resolveMachineAgentExecutionPlacementV1({ policy: preview.policy, platform: effects.platform }) === 'sharedAgent'
          && !preview.plan.requiresAdmin && preview.plan.sessionsToReplace === 0 && effects.nativeReadiness
          ? await observeAgentIsolationNativeReadiness({ installedCli: effects.installedCli,
            roots: preview.plan.roots.map(root => root.path), signal: context?.signal,
            privateRoots: effects.nativeReadiness.privateRoots, system: effects.nativeReadiness.system }) : undefined);
        if (!await verify()) throw new RpcError('Current Machine admission is required', RPC_ERROR_CODES.FORBIDDEN);
        if (status) {
          await effects.publishStatus(status);
          return { ...preview, status };
        }
        if (preview.kind === 'unavailable') await effects.publishStatus(projectMachineAgentIsolationUnavailableStatusV1(preview));
        return preview;
      }
      const mutation = MACHINE_AGENT_ISOLATION_ACTION_INPUT_SCHEMAS['machines.agentIsolation.set'].parse(raw);
      const failed = (code: 'cancelled' | 'denied' | 'locked' | 'invalid' | 'unavailable' | 'outcome_unknown',
        operationId?: string, setup?: MachineElevatedNotAppliedResultV1) =>
        MachineAgentIsolationSetResultV1Schema.parse({ kind: 'failed', code, ...(operationId ? { operationId } : {}),
          ...(setup ? { setup } : {}) });
      const requireReview = async (prepared: PreparedAgentIsolationEffects) => {
        if (!await verify()) throw new RpcError('Current Machine admission is required', RPC_ERROR_CODES.FORBIDDEN);
        context?.localActionContext?.operationOwnerUpdate?.update({ state: 'running', observation: {
          kind: 'review_required', code: 'agent_isolation_effect_changed', machineId: mutation.machineId,
          enabled: mutation.enabled, current: prepared.preview,
        } });
        return MachineAgentIsolationSetResultV1Schema.parse({ kind: 'plan_changed', ...(operationId ? { operationId } : {}), current: prepared.preview });
      };
      const before = await port.read();
      if (before.status !== 'ready') return failed(before.status);
      const previous = readMachineAgentIsolationPolicyV1(before.metadata);
      if (previous.status !== 'ready') return failed(previous.status);
      // Creation initializes an absent field; recovery preserves any policy
      // already selected, without replaying native effects or replacing Sessions.
      const creationDefault = !!(context?.localActionContext?.externalActionExecutionAuthorization?.binding.managedContinuation
        || context?.callerInputAuthorization?.binding.managedContinuation);
      if (creationDefault && previous.source === 'stored') {
        return MachineAgentIsolationSetResultV1Schema.parse({ kind: 'unchanged',
          metadataVersion: before.metadataVersion, status: options.read().status });
      }
      if (!agentIsolationMetadataFieldV1.equal(previous.policy, mutation.expectedPolicy)
        && !agentIsolationMetadataFieldV1.equal(previous.policy, desiredPolicy)) return MachineAgentIsolationSetResultV1Schema.parse({
          kind: 'conflict', policy: previous.policy, metadataVersion: before.metadataVersion });
      let prepared = await prepare(mutation.expectedPolicy).catch(() => null);
      if (!prepared) return failed('unavailable');
      if (prepared.preview.plan.planDigest !== mutation.expectedPlanDigest) return await requireReview(prepared);
      if (!operationId) return failed('unavailable');
      let changed: NonNullable<typeof prepared> | null = null;
      let preservedCreationVersion: number | undefined;
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
            if (currentPolicy.source === 'stored') {
              preservedCreationVersion = snapshot.metadataVersion;
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
      if (preservedCreationVersion !== undefined) return MachineAgentIsolationSetResultV1Schema.parse({ kind: 'unchanged',
        metadataVersion: preservedCreationVersion, status: options.read().status });
      if (changed) return await requireReview(changed);
      if (result.status === 'conflict') return MachineAgentIsolationSetResultV1Schema.parse({ kind: 'conflict', policy: result.policy, metadataVersion: result.metadataVersion });
      if (result.status !== 'applied' && result.status !== 'satisfied' && result.status !== 'unchanged') {
        return failed(result.status === 'outcomeUnknown' ? 'outcome_unknown' : result.status);
      }
      const publish = async (status: MachineAgentIsolationStatusV1) => {
        // The admitted apply owns its status through settlement. Cancellation
        // stops native work; it must still withdraw the applying publication.
        await effects.publishStatus(status);
        const label = status.kind === 'applying' ? ({ account: 'Preparing separate Agent user', sudoers: 'Configuring Agent launch',
          workspace: 'Preparing workspace access', runtime_replacement: 'Waiting for Agent runtime replacement' } as const)[status.phase]
          : status.kind === 'disabled' ? 'Agent isolation turned off' : status.kind === 'effective'
            ? 'Agent isolation ready' : 'Agent isolation unavailable';
        context?.localActionContext?.operationProgress?.update({ phase: status.kind === 'applying' ? status.phase : status.kind, label });
      };
      const parkForReview = async (stage: 'before_native_apply' | 'native_apply_refused' | 'post_apply_check' | 'after_native_readiness',
        current?: PreparedAgentIsolationEffects | null) => {
        await publish({ kind: 'applying', phase: 'workspace' });
        const fresh = current ?? await prepare().catch(() => null);
        logger.warnLocalFile('[agent-isolation] Apply requires review', { operationId, stage,
          ...(fresh && prepared ? { comparison: compareMachineSetupEffectPlansV1(prepared.setupPlan, fresh.setupPlan),
            pendingFields: fresh.setupPlan.nativeFacts.flatMap((fact, index) => fact.status === 'satisfied' ? []
              : [`nativeFacts[${index}].status`]) } : {}) });
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
          && (mutation.enabled ? sameStrictJsonValue(intent.steps, prepared.setupPlan.steps)
            : prepared.setupPlan.steps.every(step => intent.steps.some(candidate => sameStrictJsonValue(candidate, step))));
      };
      if (!await verifyEffect()) {
        return await parkForReview('before_native_apply');
      }
      const retirement = prepared.preview.plan.retirement ? { retirement: {
        removed: prepared.preview.plan.retirement.filter(effect => effect.action === 'remove').map(effect => effect.stepId),
        retained: prepared.preview.plan.retirement.filter(effect => effect.action === 'retain'),
      } } : {};
      const currentStatus = options.read().status;
      const waitingForReplacement = currentStatus.kind === 'applying' && currentStatus.phase === 'runtime_replacement'
        && (prepared.preview.plan.sessionsToReplace > 0 || mutation.enabled && !effects.nativeReadiness);
      const settled = prepared.preview.plan.sessionsToReplace === 0
        && (mutation.enabled ? currentStatus.kind === 'effective' : currentStatus.kind === 'disabled');
      if (result.status !== 'applied' && !prepared.preview.plan.requiresAdmin && (waitingForReplacement || settled)) {
        return MachineAgentIsolationSetResultV1Schema.parse({ kind: 'unchanged', metadataVersion: result.metadataVersion,
          status: currentStatus, ...retirement });
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
          if (effect.outcome === 'not_applied' && effect.reasonCode === 'plan_stale') return await parkForReview('native_apply_refused');
          const setup = effect.outcome === 'not_applied' ? effect : undefined;
          await publish(projectMachineAgentIsolationUnavailableStatusV1({ kind: 'unavailable',
            status: { kind: 'unavailable', code: 'provisioning_unavailable' }, ...(setup ? { setup } : {}) }));
          if (effect.outcome === 'outcome_unknown') context?.localActionContext?.operationOwnerUpdate?.update({ state: 'running',
            outcome: { ok: false, errorCode: 'outcome_unknown', error: 'Elevated isolation effects could not be confirmed' } });
          return failed(effect.outcome === 'outcome_unknown' ? 'outcome_unknown'
            : effect.outcome === 'not_applied' && effect.reasonCode === 'cancelled' ? 'cancelled' : 'denied', operationId, setup);
        }
      }
      // Setup is not effectiveness. Only the current daemon's finite native
      // qualification may publish it; existing Sessions must first be replaced.
      let status: MachineAgentIsolationStatusV1 = !mutation.enabled && effects.readSessionsToReplace() === 0
        ? { kind: 'disabled' } : { kind: 'applying', phase: 'runtime_replacement' };
      if (mutation.enabled && effects.readSessionsToReplace() === 0) {
        // One finite CHECK after APPLY. Pending facts have no advancing event:
        // settle them with their native cause and the existing reviewed repair.
        const observed = await prepareResult().catch(() => null);
        status = { kind: 'unavailable', code: 'provisioning_unavailable', prerequisite: {
          reason: 'native_effect_pending', requiredFact: 'native_readiness', detail: 'native_readiness_unavailable',
          remedy: 'machines.agentIsolation.preview',
        } };
        if (observed && 'preview' in observed) {
          const ready = observed;
          if (ready.preview.plan.requiresAdmin && ready.preview.plan.planDigest !== prepared.preview.plan.planDigest)
            return await parkForReview('post_apply_check', ready);
          const pendingStatus = projectAgentIsolationPendingNativeStatus(ready.setupPlan);
          if (pendingStatus) {
            status = pendingStatus;
            logger.warnLocalFile('[agent-isolation] Applied setup is not ready', { operationId, stage: 'post_apply_check',
              comparison: compareMachineSetupEffectPlansV1(prepared.setupPlan, ready.setupPlan),
              pendingFields: ready.setupPlan.nativeFacts.flatMap((fact, index) => fact.status === 'satisfied' ? []
                : [`nativeFacts[${index}].status`]) });
          } else if (effects.nativeReadiness) status = await observeAgentIsolationNativeReadiness({ installedCli: effects.installedCli,
            roots: ready.preview.plan.roots.map(root => root.path), signal: context?.signal,
            privateRoots: effects.nativeReadiness.privateRoots, system: effects.nativeReadiness.system });
          // Neither changed policy/Workspace census nor a newly admitted
          // predecessor Session can inherit the completed native proof.
          if (!await verifyEffect()) return await parkForReview('after_native_readiness');
          if (effects.readSessionsToReplace() !== 0) status = { kind: 'applying', phase: 'runtime_replacement' };
        } else if (observed) status = projectMachineAgentIsolationUnavailableStatusV1(observed);
      }
      await publish(status);
      return MachineAgentIsolationSetResultV1Schema.parse({ kind: 'accepted', operationId, metadataVersion: result.metadataVersion, status, ...retirement });
    };
    rpc.registerHandler(actionId, async (raw, ingress) => {
      if (actionId !== 'machines.agentIsolation.set' || !options.runActionOperation || !ingress) return await run(raw, ingress);
      const request = MACHINE_AGENT_ISOLATION_ACTION_INPUT_SCHEMAS[actionId].parse(raw);
      const context = buildActionExecutorContextForRpc({ ...ingress, actionId, serverId: request.serverId,
        localActionContext: { ...ingress.localActionContext,
          actionRequestId: ingress.localActionContext?.actionRequestId ?? ingress.transportRequestId } });
      const result = await options.runActionOperation({ actionId, input: request, context,
        execute: async operation => ({ ok: true, result: await run(raw, { ...ingress,
          signal: operation.signal ? AbortSignal.any([ingress.signal, operation.signal]) : ingress.signal,
          localActionContext: { ...ingress.localActionContext, ...operation } }) }),
      });
      if (!result.ok) throw new RpcError(result.error, result.errorCode);
      return MachineAgentIsolationSetResultV1Schema.parse(result.result);
    });
  }
}
