import { runProfilesListCommand } from './list';

export async function runProfilesSubcommand(subcommand: string, args: string[]): Promise<boolean> {
  if (subcommand === 'list') {
    await runProfilesListCommand(args.slice(1));
    return true;
  }
  return false;
}

