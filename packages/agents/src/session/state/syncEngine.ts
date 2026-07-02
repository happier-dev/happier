import type { SessionStateFieldId, SessionStateFieldValue } from '@happier-dev/protocol';

import {
  dispatchHappierToProvider,
  type SessionStateApplyResult,
} from './dispatch/happierToProvider.js';
import {
  dispatchProviderToHappier,
  type SessionStateReadProviderResult,
} from './dispatch/providerToHappier.js';
import {
  createSessionStateFieldMetadataUpdater,
  hasSessionStateFieldMetadataBinding,
} from './bindings/publishField.js';
import {
  isSessionStateDirectionSupported,
  isSessionStateFieldSupported,
  type SessionStateCapabilityGateResult,
} from './capabilityGate.js';
import { getSessionStateFieldDescriptor } from './fieldRegistry.js';
import { emitSessionStateTelemetry, sanitizeSessionStateErrorCode } from './telemetry.js';
import type {
  RuntimeFacetCtx,
  SessionStateApplyReason,
  SessionStateDisposable,
  SessionStateFieldWriteValue,
  SessionStateSyncEngineOptions,
} from './_types.js';

function resolveProviderMirrorValue<F extends SessionStateFieldId>(
  fieldId: F,
  value: SessionStateFieldWriteValue<F>,
): SessionStateFieldValue<F> | null {
  if (fieldId === 'identity.runtimeDescriptor' && value === null) {
    return null;
  }
  if (fieldId === 'identity.providerSessionId' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const providerSessionId = (value as Readonly<{ value?: unknown }>).value;
    return (typeof providerSessionId === 'string' ? providerSessionId : null) as SessionStateFieldValue<F> | null;
  }
  if (fieldId === 'display.title' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const title = (value as Readonly<{ title?: unknown }>).title;
    return (typeof title === 'string' ? title : null) as SessionStateFieldValue<F> | null;
  }
  return value as SessionStateFieldValue<F>;
}

export type SessionStateMetadataWriteResult =
  | Readonly<{
    ok: true;
    version: number;
    provider?: SessionStateApplyResult;
  }>
  | Readonly<{ ok: false; reason: 'unsupported' | 'conflict' | 'forbidden' | 'unknown_error' }>;

export type SessionStateObserveProviderResult =
  | Readonly<{ ok: true; disposable: SessionStateDisposable }>
  | Readonly<{ ok: false; reason: 'unsupported'; gate: SessionStateCapabilityGateResult }>
  | Readonly<{ ok: false; reason: 'provider_error'; errorCode?: string }>;

export type SessionStateSyncEngine = Readonly<{
  applyHappierField<F extends SessionStateFieldId>(params: Readonly<{
    ctx: RuntimeFacetCtx;
    fieldId: F;
    value: SessionStateFieldValue<F>;
    reason: SessionStateApplyReason;
  }>): Promise<SessionStateApplyResult>;

  readProviderField<F extends SessionStateFieldId>(params: Readonly<{
    ctx: RuntimeFacetCtx;
    fieldId: F;
  }>): Promise<SessionStateReadProviderResult<F>>;

  observeProviderField<F extends SessionStateFieldId>(params: Readonly<{
    ctx: RuntimeFacetCtx;
    fieldId: F;
    emit: (value: SessionStateFieldValue<F>) => void;
  }>): SessionStateObserveProviderResult;

  writeHappierField<F extends SessionStateFieldId>(params: Readonly<{
    sessionId: string;
    fieldId: F;
    value: SessionStateFieldWriteValue<F>;
    reason: SessionStateApplyReason;
    metadataReason: string;
    ctx?: RuntimeFacetCtx;
    maxAttempts?: number;
    mirrorToProvider?: boolean;
  }>): Promise<SessionStateMetadataWriteResult>;
}>;

function emitMetadataWriteTelemetry(
  options: SessionStateSyncEngineOptions,
  event: Readonly<{
    sessionId: string;
    fieldId: SessionStateFieldId;
    reason: string;
    outcome: 'applied' | 'skipped' | 'failed';
    capabilityState: 'supported' | 'unsupported';
    errorCode?: string;
  }>,
): void {
  const descriptor = getSessionStateFieldDescriptor(event.fieldId);
  emitSessionStateTelemetry(options.telemetry, {
    sessionId: event.sessionId,
    fieldId: event.fieldId,
    direction: 'happierMetadata',
    reason: event.reason,
    conflictPolicy: descriptor.conflictPolicy,
    capabilityState: event.capabilityState,
    outcome: event.outcome,
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
  });
}

