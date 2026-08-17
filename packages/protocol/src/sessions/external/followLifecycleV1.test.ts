import { describe, expect, it } from 'vitest';

import * as externalSessions from './index.js';

const LEGACY_LINK = {
  directSessionV1: {
    v: 1,
    providerId: 'claude',
    machineId: 'machine-legacy',
    remoteSessionId: 'remote-legacy',
    source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
  },
};

const QUALIFIED_IDENTITY = {
  v: 1 as const,
  agent: {
    pluginId: 'com.example.external-agent',
    localId: 'assistant',
  },
  source: {
    kind: 'claudeConfig',
    contractVersion: 1 as const,
  },
};

function policy(
  suffix: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    machineId: 'machine-1',
    qualifiedIdentity: QUALIFIED_IDENTITY,
    sourcePolicyId: `es-source-policy:v1:${suffix.repeat(64)}`,
    enabledAtMs: 1_000,
    ...overrides,
  };
}

describe('external-session follow lifecycle contracts', () => {
  it('normalizes follow status and a bounded last issue through the one link writer', () => {
    const protocol = externalSessions as Record<string, any>;

    expect(protocol.updateLinkedExternalSessionFollowMetadataV1(LEGACY_LINK, {
      followPolicyV1: {
        v: 1,
        policy: 'background_follow',
        updatedAtMs: 20,
      },
      followStatusV1: {
        v: 1,
        status: 'error',
        reason: 'lease_failed',
        updatedAtMs: 21,
      },
      lastFollowIssueV1: {
        v: 1,
        code: 'source_unavailable',
        message: 'The external session source is unavailable.',
        retryable: true,
        observedAtMs: 21,
      },
    })).toMatchObject({
      externalSessionV1: {
        v: 1,
        agentId: 'claude',
        followPolicyV1: {
          v: 1,
          policy: 'background_follow',
          updatedAtMs: 20,
        },
        followStatusV1: {
          v: 1,
          status: 'error',
          reason: 'lease_failed',
          updatedAtMs: 21,
        },
        lastFollowIssueV1: {
          v: 1,
          code: 'source_unavailable',
          message: 'The external session source is unavailable.',
          retryable: true,
          observedAtMs: 21,
        },
      },
    });

    expect(protocol.readExternalSessionFollowStatusV1({
      v: 1,
      status: 'reacquiring',
      updatedAtMs: 30,
    })).toEqual({
      v: 1,
      status: 'reacquiring',
      updatedAtMs: 30,
    });
    expect(protocol.readExternalSessionFollowStatusV1({
      v: 1,
      status: 'reacquiring',
      updatedAtMs: 30,
      futureField: true,
    })).toBeNull();
    expect(protocol.readExternalSessionFollowStatusV1({
      v: 1,
      status: 'working',
      updatedAtMs: 30,
    })).toBeNull();
    expect(protocol.readExternalSessionFollowIssueV1({
      v: 1,
      code: '',
      observedAtMs: 30,
    })).toBeNull();
  });

  it('clears lifecycle fields explicitly without disturbing the linked identity', () => {
    const protocol = externalSessions as Record<string, any>;
    const metadata = protocol.updateLinkedExternalSessionFollowMetadataV1(LEGACY_LINK, {
      followStatusV1: {
        v: 1,
        status: 'active',
        updatedAtMs: 10,
      },
      lastFollowIssueV1: {
        v: 1,
        code: 'old_failure',
        observedAtMs: 9,
      },
    });

    const cleared = protocol.updateLinkedExternalSessionFollowMetadataV1(metadata, {
      followStatusV1: null,
      lastFollowIssueV1: null,
    });

    expect(cleared.externalSessionV1).not.toHaveProperty('followStatusV1');
    expect(cleared.externalSessionV1).not.toHaveProperty('lastFollowIssueV1');
    expect(cleared.externalSessionV1).toMatchObject({
      v: 1,
      agentId: 'claude',
      machineId: 'machine-legacy',
      remoteSessionId: 'remote-legacy',
    });
    expect(cleared).not.toHaveProperty('directSessionV1');
  });

  it('preserves current qualified identity through policy mutation and omits it from the released row', () => {
    const protocol = externalSessions as Record<string, any>;
    const metadata = {
      externalSessionV1: {
        v: 1,
        agentId: 'assistant',
        machineId: 'machine-1',
        remoteSessionId: 'remote-1',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
        qualifiedIdentity: QUALIFIED_IDENTITY,
        linkData: { opaqueIdentity: 'plugin-owned' },
      },
    };

    const updated = protocol.updateLinkedExternalSessionFollowMetadataV1(metadata, {
      followPolicyV1: {
        v: 1,
        policy: 'background_follow',
        updatedAtMs: 20,
      },
    });

    expect(updated).toMatchObject({
      externalSessionV1: {
        agentId: 'assistant',
        qualifiedIdentity: QUALIFIED_IDENTITY,
        linkData: { opaqueIdentity: 'plugin-owned' },
        followPolicyV1: {
          v: 1,
          policy: 'background_follow',
          updatedAtMs: 20,
        },
      },
    });
    expect(updated).not.toHaveProperty('directSessionV1');
  });

  it('does not mutate a released row when a malformed current row is present', () => {
    const protocol = externalSessions as Record<string, any>;
    const metadata = {
      externalSessionV1: {
        v: 1,
        agentId: '',
        machineId: 'machine-current',
        remoteSessionId: 'remote-current',
        source: { kind: 'claudeConfig', configDir: '/tmp/current' },
      },
      ...LEGACY_LINK,
    };

    expect(protocol.updateLinkedExternalSessionFollowMetadataV1(metadata, {
      followPolicyV1: {
        v: 1,
        policy: 'background_follow',
        updatedAtMs: 20,
      },
    })).toBe(metadata);
  });

  it('reserves a stable completed boundary once before best-effort effects', () => {
    const protocol = externalSessions as Record<string, any>;
    const first = protocol.reserveExternalSessionCompletedBoundaryV1(null, {
      id: 'turn-17',
      observedAtMs: 100,
    });

    expect(first).toEqual({
      outcome: 'reserved',
      boundary: { id: 'turn-17', observedAtMs: 100 },
    });

    // Simulate restart after the canonical boundary owner was persisted but before
    // or after a best-effort notification effect. Re-observing the same stable id
    // must not reserve another attempt even when its observation timestamp changes.
    expect(protocol.reserveExternalSessionCompletedBoundaryV1(first.boundary, {
      id: 'turn-17',
      observedAtMs: 200,
    })).toEqual({
      outcome: 'replay',
      boundary: first.boundary,
    });

    expect(protocol.reserveExternalSessionCompletedBoundaryV1(first.boundary, {
      id: 'turn-16',
      observedAtMs: 90,
    })).toEqual({
      outcome: 'stale',
      boundary: first.boundary,
    });
    expect(protocol.reserveExternalSessionCompletedBoundaryV1(first.boundary, {
      id: 'turn-conflict',
      observedAtMs: 100,
    })).toEqual({
      outcome: 'conflict',
      boundary: first.boundary,
    });
    expect(protocol.reserveExternalSessionCompletedBoundaryV1(first.boundary, {
      id: 'turn-18',
      observedAtMs: 201,
    })).toEqual({
      outcome: 'reserved',
      boundary: { id: 'turn-18', observedAtMs: 201 },
    });

    const metadata = protocol.updateLinkedExternalSessionFollowMetadataV1(LEGACY_LINK, {
      followStatusV1: { v: 1, status: 'active', updatedAtMs: 100 },
    });
    expect(metadata.externalSessionV1).not.toHaveProperty('boundary');
    expect(metadata.externalSessionV1).not.toHaveProperty('lastNotificationAttemptBoundaryId');
  });

  it('defaults passive restart follow off until the user explicitly enables it', () => {
    const protocol = externalSessions as Record<string, any>;

    expect(protocol.readExternalSessionsSettingsV1(undefined)).toEqual({
      v: 1,
      keepPassivelyFollowingAfterRestart: false,
      autoLinkSourcePolicies: [],
    });
    expect(protocol.readExternalSessionsSettingsV1({
      v: 1,
      keepPassivelyFollowingAfterRestart: true,
      futureField: { revision: 2 },
    })).toEqual({
      v: 1,
      keepPassivelyFollowingAfterRestart: true,
      autoLinkSourcePolicies: [],
      futureField: { revision: 2 },
    });
    expect(protocol.readExternalSessionsSettingsV1({
      v: 1,
      keepPassivelyFollowingAfterRestart: 'yes',
    })).toBeNull();
  });

  it('roundtrips strict bounded auto-link source policies in the existing v1 envelope', () => {
    const protocol = externalSessions as Record<string, any>;
    const settings = {
      v: 1,
      keepPassivelyFollowingAfterRestart: true,
      autoLinkSourcePolicies: [policy('a')],
    };

    expect(protocol.ExternalSessionsSettingsV1Schema.parse(settings)).toEqual(settings);
    expect(protocol.readExternalSessionsSettingsV1(settings)).toEqual(settings);
  });

  it('derives one deterministic domain-separated policy id from the complete canonical source scope', () => {
    const protocol = externalSessions as Record<string, any>;
    const input = {
      machineId: 'machine-1',
      qualifiedIdentity: QUALIFIED_IDENTITY,
      canonicalResolvedSourceKey: 'claudeConfig:/tmp/claude',
    };

    const first = protocol.deriveExternalSessionsAutoLinkSourcePolicyIdV1(input);
    expect(first).toBe(
      'es-source-policy:v1:5d70e906669eb040e83abffb7e41be2e6a6645616214a0e721e3969ca9467ab7',
    );
    expect(protocol.deriveExternalSessionsAutoLinkSourcePolicyIdV1({
      ...input,
      qualifiedIdentity: {
        ...QUALIFIED_IDENTITY,
        agent: { ...QUALIFIED_IDENTITY.agent },
        source: { ...QUALIFIED_IDENTITY.source },
      },
    })).toBe(first);

    for (const changed of [
      { ...input, machineId: 'machine-2' },
      {
        ...input,
        qualifiedIdentity: {
          ...QUALIFIED_IDENTITY,
          agent: { ...QUALIFIED_IDENTITY.agent, pluginId: 'com.example.other-agent' },
        },
      },
      {
        ...input,
        qualifiedIdentity: {
          ...QUALIFIED_IDENTITY,
          agent: { ...QUALIFIED_IDENTITY.agent, localId: 'other-assistant' },
        },
      },
      {
        ...input,
        qualifiedIdentity: {
          ...QUALIFIED_IDENTITY,
          source: { ...QUALIFIED_IDENTITY.source, kind: 'codexHome' },
        },
      },
      { ...input, canonicalResolvedSourceKey: 'claudeConfig:/tmp/other' },
    ]) {
      expect(protocol.deriveExternalSessionsAutoLinkSourcePolicyIdV1(changed)).not.toBe(first);
    }

    // The v1 digest is explicitly domain separated; it must not equal the retired
    // CLI-local digest over the same untagged tuple.
    expect(first).not.toBe(
      'es-source-policy:v1:1811b97d28db39c0022693113ef1875e0b59ee0d3c9b9a6420ab6889de3a1c60',
    );
    expect(() => protocol.deriveExternalSessionsAutoLinkSourcePolicyIdV1({
      ...input,
      canonicalResolvedSourceKey: ' ',
    })).toThrow();
    expect(() => protocol.deriveExternalSessionsAutoLinkSourcePolicyIdV1({
      ...input,
      rawPath: '/private/session.jsonl',
    })).toThrow();
  });

  it('fails only the policy collection closed when it is malformed, duplicated, or over limit', () => {
    const protocol = externalSessions as Record<string, any>;
    const maximumPolicies = Array.from({ length: 128 }, (_, index) => ({
      ...policy('a'),
      sourcePolicyId: `es-source-policy:v1:${index.toString(16).padStart(64, '0')}`,
    }));
    expect(protocol.readExternalSessionsSettingsV1({
      v: 1,
      keepPassivelyFollowingAfterRestart: true,
      autoLinkSourcePolicies: maximumPolicies,
    }).autoLinkSourcePolicies).toHaveLength(128);

    const malformedCollections = [
      [{ ...policy('a'), rawPath: '/private/session.jsonl' }],
      [policy('a'), policy('a', { enabledAtMs: 2_000 })],
      [...maximumPolicies, {
        ...policy('a'),
        sourcePolicyId: `es-source-policy:v1:${(128).toString(16).padStart(64, '0')}`,
      }],
      [policy('A')],
    ];

    for (const autoLinkSourcePolicies of malformedCollections) {
      expect(protocol.readExternalSessionsSettingsV1({
        v: 1,
        keepPassivelyFollowingAfterRestart: true,
        autoLinkSourcePolicies,
        futureField: { revision: 2 },
      })).toEqual({
        v: 1,
        keepPassivelyFollowingAfterRestart: true,
        autoLinkSourcePolicies: [],
        futureField: { revision: 2 },
      });
    }
  });

  it('patches one known setting while preserving policies and unknown future fields', () => {
    const protocol = externalSessions as Record<string, any>;
    const current = {
      v: 1,
      keepPassivelyFollowingAfterRestart: false,
      autoLinkSourcePolicies: [policy('a')],
      futureField: { revision: 2 },
    };

    const patched = protocol.patchExternalSessionsSettingsV1(current, {
      keepPassivelyFollowingAfterRestart: true,
    });

    expect(patched).toEqual({
      ...current,
      keepPassivelyFollowingAfterRestart: true,
    });
    expect(current.keepPassivelyFollowingAfterRestart).toBe(false);
  });

  it('upserts and removes exact policy scopes without disturbing passive follow, peers, or future fields', () => {
    const protocol = externalSessions as Record<string, any>;
    const first = policy('a');
    const second = policy('b', { machineId: 'machine-2' });
    const current = {
      v: 1,
      keepPassivelyFollowingAfterRestart: true,
      autoLinkSourcePolicies: [first, second],
      futureField: { revision: 2 },
    };

    const upserted = protocol.upsertExternalSessionsAutoLinkSourcePolicyV1(
      current,
      policy('a', { enabledAtMs: 3_000 }),
    );
    expect(upserted).toEqual({
      ...current,
      autoLinkSourcePolicies: [
        policy('a', { enabledAtMs: 3_000 }),
        second,
      ],
    });
    expect(protocol.upsertExternalSessionsAutoLinkSourcePolicyV1(
      upserted,
      policy('a', { enabledAtMs: 3_000 }),
    )).toEqual(upserted);

    const removed = protocol.removeExternalSessionsAutoLinkSourcePolicyV1(upserted, {
      machineId: 'machine-1',
      qualifiedIdentity: QUALIFIED_IDENTITY,
      sourcePolicyId: policy('a').sourcePolicyId,
    });
    expect(removed).toEqual({
      ...current,
      autoLinkSourcePolicies: [second],
    });
    expect(protocol.removeExternalSessionsAutoLinkSourcePolicyV1(removed, {
      machineId: 'machine-1',
      qualifiedIdentity: QUALIFIED_IDENTITY,
      sourcePolicyId: policy('a').sourcePolicyId,
    })).toEqual(removed);
  });

  it('stores only the exact privacy-safe policy shape', () => {
    const protocol = externalSessions as Record<string, any>;
    const sensitiveFields = [
      'path',
      'url',
      'nativeSessionId',
      'remoteSessionId',
      'resolvedSource',
      'sourceKey',
      'credential',
      'token',
      'connectedServiceId',
      'title',
      'cwd',
      'hookPayload',
      'payload',
      'candidate',
      'linkData',
    ];

    for (const field of sensitiveFields) {
      expect(() => protocol.upsertExternalSessionsAutoLinkSourcePolicyV1(
        undefined,
        policy('a', { [field]: 'private-value' }),
      )).toThrow();
    }
    expect(() => protocol.upsertExternalSessionsAutoLinkSourcePolicyV1(
      undefined,
      policy('a', { machineId: 'm'.repeat(257) }),
    )).toThrow();
    expect(() => protocol.upsertExternalSessionsAutoLinkSourcePolicyV1(
      undefined,
      policy('a', { enabledAtMs: Number.MAX_SAFE_INTEGER + 1 }),
    )).toThrow();
    const fullSettings = Array.from({ length: 128 }, (_, index) => ({
      ...policy('a'),
      sourcePolicyId: `es-source-policy:v1:${index.toString(16).padStart(64, '0')}`,
    })).reduce(
      (settings, entry) =>
        protocol.upsertExternalSessionsAutoLinkSourcePolicyV1(settings, entry),
      undefined,
    );
    expect(() => protocol.upsertExternalSessionsAutoLinkSourcePolicyV1(
      fullSettings,
      {
        ...policy('a'),
        sourcePolicyId: `es-source-policy:v1:${(128).toString(16).padStart(64, '0')}`,
      },
    )).toThrow();

    expect(Object.keys(protocol.upsertExternalSessionsAutoLinkSourcePolicyV1(
      undefined,
      policy('a'),
    ).autoLinkSourcePolicies[0])).toEqual([
      'machineId',
      'qualifiedIdentity',
      'sourcePolicyId',
      'enabledAtMs',
    ]);
  });
});
