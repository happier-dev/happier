import { describe, expect, it } from 'vitest';

import { getSessionStateFieldCapability, isSessionStateDirectionSupported, isSessionStateFieldSupported } from './capabilityGate.js';

describe('isSessionStateDirectionSupported', () => {
  it('reuses activity support for host turn progress without granting provider synchronization', () => {
    const activity = {
      supported: true,
      happierToProvider: { supported: true, transport: 'runtime-hook' as const },
      providerToHappier: { supported: true, source: 'event' as const },
    };
    const capabilities = { runtime: { activity } };
    expect(getSessionStateFieldCapability(capabilities, 'runtime.turnProgress')).toBe(activity);
    expect(isSessionStateFieldSupported({ capabilities, fieldId: 'runtime.turnProgress' })).toEqual({ supported: true });
    expect(isSessionStateFieldSupported({ capabilities: {}, fieldId: 'runtime.turnProgress' }))
      .toEqual({ supported: false, reason: 'field-unsupported' });
    for (const direction of ['happierToProvider', 'providerToHappier'] as const) {
      expect(isSessionStateDirectionSupported({ capabilities, fieldId: 'runtime.turnProgress', direction }))
        .toEqual({ supported: false, reason: 'field-unsupported' });
    }
  });

  it('blocks unsupported fields', () => {
    expect(isSessionStateDirectionSupported({
      capabilities: {},
      fieldId: 'display.title',
      direction: 'happierToProvider',
    })).toEqual({ supported: false, reason: 'field-unsupported' });
  });

  it('blocks unsupported directions on supported fields', () => {
    expect(isSessionStateDirectionSupported({
      capabilities: {
        display: {
          title: {
            supported: true,
            happierToProvider: { supported: false },
          },
        },
      },
      fieldId: 'display.title',
      direction: 'happierToProvider',
    })).toEqual({ supported: false, reason: 'direction-unsupported' });
  });

  it('allows supported directions', () => {
    expect(isSessionStateDirectionSupported({
      capabilities: {
        display: {
          title: {
            supported: true,
            happierToProvider: { supported: true, transport: 'runtime-hook' },
          },
        },
      },
      fieldId: 'display.title',
      direction: 'happierToProvider',
    })).toEqual({ supported: true });
  });

  it('allows runtime activity provider-to-Happier when advertised', () => {
    expect(isSessionStateDirectionSupported({
      capabilities: {
        runtime: {
          activity: {
            supported: true,
            providerToHappier: { supported: true, source: 'event' },
          },
        },
      },
      fieldId: 'runtime.activity',
      direction: 'providerToHappier',
    })).toEqual({ supported: true });
  });

  it('blocks deferred view fields even when a provider advertises support', () => {
    expect(isSessionStateDirectionSupported({
      capabilities: {
        view: {
          readState: {
            supported: true,
            happierToProvider: { supported: true },
            providerToHappier: { supported: true },
          },
        },
      },
      fieldId: 'view.readState',
      direction: 'happierToProvider',
    })).toEqual({ supported: false, reason: 'field-unsupported' });

    expect(isSessionStateDirectionSupported({
      capabilities: {
        view: {
          attention: {
            supported: true,
            providerToHappier: { supported: true },
          },
        },
      },
      fieldId: 'view.attention',
      direction: 'providerToHappier',
    })).toEqual({ supported: false, reason: 'field-unsupported' });
  });
});
