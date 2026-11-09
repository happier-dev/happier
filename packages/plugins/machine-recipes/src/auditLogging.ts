import type { MachineRecipeV1 } from '@happier-dev/plugin-sdk';
import { packageSelection } from './packageSelection.js';

const packages = packageSelection({ apt: [{ name: 'auditd' }], dnf: [{ name: 'audit' }] });
const key = 'happier-host-security';
const paths = ['/etc/passwd', '/etc/group', '/etc/shadow', '/etc/ssh/sshd_config', '/etc/sudoers'];
const rules = paths.map(path => `-w ${path} -p wa -k ${key}`);
const content = { kind: 'literal' as const, value: `${rules.join('\n')}\n` };
const file = { id: 'audit-policy', kind: 'file' as const, path: '/etc/audit/rules.d/happier-host-security.rules',
  owner: 'root', group: 'root', mode: 0o600, requiredFacts: [{ kind: 'init' as const, system: 'systemd' as const }] };

export const auditLogging = {
  revision: '1', title: 'Audit logging',
  description: 'Audit changes to host accounts, SSH and sudo policy. Existing audit rules remain in place.',
  inputSchema: { type: 'object', properties: {
    profile: { type: 'string', enum: ['host-security'] },
  }, required: ['profile'], additionalProperties: false },
  checks: packages.checks,
  steps: [...packages.steps!,
    { id: 'audit-kernel', kind: 'command', executable: 'auditctl', args: ['-s'],
      requiredFacts: [{ kind: 'init', system: 'systemd' }],
      check: { executable: 'auditctl', args: ['-s'], unsatisfiedExitCodes: [] } },
    { ...file, content },
    { id: 'audit-service', kind: 'serviceUnit', unit: 'auditd.service', enabled: true, running: true, requiredFacts: file.requiredFacts },
    { id: 'audit-load', kind: 'command', executable: 'augenrules', args: ['--load'], check: { kind: 'audit', rules }, requiredFacts: file.requiredFacts },
  ],
  removeSteps: [{ ...file, state: 'absent', expectedContentDigest: { kind: 'renderedContent', content } },
    ...paths.map((path, index) => ({ id: `audit-remove-${index}`, kind: 'command' as const, executable: 'auditctl',
      args: ['-W', path, '-p', 'wa', '-k', key], check: { kind: 'audit' as const, rules: [rules[index]!], state: 'absent' as const }, requiredFacts: file.requiredFacts })),
  ],
} satisfies Omit<MachineRecipeV1, 'id'>;
