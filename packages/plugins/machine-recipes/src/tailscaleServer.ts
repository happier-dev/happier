import { createTailscaleJoinSteps, machineConnectorCredentialDirectory,
  SharedSavedSecretReferenceSelectionV1Schema, type MachineRecipeV1 } from '@happier-dev/plugin-sdk';

const requiredFacts = [{ kind: 'init' as const, system: 'systemd' as const }];
const input = (path: string) => ({ kind: 'input' as const, path });
const credentialFile = { kind: 'targetFact' as const, fact: 'invocation.credentialFile' as const };
// Vendor-native keyring endpoints verified together, not inferred across distros.
// https://pkgs.tailscale.com/stable/ (2026-11-09)
const distributions = [
  { id: 'ubuntu-noble', os: 'ubuntu', release: 'noble' },
  { id: 'ubuntu-jammy', os: 'ubuntu', release: 'jammy' },
  { id: 'debian-bookworm', os: 'debian', release: 'bookworm' },
  { id: 'debian-trixie', os: 'debian', release: 'trixie' },
] as const;
const sources = distributions.flatMap(({ id, os, release }) => {
  const when = [{ input: { op: 'eq' as const, path: 'distribution', value: id } }];
  const nativeField = (field: string, value: string) => {
    const args = ['-Ex', `${field}=(${value}|"${value}"|'${value}')`, '/etc/os-release'];
    return { id: `${id}-${field.toLowerCase()}`, kind: 'command' as const, executable: 'grep', args,
      requiredFacts, when, check: { executable: 'grep', args, unsatisfiedExitCodes: [] } };
  };
  return [nativeField('ID', os), nativeField('VERSION_CODENAME', release),
    { id: `${id}-source`, kind: 'packageSource' as const, manager: 'apt' as const, requiredFacts, when,
      path: '/etc/apt/sources.list.d/tailscale.list', keyPath: '/usr/share/keyrings/tailscale-archive-keyring.gpg',
      url: `https://pkgs.tailscale.com/stable/${os}`, suite: release, components: ['main'], architectures: ['amd64', 'arm64'],
      keyUrl: `https://pkgs.tailscale.com/stable/${os}/${release}.noarmor.gpg`,
      keyFingerprint: '2596A99EAAB33821893C0A79458CA832957F5868' }];
});

export const tailscaleServer = {
  revision: '1', title: 'Tailscale server',
  description: 'Install the signed vendor package, disconnect the current profile and authenticate with the selected saved key. No exit node or advertised routes.',
  inputSchema: { type: 'object', properties: {
    distribution: { type: 'string', enum: distributions.map(distribution => distribution.id) },
    joinCredential: SharedSavedSecretReferenceSelectionV1Schema.jsonSchema,
    setOperator: { type: 'boolean' },
  }, required: ['distribution', 'joinCredential', 'setOperator'], additionalProperties: false },
  inputHints: { fields: [{ path: 'joinCredential', title: 'Tailscale setup key', widget: 'select', required: true,
    inputType: { hostType: 'savedSecretReference' } }] },
  steps: [...sources,
    { id: 'tailscale-package', kind: 'package', manager: 'apt', packages: [{ name: 'tailscale' }], requiredFacts },
    { id: 'tailscale-service', kind: 'serviceUnit', unit: 'tailscaled.service', enabled: true, running: true, requiredFacts },
    { ...machineConnectorCredentialDirectory, requiredFacts },
    { id: 'tailscale-credential', kind: 'file', path: credentialFile, owner: 'root', group: 'root', mode: 0o600,
      lifetime: 'invocation', content: { kind: 'secretGrant', credentialSelection: {
        provider: { kind: 'builtin', id: 'tailscale' }, config: {},
        credentialRefs: [{ purpose: 'network.join', credentialRef: { kind: 'savedSecret',
          ref: input('joinCredential.ref'), resourceRevision: input('joinCredential.resourceRevision') } }],
      } }, requiredFacts },
    ...createTailscaleJoinSteps({ credentialFile, credentialInputPath: 'joinCredential', switchNetworkInputPath: 'joinCredential' })
      .map(step => ({ ...step, requiredFacts })),
  ],
} satisfies Omit<MachineRecipeV1, 'id'>;
