import type { ForkPointV1, ForkRequestV1, ForkResultV1 } from '@happier-dev/agents';

export type ProviderNativeForkPoint = { type: 'latest' } | { type: 'seq'; upToSeqInclusive: number };

export type ProviderNativeForkHandlerParams = ForkRequestV1 & Readonly<{
  signal?: AbortSignal;
}>;

export type ProviderNativeForkHandler = (
  params: ProviderNativeForkHandlerParams
) => ForkResultV1 | null | Promise<ForkResultV1 | null>;

export function toForkPointV1(forkPoint: ProviderNativeForkPoint): ForkPointV1 {
  return forkPoint.type === 'seq'
    ? { kind: 'message_seq', upToSeqInclusive: forkPoint.upToSeqInclusive }
    : { kind: 'latest' };
}
