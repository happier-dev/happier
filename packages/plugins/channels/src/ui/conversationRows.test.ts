import { describe, expect, it } from 'vitest';

import {
  channelsStatusNeedsYou,
  connectionStatus,
  readChannelsPageLocation,
  type ChannelsConnection,
} from './conversationRows.js';

describe('readChannelsPageLocation', () => {
  it('reads the link journey, optionally on one named bot (a session tab\'s "+" picks the bot first)', () => {
    expect(readChannelsPageLocation('link')).toEqual({ step: 'link' });
    expect(readChannelsPageLocation('link/connection-1')).toEqual({ step: 'link', connectionId: 'connection-1' });
    expect(readChannelsPageLocation('binding-1/edit')).toEqual({ bindingId: 'binding-1', step: 'edit' });
    expect(readChannelsPageLocation('binding-1')).toEqual({ bindingId: 'binding-1' });
  });
});

const t = (_key: string, fallback: string): string => fallback;

function connection(attention: Partial<ChannelsConnection['attention']> = {}): ChannelsConnection {
  return {
    connectionId: 'connection-1',
    revision: 1,
    authorityEpoch: 1,
    providerPluginId: 'happier.telegram',
    selectedMachineId: 'machine-1',
    selectedTransport: 'socket',
    enabled: true,
    deletionState: 'none',
    maximumObservationAgeMs: 120_000,
    attention: {
      historyGap: null,
      providerReadiness: null,
      ingressConflict: null,
      pollFailure: null,
      bestEffortBeforeDurableAdmission: false,
      oldTransportStopUnconfirmed: false,
      endpointRetargetOwed: false,
      acceptedPossibleLoss: false,
      outwardDelivery: { retryDue: false, notDelivered: false, partial: false, outcomeUnknown: false, archiveRecovery: false },
      ...attention,
    },
  };
}

const DELIVERY = connection().attention.outwardDelivery;

describe('connectionStatus', () => {
  it('says nothing for a healthy bot, asks for you in the attention tone, and keeps rose for failure', () => {
    expect(connectionStatus(connection(), t).tone).toBe('secondary');
    expect(connectionStatus(connection({ providerReadiness: { code: 'providerCredentialInvalid' } }), t).tone).toBe('attention');
    expect(connectionStatus(connection({ oldTransportStopUnconfirmed: true, endpointRetargetOwed: true }), t).tone).toBe('attention');
    expect(connectionStatus(connection({ outwardDelivery: { ...DELIVERY, notDelivered: true } }), t).tone).toBe('attention');
    expect(connectionStatus(connection({ outwardDelivery: { ...DELIVERY, outcomeUnknown: true } }), t).tone).toBe('danger');
    // A retry the system owns is a caution, not a request of the reader.
    expect(connectionStatus(connection({ outwardDelivery: { ...DELIVERY, retryDue: true } }), t).tone).toBe('warning');
  });

  it('treats needs-you, caution and failure as needing a look, and a quiet state as not', () => {
    expect(channelsStatusNeedsYou('attention')).toBe(true);
    expect(channelsStatusNeedsYou('warning')).toBe(true);
    expect(channelsStatusNeedsYou('danger')).toBe(true);
    expect(channelsStatusNeedsYou('secondary')).toBe(false);
    expect(channelsStatusNeedsYou('neutral')).toBe(false);
  });
});
