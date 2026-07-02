export type ConnectedServiceTransitionLockMode =
  | Readonly<{ kind: 'acquire_session_lock' }>
  | Readonly<{
      kind: 'test_only_unlocked';
      reason: string;
    }>;
