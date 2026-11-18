import { createLocalCaptureContribution, LOCAL_CAPTURE_DATABASE_ENVIRONMENT_NAMES, LOCAL_CAPTURE_ENVIRONMENT_NAMES } from './contribution.js';
import { definePlugin, PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { DATABASE_TELEMETRY_MACHINE_ROLE_CATALOG_V1 } from '@happier-dev/plugin-sdk/protocol';
import { DATABASE_CAPTURE_CLEAR_ACTION_ID_V1, DATABASE_CAPTURE_RESOURCE_ID_V1, databaseActionLocalIdV1, TELEMETRY_KEY_FLOW_CHECK_ACTION_ID_V1,
    TELEMETRY_KEY_FLOW_HEALTH_KIND_V1 } from '@happier-dev/database-protocol';
import { TELEMETRY_REQUESTS_FIELD_ID_V1, TELEMETRY_REQUESTS_LIST_EXTENSION_ID_V1 } from '@happier-dev/database-protocol';
import { localCaptureBackground } from './background.js';
import { telemetryCollectorRunner } from './telemetry/runner.js';
import { telemetryExceptionManifestParts, telemetryExceptionSourceContribution } from './exceptions/contribution.js';
import { createCaptureActionProducers, createCaptureActions, createCapturePublicActionProducers } from './actions.js';
import { createCaptureResourceRuntime } from './resources.js';
import { captureSourcePartition } from './partition.js';
import { telemetryHealthActions } from './health.js';
import { keyFlowConfigSchema } from './healthSchemas.js';
import { telemetryRegressionActions } from './regression.js';
import { TELEMETRY_REGRESSION_WORKFLOW_ID_V1, TELEMETRY_REGRESSION_WORKFLOW_V1 } from './regressionWorkflow.js';
import { TELEMETRY_WIDGET_RENDERERS, TELEMETRY_WIDGET_VIEWS } from './widgets.js';

/** Local sources (the requester's own Machine and worktrees) are admitted for the Account that
 * recorded them: the source must be on this executing Machine, and the requester's Account selects
 * its own partition. Environment telemetry keeps R16 host admission (D39). Clear deletes data, so it
 * is local only: a reader of shared Environment telemetry cannot clear it for the team. */
function localCaptureOwner(machineId: string, context: PluginInvocationContext): string {
 const accountId = context.requesterAccount?.accountId;
 if (!accountId || context.chosenMachine?.machineId !== machineId) throw new PluginError({ code: 'capture_source_unavailable' });
 return accountId;
}

const capture = createCapturePublicActionProducers({
 acquireRuntime: localCaptureBackground.acquireRuntime,
 async admitSource({ source }, context, actionId) {
  if (source.kind === 'worktree') {
   return { source, partition: captureSourcePartition(source, localCaptureOwner(source.machineId, context)) };
  }
  if (actionId === DATABASE_CAPTURE_CLEAR_ACTION_ID_V1) throw new PluginError({ code: 'capture_source_unavailable' });
  const admit = context.services.deploymentDatabases?.admitTelemetryRead;
  if (!admit) throw new PluginError({ code: 'deployment_target_role_unavailable' });
  await admit({ serverId: source.serverId, environmentId: source.environmentId });
  return { source, partition: captureSourcePartition(source, undefined) };
 },
 async configureCapture({ project, enabled, retry }, context) {
  const ownerAccountId = localCaptureOwner(project.machineId, context);
  const lease = await localCaptureBackground.acquireRuntime(context);
  try {
   const { configure } = createCaptureActionProducers({ runtime: lease.runtime, accountStorage: context.services.storage.account,
    stopProjectCapture: scope => localCaptureBackground.stopProjectCapture(scope, ownerAccountId) });
   return { ok: true as const, ...await configure({ project, enabled, ...(retry ? { retry } : {}) }) };
  } finally { await lease.release(); }
 },
});

const EXCEPTION_DETAIL_RENDERER_ID = 'exception-detail';
const EXCEPTION_DETAIL_FALLBACK_RENDERER_ID = 'exception-detail-fallback';

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
 actions: { ...createCaptureActions(capture), ...telemetryHealthActions, ...telemetryRegressionActions, ...telemetryExceptionManifestParts.actions },
 accountCollections: telemetryExceptionManifestParts.accountCollections,
 notifications: telemetryExceptionManifestParts.notifications,
 events: telemetryExceptionManifestParts.events,
 workflows: { [TELEMETRY_REGRESSION_WORKFLOW_ID_V1]: TELEMETRY_REGRESSION_WORKFLOW_V1 },
 // D30/J2: the native exception detail, mounted by PRs & Issues for the Happier exceptions source.
 // D36: App vitals, Metric and Slowest routes, offered in Add widget → Telemetry and never auto-added.
 ui: { listExtensions: { [TELEMETRY_REQUESTS_LIST_EXTENSION_ID_V1]: {
  entity: 'service', filterFields: [{ id: TELEMETRY_REQUESTS_FIELD_ID_V1, title: 'Requests · 24 h',
   source: { resource: DATABASE_CAPTURE_RESOURCE_ID_V1 }, value: { kind: 'number', unit: '{request}' },
   column: { title: 'Requests · 24 h', width: 112, align: 'end', priority: 20, defaultHidden: true },
  }],
 } }, views: [...TELEMETRY_WIDGET_VIEWS], renderers: [
  ...TELEMETRY_WIDGET_RENDERERS,
  // The detail reads occurrences and writes lifecycle through this plugin's own Actions.
  { id: EXCEPTION_DETAIL_RENDERER_ID, kind: 'reactNative', artifact: 'telemetry-exception-detail-native', requiredHostMethods: ['executeAction'] },
  { id: EXCEPTION_DETAIL_FALLBACK_RENDERER_ID, kind: 'declarative', root: { kind: 'text', text: {
   key: 'plugins.telemetry.exceptions.detail.fallback', fallback: 'Exception details are unavailable on this surface.' } } },
 ] },
 contributesTo: telemetryExceptionSourceContribution({ renderer: EXCEPTION_DETAIL_RENDERER_ID, fallbackRenderers: [EXCEPTION_DETAIL_FALLBACK_RENDERER_ID] }),
 healthCheckKinds: { [TELEMETRY_KEY_FLOW_HEALTH_KIND_V1.localId]: { title: 'Key flow', configSchema: keyFlowConfigSchema.jsonSchema,
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
