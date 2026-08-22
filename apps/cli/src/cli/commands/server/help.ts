import chalk from 'chalk';

import { configuration } from '@/configuration';

export function showServerHelp(): void {
  console.log(`
${chalk.bold('happier server')} - Manage Happier server profiles

${chalk.bold('Usage:')}
  happier server list
  happier server current
  happier server add [--name <name>] [--server-url <url>] [--local-server-url <url>] [--webapp-url <url>] [--use] [--no-use] [--yes] [--start-daemon] [--install-service]
  happier server use <name-or-id>
  happier server remove <name-or-id> [--force]
  happier server test [<name-or-id>]
  happier server set --server-url <url> [--local-server-url <url>] [--webapp-url <url>]

${chalk.bold('Notes:')}
  • Profiles are stored in ${configuration.settingsFile}
  • Credentials are stored per-server under ${configuration.serversDir}
  • Use --server-url for the canonical/share URL used in deep links and QR codes
  • Use --local-server-url for a local-only API URL (optional)
  • add checks the relay answers /v1/version before saving it; --yes saves it without checking
  • Env vars override for one run: HAPPIER_SERVER_URL / HAPPIER_LOCAL_SERVER_URL / HAPPIER_WEBAPP_URL
`);
}
