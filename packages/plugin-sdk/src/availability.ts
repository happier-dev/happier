import type { PluginRemediationData } from '@happier-dev/cli-common/plugins/errors';
export type { PluginRemediationData } from '@happier-dev/cli-common/plugins/errors';

/** Declarative availability data is admitted by the host, not interpreted by authors. */
export type PluginAvailabilityDescriptor = unknown;


export type PluginOperationAvailability =
    | Readonly<{ status: 'available' }>
    | Readonly<{ status: 'unavailable'; code: string; remediation?: PluginRemediationData }>
    | Readonly<{ status: 'denied'; code: string; remediation?: PluginRemediationData }>;
