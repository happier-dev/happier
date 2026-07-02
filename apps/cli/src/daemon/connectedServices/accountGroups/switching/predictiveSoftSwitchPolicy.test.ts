import { describe, expect, it } from 'vitest';

import { evaluatePredictiveSoftSwitchPolicy } from './predictiveSoftSwitchPolicy';

describe('evaluatePredictiveSoftSwitchPolicy', () => {
  it('suppresses predictive soft-threshold switching for restart-only providers', () => {
    expect(evaluatePredictiveSoftSwitchPolicy({
      reason: 'soft_threshold',
      predictiveSoftSwitchMode: 'unsupported',
    })).toEqual({
      status: 'suppress',
      reason: 'predictive_soft_switch_restart_required',
    });
  });

  it('suppresses predictive soft-threshold switching while a turn is in flight', () => {
    expect(evaluatePredictiveSoftSwitchPolicy({
      reason: 'soft_threshold',
      predictiveSoftSwitchMode: 'supported',
      turnState: { inFlight: true },
    })).toEqual({
      status: 'suppress',
      reason: 'predictive_soft_switch_turn_in_flight',
    });
  });

  it('keeps hard usage-limit switching enabled even when predictive soft switching is disabled', () => {
    expect(evaluatePredictiveSoftSwitchPolicy({
      reason: 'usage_limit',
      predictiveSoftSwitchMode: 'unsupported',
      turnState: { inFlight: true },
    })).toEqual({ status: 'allow' });
  });
});
