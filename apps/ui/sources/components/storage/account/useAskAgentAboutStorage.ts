import * as React from 'react';

import { resolvePreferredLaunchMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';
import { navigateToNewSessionSeedPage } from '@/components/sessions/new/newSessionSeedNavigation';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getStorage } from '@/sync/domains/state/storageStore';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { openSessionAuthoringSeed } from '@/sync/ops/actions/openSessionAuthoringSeed';
import type { SessionAuthoringOpenOutcome } from '@/sync/ops/actions/sessionAuthoringActions';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';

/**
 * The Storage view's "Ask an agent" cards: one ordinary new-Session draft seeded with the card's prompt, through the
 * admitted `session.authoring.open` Action (the same entry Pets' "Create a pet" uses), with the person's usual agent.
 * The agent then reads and proposes through the storage Actions (`storage.inventory.read`, `artifact.delete`), each
 * deletion asking first.
 */
export function useAskAgentAboutStorage(): (
  prompt: string,
) => Promise<SessionAuthoringOpenOutcome> {
  return React.useCallback(async (prompt: string) => {
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime)
      return { kind: 'stale' as const, reason: 'host_retired' as const };
    // Read on the person's press: the cards need no live Machine/history subscription.
    const state = getStorage().getState();
    const machines = resolveVisibleMachinesForActiveServerFromState(state);
    const recentMachinePaths = state.authoringMemory.recentMachinePaths;
    const machineId = resolvePreferredLaunchMachineId({
      scope: lifetime.scope,
      machines,
      recentMachinePaths,
      preferredMachineId: recentMachinePaths[0]?.machineId,
    });
    const machine = machines.find((item) => item.id === machineId);
    const directory = resolveAbsolutePath('~', machine?.metadata?.homeDir);
    let navigation: Promise<boolean> | undefined;
    const outcome = await openSessionAuthoringSeed({
      scope: lifetime.scope,
      accountLifetime: lifetime,
      isCurrent: lifetime.isCurrent,
      seed: {
        prompt,
        placement: machineId
          ? {
              kind: 'exactTarget',
              serverId: lifetime.scope.serverId,
              machineId,
              directory,
            }
          : { kind: 'currentTarget', directory },
      },
      navigateToNewSession: (input) => {
        navigation = navigateToNewSessionSeedPage(
          input,
          lifetime.scope,
          lifetime.isCurrent,
        );
      },
    });
    if (navigation && !(await navigation))
      return {
        kind: 'unavailable' as const,
        reason: 'navigation_unavailable' as const,
      };
    return outcome;
  }, []);
}
