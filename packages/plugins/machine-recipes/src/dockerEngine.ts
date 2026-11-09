import { createDockerEngineSetupSteps, dockerEnginePresenceCheck, DOCKER_ENGINE_RECIPE_REF_V1, type MachineRecipeV1 } from '@happier-dev/plugin-sdk';

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
  revision: DOCKER_ENGINE_RECIPE_REF_V1.revision, title: 'Docker Engine', software: true, icon: 'desktop',
  description: 'Containers, and the engine your apps deploy onto.',
  inputSchema: { type: 'object', properties: {
    daemonConfig: { type: 'object', description: 'Reviewed daemon settings to merge. Leave empty to preserve existing values.', properties: {
      icc: { type: 'boolean' },
      'no-new-privileges': { type: 'boolean' },
      'log-driver': { type: 'string', minLength: 1 },
      'log-opts': { type: 'object', properties: {
        'max-size': { type: 'string', minLength: 1 },
        'max-file': { type: 'string', minLength: 1 },
      }, additionalProperties: false },
    }, additionalProperties: false },
  }, required: ['daemonConfig'], additionalProperties: false },
  checks: [
    commandCheck('supported-distro', 'grep', ['-Eq', '^ID="?(ubuntu|debian)"?$', '/etc/os-release']),
    commandCheck('ubuntu-family', 'grep', ['-Eq', '^ID="?ubuntu"?$', '/etc/os-release'], [1]),
    dockerEnginePresenceCheck,
  ],
  steps: [...distroPackages('ubuntu'), ...distroPackages('debian'),
    ...createDockerEngineSetupSteps({ distribution: 'ubuntu', daemonUsername: { kind: 'targetFact', fact: 'daemon.username' }, enginePresent: false,
      daemonConfig: { kind: 'input', path: 'daemonConfig' } })
      .filter(step => step.kind !== 'package')
      .map(step => ({ ...step, when: [
        { checkId: 'supported-distro', status: ['satisfied' as const] },
      ] })),
  ],
};
