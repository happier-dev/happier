import { SESSION_RUNNER_RUNTIME_METADATA_KEY, type SessionMetadata, type SessionStateFieldId, type SessionStateFieldValue } from '@happier-dev/protocol';

import type {
  MetadataUpdatePort,
  SessionStateBinding,
  SessionStateFieldWriteValue,
  SessionStateStoredValue,
} from '../_types.js';
import {
  acpConfigOptionIntentBinding,
  acpSessionModeIntentBinding,
  modelIntentBinding,
  permissionModeIntentBinding,
} from './intent.js';
import { runtimeDescriptorBinding } from './runtimeDescriptor.js';
import { runtimeActivityBinding } from './runtimeActivity.js';
import { externalAgentObservationBinding } from './externalAgent.js';
import { externalSessionOperationBinding } from './externalSessionOperation.js';
import { sessionRunnerRuntimeBinding } from './sessionRunnerRuntime.js';
import { sessionWorkStateBinding } from './workState.js';
import { sessionUsageLimitRecoveryBinding } from './usageLimitRecovery.js';
import { summaryTextBinding } from './summaryText.js';
import {
  getLegacyProviderSessionIdMetadataKeys,
  getAgentNativeSessionLogPathMetadataKeys,
  providerSessionIdBinding,
} from './providerSessionId.js';

const SESSION_STATE_METADATA_BINDINGS = {
  'identity.runtimeDescriptor': runtimeDescriptorBinding,
  'identity.providerSessionId': providerSessionIdBinding,
  'intent.model': modelIntentBinding,
  'intent.permissionMode': permissionModeIntentBinding,
  'intent.acpSessionMode': acpSessionModeIntentBinding,
  'intent.acpConfigOption': acpConfigOptionIntentBinding,
  'display.title': summaryTextBinding,
  'runtime.workState': sessionWorkStateBinding,
  'runtime.activity': runtimeActivityBinding,
  'runtime.externalAgent': externalAgentObservationBinding,
  'runtime.externalSessionOperation': externalSessionOperationBinding,
  'runtime.usageLimitRecovery': sessionUsageLimitRecoveryBinding,
  'runtime.sessionRunner': sessionRunnerRuntimeBinding,
} satisfies Partial<{ [F in SessionStateFieldId]: SessionStateBinding<F> }>;

function getBinding<F extends SessionStateFieldId>(fieldId: F): SessionStateBinding<F> | null {
  const binding = SESSION_STATE_METADATA_BINDINGS[fieldId as keyof typeof SESSION_STATE_METADATA_BINDINGS];
  return binding ? (binding as SessionStateBinding<F>) : null;
}

export function hasSessionStateFieldMetadataBinding(fieldId: SessionStateFieldId): boolean {
  return fieldId in SESSION_STATE_METADATA_BINDINGS;
}

export function readSessionStateFieldFromMetadata<F extends SessionStateFieldId>(
  metadata: SessionMetadata,
  fieldId: F,
): SessionStateFieldValue<F> | undefined {
  const value = getBinding(fieldId)?.read(metadata).value;
  return value === null || value === undefined ? undefined : value;
}

export function writeSessionStateFieldToMetadata<F extends SessionStateFieldId>(
  metadata: SessionMetadata,
  fieldId: F,
  value: SessionStateFieldWriteValue<F>,
): SessionMetadata {
  // Mirror engine's `unsupported` gate: view.* and other unbound fields are no-ops here.
  // Wave-20: prevents standalone helper from throwing when a binding-less field id is passed,
  // matching syncEngine.writeHappierField (which returns { ok: false, reason: 'unsupported' }).
  const binding = getBinding(fieldId);
  if (!binding) {
    return metadata;
  }
  return binding.write(metadata, { value });
}

export function clearSessionStateFieldFromMetadata(
  metadata: SessionMetadata,
  fieldId: SessionStateFieldId,
): SessionMetadata {
  const next = { ...metadata } as Record<string, unknown>;
  switch (fieldId) {
    case 'identity.runtimeDescriptor':
      delete next.runtimeDescriptorV1;
      delete next.agentRuntimeDescriptorV1;
      break;
    case 'identity.providerSessionId':
      for (const key of getLegacyProviderSessionIdMetadataKeys()) {
        delete next[key];
      }
      // A native session-log path names the conversation of the id it was
      // published with, so clearing the id must clear the path; leaving one
      // behind would point a later reader at a foreign Agent's log.
      for (const key of getAgentNativeSessionLogPathMetadataKeys()) {
        delete next[key];
      }
      break;
    case 'intent.permissionMode':
      delete next.permissionMode;
      delete next.permissionModeUpdatedAt;
      break;
    case 'intent.acpSessionMode':
      delete next.sessionModeOverrideV1;
      delete next.acpSessionModeOverrideV1;
      break;
    case 'intent.model':
      delete next.modelSelectionIntentV1;
      delete next.modelOverrideV1;
      break;
    case 'intent.acpConfigOption':
      delete next.sessionConfigOptionOverridesV1;
      delete next.acpConfigOptionOverridesV1;
      break;
    case 'display.title':
      delete next.summary;
      break;
    case 'runtime.workState':
      delete next.sessionWorkStateV1;
      break;
    case 'runtime.activity':
      delete next.runtimeActivityState;
      delete next.runtimeActivityActiveCount;
      delete next.runtimeActivityObservedAt;
      delete next.runtimeActivitySourceClass;
      delete next.runtimeActivityRevision;
      break;
    case 'runtime.externalAgent':
      delete next.externalAgentObservationV1;
      break;
    case 'runtime.externalSessionOperation':
      delete next.externalSessionOperationV1;
      break;
    case 'runtime.usageLimitRecovery':
      delete next.sessionUsageLimitRecoveryV1;
      break;
    case 'runtime.sessionRunner':
      delete next[SESSION_RUNNER_RUNTIME_METADATA_KEY];
      break;
    case 'view.readState':
    case 'view.attention':
      break;
  }
  return next as SessionMetadata;
}

