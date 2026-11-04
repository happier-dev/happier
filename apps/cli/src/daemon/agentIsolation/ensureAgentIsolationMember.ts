import { createMachineSetupNativeBackend } from '@happier-dev/cli-common/machineSetup';
import type { AgentIsolationEffectDependencies, ApplyAgentIsolationMemberEffectsResult } from '@/daemon/agentIsolation/agentIsolationProvisioner';
import type { AgentIsolationMemberRequester } from '@/daemon/agentIsolation/provisioning';
import { readAgentIsolationMemberLaunchIdentity } from './memberBindings';
import { readAgentIsolationMemberWorkspaceRoot } from './agentIsolationNativeIdentity';
import { observeAgentIsolationMemberLaunchReadiness } from './agentIsolationReadiness';

export type EnsureAgentIsolationMemberInput = Readonly<{
  /** Selected by verified admission before this operation. Profile ids do not qualify Home. */
  requesterIdentity: AgentIsolationMemberRequester;
  activeServerDir: string;
  signal?: AbortSignal;
  /** Local operation/installation/cancellation custody only. No repeated Home admission. */
  verifyLocalCustody(): Promise<boolean>;
  /** Bound only by createAgentIsolationMemberOperations to its existing Action,
   * setup task, transient prompt and machineSetup native admission. Every
   * failed native qualification idempotently repairs state before payload dispatch. */
  setup(): Promise<ApplyAgentIsolationMemberEffectsResult>;
}>;
export type EnsureAgentIsolationMemberResult = Extract<ApplyAgentIsolationMemberEffectsResult, { kind: 'not_ready' }>
  | (Extract<ApplyAgentIsolationMemberEffectsResult, { kind: 'ready' }> & Readonly<{
    repaired?: true;
  }>);

/** Existing P11 provisioner owner, re-exported from agentIsolationProvisioner.
 * A ready result is one observed native identity; effective launch still
 * belongs to the fixed RunAs/agent-launch boundary.
 */
export async function ensureAgentIsolationMember(input: EnsureAgentIsolationMemberInput,
  effects: AgentIsolationEffectDependencies): Promise<EnsureAgentIsolationMemberResult> {
  const refused = (reasonCode: 'cancelled' | 'plan_stale' | 'denied' | 'mode_none'): EnsureAgentIsolationMemberResult =>
    ({ kind: 'not_ready', result: { outcome: 'not_applied', reasonCode } });
  try {
    const { requesterIdentity } = input;
    if (requesterIdentity.requester.installationId !== effects.elevation.installationId) return refused('plan_stale');
    if (input.signal?.aborted) return refused('cancelled');
    if (!await input.verifyLocalCustody()) return refused('plan_stale');
    if (effects.platform !== 'linux') return { kind: 'not_ready', result: { outcome: 'not_applied', reasonCode: 'platform_unsupported' } };
    const daemonObservation = effects.readDaemonObservation?.();
    if (daemonObservation) {
      try {
        const backend = effects.backend ?? createMachineSetupNativeBackend({ signal: input.signal });
        const identity = await readAgentIsolationMemberLaunchIdentity({ requesterIdentity,
          activeServerDir: input.activeServerDir, signal: input.signal }, backend);
        await readAgentIsolationMemberWorkspaceRoot(identity, backend, { daemonObservation, signal: input.signal });
        const readiness = await observeAgentIsolationMemberLaunchReadiness({ installedCli: effects.installedCli,
          memberIdentity: identity, signal: input.signal, system: effects.nativeReadiness?.system });
        if (readiness.kind === 'member_native_ready') {
          return { kind: 'ready', identity, daemonObservation };
        }
      } catch {
        if (input.signal?.aborted) return refused('cancelled');
        // Missing identity/binding/workspace or effective RunAs permission uses
        // the existing P10 mutation owner, never a separate repair path.
      }
    }
    if (input.signal?.aborted) return refused('cancelled');
    const prepared = await input.setup();
    if (prepared.kind !== 'ready') return prepared;
    const readiness = await observeAgentIsolationMemberLaunchReadiness({ installedCli: effects.installedCli,
      memberIdentity: prepared.identity, signal: input.signal, system: effects.nativeReadiness?.system });
    return readiness.kind === 'member_native_ready' ? { ...prepared, repaired: true } : refused('denied');
  } catch { return refused(input.signal?.aborted ? 'cancelled' : 'denied'); }
}
