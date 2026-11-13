import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StoredCredentials } from '@/persistence';
import * as persistence from '@/persistence';
import { bindRequesterSessionCredentialScope, decodeStoredCredentials } from '@/persistence';
import { readMcpExecutionSource } from '@/mcp/runtime/mcpExecutionSource';

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

afterEach(() => vi.restoreAllMocks());

describe('plugin session launch binding', () => {
  it.each(['child', 'local', 'server-only', 'authored-scope', 'authored-getter'])('preserves only actual host credential context through Session normalization (%s)', async kind => {
    let sourceCredentials = decodeStoredCredentials({ token: 'normalizer-fixture' });
    if (!sourceCredentials) throw new Error('Invalid stored credential fixture');
    const scope = { serverId: 'profile-normalizer', serverHttpBaseUrl: 'https://normalizer.example.test',
      requesterSession: { sessionId: 'session-1', homeServerIdentityId: 'srv_normalizer', attribution: {
        serverId: 'profile-normalizer', accountId: 'member', machineId: 'm1', installationId: 'install',
      } } };
    // Device settings I/O is the boundary; retained Home and exact profile
    // qualification still pass through their actual canonical owners.
    vi.spyOn(persistence, 'readSettings').mockResolvedValue({ schemaVersion: 6, onboardingCompleted: true,
      servers: { 'profile-normalizer': { id: 'profile-normalizer', name: 'Normalizer',
        serverUrl: scope.serverHttpBaseUrl, webappUrl: scope.serverHttpBaseUrl, createdAt: 1, updatedAt: 1,
        homeConnectionDescriptor: { v: 1, homeServerIdentityId: 'srv_normalizer', canonicalServerUrl: scope.serverHttpBaseUrl,
          revision: 1, endpoints: [{ kind: 'https', url: scope.serverHttpBaseUrl }] },
      } } });
    if (kind === 'child') sourceCredentials = bindRequesterSessionCredentialScope(sourceCredentials, scope);
    if (kind === 'server-only') sourceCredentials = bindRequesterSessionCredentialScope(sourceCredentials, {
      serverId: scope.serverId, serverHttpBaseUrl: scope.serverHttpBaseUrl,
    });
    if (kind === 'authored-scope') sourceCredentials = { ...sourceCredentials, requesterSessionCredentialScope: scope };
    if (kind === 'authored-getter') Object.defineProperty(sourceCredentials, 'requesterSessionCredentialScope', { get: () => scope });
    const options = buildPluginHostSessionRuntimeOptions(buildPluginSessionBindingInput({ credentials: sourceCredentials }));
    const selected = readMcpExecutionSource({ credentials: options.credentials, localWorkflow: kind !== 'child',
      sessionId: 'session-1', machineId: 'm1', serverHttpBaseUrl: scope.serverHttpBaseUrl });
    if (kind !== 'child' && kind !== 'local') await expect(selected).rejects.toMatchObject({ code: 'agent_isolation_unavailable' });
    else if (kind === 'child') await expect(selected).resolves.toMatchObject({ kind: 'requester', identity: { kind: 'isolated' } });
    else await expect(selected).resolves.toEqual({ kind: 'local_user' });
  });
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
