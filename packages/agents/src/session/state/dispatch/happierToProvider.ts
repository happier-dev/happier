import type { SessionStateFieldId, SessionStateFieldValue } from '@happier-dev/protocol';

import { isSessionStateDirectionSupported, type SessionStateCapabilityGateResult } from '../capabilityGate.js';
import { getSessionStateFieldDescriptor } from '../fieldRegistry.js';
import { emitSessionStateTelemetry, sanitizeSessionStateErrorCode } from '../telemetry.js';
import type {
  RuntimeFacetCtx,
  SessionStateApplyReason,
  SessionStateSyncEngineOptions,
} from '../_types.js';

export type SessionStateApplyResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: 'unsupported'; gate: SessionStateCapabilityGateResult }>
  | Readonly<{ ok: false; reason: 'provider_error'; errorCode?: string }>;

export async function dispatchHappierToProvider<F extends SessionStateFieldId>(
  options: SessionStateSyncEngineOptions,
  params: Readonly<{
    ctx: RuntimeFacetCtx;
    fieldId: F;
    value: SessionStateFieldValue<F>;
    reason: SessionStateApplyReason;
  }>,
): Promise<SessionStateApplyResult> {
  const descriptor = getSessionStateFieldDescriptor(params.fieldId);
  const gate = isSessionStateDirectionSupported({
    capabilities: options.capabilities,
    fieldId: params.fieldId,
    direction: 'happierToProvider',
  });

  if (!gate.supported || !options.facet) {
    const unsupportedGate = gate.supported
      ? { supported: false as const, reason: 'field-unsupported' as const }
      : gate;
    emitSessionStateTelemetry(options.telemetry, {
      sessionId: params.ctx.sessionId,
      fieldId: params.fieldId,
      direction: 'happierToProvider',
      reason: params.reason,
      conflictPolicy: descriptor.conflictPolicy,
      capabilityState: 'unsupported',
      outcome: 'skipped',
    });
    return { ok: false, reason: 'unsupported', gate: unsupportedGate };
  }

  try {
    await options.facet.applyHappierField(params.ctx, params.fieldId, params.value, {
      reason: params.reason,
    });
    emitSessionStateTelemetry(options.telemetry, {
      sessionId: params.ctx.sessionId,
      fieldId: params.fieldId,
      direction: 'happierToProvider',
      reason: params.reason,
      conflictPolicy: descriptor.conflictPolicy,
      capabilityState: 'supported',
      outcome: 'applied',
    });
    return { ok: true };
  } catch (error) {
    const errorCode = sanitizeSessionStateErrorCode(error);
    if (errorCode === 'unsupported') {
      const unsupportedGate = { supported: false as const, reason: 'field-unsupported' as const };
      emitSessionStateTelemetry(options.telemetry, {
        sessionId: params.ctx.sessionId,
        fieldId: params.fieldId,
        direction: 'happierToProvider',
        reason: params.reason,
        conflictPolicy: descriptor.conflictPolicy,
        capabilityState: 'unsupported',
        outcome: 'skipped',
        errorCode,
      });
      return { ok: false, reason: 'unsupported', gate: unsupportedGate };
    }
    emitSessionStateTelemetry(options.telemetry, {
      sessionId: params.ctx.sessionId,
      fieldId: params.fieldId,
      direction: 'happierToProvider',
      reason: params.reason,
      conflictPolicy: descriptor.conflictPolicy,
      capabilityState: 'supported',
      outcome: 'failed',
      ...(errorCode ? { errorCode } : {}),
    });
    return { ok: false, reason: 'provider_error', ...(errorCode ? { errorCode } : {}) };
  }
}
