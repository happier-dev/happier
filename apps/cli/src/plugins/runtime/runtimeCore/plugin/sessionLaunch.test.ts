import { describe, expect, it } from 'vitest';

import type { StoredCredentials } from '@/persistence';

import {
  buildPluginHostSessionRuntimeOptions,
  buildPluginSessionBindingInput,
} from './sessionLaunch';

const credentials = {
  token: 'test-token',
  encryption: {
    type: 'legacy' as const,
    secret: new Uint8Array([1, 2, 3]),
  },
} satisfies StoredCredentials;

describe('plugin session launch binding', () => {
  it('rejects Pool origin containing private definition fields', () => {
    expect(() => buildPluginSessionBindingInput({
      credentials,
      placementOrigin: {
        kind: 'machine_pool',
        poolId: '0191f11b-4ab2-7ef2-8dd2-268abc9c191f',
        name: 'Private pool',
      },
    })).toThrow();
  });

  it('rejects malformed access instead of silently dropping creation authority', () => {
    expect(() => buildPluginSessionBindingInput({
      credentials, initialAccess: { grants: [], extra: true },
    })).toThrow();
  });

  it('rejects initial access on an existing Happier Session', () => {
    for (const context of [
      { initialAccess: { grants: [] } },
      { primaryTeamId: null },
      {
        teamCredentialBindings: [{
          v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-1', expectedResourceRevision: 1,
        }],
      },
    ]) {
      for (const attach of [{ existingSessionId: 'session-1' }, { sessionAttachFilePath: '/private/attach.json' }]) {
        expect(() => buildPluginSessionBindingInput({ credentials, ...context, ...attach })).toThrow();
      }
    }
  });

  it.each(['', 42, false, {}])('rejects malformed explicit Team context %j', (primaryTeamId) => {
    expect(() => buildPluginSessionBindingInput({ credentials, primaryTeamId })).toThrow();
  });

  it('preserves an initial title through the host runtime options', () => {
    const input = buildPluginSessionBindingInput({
      credentials,
      initialTitle: ' CLI live QA ',
    });
    const options = buildPluginHostSessionRuntimeOptions(input);

    expect(options).toMatchObject({ initialTitle: 'CLI live QA' });
  });

  it('preserves the exact Team credential binding into the host Session runtime', () => {
    const teamCredentialBinding = {
      v: 1 as const,
      slot: { kind: 'provider_model' as const },
      resourceId: 'resource-1',
      expectedResourceRevision: 3,
      deliveryMode: 'brokered' as const,
    };
    const input = buildPluginSessionBindingInput({
      credentials,
      teamCredentialBindings: [teamCredentialBinding],
    });

    expect(input.teamCredentialBindings).toEqual([teamCredentialBinding]);
    expect(buildPluginHostSessionRuntimeOptions(input).teamCredentialBindings)
      .toEqual([teamCredentialBinding]);
  });

  it('admits an attached Runner Team binding only with the host-scoped exact-binding authority', () => {
    const teamCredentialBinding = {
      v: 1 as const,
      slot: { kind: 'provider_model' as const },
      resourceId: 'resource-1',
      expectedResourceRevision: 3,
      deliveryMode: 'brokered' as const,
    };
    expect(buildPluginSessionBindingInput({
      credentials,
      existingSessionId: 'session-1',
      teamCredentialBindings: [teamCredentialBinding],
      allowAttachedTeamCredentialBinding: true,
    }).teamCredentialBindings).toEqual([teamCredentialBinding]);
  });
});
