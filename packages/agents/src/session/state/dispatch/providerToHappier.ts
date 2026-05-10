import type { SessionStateFieldId, SessionStateFieldValue } from '@happier-dev/protocol';

import { isSessionStateDirectionSupported, type SessionStateCapabilityGateResult } from '../capabilityGate.js';
import { getSessionStateFieldDescriptor } from '../fieldRegistry.js';
import { emitSessionStateTelemetry, sanitizeSessionStateErrorCode } from '../telemetry.js';
import type { RuntimeFacetCtx, SessionStateSyncEngineOptions } from '../_types.js';

export type SessionStateReadProviderResult<F extends SessionStateFieldId> =
  | Readonly<{ ok: true; value: SessionStateFieldValue<F> | null }>
  | Readonly<{ ok: false; reason: 'unsupported'; gate: SessionStateCapabilityGateResult }>
  | Readonly<{ ok: false; reason: 'provider_error'; errorCode?: string }>;

export async function dispatchProviderToHappier<F extends SessionStateFieldId>(
  options: SessionStateSyncEngineOptions,
  params: Readonly<{
    ctx: RuntimeFacetCtx;
    fieldId: F;
  }>,
): Promise<SessionStateReadProviderResult<F>> {
  const descriptor = getSessionStateFieldDescriptor(params.fieldId);
  const gate = isSessionStateDirectionSupported({
    capabilities: options.capabilities,
    fieldId: params.fieldId,
    direction: 'providerToHappier',
  });

  if (!gate.supported || !options.facet) {
    const unsupportedGate = gate.supported
      ? { supported: false as const, reason: 'field-unsupported' as const }
      : gate;
    emitSessionStateTelemetry(options.telemetry, {
      sessionId: params.ctx.sessionId,
      fieldId: params.fieldId,
      direction: 'providerToHappier',
      reason: 'provider-read',
      conflictPolicy: descriptor.conflictPolicy,
      capabilityState: 'unsupported',
      outcome: 'skipped',
    });
    return { ok: false, reason: 'unsupported', gate: unsupportedGate };
  }

  try {
    const value = await options.facet.readField(params.ctx, params.fieldId);
    emitSessionStateTelemetry(options.telemetry, {
      sessionId: params.ctx.sessionId,
      fieldId: params.fieldId,
      direction: 'providerToHappier',
      reason: 'provider-read',
      conflictPolicy: descriptor.conflictPolicy,
      capabilityState: 'supported',
      outcome: 'applied',
    });
    return { ok: true, value };
  } catch (error) {
    const errorCode = sanitizeSessionStateErrorCode(error);
    if (errorCode === 'unsupported') {
      const unsupportedGate = { supported: false as const, reason: 'field-unsupported' as const };
      emitSessionStateTelemetry(options.telemetry, {
        sessionId: params.ctx.sessionId,
        fieldId: params.fieldId,
        direction: 'providerToHappier',
        reason: 'provider-read',
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
      direction: 'providerToHappier',
      reason: 'provider-read',
      conflictPolicy: descriptor.conflictPolicy,
      capabilityState: 'supported',
      outcome: 'failed',
      ...(errorCode ? { errorCode } : {}),
    });
    return { ok: false, reason: 'provider_error', ...(errorCode ? { errorCode } : {}) };
  }
}
