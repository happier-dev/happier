import type { RequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import type { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';

/** Carry the admitted subject into SDK services; never reselect a durable default. */
export function readRunnerConnectedAccountBinding(input: Readonly<{
  sessionId: string;
  runKey?: string;
  connectedServiceRuntimeRegistry: ConnectedServiceRuntimeRegistry;
  requester?: Pick<RequesterSessionRuntimeContext, 'connectedAccountsOwner' | 'connectedServiceRuntimeRegistry'>;
}>) {
  const target = input.runKey
    ? input.connectedServiceRuntimeRegistry.getRunTargetByRunKey(input.runKey)
    : input.requester?.connectedServiceRuntimeRegistry.getBySessionId(input.sessionId);
  return target?.exactPurposeBindingSubjectId ? {
    exactPurposeBindingSubjectId: target.exactPurposeBindingSubjectId,
    ...(input.requester ? { connectedAccountsOwner: input.requester.connectedAccountsOwner } : {}),
  } : {};
}
