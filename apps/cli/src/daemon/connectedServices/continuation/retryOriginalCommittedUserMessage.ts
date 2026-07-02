import {
  fetchLatestCommittedUserTextAtOrBeforeMs,
  type LatestCommittedUserTextBeforeFailure,
} from '@/api/session/transcriptQueries';
import type { Credentials } from '@/persistence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import {
  sendSessionMessage,
  type SendSessionMessageSocketCommit,
} from '@/session/services/sendSessionMessage';

type RetryOriginalCommittedUserMessageInput = Readonly<{
  credentials: Credentials;
  sessionId: string;
  failureAtMs: number;
  localId: string;
  onCommittedViaSocket?: (input: SendSessionMessageSocketCommit) => Promise<void> | void;
}>;

type RetryOriginalCommittedUserMessageDeps = Readonly<{
  resolveTransportContext: typeof resolveSessionTransportContext;
  fetchOriginalUserText: typeof fetchLatestCommittedUserTextAtOrBeforeMs;
  sendMessage: typeof sendSessionMessage;
}>;

export async function retryOriginalCommittedUserMessageWithDeps(
  deps: RetryOriginalCommittedUserMessageDeps,
  input: RetryOriginalCommittedUserMessageInput,
): Promise<void> {
  const transport = await deps.resolveTransportContext({
    credentials: input.credentials,
    idOrPrefix: input.sessionId,
  });
  if (!transport.ok) {
    throw new Error(`original_user_message_context_unavailable:${transport.code}`);
  }

  const original: LatestCommittedUserTextBeforeFailure | null = await deps.fetchOriginalUserText({
    token: input.credentials.token,
    sessionId: transport.sessionId,
    encryptionKey: transport.ctx.encryptionKey,
    encryptionVariant: transport.ctx.encryptionVariant,
    failureAtMs: input.failureAtMs,
  });
  if (!original) {
    throw new Error('original_user_message_unavailable');
  }

  const sent = await deps.sendMessage({
    credentials: input.credentials,
    idOrPrefix: transport.sessionId,
    message: original.text,
    localId: input.localId,
    wait: false,
    timeoutMs: 1,
    onCommittedViaSocket: input.onCommittedViaSocket,
    ...(original.permissionMode ? { permissionModeOverride: original.permissionMode } : {}),
    ...(original.model ? { modelOverride: original.model } : {}),
  });
  if (!sent.ok) {
    throw new Error(`original_user_message_retry_failed:${sent.code}`);
  }
}

export async function retryOriginalCommittedUserMessage(
  input: RetryOriginalCommittedUserMessageInput,
): Promise<void> {
  await retryOriginalCommittedUserMessageWithDeps(
    {
      resolveTransportContext: resolveSessionTransportContext,
      fetchOriginalUserText: fetchLatestCommittedUserTextAtOrBeforeMs,
      sendMessage: sendSessionMessage,
    },
    input,
  );
}
