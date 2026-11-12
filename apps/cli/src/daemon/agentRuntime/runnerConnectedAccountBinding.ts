import type { RequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import type { ConnectedServiceRuntimeRegistry } from '@/daemon/connectedServices/runtimeRegistry/registry';

/** Keep SDK services on the requester owner, carrying the admitted subject when present. */
export function readRunnerConnectedAccountBinding(input: Readonly<{
  sessionId: string;
  runKey?: string;
  connectedServiceRuntimeRegistry: ConnectedServiceRuntimeRegistry;
  requester?: Pick<RequesterSessionRuntimeContext, 'connectedAccountsOwner' | 'connectedServiceRuntimeRegistry'>;
}>) {
  const target = input.runKey
    ? input.connectedServiceRuntimeRegistry.getRunTargetByRunKey(input.runKey)
    : input.requester?.connectedServiceRuntimeRegistry.getBySessionId(input.sessionId);
  return {
    ...(input.requester ? { connectedAccountsOwner: input.requester.connectedAccountsOwner } : {}),
    ...(target?.exactPurposeBindingSubjectId ? { exactPurposeBindingSubjectId: target.exactPurposeBindingSubjectId } : {}),
  };
}
