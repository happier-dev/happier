import { createDockerEngineSetupSteps, dockerEnginePresenceCheck, type MachineRecipeV1 } from '@happier-dev/plugin-sdk';

function commandCheck(id: string, executable: string, args: string[], unsatisfiedExitCodes: number[] = []) {
  return { id, kind: 'command' as const, executable, args, check: { executable, args, unsatisfiedExitCodes } };
}

function distroPackages(family: 'ubuntu' | 'debian') {
  return createDockerEngineSetupSteps({ distribution: family, daemonUsername: { kind: 'targetFact', fact: 'daemon.username' }, enginePresent: false })
    .filter(step => step.kind === 'package').map(step => ({ ...step, when: [
    { checkId: 'supported-distro', status: ['satisfied' as const] },
    { checkId: 'ubuntu-family', status: [family === 'ubuntu' ? 'satisfied' as const : 'drifted' as const] },
    { checkId: dockerEnginePresenceCheck.id, status: ['drifted' as const] },
  ] }));
}

/** Distro packages only. Shared engine data has no safe automatic inverse. */
export const dockerEngine: Omit<MachineRecipeV1, 'id'> = {
  revision: '1', title: 'Docker Engine', software: true, icon: 'desktop',
  description: 'Containers, and the engine your apps deploy onto.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  checks: [
    commandCheck('supported-distro', 'grep', ['-Eq', '^ID="?(ubuntu|debian)"?$', '/etc/os-release']),
    commandCheck('ubuntu-family', 'grep', ['-Eq', '^ID="?ubuntu"?$', '/etc/os-release'], [1]),
    dockerEnginePresenceCheck,
  ],
  steps: [...distroPackages('ubuntu'), ...distroPackages('debian'),
    ...createDockerEngineSetupSteps({ distribution: 'ubuntu', daemonUsername: { kind: 'targetFact', fact: 'daemon.username' }, enginePresent: false })
      .filter(step => step.kind !== 'package')
      .map(step => ({ ...step, when: [
        { checkId: 'supported-distro', status: ['satisfied' as const] },
        ...(step.kind !== 'serviceUnit' ? [] : [
          { checkId: dockerEnginePresenceCheck.id, status: ['drifted' as const] },
        ]),
      ] })),
  ],
};
