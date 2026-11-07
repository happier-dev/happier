import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

/**
 * Managed detail/configuration links without a Home belong to the current Home.
 * An explicit route scope always wins, including an unknown Home: `KnownHomeGate`
 * owns its refusal, rather than retrying against another Home.
 */
export function useManagedMachineRouteScope(value: string | string[] | undefined): string {
    const requested = (Array.isArray(value) ? value[0] : value)?.trim() ?? '';
    const currentHome = useActiveServerSnapshot(!requested);
    return resolveServerProfileScopeIdForIdentifier(requested || currentHome.serverId);
}
