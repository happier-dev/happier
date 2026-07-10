export type {
  MetadataUpdatePort,
  RuntimeFacetCtx,
  SessionStateApplyReason,
  SessionStateBinding,
  SessionStateDirection,
  SessionStateDisposable,
  SessionStateFacet,
  SessionStateFieldDescriptor,
  SessionStateFieldWriteValue,
  SessionStateStoredValue,
  SessionStateSyncEngineOptions,
  SessionStateTelemetryEvent,
  SessionStateWrite,
} from './_types.js';
export {
  getSessionStateFieldCapability,
  isSessionStateDirectionSupported,
  type SessionStateCapabilityGateResult,
} from './capabilityGate.js';
export {
  SESSION_STATE_FIELD_REGISTRY,
  getSessionStateFieldDescriptor,
} from './fieldRegistry.js';
export {
  createSessionStateFacetFromHandlers,
  type SessionStateProviderFieldHandler,
  type SessionStateProviderHandlerMap,
} from './registerHandler.js';
export {
  createSessionStateSyncEngine,
  type SessionStateObserveProviderResult,
  type SessionStateMetadataWriteResult,
  type SessionStateSyncEngine,
} from './syncEngine.js';
export {
  emitSessionStateTelemetry,
  sanitizeSessionStateErrorCode,
} from './telemetry.js';
export {
  createFingerprintPublicationState,
  resolveFingerprintPublication,
  rollbackFingerprintPublication,
  type FingerprintPublicationDecision,
  type FingerprintPublicationState,
} from './policies/fingerprintPublication.js';
export {
  clearSessionStateFieldFromMetadata,
  createSessionStateFieldMetadataUpdater,
  hasSessionStateFieldMetadataBinding,
  writeSessionStateFieldToMetadata,
  publishSessionStateFieldMutationToMetadata,
  publishSessionStateFieldToMetadata,
} from './bindings/publishField.js';
export {
  readRuntimeDescriptorSessionState,
  writeRuntimeDescriptorSessionState,
} from './bindings/runtimeDescriptor.js';
export {
  readSessionUsageLimitRecoverySessionState,
  writeSessionUsageLimitRecoverySessionState,
} from './bindings/usageLimitRecovery.js';
export {
  readProviderSessionIdSessionState,
  writeProviderSessionIdSessionState,
  type ProviderSessionIdMetadataKey,
} from './bindings/providerSessionId.js';
export {
  resolveTimestampedFieldUpdate,
  type TimestampedFieldStaleBehavior,
  type TimestampedFieldUpdateResult,
  type TimestampedFieldValue,
} from '../timestamps/resolveTimestampedFieldUpdate.js';
export {
  computeMonotonicUpdatedAt,
  type MonotonicUpdatedAtPolicy,
} from '../timestamps/monotonic.js';
export {
  LEGACY_ACP_CONFIG_OPTION_OVERRIDES_KEY,
  LEGACY_ACP_SESSION_MODE_OVERRIDE_KEY,
  MODEL_OVERRIDE_KEY,
  PERMISSION_MODE_KEY,
  PERMISSION_MODE_UPDATED_AT_KEY,
  SESSION_CONFIG_OPTION_OVERRIDES_KEY,
  SESSION_MODE_OVERRIDE_KEY,
  getIntentMetadataKeysForAlias,
} from './bindings/metadataKeys.js';
export {
  readAcpConfigOptionIntentFromMetadata,
  readAcpSessionModeIntentFromMetadata,
  readModelIntentFromMetadata,
  readPermissionModeIntentFromMetadata,
  readStringOverrideIntentFromMetadata,
} from './bindings/intent.js';
export {
  inferLatestUserPermissionModeIntent,
  type InferredPermissionModeIntent,
} from './sources/permissionModeInference.js';
export {
  resolveModelSelectionIntentFromSessionMetadata,
  resolveMetadataStringOverrideV1,
  resolvePermissionIntentFromSessionMetadata,
} from './metadataReaders.js';
