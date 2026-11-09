import type { MachineRecipeV1 } from '@happier-dev/plugin-sdk';
import { packageSelection } from './packageSelection.js';

const input = (path: string) => ({ kind: 'input' as const, path });
const packages = packageSelection({ apt: [{ name: 'fail2ban' }, { name: 'python3-systemd' }],
  dnf: [{ name: 'fail2ban-server' }, { name: 'python3-systemd' }] });
// Fail2ban 1.0/1.1 jail.conf owns recidive's log source and all-port action.
// Inherit it, including distro/local overrides; its default logs are files.
const content = { kind: 'template' as const, value: `[happier-sshd]
enabled=true
filter=sshd
backend=systemd
port={port}
maxretry={maxRetry}
findtime={findTime}
bantime={banTime}

[happier-recidive]
enabled=true
filter=recidive[_jailname="happier-sshd"]
backend=%(recidive/backend)s
logpath=%(recidive/logpath)s
banaction=%(recidive/banaction)s
maxretry={recidiveMaxRetry}
findtime={recidiveFindTime}
bantime={recidiveBanTime}
`, variables: Object.fromEntries(['port', 'maxRetry', 'findTime', 'banTime', 'recidiveMaxRetry', 'recidiveFindTime', 'recidiveBanTime']
  .map(name => [name, input(name)])) };
const probe = { kind: 'fail2ban' as const, jails: {
  'happier-sshd': { maxRetry: input('maxRetry'), findTimeSeconds: input('findTime'), banTimeSeconds: input('banTime'), port: input('port') },
  'happier-recidive': { maxRetry: input('recidiveMaxRetry'), findTimeSeconds: input('recidiveFindTime'), banTimeSeconds: input('recidiveBanTime') },
} };
const file = { id: 'ssh-jails', kind: 'file' as const, path: '/etc/fail2ban/jail.d/happier-sshd.local', owner: 'root', group: 'root', mode: 0o644,
  requiredFacts: [{ kind: 'init' as const, system: 'systemd' as const }], onChange: { serviceStepId: 'fail2ban-service', action: 'restart' as const } };
const service = { id: 'fail2ban-service', kind: 'serviceUnit' as const, unit: 'fail2ban.service', enabled: true, running: true,
  requiredFacts: [{ kind: 'init' as const, system: 'systemd' as const }] };
const positiveInteger = { type: 'integer' as const, minimum: 1, maximum: Number.MAX_SAFE_INTEGER };

export const sshFail2ban = {
  revision: '1', title: 'SSH bans',
  description: 'Watch failed SSH logins and repeated bans while public SSH remains open. Review every retry and time window.',
  appliesWhen: { posture: 'publicSshOpen' },
  inputSchema: { type: 'object', properties: {
    port: { type: 'integer', minimum: 1, maximum: 65535 }, maxRetry: positiveInteger, findTime: positiveInteger, banTime: positiveInteger,
    recidiveMaxRetry: positiveInteger, recidiveFindTime: positiveInteger, recidiveBanTime: positiveInteger,
  }, required: ['port', 'maxRetry', 'findTime', 'banTime', 'recidiveMaxRetry', 'recidiveFindTime', 'recidiveBanTime'], additionalProperties: false },
  checks: packages.checks,
  steps: [...packages.steps!, { ...file, content, validate: probe, probe }, service],
  removeSteps: [{ ...file, state: 'absent', expectedContentDigest: { kind: 'renderedContent', content }, validate: probe }, service],
} satisfies Omit<MachineRecipeV1, 'id'>;
