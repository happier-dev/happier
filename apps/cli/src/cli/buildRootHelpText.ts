import { bold, helpFormatter } from '@happier-dev/cli-common/output';

import { listRootHelpCommands } from './commandSurfaceManifest';

const HELP_LABEL_WIDTH = 27;

export function buildRootHelpText(): string {
  const helpEntries = listRootHelpCommands();
  const usage = helpFormatter.renderRows(
    helpEntries.map((entry) => ({
      label: entry.rootHelpLabel ?? '',
      description: entry.rootHelpDescription ?? '',
      ...(entry.rootHelpDetail ? { detail: entry.rootHelpDetail } : {}),
    })),
    { labelWidth: HELP_LABEL_WIDTH },
  );
  return `
${bold('happier')} - AI CLI On the Go

${bold('Usage:')}
${usage}

${bold('Examples:')}
  happier                    Start session
  happier --refresh-settings  Force-refresh account settings before starting
  happier --launch-profile <id-or-name> Start with a launch profile from your settings
  happier --auth cs:<id>    Start with an exact Connected Services profile or pool
  happier --auth native     Start with native provider authentication
  happier --yolo             Start with bypassing permissions
                              happier sugar for --dangerously-skip-permissions
  happier --chrome           Enable Chrome browser access for this session
  happier --no-chrome        Disable Chrome even if default is on
  happier --js-runtime bun   Use bun instead of node to spawn JavaScript-backed CLIs
  happier auth login --force Authenticate
  happier profiles list      List available Agent profiles
  happier doctor             Run diagnostics

${bold('Server selection (global flags; prefix-only; no persistence):')}
  happier --server <name-or-id> ...
  happier --server-url <url> [--local-server-url <url>] [--webapp-url <url>] ...

${bold('API Token authentication (global; prefix-only; never persisted):')}
  happier --api-token <token> ...
  HAPPIER_TOKEN=<token> happier ...
  Create API Tokens in Settings. They authorize broad account automation, not present-user approvals or security controls.
`;
}
