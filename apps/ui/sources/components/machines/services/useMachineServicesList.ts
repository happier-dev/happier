import * as React from 'react';
import type { PluginUiHostReadReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMachineServiceResource } from '@/components/machines/resources/useMachineServiceResource';
import type { MachineServicesListState } from './useMachineServices';
import { machineServicesListProjection } from './machineServicesListProjection';

type ListReference = Extract<PluginUiHostReadReferenceV1, { hostRead: 'machines.services.list' }>;
type ListQuery = Readonly<ListReference['input'] & { active: boolean }>;

/** Visible list demand uses the one admitted list Resource; no second Action effect or timer. */
export function useMachineServicesList(input: ListQuery) {
    const { resolution, binding } = useServerCredentialAccountScopeBinding(input.serverId);
    const resolving = resolution.kind === 'resolving' || resolution.kind === 'bound' && binding === null;
    return useAdmittedMachineServicesList(input, binding, resolving);
}

/** Allows a surface that already admitted its Account scope to consume the same list Resource. */
export function useAdmittedMachineServicesList(input: ListQuery | null, lifetime: ServerAccountScopeLifetime | null, resolving = false):
    MachineServicesListState & Readonly<{ firstInventoryCount: number | null; coverage: 'managed_services' | null; refresh(): Promise<void> }> {
    const { serverId, machineId, environmentId, composeService, preflight } = input ?? {};
    const active = input?.active ?? false;
    const reference = React.useMemo<ListReference | null>(() => serverId === undefined || machineId === undefined ? null : ({
        hostRead: 'machines.services.list', input: { serverId, machineId,
            ...(environmentId ? { environmentId } : {}),
            ...(composeService ? { composeService } : {}),
            ...(preflight ? { preflight } : {}) },
    }), [serverId, machineId, environmentId, composeService, preflight]);
    const resource = useMachineServiceResource({ accountLifetime: lifetime, reference,
        resolving, active, follow: true, projection: machineServicesListProjection });
    const value = resource?.value;
    const readAt = React.useMemo(() => value ? Date.now() : null, [value]);
    return {
        rows: value?.kind === 'snapshot' ? value.services : null,
        firstInventoryCount: value?.firstInventoryCount ?? null,
        coverage: value?.kind === 'snapshot' ? value.coverage ?? null : null,
        unavailable: value?.kind === 'unavailable' ? value.reason
            : active && !lifetime && !resolving ? 'admission_unavailable' : null,
        readAt,
        pending: active && (resolving || lifetime !== null && (!resource || resource.pending !== 'idle'
            || resource.value === undefined && resource.error === undefined)),
        error: resource?.error ? { ...resource.error, code: resource.error.code ?? 'action_failed' } : null,
        refresh: resource?.refresh ?? (() => Promise.resolve()),
    };
}
