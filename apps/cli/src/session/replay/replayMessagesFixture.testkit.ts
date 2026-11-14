import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import * as z from 'zod/mini';
import {
  SessionMessageV1Schema,
  SessionMessagesPageV1Schema,
  type SessionMessagePageActivityV1,
} from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';

const MessageFixtureInputSchema = lazyZodSchema(() => z.extend(SessionMessageV1Schema, {
  id: z.optional(SessionMessageV1Schema.shape.id),
}));

/** Build HTTP boundary fixtures with the same schemas the real page reader consumes. */
export function createReplayMessagesPage(params: Readonly<{
  messages: readonly unknown[];
  hasMore: boolean;
  direction?: 'backward' | 'forward';
  activity?: SessionMessagePageActivityV1;
}>) {
  const messages = params.messages.map((input, index) => {
    const message = MessageFixtureInputSchema.parse(input);
    return SessionMessageV1Schema.parse({
      ...message,
      id: message.id ?? `replay-${message.seq}-${message.createdAt}-${index}`,
    });
  });
  const continuationSeq = params.hasMore ? messages.at(-1)?.seq ?? null : null;
  return SessionMessagesPageV1Schema.parse({
    ...(params.activity ? { activity: params.activity } : {}),
    messages,
    hasMore: params.hasMore,
    nextBeforeSeq: params.direction === 'forward' ? null : continuationSeq,
    nextAfterSeq: params.direction === 'forward' ? continuationSeq : null,
  });
}
