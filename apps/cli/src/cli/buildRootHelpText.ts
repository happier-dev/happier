import chalk from 'chalk';

import { listRootHelpCommands } from './commandSurfaceManifest';

const HELP_LABEL_WIDTH = 27;

function formatHelpEntry(label: string, description: string): string {
  return `  ${label.padEnd(HELP_LABEL_WIDTH)} ${description}`;
}

export function buildRootHelpText(): string {
  const helpEntries = listRootHelpCommands();
  return `
${chalk.bold('happier')} - AI CLI On the Go

${chalk.bold('Usage:')}
${helpEntries.map((entry) => {
    const label = entry.rootHelpLabel ?? '';
    const description = entry.rootHelpDescription ?? '';
    const firstLine = formatHelpEntry(label, description);
    if (!entry.rootHelpDetail) return firstLine;
    return `${firstLine}\n${formatHelpEntry('', entry.rootHelpDetail)}`;
  }).join('\n')}

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
