import * as React from 'react';
import type { DeploymentPublishPrepareInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { prepareCatalogAppPublish } from '@/sync/ops/actions/deploymentPublishActions';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

/** Store/New app explicitly enter the existing pinned template preparation; mounting does no work. */
export function useCatalogAppPreparation(lifetime: ServerAccountScopeLifetime) {
    const execute = React.useMemo(() => createFrontDoorActionExecute(), [lifetime]);
    return React.useCallback((input: DeploymentPublishPrepareInputV1, signal?: AbortSignal) =>
        prepareCatalogAppPublish(input, lifetime, (actionId, operand, options) => execute(actionId, operand, {
            surface: 'ui', serverId: lifetime.scope.serverId, expectedAccountId: lifetime.scope.accountId,
            signal: options?.signal,
        }), signal), [execute, lifetime]);
}
