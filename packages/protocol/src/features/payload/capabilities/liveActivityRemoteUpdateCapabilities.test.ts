import { describe, expect, it } from 'vitest';

import { CapabilitiesSchema } from './capabilitiesSchema.js';

describe('Live Activity remote update capabilities payload', () => {
  it('preserves selected-server transport diagnostics without treating them as feature gates', () => {
    const parsed = CapabilitiesSchema.parse({
      liveActivities: {
        remoteUpdates: {
          modes: {
            hosted_happier_relay: {
              available: false,
              reasons: ['hosted_relay_provider_blocked'],
            },
            direct_apns: {
              available: true,
              reasons: [],
              configurationDiagnostics: [],
            },
            background_wake_best_effort: {
              available: false,
              reasons: ['background_wake_disabled'],
            },
          },
          capabilities: {
            perActivityUpdate: {
              id: 'per_activity_update',
              status: 'supported_when_configured',
              events: ['update', 'end'],
              targetKinds: ['activitykit_update_token'],
              availableModes: ['direct_apns'],
              reasons: [],
            },
            pushToStart: {
              id: 'push_to_start',
              status: 'future_unsupported',
              events: ['start'],
              targetKinds: ['activitykit_push_to_start_token'],
              availableModes: [],
              reasons: ['not_in_phase_9_5'],
            },
            broadcastChannel: {
              id: 'broadcast_channel',
              status: 'future_unsupported',
              events: [],
              targetKinds: [],
              availableModes: [],
              reasons: ['private_per_session_surface_not_broadcast'],
            },
          },
        },
      },
    });

    expect(parsed.liveActivities.remoteUpdates.modes.direct_apns.available).toBe(true);
    expect(parsed.liveActivities.remoteUpdates.capabilities.pushToStart.status).toBe('future_unsupported');
  });

  it('rejects capability event sets that do not match the capability id', () => {
    expect(() => CapabilitiesSchema.parse({
      liveActivities: {
        remoteUpdates: {
          modes: {
            hosted_happier_relay: {
              available: false,
              reasons: ['hosted_relay_provider_blocked'],
            },
            direct_apns: {
              available: true,
              reasons: [],
            },
            background_wake_best_effort: {
              available: false,
              reasons: ['background_wake_disabled'],
            },
          },
          capabilities: {
            perActivityUpdate: {
              id: 'per_activity_update',
              status: 'supported_when_configured',
              events: ['update', 'end'],
              targetKinds: ['activitykit_update_token'],
              availableModes: ['direct_apns'],
              reasons: [],
            },
            pushToStart: {
              id: 'push_to_start',
              status: 'future_unsupported',
              events: ['start', 'update'],
              targetKinds: ['activitykit_push_to_start_token'],
              availableModes: [],
              reasons: ['not_in_phase_9_5'],
            },
            broadcastChannel: {
              id: 'broadcast_channel',
              status: 'future_unsupported',
              events: [],
              targetKinds: [],
              availableModes: [],
              reasons: ['private_per_session_surface_not_broadcast'],
            },
          },
        },
      },
    })).toThrow();
  });

  it('parses sanitized direct APNs credential diagnostics as capabilities, not feature gates', () => {
    const parsed = CapabilitiesSchema.parse({
      liveActivities: {
        remoteUpdates: {
          modes: {
            hosted_happier_relay: {
              available: false,
              reasons: ['hosted_relay_provider_blocked'],
            },
            direct_apns: {
              available: false,
              reasons: ['direct_apns_not_configured'],
              configurationDiagnostics: [
                'apns_key_id_missing',
                'apns_private_key_must_be_p8_token_key',
              ],
            },
            background_wake_best_effort: {
              available: true,
              reasons: [],
            },
          },
          capabilities: {
            perActivityUpdate: {
              id: 'per_activity_update',
              status: 'supported_when_configured',
              events: ['update', 'end'],
              targetKinds: ['activitykit_update_token'],
              availableModes: ['background_wake_best_effort'],
              reasons: [],
            },
            pushToStart: {
              id: 'push_to_start',
              status: 'future_unsupported',
              events: ['start'],
              targetKinds: ['activitykit_push_to_start_token'],
              availableModes: [],
              reasons: ['not_in_phase_9_5'],
            },
            broadcastChannel: {
              id: 'broadcast_channel',
              status: 'future_unsupported',
              events: [],
              targetKinds: [],
              availableModes: [],
              reasons: ['private_per_session_surface_not_broadcast'],
            },
          },
        },
      },
    });

    expect(parsed.liveActivities.remoteUpdates.modes.direct_apns.configurationDiagnostics).toEqual([
      'apns_key_id_missing',
      'apns_private_key_must_be_p8_token_key',
    ]);
  });
});
