import type {
  ConnectedServiceSessionAuthSwitchCore,
  ConnectedServiceSessionAuthSwitchReason,
} from '../../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import type { ConnectedServiceTransitionLockMode } from './connectedServiceTransitionLockMode';

export async function runSerializedConnectedServiceTransition<T>(input: Readonly<{
  core: ConnectedServiceSessionAuthSwitchCore;
  transitionLockMode?: ConnectedServiceTransitionLockMode;
  sessionId: string;
  reason: ConnectedServiceSessionAuthSwitchReason;
  execute(): Promise<T>;
}>): Promise<T> {
  const mode = input.transitionLockMode ?? { kind: 'acquire_session_lock' };
  switch (mode.kind) {
    case 'test_only_unlocked':
      if (!mode.reason.trim()) {
        throw new Error('connected service transition test-only unlock reason is required');
      }
      return await input.execute();
    case 'acquire_session_lock':
      return await input.core.run({
        sessionId: input.sessionId,
        reason: input.reason,
        execute: input.execute,
      });
    default:
      throw new Error('verified connected service transition lock mode is required');
  }
}
