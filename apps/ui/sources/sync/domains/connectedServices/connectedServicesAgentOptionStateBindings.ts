import { ConnectedServiceBindingsV2IngressSchema, readBuiltInLegacyConnectedAccountServiceKeyIngress, TeamResourceConnectedServiceSelectionV2Schema, type TeamResourceConnectedServiceSelectionV2 } from '@happier-dev/protocol/connect/connected-service-bindings';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';

export type ConnectedServicesServiceBinding =
    | Readonly<{
        source: 'native';
      }>
    | Readonly<{
        source: 'connected';
        selection?: 'profile' | 'group';
        profileId?: string;
        groupId?: string;
        /** Runtime observation; never a desired account selection. */
        appliedProfileId?: string;
      }>
    | TeamResourceConnectedServiceSelectionV2;

export const CONNECTED_SERVICES_BINDINGS_KEY = 'connectedServicesBindingsByServiceId' as const;

/** An authored seed or editor choice takes precedence over Account defaults. */
export function hasConnectedServicesBindingsInAgentOptionState(
    agentOptionState: Record<string, unknown> | null | undefined,
): boolean {
    return Boolean(agentOptionState && (
        Object.prototype.hasOwnProperty.call(agentOptionState, CONNECTED_SERVICES_BINDINGS_KEY)
        || Object.prototype.hasOwnProperty.call(agentOptionState, 'connectedServices')
    ));
}

export { teamResourceConnectedServiceSelectionKey, areTeamResourceConnectedServiceSelectionsEqual } from '@happier-dev/protocol/connect/connected-service-bindings';

/**
 * The one parser for one Connected Services binding record as authored by UI
 * option state and session payload maps. Fresh values use strict admission;
 * retained maps explicitly select the canonical stored projection. Malformed
 * known fields still parse to `null` instead of guessing an intent.
 */
export function parseConnectedServicesServiceBinding(
    value: unknown,
    mode: 'input' | 'stored' = 'input',
): ConnectedServicesServiceBinding | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.source === 'team_resource') {
        const schema = mode === 'stored'
            ? createStoredReadSchema(TeamResourceConnectedServiceSelectionV2Schema)
            : TeamResourceConnectedServiceSelectionV2Schema;
        const parsed = schema.safeParse(record);
        return parsed.success ? parsed.data : null;
    }
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
            ...(mode === 'stored' && typeof record.appliedProfileId === 'string' && record.appliedProfileId.trim()
                ? { appliedProfileId: record.appliedProfileId } : {}),
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
    const options = params.agentOptionState;
    // Configuration handoffs carry the canonical envelope; editor changes
    // carry the controlled map. A later explicit edit (including Native) wins
    // over the retained seed, even when that edit's value is empty or invalid.
    const envelope = options && !Object.prototype.hasOwnProperty.call(options, CONNECTED_SERVICES_BINDINGS_KEY)
        ? createStoredReadSchema(ConnectedServiceBindingsV2IngressSchema).safeParse(options.connectedServices)
        : null;
    const raw = options && Object.prototype.hasOwnProperty.call(options, CONNECTED_SERVICES_BINDINGS_KEY)
        ? options[CONNECTED_SERVICES_BINDINGS_KEY]
        : envelope?.success ? envelope.data.bindingsByServiceId : null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

    const out: Record<string, ConnectedServicesServiceBinding | undefined> = {};
    for (const [serviceId, value] of Object.entries(raw)) {
        const canonicalServiceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(serviceId) ?? serviceId;
        // A current editor may have appended a qualified selection to a
        // retained 0.2 map. Its choice wins over the old scalar alias.
        if (canonicalServiceId !== serviceId && Object.prototype.hasOwnProperty.call(raw, canonicalServiceId)) continue;
        const binding = parseConnectedServicesServiceBinding(value, 'stored');
        if (binding) out[canonicalServiceId] = binding;
    }
    return out;
}
