import type {
    ConnectedAccountServiceKey,
    ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

export function buildConnectedServiceSwitchContinuationAttemptId(input: Readonly<{
    action: 'hot_applied' | 'restart_requested';
    serviceIds: ReadonlySet<ConnectedAccountServiceKey>;
    normalizedBindings: ConnectedServiceBindingsV1;
    expectedGroupGenerationByServiceId?: Readonly<Record<string, number>>;
}>): string {
    const parts = [...input.serviceIds]
        .sort()
        .map((serviceId) => {
            const binding = input.normalizedBindings.bindingsByServiceId[serviceId];
            if (!binding || binding.source !== 'connected') return `${serviceId}:native`;
            if (binding.selection === 'group') {
                const generation = input.expectedGroupGenerationByServiceId?.[serviceId];
                return [
                    serviceId,
                    'group',
                    binding.groupId,
                    binding.profileId ?? '',
                    typeof generation === 'number' ? String(generation) : '',
                ].join(':');
            }
            return [serviceId, 'profile', binding.profileId].join(':');
        });
    return ['connected-service-auth-switch', input.action, ...parts].join('|');
}
