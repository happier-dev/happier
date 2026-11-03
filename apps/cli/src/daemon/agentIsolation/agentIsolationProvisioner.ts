import { applyMachineSetupEffectPlan, checkMachineSetupEffectPlan, createMachineSetupNativeBackend, type MachineSetupBackend } from '@happier-dev/cli-common/machineSetup';
import { resolveMachineAgentExecutionPlacementV1, readMachineAgentIsolationPolicyV1, type AgentIsolationEffectPlanV1, type MachineAgentIsolationPolicyV1,
  type MachineAgentIsolationPreviewResultV1, type MachineAgentIsolationStatusV1, type MachineElevatedResultV1 } from '@happier-dev/protocol';
import type { MachineSetupEffectPlanV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { MachineSetupObservationReasonV1Schema } from '@happier-dev/protocol/machines/setup/machineSetupObservationReasonV1';
import type { MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import { checkElevatedMachineSetupPlanResult, runElevatedEffect, runElevatedMachineSetupIntent, type MachineElevationDependencies } from '@/machines/adminAccess/runElevatedEffect';
import { buildAgentIsolationMemberAccountStep, buildAgentIsolationMemberRetirementSteps,
  deriveAgentIsolationMemberIdentity, type AgentIsolationMemberRequester, type AgentIsolationDaemonObservation } from './provisioning';
import { readAgentIsolationNativeIdentity, type AgentIsolationMemberNativeIdentity } from './agentIsolationNativeIdentity';
import { readAgentIsolationMemberBinding, readAgentIsolationMemberBindingForAccount, writeAgentIsolationMemberBinding,
  type AgentIsolationMemberBindingScope } from './memberBindings';
import { resolveAgentIsolationEffectIntentResult } from './effectIntent';
import type { AgentIsolationReadinessSystem } from './agentIsolationReadiness';
import type { MachineNativeEffectContext } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
export { ensureAgentIsolationMember, type EnsureAgentIsolationMemberInput,
  type EnsureAgentIsolationMemberResult } from './ensureAgentIsolationMember';
export { readAgentIsolationMemberBinding, readAgentIsolationMemberBindingForAccount, readAgentIsolationMemberLaunchIdentity,
  readProvisionedRequesterAccounts, writeAgentIsolationMemberBinding,
  projectAgentIsolationMemberBinding, type AgentIsolationMemberBinding, type AgentIsolationMemberBindingScope } from './memberBindings';

export type AgentIsolationEffectDependencies = Readonly<{
  platform: NodeJS.Platform;
  installedCli: string;
  readRoots(): readonly Readonly<{ rootId: string; path: string }>[] | null;
  readSessionsToReplace(): number;
  protectedRoots?: readonly string[];
  /** The native setup adapter is the OS boundary, shared with root APPLY. */
  backend?: MachineSetupBackend;
  /** Present only at the daemon composition; optional OS override is for native boundary tests. */
  nativeReadiness?: Readonly<{ privateRoots: readonly string[]; system?: AgentIsolationReadinessSystem }>;
  elevation: Omit<MachineElevationDependencies, 'verifyCurrent'>;
  /** Incumbent observer's held fact for read-only status qualification. */
  readDaemonObservation?(): AgentIsolationDaemonObservation | null;
  publishStatus(status: MachineAgentIsolationStatusV1): Promise<void>;
}>;
export type PreparedAgentIsolationEffects = Readonly<{
  preview: Extract<MachineAgentIsolationPreviewResultV1, { kind: 'ready' }>;
  setupPlan: MachineSetupEffectPlanV1;
  daemonObservation?: AgentIsolationDaemonObservation;
}>;

export async function resolveAgentIsolationEffectIntent(enabled: boolean, effects: AgentIsolationEffectDependencies,
  requesterIdentity?: AgentIsolationMemberRequester, retainedMemberUid?: number) {
  const result = await resolveAgentIsolationEffectIntentResult(enabled, effects, requesterIdentity, retainedMemberUid);
  return result.kind === 'ready' ? result.intent : null;
}

/** One review/digest owner, reused before every CAS and inside elevated APPLY. */
export async function prepareAgentIsolationEffects(input: Parameters<typeof prepareAgentIsolationEffectsResult>[0],
  effects: AgentIsolationEffectDependencies): Promise<PreparedAgentIsolationEffects | null> {
  const result = await prepareAgentIsolationEffectsResult(input, effects);
  return 'preview' in result ? result : null;
}

/** Read-only preparation preserves the native/elevation owner's prerequisite;
 * mutation callers retain their existing null contract through the wrapper. */
export async function prepareAgentIsolationEffectsResult(input: Readonly<{
  machineId: string; enabled: boolean; port: MachineMetadataFieldPortV1;
  status: MachineAgentIsolationStatusV1; expectedPolicy?: MachineAgentIsolationPolicyV1;
  operationId?: string; signal?: AbortSignal; verifyCurrent?: () => Promise<boolean>;
  memberProvisioning?: 'linuxUsersV1';
  requesterIdentity?: AgentIsolationMemberRequester;
}>, effects: AgentIsolationEffectDependencies): Promise<PreparedAgentIsolationEffects
  | Extract<MachineAgentIsolationPreviewResultV1, { kind: 'unavailable' }>> {
  const unavailable = (code: Extract<MachineAgentIsolationStatusV1, { kind: 'unavailable' }>['code'] = 'provisioning_unavailable') =>
    ({ kind: 'unavailable', status: { kind: 'unavailable', code } } as const);
  if (effects.platform !== 'linux') return unavailable('unsupported_platform');
  if (input.requesterIdentity && (input.requesterIdentity.requester.machineId !== input.machineId
    || input.requesterIdentity.requester.installationId !== effects.elevation.installationId)) return unavailable();
  const snapshot = await input.port.read();
  if (snapshot.status !== 'ready') return unavailable('metadata_unavailable');
  const policy = readMachineAgentIsolationPolicyV1(snapshot.metadata);
  if (policy.status !== 'ready') return unavailable('metadata_unavailable');
  const resolved = await resolveAgentIsolationEffectIntentResult(input.enabled, effects, input.requesterIdentity);
  if (resolved.kind === 'unavailable') return resolved;
  const intent = resolved.intent;
  const { roots, ancestorAcls, sessionsToReplace, steps } = intent;
  const memberReview = input.enabled && input.memberProvisioning === 'linuxUsersV1'
    ? { memberProvisioning: 'linuxUsersV1' as const } : {};
  const basis: MachineSetupEffectPlanV1['basis'] = { kind: 'agentIsolation', machineId: input.machineId, enabled: input.enabled,
    expectedPolicy: input.expectedPolicy ?? policy.policy, review: { roots, ancestorAcls, sessionsToReplace, ...memberReview } };
  let setupPlan: MachineSetupEffectPlanV1;
  if (!effects.backend && input.enabled && input.operationId && input.verifyCurrent) {
    const checked = await checkElevatedMachineSetupPlanResult({ machineId: input.machineId, operationId: input.operationId,
      basis, steps, signal: input.signal }, { ...effects.elevation, verifyCurrent: input.verifyCurrent });
    if (checked.outcome !== 'checked') return { ...unavailable(),
      ...(checked.outcome === 'not_applied' ? { setup: checked } : {}) };
    setupPlan = checked.plan;
  } else setupPlan = await checkMachineSetupEffectPlan({ basis, steps, backend: effects.backend ?? createMachineSetupNativeBackend() });
  const nativeFailure = setupPlan.nativeFacts.find(fact => fact.status === 'unavailable' || fact.status === 'unsupported');
  if (nativeFailure) {
    const reasonCode = nativeFailure.status === 'unsupported' ? 'native_check_unsupported' : 'native_check_unavailable';
    const reason = MachineSetupObservationReasonV1Schema.safeParse(nativeFailure.reason);
    return { ...unavailable(), setup: { outcome: 'not_applied', reasonCode,
      failure: { kind: reasonCode, ...(reason.success ? { reason: reason.data } : {}) } } };
  }
  const plan: AgentIsolationEffectPlanV1 = { ...memberReview, roots: roots.map(root => ({ ...root,
    changes: input.enabled && setupPlan.nativeFacts.find(fact => fact.stepId === `workspace-${root.rootId}`)?.status !== 'satisfied'
      ? ['group', 'setgid', 'mode', 'gitShared', 'safeDirectory'] : [] })), ancestorAcls, sessionsToReplace,
    requiresAdmin: setupPlan.nativeFacts.some(fact => fact.status !== 'satisfied'), planDigest: setupPlan.planDigest };
  return { setupPlan, ...('daemonObservation' in intent ? { daemonObservation: intent.daemonObservation } : {}),
    preview: { kind: 'ready', plan, policy: policy.policy,
    metadataVersion: snapshot.metadataVersion, status: input.status } };
}

export type ApplyAgentIsolationMemberEffectsInput = Readonly<{
  machineId: string; requesterIdentity: AgentIsolationMemberRequester; operationId: string; activeServerDir: string;
  port: MachineMetadataFieldPortV1; status?: MachineAgentIsolationStatusV1;
  /** Omitted only by the owner-reviewed lazy setup/recovery operation. Public
   * preview/set and explicit prepared callers retain exact digest admission. */
  expectedPlanDigest?: string;
  signal?: AbortSignal;
  /** Local operation/installation/cancellation custody after Home admission. */
  verifyCurrent(): Promise<boolean>;
  nativeEffectContext: MachineNativeEffectContext;
}>;
export type ApplyAgentIsolationMemberEffectsResult = Readonly<{
  kind: 'ready'; identity: AgentIsolationMemberNativeIdentity; daemonObservation: AgentIsolationDaemonObservation;
}> | Readonly<{ kind: 'not_ready'; result: Exclude<MachineElevatedResultV1, { outcome: 'applied' }> }>;

/** The single member mutation owner, consumed by both explicit reviewed plans
 * and owner-authorized first use/recovery. Callers never mint an approval or
 * upgrade the requester's role; the existing setup operation encloses binding
 * commit as well as native CHECK/APPLY.
 */
export async function applyAgentIsolationMemberEffects(input: ApplyAgentIsolationMemberEffectsInput,
  effects: AgentIsolationEffectDependencies): Promise<ApplyAgentIsolationMemberEffectsResult> {
  const refused = (reasonCode: 'cancelled' | 'plan_stale' | 'denied'): ApplyAgentIsolationMemberEffectsResult =>
    ({ kind: 'not_ready', result: { outcome: 'not_applied', reasonCode } });
  if (input.nativeEffectContext.operation.operationId !== input.operationId
    || input.requesterIdentity.requester.machineId !== input.machineId
    || input.requesterIdentity.requester.installationId !== effects.elevation.installationId) return refused('plan_stale');
  if (input.signal?.aborted) return refused('cancelled');
  if (!await input.verifyCurrent()) return refused('plan_stale');
  if (effects.platform !== 'linux') return { kind: 'not_ready', result: { outcome: 'not_applied', reasonCode: 'platform_unsupported' } };
  try {
    const snapshot = await input.port.read();
    if (snapshot.status !== 'ready') return refused('denied');
    const policy = readMachineAgentIsolationPolicyV1(snapshot.metadata);
    if (policy.status !== 'ready' || resolveMachineAgentExecutionPlacementV1({ policy: policy.policy, platform: effects.platform }) !== 'member') return refused('denied');
    const scope = { activeServerDir: input.activeServerDir, homeServerIdentityId: input.requesterIdentity.homeServerIdentityId,
      machineId: input.machineId, installationId: input.requesterIdentity.requester.installationId };
    const binding = await readAgentIsolationMemberBindingForAccount(scope, input.requesterIdentity.requester.accountId);
    const verify = async () => !input.signal?.aborted && await input.verifyCurrent();
    const acceptPlan = async (plan: MachineSetupEffectPlanV1) => {
      const retained = binding ?? await readAgentIsolationMemberBindingForAccount(scope, input.requesterIdentity.requester.accountId);
      if (!retained) return true;
      // Root CHECK already proves full provenance. Retained private data also
      // reserves its numeric UID/home before any native mutation or RunAs grant.
      const account = plan.nativeFacts.find(fact => fact.stepId === 'agent-account');
      const accountStep = plan.steps.find(step => step.id === 'agent-account');
      if (account?.facts.present === false) return accountStep?.kind === 'user' && accountStep.uid === retained.uid
        && account.facts.availableUid === retained.uid;
      return account?.facts.present === true && account.facts.uid === retained.uid
        && account.facts.username === retained.username && account.facts.home === retained.home;
    };
    let daemonObservation: AgentIsolationDaemonObservation | undefined;
    if (input.expectedPlanDigest !== undefined) {
      const prepared = await prepareAgentIsolationEffects({ ...input, enabled: true,
        status: input.status ?? { kind: 'unavailable', code: 'provisioning_unavailable' } }, effects);
      if (!prepared || prepared.setupPlan.planDigest !== input.expectedPlanDigest) return refused('plan_stale');
      if (!await acceptPlan(prepared.setupPlan)) return refused('denied');
      daemonObservation = prepared.daemonObservation;
      if (!await verify()) return refused('plan_stale');
      if (prepared.preview.plan.requiresAdmin) {
        if (effects.backend) {
          const result = await applyMachineSetupEffectPlan({ plan: prepared.setupPlan,
            backend: effects.backend, signal: input.signal });
          if (result.status !== 'applied') return result.status === 'outcome_unknown'
            ? { kind: 'not_ready', result: { outcome: 'outcome_unknown' } } : refused(result.status === 'cancelled' ? 'cancelled' : 'denied');
        } else {
          const result = await runElevatedEffect({ machineId: input.machineId, operationId: input.operationId, signal: input.signal,
            effect: { kind: 'setupOperation', plans: [{ plan: prepared.setupPlan }] } },
          { ...effects.elevation, verifyCurrent: verify });
          if (result.outcome !== 'applied') return { kind: 'not_ready', result };
          daemonObservation = result.observation;
        }
      }
    } else {
      const intent = await resolveAgentIsolationEffectIntent(true, effects, input.requesterIdentity, binding?.uid);
      if (!intent) return refused('denied');
      const result = await runElevatedMachineSetupIntent({ machineId: input.machineId, operationId: input.operationId,
        signal: input.signal, basis: { kind: 'agentIsolation', machineId: input.machineId, enabled: true,
          expectedPolicy: policy.policy, review: { roots: intent.roots, ancestorAcls: intent.ancestorAcls,
            sessionsToReplace: intent.sessionsToReplace, memberProvisioning: 'linuxUsersV1' } }, steps: intent.steps, acceptPlan },
      { ...effects.elevation, verifyCurrent: verify });
      if (result.outcome !== 'applied') return { kind: 'not_ready', result };
      daemonObservation = result.observation;
    }
    if (!daemonObservation || !await verify()) return refused('plan_stale');
    const identity = await readAgentIsolationNativeIdentity({ requesterIdentity: input.requesterIdentity,
      ...(binding ? { expectedUid: binding.uid } : {}), signal: input.signal }, effects.backend);
    if (!await verify()) return refused('plan_stale');
    await writeAgentIsolationMemberBinding(input.activeServerDir, identity);
    if (!await verify()) return refused('plan_stale');
    return { kind: 'ready', identity, daemonObservation };
  } catch { return refused(input.signal?.aborted ? 'cancelled' : 'denied'); }
}

/** Exact server-authorized loss is serialized by its existing setup-operation owner. */
export async function retireAgentIsolationMemberIdentity(input: Readonly<{
  scope: AgentIsolationMemberBindingScope; accountId: string; operationId: string; signal?: AbortSignal;
  nativeEffectContext: MachineNativeEffectContext;
  /** Local custody after the receiver's one Home admission, never another Home read. */
  isCurrentInstallation(): boolean;
  /** Existing lifecycle boundary: admitted finite work finishes before this settles. */
  waitForNaturalBoundary(): Promise<Readonly<{ kind: 'settled' | 'incomplete' }>>;
  /** Exact physical socket/material cleanup, independent of launch withdrawal. */
  cleanupOwnedWork(): Promise<Readonly<{ kind: 'settled' | 'incomplete' }>>;
}>, effects: AgentIsolationEffectDependencies): Promise<Readonly<{ kind: 'settled' | 'incomplete' }>> {
  let nativeSettled = false;
  let boundarySettled = false;
  const current = () => !input.signal?.aborted && input.isCurrentInstallation();
  const verifyCurrent = async () => current();
  try {
    if (current() && input.nativeEffectContext.operation.operationId === input.operationId
      && input.scope.installationId === effects.elevation.installationId) {
      // The existing lifecycle owner closes open-ended work immediately and
      // lets admitted finite work finish. Never withdraw RunAs/material while
      // that owner still reports work before its natural boundary.
      boundarySettled = (await input.waitForNaturalBoundary()).kind === 'settled';
      if (!boundarySettled || !current()) return { kind: 'incomplete' };
      const requesterIdentity: AgentIsolationMemberRequester = { kind: 'isolated', separationRequired: true,
        homeServerIdentityId: input.scope.homeServerIdentityId, requester: { serverId: input.scope.homeServerIdentityId,
          accountId: input.accountId, machineId: input.scope.machineId, installationId: input.scope.installationId } };
      const identity = deriveAgentIsolationMemberIdentity(requesterIdentity);
      const binding = await readAgentIsolationMemberBindingForAccount(input.scope, input.accountId);
      const backend = effects.backend ?? createMachineSetupNativeBackend({ signal: input.signal });
      const account = buildAgentIsolationMemberAccountStep(identity);
      const { locked: _locked, ...publicAccount } = account;
      const presence = await backend.observe(publicAccount);
      const accountAbsent = presence.facts.present === false;
      let observed: AgentIsolationMemberNativeIdentity | undefined;
      if (!accountAbsent) {
        try {
          observed = await readAgentIsolationNativeIdentity({ requesterIdentity, ...(binding ? { expectedUid: binding.uid } : {}), signal: input.signal }, backend);
          if (binding) await readAgentIsolationMemberBinding(input.scope.activeServerDir, observed);
        } catch { /* Withdrawal can still remove only its exact owned rule. */ }
      }
      {
        const daemon = await effects.elevation.observe();
        if (daemon.daemonIdentity !== 'nonRoot' || !daemon.daemonUsername) throw new Error('daemon_identity_unavailable');
        // Root CHECK observes the reserved account's password lock in the same
        // attended invocation as exact RunAs withdrawal. A present account step
        // is accepted only when already satisfied; retirement cannot recreate
        // a missing account or repair a foreign/changed identity.
        const steps = [...(observed ? [account] : []),
          ...buildAgentIsolationMemberRetirementSteps({ daemonUsername: daemon.daemonUsername, binaryPath: effects.installedCli, requesterIdentity })];
        const basis: MachineSetupEffectPlanV1['basis'] = { kind: 'agentIsolation', machineId: input.scope.machineId,
          enabled: true, expectedPolicy: { enabled: true }, review: { roots: [], ancestorAcls: [], sessionsToReplace: 0 } };
        const result = await runElevatedMachineSetupIntent({ machineId: input.scope.machineId, operationId: input.operationId,
          basis, steps, signal: input.signal, acceptPlan: async plan => {
            if (!current()) return false;
            if (!observed) return true;
            const locked = plan.nativeFacts.find(fact => fact.stepId === account.id);
            return locked?.status === 'satisfied' && locked.facts.uid === observed.agentUid;
          } }, { ...effects.elevation, verifyCurrent });
        nativeSettled = result.outcome === 'applied' && (accountAbsent && !binding || !!observed);
      }
    }
  } catch { /* Exact resource cleanup remains independent of native setup success. */ }
  try {
    if (!boundarySettled || !current()) return { kind: 'incomplete' };
    const cleanup = await input.cleanupOwnedWork();
    return nativeSettled && cleanup.kind === 'settled' && current() ? { kind: 'settled' } : { kind: 'incomplete' };
  } catch { return { kind: 'incomplete' }; }
}
