import * as React from 'react';
import {
  listUsageAppEnvironments,
  type UsageAppEnvironment,
} from '@/sync/api/account/usageAppCallsAccounting';
import { createFrontDoorUiActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/**
 * The viewer's app Environments that Usage can offer under "Your apps": one header list per mounted page and
 * Account. Until it answers, or when it cannot (no deployments, no access), Sources offers Agents only.
 */
export function useUsageAppEnvironments(
  authority: ServerAccountScopeLifetime | null,
): readonly UsageAppEnvironment[] | null {
  const [read, setRead] = React.useState<Readonly<{
    authority: ServerAccountScopeLifetime;
    environments: readonly UsageAppEnvironment[];
  }> | null>(null);
  React.useEffect(() => {
    if (!authority?.isCurrent()) return;
    const controller = new AbortController();
    const retired = authority.onRetire(() => controller.abort());
    const { serverId, accountId } = authority.scope;
    void listUsageAppEnvironments(
      createFrontDoorUiActionExecutor(undefined, {
        serverId,
        expectedAccountId: accountId,
      }),
      serverId,
      controller.signal,
    ).then(
      (environments) => {
        if (!controller.signal.aborted && authority.isCurrent())
          setRead({ authority, environments });
      },
      () => {
        /* Not offering Your apps is this read's only failure presentation. */
      },
    );
    return () => {
      retired.dispose();
      controller.abort();
    };
  }, [authority]);
  return read?.authority === authority ? read.environments : null;
}
