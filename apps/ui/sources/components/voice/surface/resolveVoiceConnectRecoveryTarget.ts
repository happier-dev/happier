import {
    BuiltInLegacyConnectedServiceBindingsV1IngressSchema,
    readBuiltInLegacyConnectedAccountServiceKeyIngress,
    type PluginContributionIdentityV1,
} from '@happier-dev/protocol';

import type {
    ConnectedServiceRegistryEntry,
} from '@/sync/domains/connectedServices/connectedServiceRegistry';
import {
    buildConnectedAccountSettingsRoute,
    resolveConnectedAccountSettingsRoute,
} from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import {
    readSessionConnectedServiceBindings,
} from '@/sync/domains/connectedServices/readSessionConnectedServiceBindings';
import type {
    ExternalVoiceProviderSettingsDescriptor,
} from '@/voice/settings/externalProviderSettings';

export type VoiceConnectRecoveryTarget =
    | Readonly<{ kind: 'default' }>
    | Readonly<{ kind: 'provider_settings' }>
    | Readonly<{
        kind: 'exact';
        route: ReturnType<typeof buildConnectedAccountSettingsRoute>;
    }>
    | Readonly<{ kind: 'unavailable' }>;

type VoiceConnectRecoveryProviderContext = Readonly<{
    sourcePluginId: string | null;
    connectedServicesBinding:
        ExternalVoiceProviderSettingsDescriptor['connectedServicesBinding'];
}>;

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function resolveBindingAgent(params: Readonly<{
    bindingAgent: NonNullable<
        ExternalVoiceProviderSettingsDescriptor['connectedServicesBinding']
    >['agent'];
    sourcePluginId: string | null;
}>): PluginContributionIdentityV1 | null {
    if (typeof params.bindingAgent !== 'string') {
        return params.bindingAgent;
    }
    return params.sourcePluginId
        ? {
            pluginId: params.sourcePluginId,
            localId: params.bindingAgent,
        }
        : null;
}

export function resolveVoiceConnectRecoveryTarget(params: Readonly<{
    agentRuntime: PluginContributionIdentityV1 | null;
    bindingScope: 'global' | 'session';
    runtimeTarget: Readonly<{ serverId: string; machineId: string }> | null;
    provider: VoiceConnectRecoveryProviderContext | null;
    providerConfig: unknown;
    sessionMetadata: unknown;
    connectedServiceEntries: readonly ConnectedServiceRegistryEntry[];
}>): VoiceConnectRecoveryTarget {
    const connectedServicesBinding = params.provider?.connectedServicesBinding;
    if (!connectedServicesBinding) {
        return params.bindingScope === 'global'
            ? { kind: 'default' }
            : { kind: 'unavailable' };
    }

    let rawBinding: unknown;
    if (params.bindingScope === 'session') {
        if (!params.agentRuntime) return { kind: 'unavailable' };
        const sessionBindings = readSessionConnectedServiceBindings({
            metadata: params.sessionMetadata,
            agentId: params.agentRuntime.localId,
        });
        if (!sessionBindings) return { kind: 'unavailable' };
        rawBinding = sessionBindings;
    } else {
        const config = readRecord(params.providerConfig);
        if (!config) return { kind: 'provider_settings' };
        rawBinding = config[connectedServicesBinding.id];
        if (rawBinding === null || rawBinding === undefined) {
            return { kind: 'provider_settings' };
        }
    }

    const bindings = BuiltInLegacyConnectedServiceBindingsV1IngressSchema.safeParse(rawBinding);
    if (!bindings.success) {
        return params.bindingScope === 'global'
            ? { kind: 'provider_settings' }
            : { kind: 'unavailable' };
    }

    const bindingAgent = resolveBindingAgent({
        bindingAgent: connectedServicesBinding.agent,
        sourcePluginId: params.provider?.sourcePluginId ?? null,
    });
    if (
        !bindingAgent
        || !params.agentRuntime
        || bindingAgent.pluginId !== params.agentRuntime.pluginId
        || bindingAgent.localId !== params.agentRuntime.localId
        || !params.runtimeTarget
        || connectedServicesBinding.serviceIds.length !== 1
    ) {
        return { kind: 'unavailable' };
    }

    const declaredServiceId = connectedServicesBinding.serviceIds[0];
    const serviceId = readBuiltInLegacyConnectedAccountServiceKeyIngress(declaredServiceId);
    if (!serviceId) return { kind: 'unavailable' };
    const selection = bindings.data.bindingsByServiceId[serviceId];
    if (!selection || selection.source !== 'connected') {
        return params.bindingScope === 'global'
            ? { kind: 'provider_settings' }
            : { kind: 'unavailable' };
    }

    const legacyRoute = selection.selection === 'group'
        ? { serviceId, groupId: selection.groupId }
        : { serviceId, profileId: selection.profileId };
    const resolved = resolveConnectedAccountSettingsRoute(
        legacyRoute,
        params.connectedServiceEntries,
    );
    if (!resolved) return { kind: 'unavailable' };

    return {
        kind: 'exact',
        route: buildConnectedAccountSettingsRoute(
            resolved.service,
            resolved.focus,
        ),
    };
}
