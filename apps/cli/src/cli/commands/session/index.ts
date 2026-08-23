import chalk from 'chalk';

import type { CommandContext } from '@/cli/commandRegistry';

export { handleSessionCommand } from './handleSessionCommand';

import { handleSessionCommand } from './handleSessionCommand';

export async function handleSessionCliCommand(context: CommandContext): Promise<void> {
  const isHistoryFollow = (
    (context.args[1] === 'history' || context.args[1] === 'create')
    && context.args.includes('--follow')
  );
  const controller = isHistoryFollow && !context.signal ? new AbortController() : null;
  const onSignal = () => controller?.abort();
  if (controller) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
  try {
    await handleSessionCommand(context.args.slice(1), {
      ...(context.signal ? { signal: context.signal } : controller ? { signal: controller.signal } : {}),
    });
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  } finally {
    if (controller) {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  }
}
