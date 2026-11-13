import type { MachineRecipeV1 } from '@happier-dev/plugin-sdk';

// Official package installer and v2.39.0 CLI contract checked 2026-11-13.
// Download to a file: a failed transfer must never look like a successful pipe.
export const coder: Omit<MachineRecipeV1, 'id'> = {
  revision: '1', title: 'Coder', software: true, icon: 'desktop',
  description: 'Host a Coder server for your development workspaces.',
  inputSchema: { type: 'object', properties: {
    accessUrl: { type: 'string', pattern: '^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$' },
  }, required: ['accessUrl'], additionalProperties: false },
  inputHints: { fields: [{ path: 'accessUrl', title: 'External HTTPS URL', widget: 'url', required: true }] },
  steps: [
    { id: 'install', kind: 'script', shell: 'sh', affects: { services: ['coder.service'] },
      requiredFacts: [{ kind: 'init', system: 'systemd' }],
      body: `set -eu
command -v apt-get >/dev/null
installer=$(mktemp)
trap 'rm -f -- "$installer"' EXIT HUP INT TERM
curl -fsSL https://raw.githubusercontent.com/coder/coder/v2.39.0/install.sh -o "$installer"
sh "$installer" --version 2.39.0
`,
      check: { body: `set -eu
command -v coder >/dev/null 2>&1 || exit 1
coder version | grep -Eq '^Coder v2\\.39\\.0([ +]|$)'
`, unsatisfiedExitCodes: [1] } },
    { id: 'config', kind: 'file', path: '/etc/coder.d/coder.env', owner: 'root', group: 'root', mode: 0o600,
      content: { kind: 'template', value: 'CODER_ACCESS_URL={accessUrl}\nCODER_HTTP_ADDRESS=127.0.0.1:3000\n',
        variables: { accessUrl: { kind: 'input', path: 'accessUrl' } } },
      onChange: { serviceStepId: 'server', action: 'restart' } },
    { id: 'docker-access', kind: 'group', name: 'docker', members: ['coder'], existingOnly: true,
      review: { title: 'Docker workspace host', description: 'Install Docker Engine first. The Coder service can create and manage containers on this Machine.' } },
    { id: 'server', kind: 'serviceUnit', unit: 'coder.service', enabled: true, running: true },
  ],
  // Retain all server/workspace data and the package. Destruction stays explicit.
  removeSteps: [{ id: 'server', kind: 'serviceUnit', unit: 'coder.service', enabled: false, running: false }],
};
