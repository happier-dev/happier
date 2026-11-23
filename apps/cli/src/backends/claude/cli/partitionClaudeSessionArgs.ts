import {
  partitionProviderSessionArgs,
  type ProviderSessionArgPartitionResult,
} from '@/cli/providerSessionArgPartition';

/**
 * Splits `happier claude` argv into Happier session controls and Claude Code passthrough args.
 *
 * `--model` is a session control, like `--permission-mode`: it seeds the session model, which
 * then follows the user's selection. It must not also reach the passthrough args, because every
 * Claude runtime reads a passthrough `--model` as a fixed override, which silently pinned the
 * startup model for the whole session.
 */
export function partitionClaudeSessionArgs(args: readonly string[]): ProviderSessionArgPartitionResult {
  return partitionProviderSessionArgs({
    args,
    providerSubcommand: 'claude',
    forwardModelFlag: false,
    forwardResumeFlag: true,
    yoloProviderArgs: ['--dangerously-skip-permissions'],
  });
}
