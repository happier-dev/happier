import { isRecord } from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

export type PiAgentEndBoundary = 'retrying' | 'final' | null;

export function classifyPiAgentEndBoundary(record: unknown): PiAgentEndBoundary {
  if (!isRecord(record) || record.type !== 'agent_end') return null;
  return record.willRetry === true ? 'retrying' : 'final';
}
