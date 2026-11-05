import * as React from 'react';
import type { PluginUiHostReadReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMachineServiceResource } from '@/components/machines/resources/useMachineServiceResource';
import type { MachineServicesListState } from './useMachineServices';
import { machineServicesListProjection } from './machineServicesListProjection';

type ListReference = Extract<PluginUiHostReadReferenceV1, { hostRead: 'machines.services.list' }>;

/** Visible list demand uses the one admitted list Resource; no second Action effect or timer. */
export function useMachineServicesList(input: Readonly<{ serverId: string; machineId: string; active: boolean }>):
    MachineServicesListState & Readonly<{ refresh(): Promise<void> }> {
    const { resolution, binding: lifetime } = useServerCredentialAccountScopeBinding(input.serverId);
    const resolving = resolution.kind === 'resolving' || resolution.kind === 'bound' && lifetime === null;
    const reference = React.useMemo<ListReference>(() => ({ hostRead: 'machines.services.list',
        input: { serverId: input.serverId, machineId: input.machineId } }), [input.serverId, input.machineId]);
    const resource = useMachineServiceResource({ accountLifetime: lifetime, reference,
        active: input.active, follow: true, projection: machineServicesListProjection });
    const value = resource?.value;
    const readAt = React.useMemo(() => value ? Date.now() : null, [value]);
    return {
        rows: value?.kind === 'snapshot' ? value.services : null,
        unavailable: value?.kind === 'unavailable' ? value.reason
            : input.active && !lifetime && !resolving ? 'admission_unavailable' : null,
        readAt,
        pending: input.active && (resolving || lifetime !== null && (!resource || resource.pending !== 'idle'
            || resource.value === undefined && resource.error === undefined)),
        error: resource?.error ? { code: resource.error.code ?? 'action_failed', message: resource.error.message } : null,
        refresh: resource?.refresh ?? (() => Promise.resolve()),
    };
}
