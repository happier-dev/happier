import * as React from 'react';

import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

import { useDeploymentAccountController } from './useDeploymentProject';
import { useDeploymentEnvironmentRecord } from './useDeploymentReads';

/**
 * One known Environment's record on a server, read through the Account's shared deployment owner while a surface
 * shows it (an API token grant, a check's facts line, an Environment update's approval). `value` is null until read
 * and when it is gone or hidden; `settled` tells the two apart.
 */
export function useEnvironmentRecord(serverId: string | null, environmentId: string | null) {
    const { binding } = useServerCredentialAccountScopeBinding(environmentId ? serverId : null);
    const active = environmentId !== null;
    const demand = React.useMemo(() => ({ mounted: active, visible: active, focused: active }), [active]);
    const controller = useDeploymentAccountController(binding, active, demand);
    const read = useDeploymentEnvironmentRecord(controller, environmentId, demand);
    const value = read.snapshot.value ?? null;
    const settled = read.snapshot.status === 'ready' || read.snapshot.status === 'unavailable';
    return React.useMemo(() => ({ value, settled }), [value, settled]);
}

/** The name of one known Environment on a server (see `useEnvironmentRecord`). */
export function useEnvironmentName(serverId: string | null, environmentId: string | null): Readonly<{ name: string | null; settled: boolean }> {
    const { value, settled } = useEnvironmentRecord(serverId, environmentId);
    const name = value?.content.name ?? null;
    return React.useMemo(() => ({ name, settled }), [name, settled]);
}
