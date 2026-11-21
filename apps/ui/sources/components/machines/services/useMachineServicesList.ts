import * as React from 'react';
import type { PluginUiHostReadReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMachineServiceResource } from '@/components/machines/resources/useMachineServiceResource';
import type { MachineServicesListState } from './useMachineServices';
import { machineServicesListProjection } from './machineServicesListProjection';

type ListReference = Extract<PluginUiHostReadReferenceV1, { hostRead: 'machines.services.list' }>;

/** Visible list demand uses the one admitted list Resource; no second Action effect or timer. */
export function useMachineServicesList(input: Readonly<ListReference['input'] & { active: boolean }>):
    MachineServicesListState & Readonly<{ firstInventoryCount: number | null; coverage: 'managed_services' | null; refresh(): Promise<void> }> {
    const { resolution, binding: lifetime } = useServerCredentialAccountScopeBinding(input.serverId);
    const resolving = resolution.kind === 'resolving' || resolution.kind === 'bound' && lifetime === null;
    const reference = React.useMemo<ListReference>(() => ({ hostRead: 'machines.services.list',
        input: { serverId: input.serverId, machineId: input.machineId,
            ...(input.environmentId ? { environmentId: input.environmentId } : {}),
            ...(input.composeService ? { composeService: input.composeService } : {}),
            ...(input.preflight ? { preflight: input.preflight } : {}) } }),
        [input.serverId, input.machineId, input.environmentId, input.composeService, input.preflight]);
    const resource = useMachineServiceResource({ accountLifetime: lifetime, reference,
        resolving, active: input.active, follow: true, projection: machineServicesListProjection });
    const value = resource?.value;
    const readAt = React.useMemo(() => value ? Date.now() : null, [value]);
    return {
        rows: value?.kind === 'snapshot' ? value.services : null,
        firstInventoryCount: value?.firstInventoryCount ?? null,
        coverage: value?.kind === 'snapshot' ? value.coverage ?? null : null,
        unavailable: value?.kind === 'unavailable' ? value.reason
            : input.active && !lifetime && !resolving ? 'admission_unavailable' : null,
        readAt,
        pending: input.active && (resolving || lifetime !== null && (!resource || resource.pending !== 'idle'
            || resource.value === undefined && resource.error === undefined)),
        error: resource?.error ? { ...resource.error, code: resource.error.code ?? 'action_failed' } : null,
        refresh: resource?.refresh ?? (() => Promise.resolve()),
    };
}
