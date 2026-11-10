import { defineProtocolNumber, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { MACHINE_SERVICES_PLUGIN_ID } from './healthSetup.js';

const endpoint = defineProtocolString({ minLength: 1 }).optional();
const observingSince = defineProtocolNumber({ integer: true, minimum: 0 }).optional();
export const monitorDefinitions = {
    'uptime-kuma': { title: 'Uptime Kuma', description: 'Import one monitor’s failure and recovery',
        webhookContributionId: 'health-uptime-kuma', observedEventId: 'health-uptime-kuma-observed',
        configSchema: defineProtocolObject({ monitorId: defineProtocolString({ pattern: '^[1-9][0-9]*$' }),
            webhookEndpointId: endpoint, observingSince }, { policy: 'closed' }) },
    gatus: { title: 'Gatus', description: 'Import one endpoint’s failure and recovery',
        webhookContributionId: 'health-gatus', observedEventId: 'health-gatus-observed',
        configSchema: defineProtocolObject({ endpointGroup: defineProtocolString(), endpointName: defineProtocolString({ minLength: 1 }),
            webhookEndpointId: endpoint, observingSince }, { policy: 'closed' }) },
} as const;
export type MonitorKind = keyof typeof monitorDefinitions;
export const monitorKinds = Object.keys(monitorDefinitions) as MonitorKind[];
export const monitorCapabilityContributions = Object.fromEntries(monitorKinds.map(kind => [kind, monitorDefinitions[kind].webhookContributionId]));
export const monitorObserved = defineProtocolObject({ sourceInstanceId: defineProtocolString({ minLength: 1 }),
    checkId: defineProtocolString({ minLength: 1 }), webhookEndpointId: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });

export function isMonitorKind(localId: string): localId is MonitorKind {
    return Object.hasOwn(monitorDefinitions, localId);
}

export function isMonitorCheck<T extends Readonly<{ kind: Readonly<{ pluginId: string; localId: string }> }>>(
    check: T,
): check is T & Readonly<{ kind: Readonly<{ localId: MonitorKind }> }> {
    return check.kind.pluginId === MACHINE_SERVICES_PLUGIN_ID && isMonitorKind(check.kind.localId);
}
