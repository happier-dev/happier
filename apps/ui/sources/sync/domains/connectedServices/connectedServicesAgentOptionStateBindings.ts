export type ConnectedServicesServiceBinding = Readonly<{
    source: 'native' | 'connected';
    selection?: 'profile' | 'group';
    profileId?: string;
    groupId?: string;
}>;

export const CONNECTED_SERVICES_BINDINGS_KEY = 'connectedServicesBindingsByServiceId' as const;

export function parseConnectedServicesBindingsByServiceIdFromAgentOptionState(params: Readonly<{
    agentOptionState: Record<string, unknown> | null | undefined;
}>): Readonly<Record<string, ConnectedServicesServiceBinding | undefined>> {
    const raw = params.agentOptionState?.[CONNECTED_SERVICES_BINDINGS_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

    const out: Record<string, ConnectedServicesServiceBinding | undefined> = {};
    for (const [serviceId, value] of Object.entries(raw)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const record = value as Record<string, unknown>;
        if (record.source === 'native') {
            out[serviceId] = { source: 'native' };
            continue;
        }
        if (record.source !== 'connected') continue;
        const profileId = typeof record.profileId === 'string' ? record.profileId : undefined;
        const groupId = typeof record.groupId === 'string' ? record.groupId : undefined;
        if (record.selection === 'group' && groupId) {
            out[serviceId] = {
                source: 'connected',
                selection: 'group',
                groupId,
                ...(profileId ? { profileId } : {}),
            };
            continue;
        }
        out[serviceId] = {
            source: 'connected',
            ...(profileId ? { profileId } : {}),
        };
    }
    return out;
}
