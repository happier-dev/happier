import { globalGitConfigCommand } from './globalGitConfig.js';
import { MachineRecipeStepV1Schema, type MachineRecipeStepV1 } from '@happier-dev/protocol/machines/setup/machineRecipeV1';

export function assertAgentIsolationLaunchPrincipal(input: Readonly<{ daemonUsername: string; binaryPath: string }>): void {
  // The install owner selects the managed executable (including per-stack homes).
  // Here it must remain one literal absolute sudoers command, without wildcards,
  // separators or escapes that could grant a different command.
  if (!/^\/[A-Za-z0-9_./-]+$/u.test(input.binaryPath)) {
    throw new Error('Agent launch requires a literal absolute executable path');
  }
  MachineRecipeStepV1Schema.parse({ id: 'daemon-principal', kind: 'user', username: input.daemonUsername });
}

/** Shared and member provisioning consume the install/detection/launch owner's root. */
export function buildAgentIsolationToolsRootStep(input: Readonly<{
  daemonUsername: string; daemonPrimaryGroup: string; toolsRoot: string;
}>): Extract<MachineRecipeStepV1, { kind: 'directory' }> {
  return { id: 'tools-root', kind: 'directory', path: input.toolsRoot,
    owner: input.daemonUsername, group: input.daemonPrimaryGroup, mode: 0o755 };
}

/** The same shared-account bootstrap steps; member provisioning remains daemon-owned. */
export function buildAgentIsolationBootstrapSteps(input: Readonly<{
  daemonUsername: string; daemonPrimaryGroup: string; binaryPath: string; toolsRoot: string;
}>): MachineRecipeStepV1[] {
  assertAgentIsolationLaunchPrincipal(input);
  MachineRecipeStepV1Schema.parse({ id: 'daemon-group', kind: 'group', name: input.daemonPrimaryGroup, members: [] });
  // Dedicated bootstrap and existing MI-1 consumers retain their shared account
  // until their selected-identity producer and lifecycle migrate together.
  const policy = [
    '# Happier managed Agent launch',
    `Cmnd_Alias HAPPIER_AGENT_LAUNCH = ${input.binaryPath} agent-launch`,
    'Defaults!HAPPIER_AGENT_LAUNCH umask=0002,umask_override',
    `${input.daemonUsername} ALL=(happier-agent) NOPASSWD:NOSETENV: HAPPIER_AGENT_LAUNCH`,
    '',
  ].join('\n');
  return [
    { id: 'agent-account', kind: 'user', username: 'happier-agent', home: '/var/lib/happier-agent', shell: '/usr/sbin/nologin', system: true, locked: true },
    { id: 'agent-home', kind: 'directory', path: '/var/lib/happier-agent', owner: 'happier-agent', group: 'happier-agent', mode: 0o700 },
    { id: 'workspace-group', kind: 'group', name: 'happier-workspace', members: [input.daemonUsername, 'happier-agent'] },
    { id: 'workspace-root', kind: 'directory', path: '/srv/happier', owner: input.daemonUsername, group: 'happier-workspace', mode: 0o2770 },
    buildAgentIsolationToolsRootStep(input),
    { id: 'agent-runas', kind: 'file', path: '/etc/sudoers.d/91-happier-agent', owner: 'root', group: 'root', mode: 0o440,
      content: { kind: 'literal', value: policy }, validate: 'sudoers' },
    ...[input.daemonUsername, 'happier-agent'].map(username => ({
      id: `${username}-shared-git`, kind: 'command' as const,
      ...globalGitConfigCommand(username, ['core.sharedRepository', 'group']),
      check: { ...globalGitConfigCommand(username, ['--get-regexp', '^core.sharedRepository$', '^group$']), unsatisfiedExitCodes: [1] },
    })),
  ];
}
