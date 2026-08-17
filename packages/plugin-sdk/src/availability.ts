import type { PluginContributionRef } from './identity.js';

export type PluginRemediationData =
    | Readonly<{ kind: 'retry' }>
    | Readonly<{ kind: 'openSettings'; path: string }>
    | Readonly<{ kind: 'selectAccount'; service: PluginContributionRef }>
    | Readonly<{ kind: 'installDependency'; dependencyId: string }>
    | Readonly<{ kind: 'openUrl'; url: string }>;

export type PluginOperationAvailability =
    | Readonly<{ status: 'available' }>
    | Readonly<{ status: 'unavailable'; code: string; remediation?: PluginRemediationData }>
    | Readonly<{ status: 'denied'; code: string; remediation?: PluginRemediationData }>;
