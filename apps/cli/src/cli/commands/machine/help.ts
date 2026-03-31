import chalk from 'chalk';

export function showMachineHelp(): void {
  console.log(`
${chalk.bold('happier machine')} - Set up remote machines (SSH)

${chalk.bold('Usage:')}
  happier machine setup --ssh <user@host> [--identity-file <path>] [--ssh-config-file <path>] [--known-hosts-path <path>] [--trusted-host-key <line>]
  happier machine setup --ssh <user@host> [--service-mode <user|none>] [--install-relay-runtime] [--relay-runtime-mode <user|system>] [--yes] [--json] [--preview|--dev|--channel stable|preview|dev]

${chalk.bold('Notes:')}
  • This is a thin wrapper over the canonical remote SSH setup task.
  • Use --json to stream protocol event/result JSON lines.
  • In interactive terminals, SSH host trust and pairing approval prompts are surfaced inline.
  • Use --yes to auto-accept setup prompts in non-interactive runs.
  `);
}
