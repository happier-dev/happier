export type ConnectedServicesServiceBinding = Readonly<{
    source: 'native' | 'connected';
    selection?: 'profile' | 'group';
    profileId?: string;
    groupId?: string;
}>;

export const CONNECTED_SERVICES_BINDINGS_KEY = 'connectedServicesBindingsByServiceId' as const;

/**
 * The one parser for one Connected Services binding record as authored by UI
 * option state and session payload maps. Unknown/malformed records parse to
 * `null` instead of guessing an intent.
 */
export function parseConnectedServicesServiceBinding(value: unknown): ConnectedServicesServiceBinding | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.source === 'native') {
        return { source: 'native' };
    }
    if (record.source !== 'connected') return null;
    const profileId = typeof record.profileId === 'string' ? record.profileId : undefined;
    const groupId = typeof record.groupId === 'string' ? record.groupId : undefined;
    if (record.selection === 'group' && groupId) {
        return {
            source: 'connected',
            selection: 'group',
            groupId,
            ...(profileId ? { profileId } : {}),
        };
    }
    return {
        source: 'connected',
        ...(profileId ? { profileId } : {}),
    };
}

export function parseConnectedServicesBindingsByServiceIdFromAgentOptionState(params: Readonly<{
    agentOptionState: Record<string, unknown> | null | undefined;
}>): Readonly<Record<string, ConnectedServicesServiceBinding | undefined>> {
    const raw = params.agentOptionState?.[CONNECTED_SERVICES_BINDINGS_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

    const out: Record<string, ConnectedServicesServiceBinding | undefined> = {};
    for (const [serviceId, value] of Object.entries(raw)) {
        const binding = parseConnectedServicesServiceBinding(value);
        if (binding) out[serviceId] = binding;
    }
    return out;
}
