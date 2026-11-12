import * as React from 'react';
import { isDeploymentReadDemandActiveV1, type DeploymentReadControllerV1, type DeploymentReadDemandV1 } from '@happier-dev/deployments';
import { projectDeploymentPromotionBindingGaps, type DeploymentPromotionBindingGap } from './deploymentPreflightWarnings';
import { useDeploymentEnvironmentRecord } from './useDeploymentReads';

export type DeploymentPromotionBindingGapResult =
    | Readonly<{ status: 'idle' | 'loading' }>
    | Readonly<{ status: 'ready'; gaps: readonly DeploymentPromotionBindingGap[] }>
    | Readonly<{ status: 'unavailable'; side: 'source' | 'destination'; reason: string; retryable: boolean }>;

/** Selected exact records share the existing controller's demand, invalidation and failure lifecycle. */
export function useDeploymentPromotionBindingGaps(controller: DeploymentReadControllerV1 | null,
    sourceEnvironmentId: string | null, destinationEnvironmentId: string | null, demand: DeploymentReadDemandV1,
): Readonly<{ result: DeploymentPromotionBindingGapResult; retry(): Promise<void> }> {
    const selected = Boolean(sourceEnvironmentId && destinationEnvironmentId);
    const source = useDeploymentEnvironmentRecord(controller, selected ? sourceEnvironmentId : null, demand);
    const destination = useDeploymentEnvironmentRecord(controller, selected ? destinationEnvironmentId : null, demand);
    const sourceBindings = source.snapshot.value?.content.bindings;
    const destinationBindings = destination.snapshot.value?.content.bindings;
    const gaps = React.useMemo(() => sourceBindings && destinationBindings
        ? projectDeploymentPromotionBindingGaps(sourceBindings, destinationBindings) : [], [sourceBindings, destinationBindings]);
    const retry = React.useCallback(() => Promise.all([source.refresh(), destination.refresh()]).then(() => {}),
        [source.refresh, destination.refresh]);
    let result: DeploymentPromotionBindingGapResult;
    if (!selected || !isDeploymentReadDemandActiveV1(demand)) result = { status: 'idle' };
    else if (!controller) result = { status: 'unavailable', side: 'source', reason: 'deployment_unavailable', retryable: false };
    else if (source.snapshot.status === 'unavailable') result = { status: 'unavailable', side: 'source',
        reason: source.snapshot.failure?.code ?? 'deployment_unavailable', retryable: source.snapshot.failure?.retryable ?? false };
    else if (destination.snapshot.status === 'unavailable') result = { status: 'unavailable', side: 'destination',
        reason: destination.snapshot.failure?.code ?? 'deployment_unavailable', retryable: destination.snapshot.failure?.retryable ?? false };
    else if (source.snapshot.status !== 'ready' || destination.snapshot.status !== 'ready') result = { status: 'loading' };
    else result = { status: 'ready', gaps };
    return { result, retry };
}
