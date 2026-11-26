import * as React from 'react';

import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';

import { teamReadFailureLabel } from './teamMutationPresentation';
import { useTeamReadFailureAction } from './useTeamReadFailureAction';

/**
 * A Team read that failed, said in the place its rows would stand: the owner's label and its one way forward.
 * Retry when asking again can help (quiet while the page's unreachable-Home banner already explains it), the
 * sign-in or Action-setting repair when that is the cause, nothing for a settled refusal.
 */
export const TeamReadFailureRows = React.memo(function TeamReadFailureRows(
  props: Readonly<{
    testID: string;
    failure: HomeDomainFailure<string> | ScopedSnapshotError;
    onRetry: () => void | Promise<unknown>;
    /** The Team whose sign-in a refusal may lead to. */
    address?: TeamAddress;
    serverId: string;
  }>,
) {
  const failureAction = useTeamReadFailureAction(props.address);
  const recovery = failureAction(props.failure, {
    onPress: props.onRetry,
    testIDPrefix: props.testID,
  });
  const reason = teamReadFailureLabel(props.failure);
  if (recovery?.onPress === props.onRetry) {
    return (
      <ItemLoadStateRows
        testID={props.testID}
        state={{
          kind: 'failed',
          reason,
          onRetry: props.onRetry,
          homeServerIds: [props.serverId],
        }}
      />
    );
  }
  return (
    <SurfaceStateCard
      testID={props.testID}
      kind="error"
      size="line"
      title={reason}
      accessibilitySemantics="alert"
      action={recovery ?? undefined}
    />
  );
});
