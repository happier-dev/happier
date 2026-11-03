import { createHash } from 'node:crypto';
import type { AgentIsolationEffectPlanV1 } from '@happier-dev/protocol';
import type { MachineRecipeStepV1, MachineSetupEffectPlanV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import { buildAgentIsolationProvisioningSteps } from './provisioning';

type Retirement = NonNullable<AgentIsolationEffectPlanV1['retirement']>;

/** Inventory comes from the bootstrap producer, including useradd's implicit
 * primary group. This program is CHECK-only; only exact removable files enter APPLY. */
export function buildAgentIsolationBootstrapRetirementObservations(input: Readonly<{
  daemonUsername: string; daemonPrimaryGroup: string; binaryPath: string;
}>): MachineRecipeStepV1[] {
  return buildAgentIsolationProvisioningSteps(input).flatMap((step): MachineRecipeStepV1[] => {
    if (step.kind === 'file' && step.content?.kind === 'literal') return [{ id: step.id, kind: 'file',
      path: step.path, owner: step.owner, group: step.group, mode: step.mode, state: 'absent',
      expectedContentDigest: createHash('sha256').update(step.content.value).digest('hex') }];
    return step.kind === 'user' ? [step, { id: 'agent-primary-group', kind: 'group', name: step.username, members: [] }] : [step];
  });
}

/** Native CHECK owns presence and exact-file safety. Legacy bootstrap did not
 * record prior ownership/configuration, so retirement never guesses those values. */
export function projectAgentIsolationBootstrapRetirement(plan: MachineSetupEffectPlanV1): Retirement {
  return plan.steps.map((step, index): Retirement[number] => {
    const fact = plan.nativeFacts[index];
    const base = { stepId: step.id, kind: step.kind, target: 'path' in step ? step.path
      : step.kind === 'user' ? step.username : step.kind === 'group' ? step.name
        : step.kind === 'command' ? [step.executable, ...step.args].join(' ') : step.id };
    const absent = fact?.facts.present === false || fact?.facts.kind === 'absent'
      || step.kind === 'file' && step.state === 'absent' && fact?.status === 'satisfied'
      || step.kind === 'command' && fact?.status === 'drifted';
    if (absent) return { ...base, observation: 'absent', action: 'none' };
    const observation = fact?.facts.present === true || fact?.facts.kind === 'file' || fact?.facts.kind === 'directory'
      || fact?.status === 'satisfied' || fact?.status === 'drifted' ? 'present' : 'unknown';
    if (step.kind === 'file' && step.state === 'absent' && fact?.status === 'drifted')
      return { ...base, observation, action: 'remove' };
    if (!fact || fact.status === 'unavailable' || fact.status === 'unsupported') return { ...base, observation, action: 'retain',
      reasonCode: fact?.reason === 'foreign_effect_conflict' ? 'foreign_effect_conflict' : 'native_check_unavailable',
      remedy: 'Have an administrator inspect this resource and its ownership, then retry the review. Changed or foreign resources are not removed.' };
    if (step.kind === 'user' || step.kind === 'group') return { ...base, observation, action: 'retain', reasonCode: 'ownership_unproven',
      remedy: 'Legacy bootstrap recorded no exclusive ownership of this identity. Have an administrator verify its users, processes and retained files before removing it.' };
    if (step.kind === 'directory') return { ...base, observation, action: 'retain',
      reasonCode: step.id === 'tools-root' ? 'shared_resource' : 'authored_data',
      remedy: step.id === 'tools-root' ? 'Managed tools are shared with other Happier features. Keep this directory while those features use it.'
        : 'Back up and inspect retained home or workspace files before an administrator removes the directory; disabling isolation never deletes authored data.' };
    return { ...base, observation, action: 'retain', reasonCode: 'prior_value_unknown',
      remedy: 'Bootstrap did not retain the previous permission or Git configuration. Have an administrator review current users and restore the intended value explicitly.' };
  });
}
