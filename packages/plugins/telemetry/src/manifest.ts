import { createLocalCaptureContribution, LOCAL_CAPTURE_DATABASE_ENVIRONMENT_NAMES, LOCAL_CAPTURE_ENVIRONMENT_NAMES } from './contribution.js';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { DATABASE_TELEMETRY_MACHINE_ROLE_CATALOG_V1 } from '@happier-dev/plugin-sdk/protocol';
import { localCaptureBackground } from './background.js';
import { telemetryCollectorRunner } from './telemetry/runner.js';

export const DATABASE_CAPTURE_PLUGIN = definePlugin({
 id: 'happier.telemetry', version: '0.0.0', displayName: 'Telemetry',
 description: 'Machine-local database observations and application telemetry.',
 entrypoints: { daemon: './dist/index.js' },
 hostAccess: { required: [], optional: [{ id: 'account-storage', capability: 'storage.account', reason: 'Read the Project capture preference.', scope: { enabled: true } }] },
 machineRoles: {
  local: { title: 'Local database capture', description: 'Record database observations and application telemetry for local Workspaces.', partOf: 'workspaces', backgroundServices: ['local-capture'] },
  telemetry: { title: 'Telemetry', description: 'Collect telemetry from deployed applications.', defaultActive: DATABASE_TELEMETRY_MACHINE_ROLE_CATALOG_V1[0].defaultActive, backgroundServices: ['telemetry-collector'] },
 },
 daemonDatabases: { capture: localCaptureBackground.databaseDefinition },
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
