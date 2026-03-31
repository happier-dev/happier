import { renderHelpPage } from '@happier-dev/cli-common/output';

export function showAuthHelp(): void {
  console.log(renderHelpPage({
    title: 'happier auth',
    subtitle: 'Authentication management',
    usage: [
      { label: 'happier auth login [--no-open] [--force] [--method web|mobile] [--server <name-or-id> | --server-url <url> [--webapp-url <url>] [--persist|--no-persist]]', description: 'Authenticate with Happier' },
      { label: 'happier auth request --json [--server <name-or-id> | --server-url <url> [--webapp-url <url>] [--persist|--no-persist]]', description: 'Create a claim-gated auth request (headless-friendly)' },
      { label: 'happier auth approve --public-key <base64> --json [--server <name-or-id> | --server-url <url> [--webapp-url <url>] [--persist|--no-persist]]', description: 'Approve an auth request using your local credentials' },
      { label: 'happier auth wait --public-key <base64> --json [--server <name-or-id> | --server-url <url> [--webapp-url <url>] [--persist|--no-persist]]', description: 'Wait for approval and write credentials for this machine' },
      { label: 'happier auth pair-remote --ssh <user@host> --json', description: 'Fully automated remote pairing over SSH' },
      { label: 'happier auth logout [--all]', description: 'Log out (active server by default)' },
      { label: 'happier auth status', description: 'Show authentication status' },
      { label: 'happier auth help', description: 'Show this help message' },
    ],
    sections: [
      {
        title: 'Options:',
        rows: [
          { label: '--no-open', description: 'Do not attempt to open a browser (prints URL instead)' },
          { label: '--force', description: 'Clear credentials, machine ID, and stop daemon before re-auth' },
          { label: '--method', description: 'Force authentication method (web|mobile). Useful for headless/non-TTY.' },
          { label: '--print-configure-links', description: 'Print advanced “configure server” links for tooling (rare)' },
          { label: '--all', description: 'When used with logout, remove local data for all servers' },
          { label: '--json', description: 'Print machine-readable JSON (recommended for containers)' },
          { label: '--public-key', description: 'Used with approve/wait; the terminal public key from "auth request --json"' },
          { label: '--ssh', description: 'Used with pair-remote; ssh target (e.g. user@host)' },
          { label: '--server', description: 'Use an existing saved server profile' },
          { label: '--server-url', description: 'Use a specific server URL (does not persist unless --persist)' },
          { label: '--webapp-url', description: 'Override web app URL for this server profile' },
          { label: '--persist', description: 'Persist --server-url as the active server profile' },
          { label: '--no-persist', description: 'Use --server-url for this invocation only (default)' },
        ],
      },
    ],
    notes: [
      'Your master secret never leaves your mobile/web device.',
      'Each CLI machine receives only a derived key for per-machine encryption, so backup codes cannot be displayed from the CLI.',
    ],
  }));
}
