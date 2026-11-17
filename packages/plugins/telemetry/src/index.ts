import { DATABASE_CAPTURE_PLUGIN } from './manifest.js';

export { PLUGIN_MANIFEST as manifest, DATABASE_CAPTURE_PLUGIN, activate } from './manifest.js';
export const { daemonDatabases, collectionMigrations } = DATABASE_CAPTURE_PLUGIN;
export { captureMigrations, createCaptureStore } from './store/capture.js';
export { createCaptureIngest } from './store/ingest.js';
export { createCaptureRuntime, type CaptureRuntime, type CapturePartition } from './runtime.js';
export { createCaptureReader, observedEndpointErrorRate, type CaptureEndpointSummary, type CaptureEndpointCursor } from './read.js';
export type { RequestSpanEvidence, DatabaseExecutionEvidence, RepeatedQueryEvidence } from './analysis/requests.js';
export { readCapturePreference, configureCapturePreference, type CaptureProjectScope } from './configuration.js';
export { localCaptureBackground, createCaptureBackgroundOwner } from './background.js';
