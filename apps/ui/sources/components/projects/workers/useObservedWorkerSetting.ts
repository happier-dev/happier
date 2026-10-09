import * as React from 'react';

import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { ProjectWorkerActionError } from '@/sync/ops/actions/projectWorkerActions';

type ReadyObservation = Readonly<{ status: 'ready' }>;
type RefusedRead = Readonly<{ status: 'locked' | 'invalid' | 'unavailable' }>;

export type ObservedWorkerSettingState<TReady extends ReadyObservation> =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{ kind: 'ready'; value: TReady }>
  | Readonly<{ kind: 'refused'; status: RefusedRead['status'] }>
  | Readonly<{ kind: 'error' }>;

/**
 * What the last write said, beside the value that is still observed:
 * saving / waiting for Ask-first approval / unknown (observe, never replay) / changed under us
 * (renewed intent required) / failed / locked.
 */
export type ObservedWorkerSettingNotice =
  | 'saving'
  | 'approval'
  | 'unknown'
  | 'changed'
  | 'failed'
  | 'locked'
  | null;

type MutationReceipt = Readonly<{ status: string }>;

/**
 * One Account-scoped semantic setting read through its Action and changed by compare-and-set (30 §5,
 * 32 §5): worker preferences, a service's placement or a Machine's work policy. The displayed value
 * only changes on an observed outcome; a pending, unknown or conflicting write never paints the
 * attempted value as saved. Scope loss retires every pending result.
 */
export function useObservedWorkerSetting<TReady extends ReadyObservation>(
  input: Readonly<{
    serverId: string;
    /** Identity of the observed object; a new key starts a fresh observation. */
    scopeKey: string;
    /** False keeps the setting unread (no consumer is showing it). Defaults to true. */
    enabled?: boolean;
    read: (accountId: string) => Promise<TReady | RefusedRead>;
    /** The current observation a receipt carries (applied/satisfied/unchanged/conflict), else null. */
    observedFromReceipt: (receipt: MutationReceipt) => TReady | null;
  }>,
) {
  const { binding } = useServerCredentialAccountScopeBinding(input.serverId);
  const accountId = binding?.isCurrent() ? binding.accountId : null;
  const key = JSON.stringify([input.scopeKey, accountId]);
  const enabled = input.enabled !== false;
  const [observation, setObservation] = React.useState<Readonly<{
    key: string;
    state: ObservedWorkerSettingState<TReady>;
  }> | null>(null);
  const [notice, setNotice] = React.useState<Readonly<{
    key: string;
    notice: ObservedWorkerSettingNotice;
  }> | null>(null);
  const [readToken, setReadToken] = React.useState(0);
  const readRef = React.useRef(input.read);
  readRef.current = input.read;
  const receiptRef = React.useRef(input.observedFromReceipt);
  receiptRef.current = input.observedFromReceipt;
  const keyRef = React.useRef(key);
  keyRef.current = key;

  const refresh = React.useCallback(
    () => setReadToken((token) => token + 1),
    [],
  );
  const approval = useActionApprovalContinuation({
    scopeKey: key,
    serverId: input.serverId,
    onExecuted: () => {
      setNotice({ key: keyRef.current, notice: null });
      refresh();
    },
  });
  const requestApprovalRef = React.useRef(approval.requestApproval);
  requestApprovalRef.current = approval.requestApproval;

  React.useEffect(() => {
    if (!binding || !accountId || !enabled) return;
    let current = true;
    const retirement = binding.onRetire(() => {
      current = false;
    });
    void readRef.current(accountId).then(
      (result) => {
        if (!current || !binding.isCurrent()) return;
        setObservation({
          key,
          state:
            result.status === 'ready'
              ? { kind: 'ready', value: result as TReady }
              : { kind: 'refused', status: (result as RefusedRead).status },
        });
      },
      () => {
        if (!current || !binding.isCurrent()) return;
        setObservation({ key, state: { kind: 'error' } });
      },
    );
    return () => {
      current = false;
      retirement.dispose();
    };
  }, [accountId, binding, enabled, key, readToken]);

  const mutate = React.useCallback(
    async (
      run: (accountId: string, current: TReady) => Promise<MutationReceipt>,
    ): Promise<void> => {
      const state = observation?.key === key ? observation.state : null;
      if (!binding || !accountId || state?.kind !== 'ready') return;
      const scopedKey = key;
      const setScopedNotice = (next: ObservedWorkerSettingNotice) => {
        if (keyRef.current === scopedKey)
          setNotice({ key: scopedKey, notice: next });
      };
      setScopedNotice('saving');
      try {
        const receipt = await run(accountId, state.value);
        if (!binding.isCurrent() || keyRef.current !== scopedKey) return;
        const observed = receiptRef.current(receipt);
        if (observed)
          setObservation({
            key: scopedKey,
            state: { kind: 'ready', value: observed },
          });
        switch (receipt.status) {
          case 'applied':
          case 'satisfied':
          case 'unchanged':
            setScopedNotice(null);
            return;
          case 'conflict':
            setScopedNotice('changed');
            return;
          case 'outcomeUnknown':
            // Observe the current value; never replay the write.
            setScopedNotice('unknown');
            refresh();
            return;
          case 'locked':
            setScopedNotice('locked');
            return;
          default:
            setScopedNotice('failed');
        }
      } catch (error) {
        if (!binding.isCurrent() || keyRef.current !== scopedKey) return;
        if (
          error instanceof ProjectWorkerActionError &&
          error.errorCode === 'approval_required' &&
          error.approvalArtifactId
        ) {
          requestApprovalRef.current(error.approvalArtifactId);
          setScopedNotice('approval');
          return;
        }
        setScopedNotice('failed');
      }
    },
    [accountId, binding, key, observation, refresh],
  );

  const state: ObservedWorkerSettingState<TReady> =
    observation?.key === key ? observation.state : { kind: 'loading' };
  const currentNotice = notice?.key === key ? notice.notice : null;
  return {
    state,
    notice:
      currentNotice === 'approval' &&
      !approval.approvalPending &&
      approval.approvalId === null
        ? null
        : currentNotice,
    busy:
      currentNotice === 'saving' ||
      (currentNotice === 'approval' && approval.approvalPending),
    refresh,
    mutate,
  };
}
