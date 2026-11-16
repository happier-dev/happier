import type { MachineRecipeV1 } from '@happier-dev/plugin-sdk';

const apt = [{ name: 'docker-sbx' }];
const brew = [{ name: 'docker/tap/sbx', kind: 'formula' as const }];
// Let WinGet select its manifest's native default scope, as Docker's official
// command does; the package manager owns its selected installer and scope.
const winget = [{ name: 'Docker.sbx', source: 'winget' }];
const aptWhen: NonNullable<MachineRecipeV1['steps'][number]['when']> = [{ checkId: 'manager-apt', status: ['satisfied', 'drifted'] }];

/** Official SBX-only installation commands, verified 2026-11-16 against
 * https://docs.docker.com/ai/sandboxes/install/ . Engine/Desktop are optional. */
export const DOCKER_SANDBOXES_INSTALL_RECIPE: Omit<MachineRecipeV1, 'id'> = {
  revision: '1', title: 'Docker Sandboxes', software: true,
  description: 'Install the Docker Sandboxes CLI on this computer.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  checks: [
    { id: 'manager-apt', kind: 'package', manager: 'apt', state: 'absent', packages: apt },
    { id: 'manager-brew', kind: 'package', manager: 'brew', state: 'absent', packages: brew },
    { id: 'manager-winget', kind: 'package', manager: 'winget', state: 'absent', packages: winget },
  ],
  steps: [
    { id: 'apt-prerequisites', kind: 'package', manager: 'apt', packages: [{ name: 'ca-certificates' }, { name: 'curl' }], when: aptWhen },
    { id: 'apt-source', kind: 'script', shell: 'sh', when: aptWhen,
      review: { title: 'Docker package repository', description: 'Configure Docker’s official Ubuntu package repository. Docker Engine is not installed.' },
      body: `set -eu
. /etc/os-release
[ "$ID" = ubuntu ]
dpkg --compare-versions "$VERSION_ID" ge 24.04
installer=$(mktemp)
trap 'rm -f -- "$installer"' EXIT HUP INT TERM
curl -fsSL https://get.docker.com -o "$installer"
REPO_ONLY=1 sh "$installer"
`,
      check: { body: `set -eu
. /etc/os-release
[ "$ID" = ubuntu ] || exit 2
dpkg --compare-versions "$VERSION_ID" ge 24.04 || exit 2
apt-cache show docker-sbx >/dev/null 2>&1 || exit 1
`, unsatisfiedExitCodes: [1] } },
    { id: 'packages-apt', kind: 'package', manager: 'apt', packages: apt, when: aptWhen },
    { id: 'packages-brew', kind: 'package', manager: 'brew', packages: brew, when: [
      { checkId: 'manager-apt', status: ['packageManagerUnavailable'] },
      { checkId: 'manager-brew', status: ['satisfied', 'drifted'] },
    ] },
    { id: 'packages-winget', kind: 'package', manager: 'winget', packages: winget, when: [
      { checkId: 'manager-apt', status: ['packageManagerUnavailable'] },
      { checkId: 'manager-brew', status: ['packageManagerUnavailable'] },
      { checkId: 'manager-winget', status: ['satisfied', 'drifted'] },
    ] },
  ],
};
