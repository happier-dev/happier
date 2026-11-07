import { createSessionFollowOccurrenceDispatcher as createDispatcher } from './sessionFollowOccurrenceDispatcher';

type Input = Parameters<typeof createDispatcher>[0];

/** A single requester harness; multi-requester tests supply the real receiver's dispatcher. */
export function createSessionFollowOccurrenceDispatcher(
  input: Omit<Input, 'dispatchReceiverRange'> & Partial<Pick<Input, 'dispatchReceiverRange'>>,
): ReturnType<typeof createDispatcher> {
  const dispatcher: ReturnType<typeof createDispatcher> = createDispatcher({ ...input,
    dispatchReceiverRange: input.dispatchReceiverRange ?? (async (request, sourcePublisher) => {
      await dispatcher.dispatchReceiverRange(request, sourcePublisher);
    }),
  });
  return dispatcher;
}
