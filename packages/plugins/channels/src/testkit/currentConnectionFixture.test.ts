import { compilePluginJsonSchema, isValidPluginJsonSchemaValue } from '@happier-dev/plugin-sdk/manifest';
import { describe, expect, it } from 'vitest';

import { CHANNEL_STATE_COLLECTION } from '../collections.js';
import {
  createCurrentConversationConnectionFixture,
  createCurrentConversationPendingOldTransportStopFixture,
  type ConversationConnectionFixtureAuthority,
} from './currentConnectionFixture.js';

describe('current Channels connection fixture', () => {
  it('emits current strict connection and frozen-stop authority facts', () => {
    const authority = {
      providerPluginId: 'happier.channel.fixture',
      providerContributionSelection: {
        contributionId: 'fixture-provider',
        immutableGenerationId: 'fixture-generation',
      },
      providerSetupInput: { source: 'fixture' },
      credentialRef: null,
      transportOrigin: {
        serverIdentityId: 'srv_fixture',
        materializationRef: {
          pluginId: 'happier.channel.fixture',
          machineId: 'machine-fixture',
          materializationId: 'materialization-fixture',
        },
      },
      providerConnectionKey: 'fixture:connection',
      providerConfig: { source: 'fixture' },
      routingIdentityKey: 'f'.repeat(43),
      integrationPrincipal: { id: 'fixture-principal' },
      authorityEpoch: 1,
    } as const satisfies ConversationConnectionFixtureAuthority;
    const connection = createCurrentConversationConnectionFixture({
      connectionId: 'connection-fixture',
      authority,
    });
    const pendingOldTransportStop = createCurrentConversationPendingOldTransportStopFixture({
      connectionId: connection.id,
      authority,
      predecessorCheckpointedPollInvocation: {
        connectionRevision: 1,
        authorityEpoch: authority.authorityEpoch,
        transportOrigin: authority.transportOrigin,
      },
      authorityEpoch: 1,
      reason: 'delete',
      overlapSafety: 'safe',
    });
    const validate = compilePluginJsonSchema(CHANNEL_STATE_COLLECTION.schema);
    const pendingDeleteConnection = {
      ...connection,
      payload: {
        ...connection.payload,
        enabled: false,
        deletionState: 'pendingStopReconciliation' as const,
        pendingOldTransportStop,
      },
    };

    expect(isValidPluginJsonSchemaValue(validate, connection)).toBe(true);
    expect(isValidPluginJsonSchemaValue(validate, pendingDeleteConnection)).toBe(true);

    for (const field of [
      'providerPluginId',
      'providerContributionSelection',
      'providerSetupInput',
      'credentialRef',
      'transportOrigin',
      'transport',
      'providerConnectionKey',
      'providerConfig',
      'routingIdentityKey',
      'integrationPrincipal',
      'authorityEpoch',
      'deletionState',
      'pendingOldTransportStop',
      'historyGap',
      'pollFailure',
    ] as const) {
      const { [field]: _omitted, ...payload } = connection.payload;
      expect(isValidPluginJsonSchemaValue(validate, { ...connection, payload })).toBe(false);
    }

    for (const field of [
      'transportOrigin',
      'predecessorCheckpointedPollInvocation',
      'providerContributionSelection',
      'stopRequest',
      'overlapSafety',
      'acceptedPossibleLoss',
    ] as const) {
      const { [field]: _omitted, ...pendingOldTransportStopWithoutField } = pendingOldTransportStop;
      expect(isValidPluginJsonSchemaValue(validate, {
        ...pendingDeleteConnection,
        payload: {
          ...pendingDeleteConnection.payload,
          pendingOldTransportStop: pendingOldTransportStopWithoutField,
        },
      })).toBe(false);
    }

    for (const field of ['credentialRef', 'providerConfig', 'authorityEpoch'] as const) {
      const { [field]: _omitted, ...stopRequest } = pendingOldTransportStop.stopRequest;
      expect(isValidPluginJsonSchemaValue(validate, {
        ...pendingDeleteConnection,
        payload: {
          ...pendingDeleteConnection.payload,
          pendingOldTransportStop: { ...pendingOldTransportStop, stopRequest },
        },
      })).toBe(false);
    }
  });
});
