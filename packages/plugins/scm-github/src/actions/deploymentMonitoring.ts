import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';

export const GITHUB_DEPLOYMENT_MONITORING_OPEN_ACTION_ID = 'github/actions/deployment-monitoring-open';
export const GithubDeploymentMonitoringOpenInputV1Schema = defineProtocolObject({
  repository: defineProtocolString({ minLength: 1 }),
  credentialRef: QualifiedConnectedAccountRefSchema.optional(),
  monitoringMachineId: defineProtocolString({ minLength: 1, pattern: '^\\S(?:.*\\S)?$' }).optional(),
}, { policy: 'closed' });
export const GithubDeploymentMonitoringOpenResultV1Schema = defineProtocolUnion([
  defineProtocolObject({ status: defineProtocolLiteral('opened') }, { policy: 'closed' }),
  defineProtocolObject({ status: defineProtocolLiteral('unavailable') }, { policy: 'closed' }),
]);

/** Opening authors a definition through the existing host; it never enrolls or observes. */
export const GITHUB_DEPLOYMENT_MONITORING_ACTIONS_V1 = {
  [GITHUB_DEPLOYMENT_MONITORING_OPEN_ACTION_ID]: {
    title: 'Open deployment monitoring setup',
    description: 'Opens the existing Automation Event editor for this repository, exact Connected Account and monitoring Machine. Opening does not enable monitoring.',
    surfaces: ['ui', 'voice', 'agent', 'mcp', 'cli', 'plugin'] as const,
    placementBindings: [], dangerLevel: 'safe' as const,
    execution: { target: 'client', client: { artifactId: 'github-forge-native', exportName: 'activate' }, platforms: ['web', 'ios', 'android'] } as const,
    inputSchema: GithubDeploymentMonitoringOpenInputV1Schema,
    resultSchema: GithubDeploymentMonitoringOpenResultV1Schema,
  },
};
