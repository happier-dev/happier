import type { CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';

export function buildProviderCliCapabilityId(providerId: string): Extract<CapabilityId, `cli.${string}`> {
    return `cli.${providerId}` as Extract<CapabilityId, `cli.${string}`>;
}
