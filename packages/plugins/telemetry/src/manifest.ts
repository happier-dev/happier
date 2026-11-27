import { createLocalCaptureContribution, LOCAL_CAPTURE_DATABASE_ENVIRONMENT_NAMES, LOCAL_CAPTURE_ENVIRONMENT_NAMES } from './contribution.js';
import { definePlugin, isDelegatedActionRequesterV1, PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { DATABASE_TELEMETRY_MACHINE_ROLE_CATALOG_V1, projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { DATABASE_PLUGIN_ID_V1 } from '@happier-dev/plugin-sdk/database';
import { DATABASE_CAPTURE_CLEAR_ACTION_ID_V1, DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1, DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1,
 DATABASE_CAPTURE_RESOURCE_ID_V1, DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1, TELEMETRY_KEY_FLOW_CHECK_ACTION_ID_V1, TELEMETRY_KEY_FLOW_HEALTH_KIND_V1 } from '@happier-dev/database-protocol';
import { databaseActionLocalIdV1, DATABASE_ACCESS_READ_ACTION_ID_V1, DatabaseAccessReadResultV1Schema, type DatabaseActionIdV1, type DatabaseCaptureSourceV1 } from '@happier-dev/database-protocol';
import { TELEMETRY_REQUESTS_FIELD_ID_V1, TELEMETRY_REQUESTS_LIST_EXTENSION_ID_V1 } from '@happier-dev/database-protocol';
import { CAPTURED_DATABASE_FINDING_EVENT_REF_V1, CapturedDatabaseFindingV1Schema } from '@happier-dev/database-protocol';
import { localCaptureBackground } from './background.js';
import { telemetryCollectorRunner } from './telemetry/runner.js';
import { productionFindingEventParts } from './telemetry/productionFindingEvent.js';
import { telemetryExceptionManifestParts, telemetryExceptionSourceContribution } from './exceptions/contribution.js';
import { TELEMETRY_ACCOUNT_DEFINITION } from './exceptions/serviceFacts.js';
import { TELEMETRY_OPEN_ISSUES_FIELD } from './exceptions/serviceFactIds.js';
import { createCaptureActionProducers, createCaptureActions, createCapturePublicActionProducers } from './actions.js';
import { createCaptureResourceRuntime, TELEMETRY_SERVICE_SUMMARY_FIELDS } from './resources.js';
import { captureSourcePartition } from './partition.js';
import { telemetryHealthActions } from './health.js';
import { keyFlowConfigSchema } from './healthSchemas.js';
import { telemetryRegressionActions } from './regression.js';
import { TELEMETRY_REGRESSION_WORKFLOW_ID_V1, TELEMETRY_REGRESSION_WORKFLOW_V1 } from './regressionWorkflow.js';
import { TELEMETRY_WIDGET_RENDERERS, TELEMETRY_WIDGET_VIEWS } from './widgets.js';

/** Local sources (the requester's own Machine and worktrees) are admitted for the Account that
 * recorded them: the source must be on this executing Machine, and the requester's Account selects
 * its own partition. Environment telemetry uses host admission for the selected action. */
type CapturePlacement = Pick<PluginInvocationContext, 'requesterAccount' | 'chosenMachine' | 'agentCaller' | 'authority'>;

function localCaptureOwner(machineId: string, context: CapturePlacement): string {
 const accountId = context.requesterAccount?.accountId;
 if (!accountId || context.chosenMachine?.machineId !== machineId) throw new PluginError({ code: 'capture_source_unavailable' });
 return accountId;
}

async function admitCaptureSource(source: DatabaseCaptureSourceV1, context: CapturePlacement,
 deployments: PluginInvocationContext['services']['deploymentDatabases'], actionId: DatabaseActionIdV1) {
 if (source.kind === 'worktree') {
  const accountId = localCaptureOwner(source.machineId, context);
  const readsDatabaseEvidence = actionId === DATABASE_CAPTURE_QUERIES_LIST_ACTION_ID_V1
   || actionId === DATABASE_CAPTURE_QUERY_GET_ACTION_ID_V1 || actionId === DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1;
  if (readsDatabaseEvidence && isDelegatedActionRequesterV1(context)) {
   throw new PluginError({ code: 'database_target_required' });
  }
  return { source, partition: captureSourcePartition(source, accountId) };
 }
 const environment = { serverId: source.serverId, environmentId: source.environmentId };
 const partition = captureSourcePartition(source, undefined);
 if (actionId === DATABASE_CAPTURE_CLEAR_ACTION_ID_V1) {
  if (!deployments?.admitTelemetryClear) throw new PluginError({ code: 'deployment_target_role_unavailable' });
  await deployments.admitTelemetryClear(environment);
  return { source, partition };
 }
 if (!deployments?.admitTelemetryRead) throw new PluginError({ code: 'deployment_target_role_unavailable' });
 const { collectorMachineId, assignmentStamped, capabilities } = await deployments.admitTelemetryRead(environment);
 return { source, partition, collectorMachineId, capabilities, ...(assignmentStamped === undefined ? {} : { assignmentStamped }) };
}

const capture = createCapturePublicActionProducers({
 acquireRuntime: localCaptureBackground.acquireRuntime,
 readWorktreeLaunchStatus: localCaptureBackground.readWorktreeLaunchStatus,
 async admitSource({ source, databaseTarget }, context, actionId) {
  if (databaseTarget === undefined) return admitCaptureSource(source, context, context.services.deploymentDatabases, actionId);
  const { workspace, projectKey } = databaseTarget;
  const machineId = workspace.kind === 'managed' ? workspace.controller.machineId : workspace.machineId;
  if (source.kind !== 'worktree' || source.serverId !== workspace.serverId || source.machineId !== machineId
   || source.workspaceId !== workspace.workspaceId || source.projectId !== projectKey) {
   throw new PluginError({ code: 'capture_source_unavailable' });
  }
  const accountId = localCaptureOwner(source.machineId, context);
  // Reuse Workbench's selected-target admission, including the initiating Agent and stored policy.
  const access = DatabaseAccessReadResultV1Schema.parse(await context.services.actions.execute({
   pluginId: DATABASE_PLUGIN_ID_V1, localId: databaseActionLocalIdV1(DATABASE_ACCESS_READ_ACTION_ID_V1),
  }, projectNativeJsonValueForTransport({ target: databaseTarget }), { signal: context.signal }));
  if (!access.access.canRead) throw new PluginError({ code: access.access.reason ?? 'capture_source_unavailable' });
  return { source, partition: captureSourcePartition(source, accountId), databaseMember: databaseTarget };
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
 ...TELEMETRY_ACCOUNT_DEFINITION,
 description: 'Machine-local database observations and application telemetry.',
 brand: { iconResourceId: 'brand-icon', monochrome: true },
 entrypoints: { daemon: './.happier-plugin-build/daemon.js' },
 machineRoles: {
  local: { title: 'Local database capture', description: 'Record database observations and application telemetry for local Workspaces.', partOf: 'workspaces', backgroundServices: ['local-capture'] },
  telemetry: { title: 'Telemetry', description: 'Collect telemetry from deployed applications.', defaultActive: DATABASE_TELEMETRY_MACHINE_ROLE_CATALOG_V1[0].defaultActive, backgroundServices: ['telemetry-collector'] },
 },
 daemonDatabases: { capture: localCaptureBackground.databaseDefinition },
 inputTypes: telemetryExceptionManifestParts.inputTypes,
 resources: { ...TELEMETRY_ACCOUNT_DEFINITION.resources, ...telemetryExceptionManifestParts.resources,
  'brand-icon': { kind: 'asset', path: 'src/brand.png', contentType: 'image/png' }, [DATABASE_CAPTURE_RESOURCE_ID_V1]: {
  source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'surface', execution: { target: 'daemon' },
  runtime: createCaptureResourceRuntime({
   subscribe: localCaptureBackground.subscribe,
   async acquireSelection(source, context, actionId) {
    const scope = await admitCaptureSource(source, context, context.deploymentDatabases, actionId);
    const database = context.daemonStorage?.database;
    if (!database) throw new PluginError({ code: 'plugin_service_unavailable' });
    const lease = await localCaptureBackground.acquireRuntime({ signal: context.signal, services: { storage: { daemon: { database } } } });
    return { ...scope, ...lease };
   },
  }),
 } },
 actions: { ...createCaptureActions(capture), ...telemetryHealthActions, ...telemetryRegressionActions, ...telemetryExceptionManifestParts.actions, ...productionFindingEventParts.actions },
 accountCollections: telemetryExceptionManifestParts.accountCollections,
 notifications: telemetryExceptionManifestParts.notifications,
 events: { ...telemetryExceptionManifestParts.events, ...productionFindingEventParts.events,
  [CAPTURED_DATABASE_FINDING_EVENT_REF_V1.localId]: { declaration: { kind: 'event', title: 'Database finding captured',
   payloadSchema: CapturedDatabaseFindingV1Schema.jsonSchema } },
 },
 workflows: { [TELEMETRY_REGRESSION_WORKFLOW_ID_V1]: TELEMETRY_REGRESSION_WORKFLOW_V1 },
 // D30/J2: the native exception detail, mounted by PRs & Issues for the Happier exceptions source.
 // D36: App vitals, Metric and Slowest routes, offered in Add widget → Telemetry and never auto-added.
 ui: { listExtensions: { [TELEMETRY_REQUESTS_LIST_EXTENSION_ID_V1]: {
  entity: 'service', filterFields: [{ id: TELEMETRY_REQUESTS_FIELD_ID_V1, title: 'Requests',
   source: { resource: DATABASE_CAPTURE_RESOURCE_ID_V1 }, value: { kind: 'number', unit: '{request}' },
   column: { title: 'Requests', qualifier: '24 h', width: 112, align: 'end', priority: 20, defaultHidden: true },
  }, ...Object.entries(TELEMETRY_SERVICE_SUMMARY_FIELDS).map(([id, { title, unit }]) => ({
   id, title, source: { resource: DATABASE_CAPTURE_RESOURCE_ID_V1 }, value: { kind: 'number' as const, unit },
   byline: true as const,
  })), TELEMETRY_OPEN_ISSUES_FIELD],
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
