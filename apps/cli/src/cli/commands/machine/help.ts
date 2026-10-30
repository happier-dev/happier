import chalk from 'chalk';

export function showMachineHelp(): void {
  console.log(`
${chalk.bold('happier machine')} - Bootstrap and manage remote machines

${chalk.bold('Usage:')}
  happier machine list [--json]
  happier machine setup --ssh <user@host> [--identity-file <path>] [--ssh-config-file <path>] [--known-hosts-path <path>] [--trusted-host-key <line>]
  happier machine setup --ssh <user@host> [--server <name-or-id> | --server-url <url> [--webapp-url <url>] [--public-server-url <url>]]
  happier machine setup --ssh <user@host> [--service-mode <user|none>] [--install-relay-runtime] [--relay-runtime-mode <user|system>] [--yes] [--json]

${chalk.bold('Commands:')}
  list                List all registered machines for the current account
  setup               Bootstrap a remote machine via SSH

${chalk.bold('Notes:')}
  • list: Shows all registered machines and their status (active/inactive)
  • setup: Thin wrapper over the canonical remote SSH bootstrap task
  • Use --json to output structured JSON for machine list or to stream protocol event/result JSON lines for setup
  • In interactive terminals, SSH host trust and pairing approval prompts are surfaced inline
  • Use --yes to auto-accept setup prompts in non-interactive runs
  `);
}
