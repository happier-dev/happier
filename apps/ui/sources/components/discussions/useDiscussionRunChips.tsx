import * as React from 'react';
import type { DiscussionAddressV1 } from '@happier-dev/protocol/discussions';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useDiscussionWorkflowRun } from './useDiscussionWorkflowRun';

/**
 * The Discussion opens a definition reference; the mounted Start body owns Where and admission.
 */
export function useDiscussionRunChips(
  params: Readonly<{
    discussion: DiscussionAddressV1;
    accountLifetime: ServerAccountScopeLifetime;
    paneScopeId: string;
    disabled: boolean;
  }>,
): Readonly<{ chips: readonly AgentInputExtraActionChip[]; capture: ReturnType<typeof useDiscussionWorkflowRun>['saveAsPattern'] }> {
  const run = useDiscussionWorkflowRun({
    discussion: params.discussion,
    accountLifetime: params.accountLifetime,
    paneScopeId: params.paneScopeId,
    disabled: params.disabled,
  });
  const chips = React.useMemo(() => [run.chip], [run.chip]);
  return { chips, capture: run.saveAsPattern };
}
