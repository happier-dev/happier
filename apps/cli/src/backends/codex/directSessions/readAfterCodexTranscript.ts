import type { DirectSessionsSource } from '@happier-dev/protocol';
import type { DirectSessionTranscriptReadAfter } from '@/backends/directSessions/providerOps';

import { readCodexDirectTranscript } from './codexDirectTranscriptSource';

export async function readAfterCodexTranscript(params: Readonly<{
  source: DirectSessionsSource;
  activeServerDir: string;
  env?: NodeJS.ProcessEnv;
  remoteSessionId: string;
  cursor: string;
  maxBytes: number;
  maxItems: number;
}>): Promise<DirectSessionTranscriptReadAfter> {
  return await readCodexDirectTranscript({ ...params, direction: 'newer', follow: true });
}
