import chalk from 'chalk';

import { configuration } from '@/configuration';

export function showServerHelp(): void {
  console.log(`
${chalk.bold('happier server')} - Manage relay profiles

${chalk.bold('Usage:')}
  happier server list
  happier server current
  happier server add [--name <name>] [--server-url <url>] [--public-server-url <url>] [--webapp-url <url>] [--use] [--no-use] [--yes] [--start-daemon] [--install-service]
  happier server use <name-or-id>
  happier server remove <name-or-id> [--force]
  happier server test [<name-or-id>]
  happier server set [--server-id <id>] --server-url <url> [--public-server-url <url>] [--webapp-url <url>]

${chalk.bold('Notes:')}
  • Profiles are stored in ${configuration.settingsFile}
  • Credentials are stored per relay profile under ${configuration.serversDir}
  • Public relay URL is used for QR codes/deep links (defaults to relay URL)
  • add checks the relay answers /v1/version before saving it; --yes saves it without checking
  • Env vars override for one run: HAPPIER_SERVER_URL / HAPPIER_PUBLIC_SERVER_URL / HAPPIER_WEBAPP_URL
`);
}