export function createSessionStateFieldMetadataUpdater<F extends SessionStateFieldId>(
  fieldId: F,
  value: SessionStateFieldWriteValue<F>,
): (metadata: SessionMetadata) => SessionMetadata {
  return (metadata) => writeSessionStateFieldToMetadata(metadata, fieldId, value);
}

export function applySessionStateFieldMetadataPatch<F extends SessionStateFieldId>(
  metadata: SessionMetadata,
  fieldId: F,
  value: SessionStateFieldWriteValue<F>,
): SessionMetadata {
  return writeSessionStateFieldToMetadata(metadata, fieldId, value);
}

export function buildSessionStateFieldMetadataPatch<F extends SessionStateFieldId>(
  fieldId: F,
  value: SessionStateFieldWriteValue<F>,
): SessionMetadata {
  return applySessionStateFieldMetadataPatch({}, fieldId, value);
}

type PublishSessionStateFieldToMetadataParams<F extends SessionStateFieldId> = Readonly<{
  sessionId: string;
  fieldId: F;
  value: SessionStateFieldWriteValue<F>;
} & (
  | Readonly<{
    updateSessionMetadataWithRetry: (
    sessionId: string,
    updater: (metadata: SessionMetadata) => SessionMetadata,
    ) => Promise<unknown>;
  }>
  | Readonly<{
    metadataPort: MetadataUpdatePort;
    reason: string;
    maxAttempts?: number;
  }>
)>;

export async function publishSessionStateFieldToMetadata<F extends SessionStateFieldId>(
  params: PublishSessionStateFieldToMetadataParams<F>,
): Promise<void> {
  // Mirror engine's `unsupported` gate: view.* and other binding-less fields short-circuit silently.
  // Wave-20: keeps standalone helper symmetric with syncEngine.writeHappierField behavior.
  if (!hasSessionStateFieldMetadataBinding(params.fieldId)) {
    return;
  }
  const updater = createSessionStateFieldMetadataUpdater(params.fieldId, params.value);
  if ('metadataPort' in params) {
    const result = await params.metadataPort.update(
      params.sessionId,
      updater,
      {
        reason: params.reason,
        ...(typeof params.maxAttempts === 'number' ? { maxAttempts: params.maxAttempts } : {}),
      },
    );
    if (!result.ok) {
      throw new Error(`Session state metadata update failed: ${result.reason}`);
    }
    return;
  }

  await params.updateSessionMetadataWithRetry(params.sessionId, updater);
}

type PublishSessionStateFieldMutationToMetadataParams<F extends SessionStateFieldId> = Readonly<{
  sessionId: string;
  fieldId: F;
  mutateValue: (
    currentValue: SessionStateStoredValue<F>['value'],
    metadata: SessionMetadata,
  ) => SessionStateFieldWriteValue<F>;
} & (
  | Readonly<{
    updateSessionMetadataWithRetry: (
    sessionId: string,
    updater: (metadata: SessionMetadata) => SessionMetadata,
    ) => Promise<unknown>;
  }>
  | Readonly<{
    metadataPort: MetadataUpdatePort;
    reason: string;
    maxAttempts?: number;
  }>
)>;

export async function publishSessionStateFieldMutationToMetadata<F extends SessionStateFieldId>(
  params: PublishSessionStateFieldMutationToMetadataParams<F>,
): Promise<void> {
  const binding = getBinding(params.fieldId);
  if (!binding) {
    return;
  }

  const updater = (metadata: SessionMetadata): SessionMetadata => {
    const current = binding.read(metadata).value;
    const nextValue = params.mutateValue(current, metadata);
    return binding.write(metadata, { value: nextValue });
  };

  if ('metadataPort' in params) {
    const result = await params.metadataPort.update(
      params.sessionId,
      updater,
      {
        reason: params.reason,
        ...(typeof params.maxAttempts === 'number' ? { maxAttempts: params.maxAttempts } : {}),
      },
    );
    if (!result.ok) {
      throw new Error(`Session state metadata update failed: ${result.reason}`);
    }
    return;
  }

  await params.updateSessionMetadataWithRetry(params.sessionId, updater);
}
