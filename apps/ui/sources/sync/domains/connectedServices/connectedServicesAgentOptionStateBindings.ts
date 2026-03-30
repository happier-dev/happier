export type ConnectedServicesServiceBinding = Readonly<{
    source: 'native' | 'connected';
    profileId?: string;
}>;

export const CONNECTED_SERVICES_BINDINGS_KEY = 'connectedServicesBindingsByServiceId' as const;

export function parseConnectedServicesBindingsByServiceIdFromAgentOptionState(params: Readonly<{
    agentOptionState: Record<string, unknown> | null | undefined;
}>): Readonly<Record<string, ConnectedServicesServiceBinding | undefined>> {
    const raw = params.agentOptionState?.[CONNECTED_SERVICES_BINDINGS_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as Record<string, ConnectedServicesServiceBinding | undefined>;
}
