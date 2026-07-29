import { describe, expect, it } from 'vitest';

import {
  clearSessionStateFieldFromMetadata,
  createSessionStateFieldMetadataUpdater,
  hasSessionStateFieldMetadataBinding,
} from './publishField.js';
import { readExternalAgentObservationSessionState } from './externalAgent.js';

const snapshot = {
  v: 1,
  qualifiedLinkIdentity: {
    v: 1,
    agent: {
      pluginId: 'happier.claude',
      localId: 'claude',
    },
    source: {
      kind: 'claudeConfig',
      contractVersion: 1,
    },
  },
  linkGeneration: 'link-generation-7',
  status: 'working',
  observedAtMs: 100,
  expiresAtMs: 150,
} as const;

describe('external-Agent observation session-state binding', () => {
  it('writes one strict runtime.externalAgent field without changing hosted, Pending, or control truth', () => {
    expect(hasSessionStateFieldMetadataBinding('runtime.externalAgent')).toBe(true);

    const hostedMetadata = {
      active: false,
      thinking: false,
      latestTurnStatus: 'idle',
      runtimeActivityState: 'idle',
      runtimeActivityActiveCount: 0,
      sessionPendingQueueHoldV1: {
        v: 1,
        held: true,
        reason: 'test',
        updatedAtMs: 90,
      },
      sessionRunnerRuntimeV1: {
        v: 1,
        state: 'offline',
        observedAtMs: 90,
      },
    } as const;
    const updated = createSessionStateFieldMetadataUpdater(
      'runtime.externalAgent',
      snapshot,
    )(hostedMetadata);

    expect(updated).toEqual({
      ...hostedMetadata,
      externalAgentObservationV1: snapshot,
    });
    expect(updated).not.toHaveProperty('externalProvider');
    expect(updated).not.toHaveProperty('runtimeExternalProviderV1');
  });

  it('reads, validates, and clears only the canonical observation snapshot', () => {
    expect(readExternalAgentObservationSessionState({
      externalAgentObservationV1: snapshot,
    })).toEqual({
      value: snapshot,
      updatedAt: 100,
    });

    expect(readExternalAgentObservationSessionState({
      externalAgentObservationV1: {
        ...snapshot,
        linkGeneration: 7,
      },
    })).toEqual({
      value: null,
      updatedAt: null,
    });

    expect(clearSessionStateFieldFromMetadata({
      path: '/tmp/project',
      externalAgentObservationV1: snapshot,
    }, 'runtime.externalAgent')).toEqual({
      path: '/tmp/project',
    });
  });
});
