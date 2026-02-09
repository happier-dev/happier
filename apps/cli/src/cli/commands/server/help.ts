import chalk from 'chalk';

import { configuration } from '@/configuration';

export function showServerHelp(): void {
  console.log(`
${chalk.bold('happier server')} - Manage Happier server profiles

${chalk.bold('Usage:')}
  happier server list
  happier server current
  happier server add [--name <name>] [--server-url <url>] [--webapp-url <url>] [--use] [--no-use] [--start-daemon] [--install-service]
  happier server use <name-or-id>
  happier server remove <name-or-id> [--force]
  happier server test [<name-or-id>]
  happier server set --server-url <url> [--webapp-url <url>]

${chalk.bold('Notes:')}
  • Profiles are stored in ${configuration.settingsFile}
  • Credentials are stored per-server under ${configuration.serversDir}
  • Env vars override for one run: HAPPIER_SERVER_URL / HAPPIER_WEBAPP_URL
`);
}
