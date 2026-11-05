import { createDockerMembershipStep, type MachineRecipeV1 } from '@happier-dev/plugin-sdk';
import { packageSelection } from './packageSelection.js';

const dockerCheck = `[ "$(uname -s)" = Linux ] || exit 2
command -v docker >/dev/null 2>&1 || exit 1
docker info >/dev/null 2>&1 || exit 1
`;
const readiness = { kind: 'script' as const, shell: 'sh' as const, body: 'docker info >/dev/null\n',
  affects: 'none' as const, check: { body: dockerCheck, unsatisfiedExitCodes: [1] } };

function commandCheck(id: string, executable: string, args: string[], unsatisfiedExitCodes: number[] = []) {
  return { id, kind: 'command' as const, executable, args, check: { executable, args, unsatisfiedExitCodes } };
}

function distroPackages(family: 'ubuntu' | 'debian') {
  const selected = packageSelection({ apt: [
    { name: 'docker.io' }, { name: 'docker-buildx' },
    { name: family === 'ubuntu' ? 'docker-compose-v2' : 'docker-compose' },
  ] });
  const steps = selected.steps.map(step => ({ ...step, id: `${family}-${step.id}`, when: [
    { checkId: 'supported-distro', status: ['satisfied' as const] },
    { checkId: 'ubuntu-family', status: [family === 'ubuntu' ? 'satisfied' as const : 'drifted' as const] },
    ...(step.when ?? []).map(condition => 'checkId' in condition
      ? { ...condition, checkId: `${family}-${condition.checkId}` } : condition),
  ] }));
  return {
    checks: (selected.checks ?? []).map(check => ({ ...check, id: `${family}-${check.id}` })),
    steps: steps.flatMap(step => [step, { ...readiness, id: `${family}-docker-ready`, when: step.when }]),
  };
}
const ubuntu = distroPackages('ubuntu');
const debian = distroPackages('debian');

/** Distro packages only. Shared engine data has no safe automatic inverse. */
export const dockerEngine: Omit<MachineRecipeV1, 'id'> = {
  revision: '1', title: 'Docker Engine', software: true, icon: 'desktop',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  checks: [
    commandCheck('supported-distro', 'grep', ['-Eq', '^ID="?(ubuntu|debian)"?$', '/etc/os-release']),
    commandCheck('ubuntu-family', 'grep', ['-Eq', '^ID="?ubuntu"?$', '/etc/os-release'], [1]),
    ...ubuntu.checks, ...debian.checks,
  ],
  steps: [...ubuntu.steps, ...debian.steps,
    { ...createDockerMembershipStep({ kind: 'targetFact', fact: 'daemon.username' }),
      when: [{ checkId: 'supported-distro', status: ['satisfied'] }] },
  ],
};
