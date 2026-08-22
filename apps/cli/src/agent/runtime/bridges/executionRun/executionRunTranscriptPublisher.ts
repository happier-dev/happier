import type { ACPMessageData, ACPProvider } from '@/api/session/sessionMessageTypes';

export type ExecutionRunTranscriptPublisher = (
  provider: ACPProvider,
  body: ACPMessageData,
  opts?: { meta?: Record<string, unknown> },
) => Promise<void>;

export function createExecutionRunTranscriptCustodyError(): Error & { code: string } {
  return Object.assign(
    new Error('Stable execution-run transcript fact was not admitted to durable custody'),
    { code: 'execution_run_transcript_custody_unavailable' },
  );
}

export function isExecutionRunTranscriptCustodyError(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'execution_run_transcript_custody_unavailable',
  );
}
