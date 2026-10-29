import { renderHelpPage } from '@happier-dev/cli-common/output';

export function showMachineHelp(): void {
  console.log(renderHelpPage({
    title: 'happier machine',
    subtitle: 'Set up remote machines (SSH)',
    usage: [
      { label: 'happier machine enroll --ssh <user@host> [--ssh-port <number>] [--ssh-auth=agent|keyfile|password] [--identity-file <path>] [--ssh-config-file <path>] [--known-hosts-path <path>] [--trusted-host-key <line>]', description: 'Connect a remote machine to the selected Home' },
      { label: 'happier machine enroll --ssh-user <user> --ssh-host <host> [--ssh-port <number>] [--ssh-auth=agent|keyfile|password] [--identity-file <path>] [--ssh-config-file <path>] [--known-hosts-path <path>] [--trusted-host-key <line>]', description: 'Bootstrap a remote machine with split SSH fields' },
      { label: 'happier machine enroll --ssh <user@host> [--ssh-port <number>] [--ssh-auth=agent|keyfile|password] [--identity-file <path>] [--ssh-config-file <path>] [--known-hosts-path <path>] [--trusted-host-key <line>] [--service-mode <user|none>] [--install-relay-runtime] [--relay-runtime-mode <user|system>] [--require-local-approval] [--yes] [--json] [--preview|--dev|--channel stable|preview|dev]', description: 'Advanced/operator setup, including optional generic Relay runtime installation' },
      { label: 'happier machine enroll --server-url <url> [--local-server-url <url>] --ssh <user@host> [...]', description: 'Compatibility URL form for a specific Home profile' },
      { label: 'happier machine enroll --home <saved>|--home-url <url>|--home-descriptor-file <path|-> --ssh <user@host> [...]', description: 'Target a saved, HTTPS, or Iroh-only Home' },
    ],
    notes: [
      'This is a thin wrapper over the canonical remote SSH setup task.',
      'Use --home, --home-url, or --home-descriptor-file to target a Home. Global --server and URL flags remain available as compatibility aliases.',
      'Descriptor-selected Homes always require trusted local approval. Use --require-local-approval to apply the same rule to generic URL-only compatibility setup.',
      '--install-relay-runtime is an advanced generic runtime option; it never creates or converts a Personal Home.',
      'Use --json to stream protocol event/result JSON lines.',
      'In interactive terminals, SSH host trust, SSH password, and pairing approval prompts are surfaced inline.',
      'Use --yes to accept setup prompts in non-interactive runs: it trusts a first-use SSH host (never a changed host key), approves pairing, and replaces conflicting background services on the remote host. Add --service-mode none to leave those services untouched.',
    ],
  }));
}
