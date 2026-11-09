import { describe, expect, it } from 'vitest';

import {
  classifyIrohHomeCarrierFailure,
  IrohError,
  IROH_HOME_TUNNEL_INVALID_ENDPOINT_ERROR,
  IROH_HOME_TUNNEL_PROBE_FAILED_ERROR,
  IROH_HOME_TUNNEL_STALE_FOCUS_ERROR,
  IROH_HOME_TUNNEL_STALE_GENERATION_ERROR,
  IROH_HOME_TUNNEL_SUSPENDED_ERROR,
  type IrohHomeCarrierFailureClass,
} from './errors';

describe('classifyIrohHomeCarrierFailure', () => {
  it('allows initial selection to use independently trusted HTTPS for unavailable capability or an unreachable, timed-out, or unclassified closed transport', () => {
    for (const code of ['unavailable', 'home_unreachable', 'transport_timeout', 'transport_closed', 'transport', 'unknown', 'invalid_preamble', 'unsupported_alpn', 'endpoint_key_unavailable', 'endpoint_config_conflict', 'loopback_bind_failed', 'resource_limit'] as const) {
      expect(classifyIrohHomeCarrierFailure(new IrohError(code, 'private failure'))).toEqual({
        fallbackAllowed: true,
        failureClass: 'carrier-unavailable',
      });
    }
    for (const error of [
      new Error(IROH_HOME_TUNNEL_SUSPENDED_ERROR),
    ]) {
      expect(classifyIrohHomeCarrierFailure(error)).toEqual({
        fallbackAllowed: true,
        failureClass: 'carrier-unavailable',
      });
    }
    for (const error of [
      new Error('future transport failure'),
      { name: 'IrohNativeOperationError', code: 'future_native_failure' },
      undefined,
    ]) {
      expect(classifyIrohHomeCarrierFailure(error)).toEqual({
        fallbackAllowed: true,
        failureClass: 'unclassified',
      });
    }
  });

  it.each(['health-unavailable', 'probe-timeout', 'features-unavailable'])('allows another verified carrier when the Iroh probe reports %s', reason => {
    expect(classifyIrohHomeCarrierFailure(new Error(`${IROH_HOME_TUNNEL_PROBE_FAILED_ERROR}:${reason}`)))
      .toEqual({ fallbackAllowed: true, failureClass: 'carrier-unavailable' });
  });

  it('allows non-security failure after Iroh acquisition to select another verified carrier', () => {
    expect(classifyIrohHomeCarrierFailure(new IrohError('transport_timeout', 'private detail')))
      .toEqual({ fallbackAllowed: true, failureClass: 'carrier-unavailable' });
  });

  it('fails closed for identity, integrity, auth refusals and retired operations', () => {
    const cases: ReadonlyArray<Readonly<{ error: unknown; failureClass: IrohHomeCarrierFailureClass }>> = [
      { error: new IrohError('endpoint_identity_invalid', 'invalid endpoint identity'), failureClass: 'descriptor-integrity' },
      { error: new IrohError('identity_mismatch', 'wrong Home'), failureClass: 'identity-auth' },
      { error: new IrohError('invalid_descriptor', 'invalid descriptor'), failureClass: 'descriptor-integrity' },
      { error: new IrohError('relay_auth_failed', 'relay denied'), failureClass: 'identity-auth' },
      { error: new IrohError('cancelled', 'cancelled'), failureClass: 'unclassified' },
      { error: new DOMException('cancelled', 'AbortError'), failureClass: 'unclassified' },
      { error: new Error(`${IROH_HOME_TUNNEL_PROBE_FAILED_ERROR}:auth-failed`), failureClass: 'identity-auth' },
      { error: new Error(`${IROH_HOME_TUNNEL_PROBE_FAILED_ERROR}:identity-mismatch`), failureClass: 'identity-auth' },
      { error: new Error(IROH_HOME_TUNNEL_INVALID_ENDPOINT_ERROR), failureClass: 'descriptor-integrity' },
      { error: new Error(IROH_HOME_TUNNEL_STALE_GENERATION_ERROR), failureClass: 'stale-target' },
      { error: new Error(IROH_HOME_TUNNEL_STALE_FOCUS_ERROR), failureClass: 'stale-target' },
    ];
    for (const { error, failureClass } of cases) {
      expect(classifyIrohHomeCarrierFailure(error)).toEqual({ fallbackAllowed: false, failureClass });
    }
  });

  it('never reflects error messages or other input-derived data in its outcome', () => {
    const secretish = new Error('token=secret url=https://private.example.test');
    const classification = classifyIrohHomeCarrierFailure(secretish);
    expect(classification).toEqual({ fallbackAllowed: true, failureClass: 'unclassified' });
    expect(Object.values(classification)).not.toContain(secretish.message);
  });

});
