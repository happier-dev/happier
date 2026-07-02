import type { Credentials } from '@/persistence';
import {
  sendSessionMessage,
  type SendSessionMessageSocketCommit,
} from '@/session/services/sendSessionMessage';

import { retryOriginalCommittedUserMessage } from './retryOriginalCommittedUserMessage';

type ContinuationPendingQueueNudgeInput = Readonly<{
  sessionId: string;
}>;

type ConnectedServiceContinuationMessageDispatcherDeps = Readonly<{
  credentials: Credentials;
  nudgePendingQueue: (input: ContinuationPendingQueueNudgeInput) => Promise<void> | void;
  sendMessage?: typeof sendSessionMessage;
  retryOriginalUserMessage?: typeof retryOriginalCommittedUserMessage;
}>;

function shouldNudgePendingQueue(input: SendSessionMessageSocketCommit): boolean {
  return input.localId.startsWith('connected-service-continuation:')
    || input.localId.startsWith('connected-service-original-retry:');
}

export function createConnectedServiceContinuationMessageDispatcher(
  deps: ConnectedServiceContinuationMessageDispatcherDeps,
) {
  const sendMessage = deps.sendMessage ?? sendSessionMessage;
  const retryOriginalUserMessage = deps.retryOriginalUserMessage ?? retryOriginalCommittedUserMessage;

  async function onCommittedViaSocket(input: SendSessionMessageSocketCommit): Promise<void> {
    if (!shouldNudgePendingQueue(input)) {
      return;
    }
    await deps.nudgePendingQueue({ sessionId: input.sessionId });
  }

  return {
    async sendContinuationPrompt(input: Readonly<{
      sessionId: string;
      prompt: string;
      localId: string;
    }>): Promise<void> {
      const sent = await sendMessage({
        credentials: deps.credentials,
        idOrPrefix: input.sessionId,
        message: input.prompt,
        localId: input.localId,
        wait: false,
        timeoutMs: 1,
        onCommittedViaSocket,
      });
      if (!sent.ok) {
        throw new Error(`continuation_prompt_send_failed:${sent.code}`);
      }
    },

    async retryOriginalUserMessage(input: Readonly<{
      sessionId: string;
      failureAtMs: number;
      localId: string;
    }>): Promise<void> {
      await retryOriginalUserMessage({
        credentials: deps.credentials,
        sessionId: input.sessionId,
        failureAtMs: input.failureAtMs,
        localId: input.localId,
        onCommittedViaSocket,
      });
    },
  };
}
