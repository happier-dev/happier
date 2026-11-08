import { t } from '@/text';

/** Saved gateway service intent, shared by its collection row and detail header. */
export function presentProviderGatewayServiceSummary(input: Readonly<{
    enabled: boolean;
    services: string;
    agents?: string;
}>): string {
    if (!input.enabled) return t('connectedServicesCollection.railGatewayOff', { services: input.services });
    if (!input.services) return t('connectedServices.purposeTargets.notSet');
    return input.agents
        ? t('connectedServicesCollection.railGatewayServesTo', { services: input.services, agents: input.agents })
        : t('connectedServicesCollection.railGatewayServes', { services: input.services });
}
