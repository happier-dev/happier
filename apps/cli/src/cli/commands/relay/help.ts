import { renderHelpPage } from '@happier-dev/cli-common/output';

export function showRelayHelp(): void {
  console.log(renderHelpPage({
    title: 'happier relay',
    subtitle: 'Relay profile management',
    usage: [
      { label: 'happier relay inspect-target [--json]', description: 'Show the resolved active relay target' },
      { label: 'happier relay set <relay-url> [--use] [--json] [--server-url <url>] [--webapp-url <url>] [--local-server-url <url>] [--name <name>]', description: 'Save or activate a relay profile' },
      { label: 'happier relay host <install|status|start|stop|restart|uninstall> [--ssh <user@host>] [--ssh-user <user> --ssh-host <host>] [--ssh-auth agent|keyfile|password] [--identity-file <path>] [--ssh-config-file <path>] [--known-hosts-path <path>] [--trusted-host-key <line>] [--ssh-port <number>] [--mode user|system] [--channel stable|preview|dev] [--env KEY=VALUE]... [--yes] [--json]', description: 'Manage a hosted relay runtime' },
      { label: 'happier relay access <status|configure|disable> [--ssh <user@host>] [--upstream-url <url>] [--provider <provider-id>] [--url <url>] [--hostname <hostname>] [--token <token>] [--yes] [--json]', description: 'Manage relay access method config (share URL strategy)' },
    ],
    notes: [
      'Detailed relay profile management remains under `happier server ...` for now.',
    ],
  }));
}
