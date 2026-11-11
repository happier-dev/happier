import chalk from 'chalk';
import { join } from 'node:path';
import { cmd } from '@happier-dev/cli-common/output';

export function usage(): string {
  return [
    `${chalk.bold('happier self')} - Self update + update checks`,
    '',
    `${chalk.bold('Usage:')}`,
    `  happier self check [--preview|--dev|--channel=<preview|dev>] [--quiet]`,
    `  happier self update [--preview|--dev|--channel=<preview|dev>] [--to <versionOrTag>]`,
    `  happier self release-channel status [--json]`,
    `  happier self release-channel list [--json]`,
    `  happier self release-channel use <stable|preview|dev>`,
    `  happier self migrate [--yes] [--json]`,
    `  happier self-update [--check] [--preview|--dev|--channel=<preview|dev>] [--to <versionOrTag>]`,
    '',
    `${chalk.bold('Channels:')}`,
    `  stable  → npm dist-tag ${cmd('latest')}`,
    `  preview → npm dist-tag ${cmd('next')}`,
    `  dev     → npm dist-tag ${cmd('dev')}`,
    '',
    `${chalk.bold('Environment:')}`,
    `  HAPPIER_CLI_UPDATE_CHECK=0                 Disable update notice + background check`,
    `  HAPPIER_CLI_UPDATE_PACKAGE_NAME=@scope/pkg Override the npm package name checked/installed`,
    `  HAPPIER_GITHUB_REPO=happier-dev/happier    Override GitHub repo for binary updates`,
    `  HAPPIER_GITHUB_TOKEN=...                   GitHub token for release API (optional)`,
    '',
  ].join('\n');
}

