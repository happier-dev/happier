import * as React from 'react';
import {
  PublicProfileOwnerReadV1Schema,
  type PublicProfileOwnerReadV1,
  type PublicProfileOwnerRecordV1,
} from '@happier-dev/protocol/account/publicProfilePublication';

import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { homeAccountChangeAffectsPublicProfile } from '@/sync/runtime/orchestration/changesPlanner';

export type PublicProfileOwnerReadState =
  | Readonly<{ kind: 'loading' }>
  | Readonly<{
      kind: 'ready';
      read: PublicProfileOwnerReadV1;
      refreshing: boolean;
    }>
  | Readonly<{ kind: 'failed' }>;

type AccountExecution = Pick<
  ReturnType<typeof useMountedActionExecution>,
  'executeValue' | 'ready'
>;

/**
 * The owner's applied edition through `account.public_profile.get`: read once when the Account's
 * mounted Action owner becomes ready, on publication/Account pushes, and on request. A refresh
 * keeps the last read on screen; a failed refresh leaves recovery available.
 */
export function usePublicProfileOwnerRead(
  execution: AccountExecution,
  scope: AccountSettingsScope | null = null,
): Readonly<{
  state: PublicProfileOwnerReadState;
  reload: () => Promise<void>;
  acknowledge: (record: PublicProfileOwnerRecordV1 | null) => void;
}> {
  const [state, setState] = React.useState<PublicProfileOwnerReadState>({
    kind: 'loading',
  });
  // The mounted owner hands out a new callback on every render; reads follow the latest one
  // without restarting, so a re-render never issues another request.
  const executeValue = React.useRef(execution.executeValue);
  executeValue.current = execution.executeValue;
  // The Home bus owns reconnect delivery; only an unsuccessful read needs its recovery wake.
  const readFailed = React.useRef(false);
  const reload = React.useCallback(async () => {
    readFailed.current = false;
    setState((current) =>
      current.kind === 'ready'
        ? { ...current, refreshing: true }
        : { kind: 'loading' },
    );
    try {
      const read = PublicProfileOwnerReadV1Schema.parse(
        await executeValue.current('account.public_profile.get', {}),
      );
      setState({ kind: 'ready', read, refreshing: false });
    } catch {
      readFailed.current = true;
      setState((current) =>
        current.kind === 'ready'
          ? { ...current, refreshing: false }
          : { kind: 'failed' },
      );
    }
  }, []);
  const { ready } = execution;
  const acknowledge = React.useCallback((record: PublicProfileOwnerRecordV1 | null) => {
    readFailed.current = false;
    setState(current => current.kind !== 'ready' ? current : { ...current,
      read: record ? { kind: 'ready', record, context: current.read.context } : { kind: 'absent', context: current.read.context },
    });
  }, []);
  React.useEffect(() => {
    if (ready) void reload();
  }, [ready, reload, scope?.serverId, scope?.accountId]);
  React.useEffect(() => {
    if (!ready || !scope) return;
    return subscribeHomeAccountChange(event => {
      if (areServerProfileIdentifiersEquivalent(event.serverId, scope.serverId)
        && homeAccountChangeAffectsPublicProfile(event)) void reload();
    }, { serverIds: [scope.serverId], reconnect: { readNotCurrent: () => readFailed.current } });
  }, [ready, reload, scope?.serverId, scope?.accountId]);
  return { state, reload, acknowledge };
}
