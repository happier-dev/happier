

export { buildUserManagerGroupRefreshStep } from '@happier-dev/cli-common/systemTasks/nativeRemoteSshBootstrap';

import { readFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { buildUserManagerGroupRefreshStep, machineSetupStepChangesDaemonGroupsV1 } from '@happier-dev/cli-common/machineSetup';
import { planServiceAction } from '@happier-dev/cli-common/service';
import type { MachineSetupEffectPlanV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';
import type { MachineSetupSessionRefreshV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { resolveDaemonServiceLabelFromEnv } from '../ownership/daemonOwnershipMetadata';

/** OS boundaries only; Plan and Apply share this lifecycle observation. */
export type DaemonGroupRefreshNative = Readonly<{
  platform?: NodeJS.Platform;
  user?: Readonly<{ username: string; uid: number }>;
  groups?: readonly number[];
  serviceLabel?: string;
  readCgroup?: () => Promise<string>;
}>;

export async function readMachineSetupSessionRefreshRequirement(
  plans: readonly MachineSetupEffectPlanV1[], native: DaemonGroupRefreshNative = {}, changed = false,
): Promise<MachineSetupSessionRefreshV1 | undefined> {
  if (!plans.some(plan => plan.steps.some(step => step.kind === 'group' || step.kind === 'user' && step.supplementaryGroups !== undefined))) return;
  const user = native.user ?? userInfo();
  const groups = native.groups ?? [...(process.getgroups?.() ?? []), ...(process.getgid ? [process.getgid()] : [])];
  const required = plans.some(plan => plan.steps.some((step, index) => {
    if (!machineSetupStepChangesDaemonGroupsV1(step, user.username)) return false;
    const fact = plan.nativeFacts[index];
    if (fact?.status !== 'satisfied' && fact?.status !== 'drifted') return changed;
    // An earlier Apply may already have changed /etc/group while this process
    // and its user manager still hold their original kernel credentials.
    if (step.kind === 'group' && typeof fact.facts.gid === 'number') {
      return groups.includes(fact.facts.gid) !== (step.state !== 'absent');
    }
    const expected = fact.facts.desiredSupplementaryGroupIds;
    if (!Array.isArray(expected)) return fact.status === 'drifted' || changed;
    return expected.some(gid => typeof gid === 'number'
      ? !groups.includes(gid) : !groups.includes(Number(gid)))
      || groups.some(gid => gid !== fact.facts.gid && !expected.some(value => Number(value) === gid));
  }));
  if (!required) return;
  const base = { kind: 'requiresSessionRefresh' as const, username: user.username };
  if ((native.platform ?? process.platform) === 'linux') {
    const cgroup = await (native.readCgroup ?? (() => readFile('/proc/self/cgroup', 'utf8')))().catch(() => '');
    const paths = cgroup.split('\n').map(line => line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1).split('/'));
    if (user.uid > 0 && paths.some(parts => parts.includes(`user@${user.uid}.service`))) {
      const step = buildUserManagerGroupRefreshStep(user);
      return { ...base, scope: 'userServices', requiresAdministrator: true,
        command: { executable: step.executable, args: step.args } };
    }
    // The ownership marker uses the launchd label on every platform. The
    // kernel cgroup supplies the actual systemd unit, including custom slices.
    const serviceLabel = native.serviceLabel ?? resolveDaemonServiceLabelFromEnv();
    const unit = serviceLabel ? paths.map(parts => parts.at(-1)).find(name => name?.endsWith('.service')) : undefined;
    if (unit) {
      const command = planServiceAction({ backend: 'systemd-system', action: 'restart', label: unit.slice(0, -'.service'.length) }).commands[0]!;
      return { ...base, scope: 'daemonService', requiresAdministrator: true,
        command: { executable: command.cmd, args: [...command.args] } };
    }
  }
  return { ...base, scope: 'loginSession', requiresAdministrator: false };
}

export function describeMachineSetupSessionRefresh(step: MachineSetupSessionRefreshV1): string {
  if (step.scope === 'loginSession') return `Group membership changed. Start the daemon from a fresh login session for ${step.username}.`;
  const command = [step.command!.executable, ...step.command!.args].join(' ');
  return `Group membership changed. An administrator must run ${command}. ${step.scope === 'userServices'
    ? 'This restarts all services in the user manager, including the daemon.' : 'This restarts the daemon service.'} Review a new Software Plan after reconnecting.`;
}
