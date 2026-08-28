import { isRecord } from '@happier-dev/plugin-sdk';

export type PiAgentEndBoundary = 'retrying' | 'final' | null;

export function classifyPiAgentEndBoundary(
  record: unknown,
  opts: Readonly<{ piRetryableProviderFailure?: boolean }> = {},
): PiAgentEndBoundary {
  if (!isRecord(record) || record.type !== 'agent_end') return null;
  if (record.willRetry === true) return 'retrying';
  if (record.willRetry === false) return 'final';
  return opts.piRetryableProviderFailure === true ? 'retrying' : 'final';
}
