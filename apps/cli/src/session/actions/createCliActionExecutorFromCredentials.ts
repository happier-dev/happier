import { commitSessionStoredMessage } from '@/session/transport/http/sessionsHttp';
import { createServerBackedSessionTranscriptStore } from '@/api/session/createServerBackedSessionTranscriptStore';
import {
  DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
  createSessionTranscriptFollowLeaseRegistry,
} from '@/api/session/transcriptQueries';
import type { SessionTranscriptActionItem } from '@/api/session/sessionTranscriptActionInput';
import { SessionMessageContentSchema } from '@/api/types';
import type { Credentials } from '@/persistence';
import { resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';

import { createCliActionExecutor } from './createCliActionExecutor';
import { ensureCliActionPolicySettings } from './ensureCliActionPolicySettings';

export function createCliActionExecutorFromCredentials(params: Readonly<{
  credentials: Credentials;
  sessionLogAccess?: Readonly<{
    workingDirectory: string;
    accessPolicy: FilesystemAccessPolicy;
    getAdditionalAllowedReadDirs?: () => ReadonlyArray<string>;
  }>;
}>): ReturnType<typeof createCliActionExecutor> {
  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials);

  const executor = createCliActionExecutor({
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId: 'cli-global',
    ctx,
    resolveTranscriptStore: async (sessionId) => createServerBackedSessionTranscriptStore({
      token: params.credentials.token,
      sessionId,
      ctx,
    }),
    transcriptFollowLeaseRegistry: createSessionTranscriptFollowLeaseRegistry({
      maxLeases: 16,
      idleTtlMs: DEFAULT_SESSION_TRANSCRIPT_FOLLOW_LEASE_IDLE_TTL_MS,
    }),
    writeTranscriptItems: async (sessionId: string, items: readonly SessionTranscriptActionItem[]) => {
      let imported = 0;
      let cursor: string | null = null;
      for (const item of items) {
        const parsedContent = SessionMessageContentSchema.safeParse(item.content);
        if (!parsedContent.success) {
          continue;
        }
        const localId = item.id.trim();
        if (!localId) {
          continue;
        }
        const committed = await commitSessionStoredMessage({
          token: params.credentials.token,
          sessionId,
          localId,
          content: parsedContent.data,
        });
        imported += 1;
        cursor = String(committed.seq);
      }
      return { imported, cursor };
    },
    ...(params.sessionLogAccess ? { sessionLogAccess: params.sessionLogAccess } : {}),
  });

  return {
    execute: async (...args) => {
      await ensureCliActionPolicySettings(params.credentials);
      return await executor.execute(...args);
    },
  };
}
