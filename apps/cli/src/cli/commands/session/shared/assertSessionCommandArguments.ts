import { assertCommandArguments, type CommandArgumentPolicy } from '@/cli/commands/shared/argvFlags';

/** Backwards-compatible session command validator delegated to the shared CLI owner. */
export function assertSessionCommandArguments(
  argv: readonly string[],
  policy: CommandArgumentPolicy,
): void {
  assertCommandArguments(argv, policy);
}
