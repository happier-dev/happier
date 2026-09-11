export interface CommandSuiteEntry {
  id: string;
  args: readonly string[];
}

export interface RunCommandSuiteOptions<TCommand extends CommandSuiteEntry> {
  commands: readonly TCommand[];
  runCommand: (command: TCommand) => Promise<void>;
  maxConcurrent?: number;
  suiteName?: string;
}

export async function runCommandSuite<TCommand extends CommandSuiteEntry>(
  options: RunCommandSuiteOptions<TCommand>,
): Promise<readonly TCommand[]> {
  if (options.commands.length === 0) {
    throw new Error(`${options.suiteName ?? 'Command suite'} selection failed: no commands were selected.`);
  }

  const maximum = Number.isInteger(options.maxConcurrent) && Number(options.maxConcurrent) > 0
    ? Number(options.maxConcurrent)
    : 1;
  const failures: Array<{ index: number; command: TCommand; error: unknown }> = [];
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < options.commands.length) {
      const index = nextIndex;
      nextIndex += 1;
      const command = options.commands[index];
      try {
        await options.runCommand(command);
      } catch (error) {
        failures.push({ index, command, error });
      }
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(maximum, options.commands.length) },
    () => worker(),
  ));

  if (failures.length > 0) {
    throw new Error([
      `${options.suiteName ?? 'Command suite'} failures:`,
      ...failures
        .sort((left, right) => left.index - right.index)
        .map(({ command, error }) => `- ${command.id}: ${error instanceof Error ? error.message : String(error)}`),
    ].join('\n'));
  }

  return options.commands;
}
