import type { Session } from '@/sync/domains/state/storageTypes';
import { resolveAgentUiBehaviorFromFlavor } from '@/agents/registry/registryUiBehavior';

export function canForkConversation(params: { session: Session | null | undefined; replayEnabled: boolean | null | undefined }): boolean {
  const session = params.session ?? null;
  if (!session) return false;
  if (params.replayEnabled === true) return true;
  const behavior = resolveAgentUiBehaviorFromFlavor((session as any)?.metadata?.flavor);
  return behavior?.forking?.supportsForkConversation?.({ session }) === true;
}

export function canForkFromMessage(params: {
  session: Session | null | undefined;
  messageSeq: number | null;
  replayEnabled: boolean | null | undefined;
}): boolean {
  const session = params.session ?? null;
  if (!session) return false;
  if (params.messageSeq == null) return false;
  if (params.replayEnabled === true) return true;
  const behavior = resolveAgentUiBehaviorFromFlavor((session as any)?.metadata?.flavor);
  return behavior?.forking?.supportsForkFromMessage?.({ session }) === true;
}

