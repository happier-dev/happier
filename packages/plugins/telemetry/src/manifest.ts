import { createLocalCaptureContribution, LOCAL_CAPTURE_DATABASE_ENVIRONMENT_NAMES, LOCAL_CAPTURE_ENVIRONMENT_NAMES } from './contribution.js';
import { definePlugin, PluginError } from '@happier-dev/plugin-sdk';
import { DATABASE_TELEMETRY_MACHINE_ROLE_CATALOG_V1 } from '@happier-dev/plugin-sdk/protocol';
import { DATABASE_CAPTURE_RESOURCE_ID_V1, databaseActionLocalIdV1, TELEMETRY_KEY_FLOW_CHECK_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import { localCaptureBackground } from './background.js';
import { telemetryCollectorRunner } from './telemetry/runner.js';
import { telemetryExceptionManifestParts } from './exceptions/contribution.js';
import { createCaptureActions, createCapturePublicActionProducers } from './actions.js';
import { createCaptureResourceRuntime } from './resources.js';
import { telemetryPartition } from './telemetry/assignments.js';
import { telemetryHealthActions } from './health.js';
import { keyFlowConfigSchema } from './healthSchemas.js';
import { telemetryRegressionActions } from './regression.js';
import { TELEMETRY_REGRESSION_WORKFLOW_ID_V1, TELEMETRY_REGRESSION_WORKFLOW_V1 } from './regressionWorkflow.js';

// R16 host admission owns requester access and collector placement. Reads keep
// the existing capture projection and do not acquire write authority.
const { clearCapture: _clear, ...captureReads } = createCapturePublicActionProducers({
 acquireRuntime: localCaptureBackground.acquireRuntime,
 async admitSource({ source }, context) {
  if (source.kind !== 'environment') throw new PluginError({ code: 'capture_source_unavailable' });
  const admit = context.services.deploymentDatabases?.admitTelemetryRead;
  if (!admit) throw new PluginError({ code: 'deployment_target_role_unavailable' });
  await admit({ serverId: source.serverId, environmentId: source.environmentId });
  return { source, partition: telemetryPartition(source.environmentId) };
 },
});

export const DATABASE_CAPTURE_PLUGIN = definePlugin({
 id: 'happier.telemetry', version: '0.0.0', displayName: 'Telemetry',
 description: 'Machine-local database observations and application telemetry.',
 entrypoints: { daemon: './dist/index.js' },
 hostAccess: { required: [], optional: [{ id: 'account-storage', capability: 'storage.account', reason: 'Read the Project capture preference and keep native exception issues.', scope: { enabled: true } }] },
 machineRoles: {
  local: { title: 'Local database capture', description: 'Record database observations and application telemetry for local Workspaces.', partOf: 'workspaces', backgroundServices: ['local-capture'] },
  telemetry: { title: 'Telemetry', description: 'Collect telemetry from deployed applications.', defaultActive: DATABASE_TELEMETRY_MACHINE_ROLE_CATALOG_V1[0].defaultActive, backgroundServices: ['telemetry-collector'] },
 },
 daemonDatabases: { capture: localCaptureBackground.databaseDefinition },
 resources: { [DATABASE_CAPTURE_RESOURCE_ID_V1]: {
  source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'surface', execution: { target: 'daemon' },
  runtime: createCaptureResourceRuntime({ subscribe: localCaptureBackground.subscribe }),
 } },
 actions: { ...createCaptureActions(captureReads), ...telemetryHealthActions, ...telemetryRegressionActions, ...telemetryExceptionManifestParts.actions },
 accountCollections: telemetryExceptionManifestParts.accountCollections,
 notifications: telemetryExceptionManifestParts.notifications,
 events: telemetryExceptionManifestParts.events,
 workflows: { [TELEMETRY_REGRESSION_WORKFLOW_ID_V1]: TELEMETRY_REGRESSION_WORKFLOW_V1 },
 healthCheckKinds: { 'key-flow': { title: 'Key flow', configSchema: keyFlowConfigSchema.jsonSchema,
  action: databaseActionLocalIdV1(TELEMETRY_KEY_FLOW_CHECK_ACTION_ID_V1) } },
 backgroundServices: [
  { declaration: { id: 'local-capture', title: 'Local database capture', placement: 'daemon', activation: 'continuous' }, runner: localCaptureBackground.run },
  { declaration: { id: 'telemetry-collector', title: 'Production telemetry', placement: 'daemon', activation: 'continuous' }, runner: telemetryCollectorRunner },
 ],

 serviceLaunchEnvironments: { 'capture-launch': { declaration: { environmentNames: [...LOCAL_CAPTURE_ENVIRONMENT_NAMES] }, runtime: createLocalCaptureContribution({
  environmentNames: LOCAL_CAPTURE_DATABASE_ENVIRONMENT_NAMES, readEnabled: localCaptureBackground.readEnabled, acquireLocalCapture: localCaptureBackground.acquireLocalCapture,
 }) } },
});
export const PLUGIN_MANIFEST = DATABASE_CAPTURE_PLUGIN.manifest;
export const activate = DATABASE_CAPTURE_PLUGIN.activate;
