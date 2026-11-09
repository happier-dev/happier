import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';

import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { FeaturesResponseSchema, HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol';
import type { ResolvedHomeTarget } from '@happier-dev/cli-common/homeTarget';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { projectSafeAuthError } from '@/cli/commands/auth/errorDiagnostic';
import { createSystemTasksRunner } from '@happier-dev/cli-common/systemTasks';

import {
  claimTerminalAuthRequest,
  createTerminalAuthRequest,
  readTerminalAuthRequestStatus,
  resolveAuthenticatedExactHomeConnectionDescriptorObservation,
  verifyTerminalAuthEnrollmentRuntime,
} from './terminalAuthEnrollmentClient';

const DESCRIPTOR = HomeConnectionDescriptorV1Schema.parse({
  v: 1,
  homeServerIdentityId: 'srv_home_expected',
  canonicalServerUrl: 'https://home.example.test',
  revision: 1,
  endpoints: [
    { kind: 'https', url: 'https://home.example.test' },
    { kind: 'iroh', endpointId: 'a'.repeat(64) },
  ],
});

const STRICT_TARGET = {
  profileId: 'home',
  homeServerIdentityId: DESCRIPTOR.homeServerIdentityId,
  descriptor: DESCRIPTOR,
  canonicalAuthUrl: DESCRIPTOR.canonicalServerUrl,
  applicationUrl: DESCRIPTOR.canonicalServerUrl,
  webappUrl: 'https://app.example.test',
  credentialDestination: {
    v: 1,
    homeServerIdentityId: DESCRIPTOR.homeServerIdentityId,
    canonicalServerUrl: DESCRIPTOR.canonicalServerUrl,
    applicationEndpointUrls: [DESCRIPTOR.canonicalServerUrl],
    irohEndpointIds: ['a'.repeat(64)],
  },
  preferredTransport: 'iroh',
  authority: 'saved_profile',
} satisfies ResolvedHomeTarget;

function readyFeatures(params: Readonly<{
  identity?: string;
  descriptor?: typeof DESCRIPTOR;
  provenance?: 'authenticated' | 'public';
}> = {}): CliServerFeaturesSnapshot {
  const descriptor = 'descriptor' in params ? params.descriptor : DESCRIPTOR;
  return {
    status: 'ready',
    provenance: params.provenance ?? 'authenticated',
    features: {
      ...FeaturesResponseSchema.parse({
        features: {},
        capabilities: {
        serverIdentity: { serverIdentityId: params.identity ?? DESCRIPTOR.homeServerIdentityId },
        },
      }),
      ...(descriptor ? { homeConnectionDescriptor: descriptor } : {}),
    },
  };
}

describe('terminal auth enrollment client', () => {
  it.each([
    { reason: 'target', target: { ...STRICT_TARGET, credentialDestination: null }, snapshot: readyFeatures() },
    { reason: 'descriptor', snapshot: readyFeatures({ descriptor: undefined }), phase: 'controller_approval' as const },
    { reason: 'identity', snapshot: readyFeatures({ identity: 'srv_home_other' }) },
    { reason: 'descriptor_identity', snapshot: readyFeatures({ descriptor: { ...DESCRIPTOR, homeServerIdentityId: 'srv_home_other' } }) },
    { reason: 'destination', snapshot: readyFeatures({ descriptor: { ...DESCRIPTOR, endpoints: [DESCRIPTOR.endpoints[0]!] } }) },
    { reason: 'destination_not_allowed', snapshot: readyFeatures(), endpointId: 'b'.repeat(64) },
  ])('carries only the closed authority reason for $reason', async ({ reason, target, snapshot, endpointId, phase }) => {
    const facts = { authorityReason: reason, authorityPhase: phase ?? 'authenticated', authorityCarrier: 'iroh',
      authorityDescriptorPresent: Boolean(snapshot.status === 'ready' && snapshot.features.homeConnectionDescriptor) };
    let failure: unknown;
    try {
      verifyTerminalAuthEnrollmentRuntime({ target: target ?? STRICT_TARGET, snapshot, ...(phase ? { phase } : {}),
        runtime: { runtimeOrigin: 'http://127.0.0.1:48123', carrier: 'iroh',
          authenticatedCredentialDestination: { kind: 'iroh', endpointId: endpointId ?? 'a'.repeat(64) } } });
    } catch (error) { failure = error; }
    // The real prepared-task boundary serializes the controller's approval
    // failure before the managed operation receives it. Keep that hop real.
    const runner = createSystemTasksRunner({ kinds: { authority: { run: async () => { throw failure; } } } });
    await runner.start({ taskId: 'authority-task', kind: 'authority', params: {} });
    const result = await runner.wait({ taskId: 'authority-task' });
    expect(result).toMatchObject({ ok: false, error: {
      code: 'HOME_AUTHORITY_MISMATCH',
      message: `The acquired enrollment runtime does not match the resolved Home authority (authorityReason ${reason}; authorityPhase ${facts.authorityPhase}; authorityCarrier iroh; authorityDescriptorPresent ${facts.authorityDescriptorPresent}).`,
    } });
    expect(failure).toMatchObject({ code: 'HOME_AUTHORITY_MISMATCH', ...facts });
    expect(projectSafeAuthError(failure)).toMatchObject({ code: 'HOME_AUTHORITY_MISMATCH', ...facts });
    expect(JSON.stringify(projectSafeAuthError(failure))).not.toMatch(/srv_home_|https?:|a{64}|b{64}/);
    expect(classifyServerEndpointError(failure).retryable).toBe(false);
  });

  it('drops private or unknown authority reasons at the safe auth failure boundary', () => {
    const failure = Object.assign(new Error('https://private.invalid token=private-token srv_private'), {
      code: 'HOME_AUTHORITY_MISMATCH', authorityReason: 'https://private.invalid',
    });
    expect(projectSafeAuthError(failure)).not.toHaveProperty('authorityReason');
    expect(projectSafeAuthError(failure).message).toBe('The acquired enrollment runtime does not match the resolved Home authority.');
  });

  it.each(['request', 'status', 'claim'] as const)('scopes cross-origin %s redirects without replaying secret bodies', async (operation) => {
    let unselectedRequests = 0;
    const sink = createServer((_request, response) => {
      unselectedRequests++;
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    const selected = createServer((_request, response) => {
      const address = sink.address();
      if (!address || typeof address === 'string') throw new Error('Missing sink listener');
      response.writeHead(307, { location: `http://127.0.0.1:${address.port}/unselected` }).end();
    });
    try {
      await Promise.all([sink, selected].map(server => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))));
      const address = selected.address();
      if (!address || typeof address === 'string') throw new Error('Missing selected listener');
      const runtimeOrigin = `http://127.0.0.1:${address.port}`;
      const runtime = { runtimeOrigin, carrier: 'https' as const,
        authenticatedCredentialDestination: { kind: 'https' as const, applicationUrl: runtimeOrigin } };
      const result = operation === 'request'
        ? createTerminalAuthRequest({ runtime, publicKey: 'fixture-key', claimSecretHash: 'fixture-hash' })
        : operation === 'status'
          ? readTerminalAuthRequestStatus({ runtime, publicKey: 'fixture-key' })
          : claimTerminalAuthRequest({ runtime, publicKey: 'fixture-key', claimSecret: 'fixture-claim' });
      if (operation === 'status') await expect(result).resolves.toEqual({});
      else await expect(result).rejects.toMatchObject({ response: { status: 307 } });
      expect(unselectedRequests).toBe(operation === 'status' ? 1 : 0);
    } finally {
      await Promise.all([selected, sink].map(server => new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      })));
    }
  });

  it.each([
    [{ status: 'error', reason: 'network' }, 'HOME_FEATURES_NETWORK', 'network'],
    [{ status: 'error', reason: 'timeout' }, 'HOME_FEATURES_TIMEOUT', 'timeout'],
    [{ status: 'error', reason: 'response_status', httpStatus: 503 }, 'HOME_FEATURES_HTTP_ERROR', 'server_error'],
    [{ status: 'error', reason: 'response_status', httpStatus: 401 }, 'HOME_FEATURES_HTTP_ERROR', 'auth_failed'],
    [{ status: 'unsupported', reason: 'endpoint_missing' }, 'HOME_FEATURES_ENDPOINT_MISSING', 'protocol_error'],
  ] as const)('preserves the typed feature refusal for %j', (snapshot, code, kind) => {
    let failure: unknown;
    try {
      verifyTerminalAuthEnrollmentRuntime({
        target: STRICT_TARGET,
        runtime: {
          runtimeOrigin: DESCRIPTOR.canonicalServerUrl,
          carrier: 'https',
          irohAttempt: { outcome: 'unavailable', reason: 'transport_timeout' },
          authenticatedCredentialDestination: { kind: 'https', applicationUrl: DESCRIPTOR.canonicalServerUrl },
        },
        snapshot,
      });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code });
    if (code === 'HOME_FEATURES_NETWORK') expect(failure).toMatchObject({ carrierFailure: {
      attemptedCarrier: 'https', reason: 'transport', irohAttempt: { outcome: 'unavailable', reason: 'transport_timeout' },
    } });
    expect(classifyServerEndpointError(failure).kind).toBe(kind);
  });

  it('distinguishes an unverified destination from a mismatched Home authority', () => {
    const runtime = {
      runtimeOrigin: 'http://127.0.0.1:48123',
      carrier: 'iroh' as const,
      authenticatedCredentialDestination: null,
    };
    let failure: unknown;
    try {
      verifyTerminalAuthEnrollmentRuntime({ target: STRICT_TARGET, runtime, snapshot: readyFeatures() });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'HOME_CREDENTIAL_DESTINATION_UNVERIFIED' });
    try {
      verifyTerminalAuthEnrollmentRuntime({
        target: STRICT_TARGET,
        runtime: { ...runtime, authenticatedCredentialDestination: { kind: 'iroh', endpointId: 'b'.repeat(64) } },
        snapshot: readyFeatures(),
      });
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'HOME_AUTHORITY_MISMATCH' });
  });

  it('distinguishes an unreadable feature response from an absent Home identity', async () => {
    const snapshot = await fetchServerFeaturesSnapshot({
      serverUrl: 'https://home.example.test',
      fetchImpl: async () => new Response(JSON.stringify({
        features: 'unreadable',
      })),
    });
    expect(snapshot).toEqual({ status: 'unsupported', reason: 'invalid_payload' });
    const verify = (snapshot: CliServerFeaturesSnapshot) => verifyTerminalAuthEnrollmentRuntime({
      target: STRICT_TARGET,
      runtime: {
        runtimeOrigin: 'http://127.0.0.1:48123',
        carrier: 'iroh',
        authenticatedCredentialDestination: { kind: 'iroh', endpointId: 'a'.repeat(64) },
      },
      snapshot,
    });
    let unreadableError: unknown;
    try { verify(snapshot); } catch (error) { unreadableError = error; }
    expect(unreadableError).toMatchObject({ code: 'HOME_FEATURES_UNREADABLE' });
    expect(verify.bind(null, readyFeatures({ identity: '' }))).toThrow('Unable to verify the selected Home identity');
  });

  it('verifies a Home whose live-stream relay does not advertise optional limits', async () => {
    const snapshot = await fetchServerFeaturesSnapshot({
      serverUrl: 'https://optional-relay-caps.example.test',
      fetchImpl: async () => new Response(JSON.stringify({
        features: {},
        capabilities: {
          serverIdentity: { serverIdentityId: DESCRIPTOR.homeServerIdentityId },
          machines: { liveStream: { serverRouted: { caps: {} } } },
        },
      })),
    });
    const verified = verifyTerminalAuthEnrollmentRuntime({
      target: {
        profileId: null,
        homeServerIdentityId: null,
        descriptor: null,
        canonicalAuthUrl: 'https://optional-relay-caps.example.test',
        applicationUrl: 'https://optional-relay-caps.example.test',
        webappUrl: 'https://optional-relay-caps.example.test',
        credentialDestination: null,
        preferredTransport: 'https',
        authority: 'manual_url',
      },
      runtime: {
        runtimeOrigin: 'https://optional-relay-caps.example.test',
        carrier: 'https',
        authenticatedCredentialDestination: {
          kind: 'https', applicationUrl: 'https://optional-relay-caps.example.test',
        },
      },
      snapshot,
    });
    expect(verified.homeServerIdentityId).toBe(DESCRIPTOR.homeServerIdentityId);
  });

  it('sends request, status, and claim only through the explicit acquired runtime origin', async () => {
    const post = vi.fn(async (url: string) => ({ data: { url } }));
    const get = vi.fn(async (url: string) => ({ data: { url } }));
    const runtime = {
      runtimeOrigin: 'http://127.0.0.1:48123',
      carrier: 'iroh' as const,
      authenticatedCredentialDestination: { kind: 'iroh' as const, endpointId: 'a'.repeat(64) },
    };

    await createTerminalAuthRequest({
      runtime,
      publicKey: 'public-key',
      claimSecretHash: 'claim-hash',
      post,
    });
    await readTerminalAuthRequestStatus({ runtime, publicKey: 'public-key', get });
    await claimTerminalAuthRequest({
      runtime,
      publicKey: 'public-key',
      claimSecret: 'claim-secret',
      post,
    });

    expect(post.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:48123/v1/auth/request',
      'http://127.0.0.1:48123/v1/auth/request/claim',
    ]);
    expect(get.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:48123/v1/auth/request/status',
    ]);
  });

  it('accepts a strict descriptor only after features prove the exact identity and acquired destination', () => {
    expect(verifyTerminalAuthEnrollmentRuntime({
      target: STRICT_TARGET,
      runtime: {
        runtimeOrigin: 'http://127.0.0.1:48123',
        carrier: 'iroh',
        authenticatedCredentialDestination: { kind: 'iroh', endpointId: 'a'.repeat(64) },
      },
      snapshot: readyFeatures(),
    })).toEqual({
      homeServerIdentityId: DESCRIPTOR.homeServerIdentityId,
      credentialDestination: { kind: 'iroh', endpointId: 'a'.repeat(64) },
    });
  });

  it.each([
    ['wrong identity', readyFeatures({ identity: 'srv_home_wrong' }), { kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
    ['wrong endpoint', readyFeatures(), { kind: 'iroh' as const, endpointId: 'b'.repeat(64) }],
    ['missing descriptor', readyFeatures({ descriptor: undefined }), { kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
  ])('rejects a strict target with %s before request admission', (_label, snapshot, destination) => {
    expect(() => verifyTerminalAuthEnrollmentRuntime({
      target: STRICT_TARGET,
      runtime: {
        runtimeOrigin: 'http://127.0.0.1:48123',
        carrier: 'iroh',
        authenticatedCredentialDestination: destination,
      },
      snapshot,
    })).toThrow();
  });

  it.each(['https', 'iroh'] as const)('accepts first contact over %s without promoting an absent public descriptor', (carrier) => {
    const destination = carrier === 'https'
      ? { kind: 'https' as const, applicationUrl: DESCRIPTOR.canonicalServerUrl }
      : { kind: 'iroh' as const, endpointId: 'a'.repeat(64) };
    expect(verifyTerminalAuthEnrollmentRuntime({
      target: STRICT_TARGET,
      phase: 'first_contact',
      runtime: { runtimeOrigin: carrier === 'https' ? DESCRIPTOR.canonicalServerUrl : 'http://127.0.0.1:48123',
        carrier, authenticatedCredentialDestination: destination },
      snapshot: readyFeatures({ descriptor: undefined, provenance: 'public' }),
    })).toEqual({ homeServerIdentityId: DESCRIPTOR.homeServerIdentityId, credentialDestination: destination });
    expect(resolveAuthenticatedExactHomeConnectionDescriptorObservation({
      snapshot: readyFeatures({ descriptor: undefined, provenance: 'public' }),
      expectedHomeServerIdentityId: DESCRIPTOR.homeServerIdentityId,
    })).toEqual({ kind: 'unavailable' });
  });

  it.each([
    ['wrong Home identity', { identity: 'srv_home_wrong', descriptor: undefined }, { kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
    ['unselected EndpointId', { descriptor: undefined }, { kind: 'iroh' as const, endpointId: 'b'.repeat(64) }],
    ['unselected application origin', { descriptor: undefined }, { kind: 'https' as const, applicationUrl: 'https://other.example.test' }],
    ['conflicting public descriptor', { descriptor: { ...DESCRIPTOR, canonicalServerUrl: 'https://other.example.test' } }, { kind: 'iroh' as const, endpointId: 'a'.repeat(64) }],
  ])('refuses %s even at public first contact', (_label, observation, destination) => {
    expect(() => verifyTerminalAuthEnrollmentRuntime({ target: STRICT_TARGET, phase: 'first_contact',
      runtime: { runtimeOrigin: 'http://127.0.0.1:48123', carrier: destination.kind,
        authenticatedCredentialDestination: destination },
      snapshot: readyFeatures({ ...observation, provenance: 'public' }),
    })).toThrow(expect.objectContaining({ code: 'HOME_AUTHORITY_MISMATCH' }));
  });

  it.each(['public', 'authenticated'] as const)('still requires the exact descriptor after claim (%s projection)', (provenance) => {
    expect(() => verifyTerminalAuthEnrollmentRuntime({ target: STRICT_TARGET,
      runtime: { runtimeOrigin: 'http://127.0.0.1:48123', carrier: 'iroh',
        authenticatedCredentialDestination: { kind: 'iroh', endpointId: 'a'.repeat(64) } },
      snapshot: readyFeatures({ descriptor: undefined, provenance }),
    })).toThrow(expect.objectContaining({ code: 'HOME_AUTHORITY_MISMATCH' }));
  });

  it('refuses an undeclared loopback alias even when the selected destination names the declared origin', () => {
    expect(() => verifyTerminalAuthEnrollmentRuntime({ target: STRICT_TARGET, phase: 'first_contact',
      runtime: { runtimeOrigin: 'http://127.0.0.1:48123', carrier: 'https',
        authenticatedCredentialDestination: { kind: 'https', applicationUrl: DESCRIPTOR.canonicalServerUrl } },
      snapshot: readyFeatures({ descriptor: undefined, provenance: 'public' }),
    })).toThrow(expect.objectContaining({ code: 'HOME_AUTHORITY_MISMATCH' }));
  });

  it('refuses non-loopback HTTP at first contact even when supplied as a destination', () => {
    const applicationUrl = 'http://home.example.test';
    expect(() => verifyTerminalAuthEnrollmentRuntime({
      target: { ...STRICT_TARGET, credentialDestination: { ...STRICT_TARGET.credentialDestination,
        applicationEndpointUrls: [applicationUrl] } },
      phase: 'first_contact',
      runtime: { runtimeOrigin: applicationUrl, carrier: 'https',
        authenticatedCredentialDestination: { kind: 'https', applicationUrl } },
      snapshot: readyFeatures({ descriptor: undefined, provenance: 'public' }),
    })).toThrow(expect.objectContaining({ code: 'HOME_AUTHORITY_MISMATCH' }));
  });

  it('preserves explicit legacy URL-only HTTPS admission without granting descriptor authority', () => {
    const target = {
      profileId: null,
      homeServerIdentityId: null,
      descriptor: null,
      canonicalAuthUrl: 'https://legacy.example.test',
      applicationUrl: 'https://legacy.example.test',
      webappUrl: 'https://legacy.example.test',
      credentialDestination: null,
      preferredTransport: 'https',
      authority: 'manual_url',
    } satisfies ResolvedHomeTarget;

    expect(verifyTerminalAuthEnrollmentRuntime({
      target,
      runtime: {
        runtimeOrigin: 'https://legacy.example.test',
        carrier: 'https',
        authenticatedCredentialDestination: {
          kind: 'https',
          applicationUrl: 'https://legacy.example.test',
        },
      },
      snapshot: readyFeatures({ descriptor: undefined, provenance: 'public' }),
    })).toEqual({
      homeServerIdentityId: DESCRIPTOR.homeServerIdentityId,
      credentialDestination: {
        kind: 'https',
        applicationUrl: 'https://legacy.example.test',
      },
    });
  });

  it('distinguishes authenticated exact descriptor authority from public fallback', () => {
    expect(resolveAuthenticatedExactHomeConnectionDescriptorObservation({
      snapshot: readyFeatures({ provenance: 'authenticated' }),
      expectedHomeServerIdentityId: DESCRIPTOR.homeServerIdentityId,
    })).toEqual({ kind: 'available', descriptor: DESCRIPTOR });

    expect(resolveAuthenticatedExactHomeConnectionDescriptorObservation({
      snapshot: readyFeatures({ provenance: 'public' }),
      expectedHomeServerIdentityId: DESCRIPTOR.homeServerIdentityId,
    })).toEqual({ kind: 'unavailable' });
  });

  it('rejects URL-only admission over Iroh or a different HTTPS origin', () => {
    const target = {
      profileId: null,
      homeServerIdentityId: null,
      descriptor: null,
      canonicalAuthUrl: 'https://legacy.example.test',
      applicationUrl: 'https://legacy.example.test',
      webappUrl: 'https://legacy.example.test',
      credentialDestination: null,
      preferredTransport: 'https',
      authority: 'manual_url',
    } satisfies ResolvedHomeTarget;

    for (const runtime of [
      {
        runtimeOrigin: 'http://127.0.0.1:48123',
        carrier: 'iroh' as const,
        authenticatedCredentialDestination: { kind: 'iroh' as const, endpointId: 'a'.repeat(64) },
      },
      {
        runtimeOrigin: 'https://other.example.test',
        carrier: 'https' as const,
        authenticatedCredentialDestination: {
          kind: 'https' as const,
          applicationUrl: 'https://other.example.test',
        },
      },
    ]) {
      expect(() => verifyTerminalAuthEnrollmentRuntime({
        target,
        runtime,
        snapshot: readyFeatures({ descriptor: undefined }),
      })).toThrow();
    }
  });
});
