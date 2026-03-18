import chalk from 'chalk';

export function showProfilesHelp(): void {
  console.log(`
${chalk.bold('happier profiles')} - Backend profiles

${chalk.bold('Usage:')}
  happier profiles list [--refresh-settings] [--json]

${chalk.bold('Aliases:')}
  happier profile list

${chalk.bold('Notes:')}
  - Use --profile <id-or-name> when starting a session to apply a profile.
  - Run "happier auth login" to see custom profiles saved in your account settings.
`);
}

