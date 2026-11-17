import * as React from 'react';

import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

import { useDeploymentAccountController } from './useDeploymentProject';
import { useDeploymentEnvironmentRecord } from './useDeploymentReads';

/**
 * The name of one known Environment on a server, read through the Account's shared deployment owner while a surface
 * shows it (an API token grant, a check's facts line). `name` is null until read and when it is gone or hidden;
 * `settled` tells the two apart.
 */
export function useEnvironmentName(serverId: string | null, environmentId: string | null): Readonly<{ name: string | null; settled: boolean }> {
    const { binding } = useServerCredentialAccountScopeBinding(environmentId ? serverId : null);
    const active = environmentId !== null;
    const demand = React.useMemo(() => ({ mounted: active, visible: active, focused: active }), [active]);
    const controller = useDeploymentAccountController(binding, active, demand);
    const read = useDeploymentEnvironmentRecord(controller, environmentId, demand);
    const name = read.snapshot.value?.content.name ?? null;
    const settled = read.snapshot.status === 'ready' || read.snapshot.status === 'unavailable';
    return React.useMemo(() => ({ name, settled }), [name, settled]);
}
