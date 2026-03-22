import chalk from 'chalk';

export function buildRootHelpText(): string {
  return `
${chalk.bold('happier')} - AI CLI On the Go

${chalk.bold('Usage:')}
\t  happier [options]         Start the default backend with mobile control
\t  happier auth              Manage authentication
\t  happier codex             Start Codex mode
\t  happier opencode          Start OpenCode mode (ACP)
\t  happier gemini            Start Gemini mode (ACP)
  happier connect           Connect AI vendor API keys
  happier notify            Send push notification
  happier install           Install provider CLIs and helpers
  happier daemon            Manage background service that allows
                            to spawn new sessions away from your computer
  happier doctor            System diagnostics & troubleshooting

${chalk.bold('Examples:')}
  happier                    Start session
  happier --refresh-settings  Force-refresh account settings before starting
  happier --profile <id-or-name> Start with a backend profile from your settings
  happier --yolo             Start with bypassing permissions
                              happier sugar for --dangerously-skip-permissions
  happier --chrome           Enable Chrome browser access for this session
  happier --no-chrome        Disable Chrome even if default is on
  happier --js-runtime bun   Use bun instead of node to spawn JavaScript-backed CLIs
  happier auth login --force Authenticate
  happier profiles list      List available backend profiles
  happier doctor             Run diagnostics

${chalk.bold('Server selection (global flags; prefix-only; no persistence):')}
  happier --server <name-or-id> ...
  happier --server-url <url> [--webapp-url <url>] [--public-server-url <url>] ...
`;
}
