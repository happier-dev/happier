import os from 'node:os';

import type { Credentials } from '@/persistence';
import { getOrCreateSessionByTag } from '@/session/transport/http/sessionsHttp';

export async function createReplaySeededSession(params: Readonly<{
  credentials: Credentials;
  directory: string;
  agentId: string;
  tag: string;
  /**
   * Additional metadata to persist at session creation time.
   * Must be provider-agnostic (provider-specific keys should be passed explicitly by caller).
   */
  metadata: Record<string, unknown>;
}>): Promise<{ sessionId: string }> {
  const tag = params.tag.trim();
  if (!tag) {
    throw new Error('Missing tag');
  }

  const { session } = await getOrCreateSessionByTag({
    credentials: params.credentials,
    tag,
    metadata: {
      tag,
      path: params.directory,
      host: os.hostname(),
      flavor: params.agentId,
      ...params.metadata,
    },
    agentState: null,
  });

  const sessionId = typeof (session as any)?.id === 'string' ? String((session as any).id).trim() : '';
  if (!sessionId) {
    throw new Error('Failed to create replay-seeded session (missing id)');
  }

  return { sessionId };
}
