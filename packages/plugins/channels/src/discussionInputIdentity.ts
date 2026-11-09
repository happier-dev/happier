/** The Discussion writer's durable retry identity also identifies its inbound binding. */
export function createConversationDiscussionInputLocalId(bindingId: string, obligationId: string): string {
  return `channels:${bindingId.length}:${bindingId}:${obligationId}`;
}

export function readConversationDiscussionInputOrigin(localId: string | null): Readonly<{ bindingId: string; obligationId: string }> | undefined {
  if (localId === null) return undefined;
  const frame = /^channels:([1-9][0-9]*):/u.exec(localId);
  if (frame === null) return undefined;
  const length = Number(frame[1]);
  const bindingId = localId.slice(frame[0].length, frame[0].length + length);
  const suffix = localId.slice(frame[0].length + length);
  return bindingId.length === length && /^:[A-Za-z0-9_-]{43}$/u.test(suffix)
    ? { bindingId, obligationId: suffix.slice(1) } : undefined;
}

export function readConversationDiscussionInputBindingId(localId: string | null): string | undefined {
  return readConversationDiscussionInputOrigin(localId)?.bindingId;
}
