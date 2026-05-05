import chalk from 'chalk';

export function showAuthHelp(): void {
  console.log(`
${chalk.bold('happier auth')} - Authentication management

${chalk.bold('Usage:')}
  happier auth login [--no-open] [--force] [--method web|mobile] [--server <name-or-id> | --server-url <url> [--webapp-url <url>] [--persist|--no-persist]]    Authenticate with Happier
  happier auth request --json [--server <name-or-id> | --server-url <url> [--webapp-url <url>] [--persist|--no-persist]]                                    Create a claim-gated auth request (headless-friendly)
  happier auth approve --public-key <base64> --json [--server <name-or-id> | --server-url <url> [--webapp-url <url>] [--persist|--no-persist]]              Approve an auth request using your local credentials
  happier auth wait --public-key <base64> --json [--server <name-or-id> | --server-url <url> [--webapp-url <url>] [--persist|--no-persist]]                Wait for approval and write credentials for this machine
  happier auth pair-remote --ssh <user@host> [--json] [--no-post-check] [--server-url-for-remote <url> [--remote-webapp-url <url>]]                              Fully automated remote pairing over SSH
  happier auth logout [--all]     Log out (active relay by default)
  happier auth status             Show authentication status
  happier auth help               Show this help message

${chalk.bold('Options:')}
  --no-open  Do not attempt to open a browser (prints URL instead)
  --force    Clear credentials, machine ID, and stop daemon before re-auth
  --method   Force authentication method (web|mobile). Useful for headless/non-TTY.
  --print-configure-links  Print advanced “configure relay” links for tooling (rare)
  --all      When used with logout, remove local data for all relays
  --json       Print machine-readable JSON (recommended for containers)
  --public-key Used with approve/wait; the terminal public key from "auth request --json"
  --ssh        Used with pair-remote; ssh target (e.g. user@host)
  --no-post-check  Skip the post-pair 'doctor repair' handoff on the remote host (defaults to running it)
  --remote-command       Happier command to run on the remote host (default: happier)
  --server-url-for-remote  Address the remote host should use to reach this computer's relay
  --remote-server-url    Legacy alias for --server-url-for-remote
  --remote-local-server-url  Remote-local API URL paired with --remote-server-url
  --remote-webapp-url    Web app URL to persist on the remote host
  --server      Use an existing saved relay profile
  --server-url  Use a specific relay URL (does not persist unless --persist)
  --webapp-url  Override web app URL for this relay profile
  --persist     Persist --server-url as the active relay profile
  --no-persist  Use --server-url for this invocation only (default)

${chalk.gray('PS: Your master secret never leaves your mobile/web device. Each CLI machine')}
${chalk.gray('receives only a derived key for per-machine encryption, so backup codes')}
${chalk.gray('cannot be displayed from the CLI.')}
`);
}