export function createSessionStateSyncEngine(
  options: SessionStateSyncEngineOptions,
): SessionStateSyncEngine {
  return {
    applyHappierField: (params) => dispatchHappierToProvider(options, params),
    readProviderField: (params) => dispatchProviderToHappier(options, params),
    observeProviderField: (params) => {
      const descriptor = getSessionStateFieldDescriptor(params.fieldId);
      const gate = isSessionStateDirectionSupported({
        capabilities: options.capabilities,
        fieldId: params.fieldId,
        direction: 'providerToHappier',
      });

      if (!gate.supported || !options.facet?.observeField) {
        const unsupportedGate = gate.supported
          ? { supported: false as const, reason: 'field-unsupported' as const }
          : gate;
        emitSessionStateTelemetry(options.telemetry, {
          sessionId: params.ctx.sessionId,
          fieldId: params.fieldId,
          direction: 'providerToHappier',
          reason: 'provider-observe',
          conflictPolicy: descriptor.conflictPolicy,
          capabilityState: 'unsupported',
          outcome: 'skipped',
        });
        return { ok: false, reason: 'unsupported', gate: unsupportedGate };
      }

      try {
        const disposable = options.facet.observeField(params.ctx, params.fieldId, params.emit);
        emitSessionStateTelemetry(options.telemetry, {
          sessionId: params.ctx.sessionId,
          fieldId: params.fieldId,
          direction: 'providerToHappier',
          reason: 'provider-observe',
          conflictPolicy: descriptor.conflictPolicy,
          capabilityState: 'supported',
          outcome: 'applied',
        });
        return { ok: true, disposable };
      } catch (error) {
        const errorCode = sanitizeSessionStateErrorCode(error);
        emitSessionStateTelemetry(options.telemetry, {
          sessionId: params.ctx.sessionId,
          fieldId: params.fieldId,
          direction: 'providerToHappier',
          reason: 'provider-observe',
          conflictPolicy: descriptor.conflictPolicy,
          capabilityState: 'supported',
          outcome: 'failed',
          ...(errorCode ? { errorCode } : {}),
        });
        return { ok: false, reason: 'provider_error', ...(errorCode ? { errorCode } : {}) };
      }
    },
    writeHappierField: async (params) => {
      if (!options.metadataPort) {
        emitMetadataWriteTelemetry(options, {
          sessionId: params.sessionId,
          fieldId: params.fieldId,
          reason: params.metadataReason,
          outcome: 'skipped',
          capabilityState: 'unsupported',
          errorCode: 'unsupported',
        });
        return { ok: false, reason: 'unsupported' };
      }
      const fieldGate = isSessionStateFieldSupported({
        capabilities: options.capabilities,
        fieldId: params.fieldId,
      });
      if (!fieldGate.supported) {
        emitMetadataWriteTelemetry(options, {
          sessionId: params.sessionId,
          fieldId: params.fieldId,
          reason: params.metadataReason,
          outcome: 'skipped',
          capabilityState: 'unsupported',
          errorCode: 'unsupported',
        });
        return { ok: false, reason: 'unsupported' };
      }
      if (!hasSessionStateFieldMetadataBinding(params.fieldId)) {
        emitMetadataWriteTelemetry(options, {
          sessionId: params.sessionId,
          fieldId: params.fieldId,
          reason: params.metadataReason,
          outcome: 'skipped',
          capabilityState: 'unsupported',
          errorCode: 'unsupported',
        });
        return { ok: false, reason: 'unsupported' };
      }

      const result = await options.metadataPort.update(
        params.sessionId,
        createSessionStateFieldMetadataUpdater(
          params.fieldId,
          params.value as SessionStateFieldWriteValue<typeof params.fieldId>,
        ),
        {
          reason: params.metadataReason,
          ...(typeof params.maxAttempts === 'number' ? { maxAttempts: params.maxAttempts } : {}),
        },
      );
      if (!result.ok) {
        emitMetadataWriteTelemetry(options, {
          sessionId: params.sessionId,
          fieldId: params.fieldId,
          reason: params.metadataReason,
          outcome: 'failed',
          capabilityState: 'supported',
          errorCode: sanitizeSessionStateErrorCode({ code: result.reason }),
        });
        return result;
      }

      emitMetadataWriteTelemetry(options, {
        sessionId: params.sessionId,
        fieldId: params.fieldId,
        reason: params.metadataReason,
        outcome: 'applied',
        capabilityState: 'supported',
      });

      const mirrorValue = resolveProviderMirrorValue(params.fieldId, params.value);
      if (!params.mirrorToProvider || mirrorValue === null) {
        return result;
      }

      return {
        ...result,
        provider: await dispatchHappierToProvider(options, {
          ctx: params.ctx ?? { sessionId: params.sessionId },
          fieldId: params.fieldId,
          value: mirrorValue,
          reason: params.reason,
        }),
      };
    },
  };
}
