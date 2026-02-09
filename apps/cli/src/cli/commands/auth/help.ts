import chalk from 'chalk';

export function showAuthHelp(): void {
  console.log(`
${chalk.bold('happier auth')} - Authentication management

${chalk.bold('Usage:')}
  happier auth login [--no-open] [--force] [--method web|mobile] [--server <name-or-id> | --server-url <url> [--webapp-url <url>] [--persist|--no-persist]]    Authenticate with Happier
  happier auth logout [--all]     Log out (active server by default)
  happier auth status             Show authentication status
  happier auth help               Show this help message

${chalk.bold('Options:')}
  --no-open  Do not attempt to open a browser (prints URL instead)
  --force    Clear credentials, machine ID, and stop daemon before re-auth
  --method   Force authentication method (web|mobile). Useful for headless/non-TTY.
  --all      When used with logout, remove local data for all servers
  --server      Use an existing saved server profile
  --server-url  Use a specific server URL (defaults to persisting as a new profile)
  --webapp-url  Override web app URL for this server profile
  --persist     Persist --server-url as the active server profile (default)
  --no-persist  Use --server-url for this invocation only

${chalk.gray('PS: Your master secret never leaves your mobile/web device. Each CLI machine')}
${chalk.gray('receives only a derived key for per-machine encryption, so backup codes')}
${chalk.gray('cannot be displayed from the CLI.')}
`);
}
