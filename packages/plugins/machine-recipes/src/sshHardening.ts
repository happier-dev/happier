import type { MachineRecipeV1 } from '@happier-dev/plugin-sdk';

const input = (path: string) => ({ kind: 'input' as const, path });
const port = { kind: 'template' as const, value: '{port}', variables: { port: input('currentPort') } };
const context = { user: input('administrator.username'), host: input('administrator.host'), address: input('administrator.address') };
const expected = { authenticationmethods: 'publickey', pubkeyauthentication: 'yes', passwordauthentication: 'no',
  permitrootlogin: 'no', permitemptypasswords: 'no', kbdinteractiveauthentication: 'no', disableforwarding: 'yes',
  allowtcpforwarding: 'no', allowagentforwarding: 'no', x11forwarding: 'no', permittunnel: 'no', port };
const probe = { kind: 'sshd' as const, contexts: [{ ...context, expected }, { ...context, user: 'root', expected }] };
const removalProbe = { kind: 'sshd' as const, contexts: [{ ...context, expected: { pubkeyauthentication: 'yes', port } }] };
const content = { kind: 'literal' as const, value: `# Happier SSH hardening
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
PermitRootLogin no
PermitEmptyPasswords no
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
DisableForwarding yes
AllowTcpForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
` };
const file = { id: 'ssh-policy', kind: 'file' as const, path: '/etc/ssh/sshd_config.d/00-happier-hardening.conf',
  owner: 'root', group: 'root', mode: 0o644, onChange: { serviceStepId: 'ssh-service', action: 'reload' as const },
  requiredFacts: [{ kind: 'init' as const, system: 'systemd' as const }] };
const service = { id: 'ssh-service', kind: 'serviceUnit' as const, unit: input('sshServiceUnit'), running: true,
  requiredFacts: [{ kind: 'init' as const, system: 'systemd' as const }] };

/** The native owner proves Include ordering, candidate validity and effective policy. */
export const sshHardening: Omit<MachineRecipeV1, 'id'> = {
  revision: '1', title: 'SSH hardening',
  description: 'Key-only administrator access, no root login or forwarding. Keep the current SSH port and the platform PAM policy.',
  inputSchema: { type: 'object', properties: {
    administrator: { type: 'object', properties: {
      username: { type: 'string', pattern: '^(?!root$)[a-zA-Z_][a-zA-Z0-9_.-]*[$]?$(?![\\s\\S])' },
      host: { type: 'string', minLength: 1, pattern: '^[^,\\r\\n\\u0000]+$(?![\\s\\S])' },
      address: { type: 'string', minLength: 1, pattern: '^[^,\\r\\n\\u0000]+$(?![\\s\\S])' },
    }, required: ['username', 'host', 'address'], additionalProperties: false },
    currentPort: { type: 'integer', minimum: 1, maximum: 65535 },
    sshServiceUnit: { type: 'string', enum: ['ssh.service', 'sshd.service'] },
  }, required: ['administrator', 'currentPort', 'sshServiceUnit'], additionalProperties: false },
  steps: [{ ...file, content, validate: probe, probe }, service],
  removeSteps: [{ ...file, state: 'absent', expectedContentDigest: { kind: 'renderedContent', content },
    validate: removalProbe }, service],
};
