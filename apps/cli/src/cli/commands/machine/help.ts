import { cmd, sectionTitle } from '@happier-dev/cli-common/output';

export function showMachineHelp(): void {
  console.log([
    `${sectionTitle('happier machine')} - Set up remote machines (SSH)`,
    '',
    sectionTitle('Usage:'),
    `  ${cmd('happier machine setup --ssh <user@host> [--identity-file <path>] [--ssh-config-file <path>] [--known-hosts-path <path>] [--trusted-host-key <line>]')}`,
    `  ${cmd('happier machine setup --ssh <user@host> [--service-mode <user|none>] [--install-relay-runtime] [--relay-runtime-mode <user|system>] [--yes] [--json] [--preview|--dev|--channel stable|preview|dev]')}`,
    `  ${cmd('happier machine setup --server-url <url> [--local-server-url <url>] --ssh <user@host> [...]')}`,
    '',
    sectionTitle('Notes:'),
    '  • This is a thin wrapper over the canonical remote SSH setup task.',
    '  • Prefix --server-url/--local-server-url when you want to bootstrap a remote machine against the same Relay profile as the current CLI.',
    '  • Use --json to stream protocol event/result JSON lines.',
    '  • In interactive terminals, SSH host trust and pairing approval prompts are surfaced inline.',
    '  • Use --yes to auto-accept setup prompts in non-interactive runs.',
  ].join('\n'));
}
