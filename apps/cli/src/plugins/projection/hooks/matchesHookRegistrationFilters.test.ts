import { describe, expect, it } from 'vitest';

import type { HookEventEnvelopeV1 } from '@happier-dev/protocol';

import type { ResolvedActivatedHookRegistration } from '@/plugins/projection/registry/types';
import { matchesHookRegistrationFilters } from './matchesHookRegistrationFilters';

function createEnvelope(overrides: Partial<HookEventEnvelopeV1> = {}): HookEventEnvelopeV1 {
  return {
    hookVersion: 1,
    eventId: 'session.spawned',
    category: 'lifecycle',
    scope: 'session',
    timestampMs: 1,
    payload: {},
    ...overrides,
  };
}

function createRegistration(
  filters?: Readonly<Record<string, unknown>>,
): ResolvedActivatedHookRegistration {
  return {
    provenance: 'external',
    source: { kind: 'path' },
    pluginId: 'acme.filters',
    manifestPath: '/plugins/acme/.happier-plugin/plugin.json',
    manifestDigest: 'sha256:test',
    daemonEntryPath: '/plugins/acme/daemon.mjs',
    sourceSpec: { kind: 'path', locator: '/plugins/acme' },
    definition: {
      hookApiVersion: 1,
      id: 'session.spawned',
      category: 'lifecycle',
      scope: 'session',
    ...(filters ? { filters } : {}),
      executionKind: 'observe',
    },
  } as unknown as ResolvedActivatedHookRegistration;
}

describe('matchesHookRegistrationFilters', () => {
  it('matches runtimeTargetId against the canonical envelope backendTarget', () => {
    expect(matchesHookRegistrationFilters(
      createEnvelope({ backendTarget: 'acme.runtime' }),
      createRegistration({ runtimeTargetId: 'acme.runtime' }),
    )).toBe(true);
  });

  it('rejects runtimeTargetId when the envelope runtime target differs', () => {
    expect(matchesHookRegistrationFilters(
      createEnvelope({ backendTarget: 'other.runtime' }),
      createRegistration({ runtimeTargetId: 'acme.runtime' }),
    )).toBe(false);
  });

  it('keeps retired backend/provider filter aliases fail-closed', () => {
    expect(matchesHookRegistrationFilters(
      createEnvelope({ backendTarget: 'acme.runtime' }),
      createRegistration({ backendTargetId: 'acme.runtime' }),
    )).toBe(false);
    expect(matchesHookRegistrationFilters(
      createEnvelope({ backendTarget: 'acme.runtime' }),
      createRegistration({ backendId: 'acme.runtime' }),
    )).toBe(false);
    expect(matchesHookRegistrationFilters(
      createEnvelope({ backendTarget: 'acme.runtime' }),
      createRegistration({ providerId: 'acme.runtime' }),
    )).toBe(false);
  });
});
