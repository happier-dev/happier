import type {
  AgentNativeContinuityProofV1,
  SessionMetadata,
  SessionStateCapabilitiesV1,
  SessionStateFieldClass,
  SessionStateFieldDeliveryClassV1,
  SessionStateFieldId,
  SessionStateFieldValue,
  SessionModelSelectionIntentV1,
} from '@happier-dev/protocol';

import type { SessionStateConflictPolicy } from './policies/_types.js';
import type { TimestampedFieldStaleBehavior } from './policies/timestampedFieldUpdate.js';

export type SessionStateDirection = 'happierMetadata' | 'happierToProvider' | 'providerToHappier';
export type SessionStateApplyReason = 'user-mutation' | 'spawn' | 'reconciliation';
export type MetadataUpdateFailureReason =
  | 'unsupported'
  | 'conflict'
  | 'forbidden'
  | 'session_lookup_timeout'
  | 'unknown_error';

export type RuntimeFacetCtx = Readonly<{
  sessionId: string;
} & Record<string, unknown>>;

export type SessionStateDisposable =
  | (() => void | Promise<void>)
  | Readonly<{ dispose: () => void | Promise<void> }>
  | Readonly<{ unsubscribe: () => void }>;

export interface SessionStateFacet {
  readonly capabilities?: SessionStateCapabilitiesV1;

  applyHappierField<F extends SessionStateFieldId>(
    ctx: RuntimeFacetCtx,
    field: F,
    value: SessionStateFieldValue<F>,
    opts: Readonly<{ reason: SessionStateApplyReason }>,
  ): Promise<void>;

  readField<F extends SessionStateFieldId>(
    ctx: RuntimeFacetCtx,
    field: F,
  ): Promise<SessionStateFieldValue<F> | null>;

  observeField?<F extends SessionStateFieldId>(
    ctx: RuntimeFacetCtx,
    field: F,
    emit: (value: SessionStateFieldValue<F>) => void,
  ): SessionStateDisposable;
}

export interface MetadataUpdatePort {
  update(
    sessionId: string,
    updater: (prev: SessionMetadata) => SessionMetadata,
    opts: Readonly<{
      reason: string;
      maxAttempts?: number;
    }>,
  ): Promise<
    | Readonly<{ ok: true; version: number }>
    | Readonly<{ ok: false; reason: MetadataUpdateFailureReason }>
  >;
}

export type SessionStateStoredValue<F extends SessionStateFieldId> = Readonly<{
  value: SessionStateFieldValue<F> | null;
  updatedAt: number | null;
  fingerprint?: string;
}>;

export type SessionStateFieldWriteValue<F extends SessionStateFieldId> =
  F extends 'identity.runtimeDescriptor'
    ? SessionStateFieldValue<F> | null
    : F extends 'runtime.workState'
      ? SessionStateFieldValue<F> | null
    : F extends 'runtime.usageLimitRecovery'
      ? SessionStateFieldValue<F> | null
    : F extends 'runtime.externalAgent'
      ? SessionStateFieldValue<F> | null
    : F extends 'runtime.externalSessionOperation'
      ? SessionStateFieldValue<F> | null
    : F extends 'identity.providerSessionId'
      ? SessionStateFieldValue<F> | Readonly<{
        value: SessionStateFieldValue<F>;
        metadataKey: string;
        /**
         * Matched continuity proof for the id in `value`, written to the target
         * Agent's catalog-declared proof key in the same metadata update.
         *
         * It travels inside this envelope rather than as its own field so a
         * proof can never be published independently of the id it proves
         * (`REQ-STATE-01`). Omitting it, or passing `null`, CLEARS any existing
         * proof: a proof only proves the exact id it was produced with, so an
         * id write with no proof must not inherit the previous one.
         */
        continuityProof?: AgentNativeContinuityProofV1 | null;
      }>
    : F extends 'intent.model'
      ? SessionModelSelectionIntentV1
    : F extends 'intent.permissionMode'
      ? SessionStateFieldValue<F> | Readonly<{
        v: 1;
        permissionMode: SessionStateFieldValue<F>['permissionMode'];
        updatedAt: number | null;
      }>
    : F extends 'display.title'
      ? SessionStateFieldValue<F> | Readonly<{
        title: SessionStateFieldValue<F>;
        updatedAt?: number;
        staleBehavior?: TimestampedFieldStaleBehavior;
        preserveExistingValue?: boolean;
      }>
    : SessionStateFieldValue<F>;

export type SessionStateWrite<F extends SessionStateFieldId> = Readonly<{
  value: SessionStateFieldWriteValue<F>;
  updatedAt?: number;
  fingerprint?: string;
  staleBehavior?: TimestampedFieldStaleBehavior;
}>;

export interface SessionStateBinding<F extends SessionStateFieldId> {
  read(metadata: SessionMetadata): SessionStateStoredValue<F>;
  write(metadata: SessionMetadata, update: SessionStateWrite<F>): SessionMetadata;
}

export type SessionStateFieldDescriptor<F extends SessionStateFieldId = SessionStateFieldId> = Readonly<{
  id: F;
  class: SessionStateFieldClass;
  conflictPolicy: SessionStateConflictPolicy;
  deliveryClass: SessionStateFieldDeliveryClassV1;
}>;

export type SessionStateTelemetryEvent = Readonly<{
  sessionId: string;
  fieldId: SessionStateFieldId;
  direction: SessionStateDirection;
  reason: string;
  conflictPolicy: SessionStateConflictPolicy | 'none';
  capabilityState: 'supported' | 'unsupported';
  outcome: 'applied' | 'skipped' | 'failed';
  errorCode?: string;
}>;

export type SessionStateSyncEngineOptions = Readonly<{
  capabilities: SessionStateCapabilitiesV1;
  facet?: SessionStateFacet | null;
  metadataPort?: MetadataUpdatePort | null;
  telemetry?: (event: SessionStateTelemetryEvent) => void;
}>;
