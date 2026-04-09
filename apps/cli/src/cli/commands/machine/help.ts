import { renderHelpPage } from '@happier-dev/cli-common/output';

export function showMachineHelp(): void {
  console.log(renderHelpPage({
    title: 'happier machine',
    subtitle: 'Set up remote machines (SSH)',
    usage: [
      { label: 'happier machine setup --ssh <user@host> [--ssh-port <number>] [--ssh-auth=agent|keyfile|password] [--identity-file <path>] [--ssh-config-file <path>] [--known-hosts-path <path>] [--trusted-host-key <line>]', description: 'Bootstrap a remote machine' },
      { label: 'happier machine setup --ssh-user <user> --ssh-host <host> [--ssh-port <number>] [--ssh-auth=agent|keyfile|password] [--identity-file <path>] [--ssh-config-file <path>] [--known-hosts-path <path>] [--trusted-host-key <line>]', description: 'Bootstrap a remote machine with split SSH fields' },
      { label: 'happier machine setup --ssh <user@host> [--ssh-port <number>] [--ssh-auth=agent|keyfile|password] [--identity-file <path>] [--ssh-config-file <path>] [--known-hosts-path <path>] [--trusted-host-key <line>] [--service-mode <user|none>] [--install-relay-runtime] [--relay-runtime-mode <user|system>] [--require-local-approval] [--yes] [--json] [--preview|--dev|--channel stable|preview|dev]', description: 'Bootstrap + optionally install the hosted server runtime and background service' },
      { label: 'happier machine setup --server-url <url> [--local-server-url <url>] --ssh <user@host> [...]', description: 'Bootstrap a remote machine against a specific server profile' },
    ],
    notes: [
      'This is a thin wrapper over the canonical remote SSH setup task.',
      'Prefix --server-url/--local-server-url when you want to bootstrap a remote machine against the same server profile as the current CLI.',
      'Use --require-local-approval to fail closed when the current CLI cannot approve the remote pairing request.',
      'Use --json to stream protocol event/result JSON lines.',
      'In interactive terminals, SSH host trust, SSH password, and pairing approval prompts are surfaced inline.',
      'Use --yes to auto-accept setup prompts in non-interactive runs.',
    ],
  }));
}
