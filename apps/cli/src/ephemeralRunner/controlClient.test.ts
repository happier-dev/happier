import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { sealBoxBundle } from '@happier-dev/protocol/crypto/boxBundle';
import { computeRunnerLaunchManifestCommitmentV1 } from '@happier-dev/protocol/ephemeralRunner/launchManifest';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

import {
  createEphemeralRunnerHttpControlConnection,
  EphemeralRunnerControlHttpError,
} from './controlClient';

const agentTargetKey = 'agent:happier.agent.codex/codex';
const displayFacts = { v: 1, homeId: 'home-a', homeName: 'Acme Home', requesterId: 'account-a', requesterName: 'Alice', teamId: 'team-a', teamName: 'Platform' } as const;
const endpointFactsProof = {
  activationSignature: encodeBase64(new Uint8Array(64).fill(8), 'base64url'),
  installationSignature: encodeBase64(new Uint8Array(64).fill(9), 'base64url'),
};
const authoringCommitment = encodeBase64(new Uint8Array(32).fill(3), 'base64url');
const credentialSelectionBinding = {
  v: 1,
  resourceId: 'resource-acme',
  brokerMachineId: 'broker-machine',
  revision: 7,
  application: {
    agentTargetKey,
    implementationIdentity: { pluginId: 'happier.provider.openrouter', localId: 'openrouter' },
    endpointTemplateId: 'chat-completions',
    protocol: 'openai-chat-completions',
  },
  sourceRevision: 'source-revision-1',
} as const;
const endpointFacts = endpointFactsProof as never;
const endpointFactsContent = { v: 1 as const, directory: '/work', machine: {
  host: 'runner.example.test', platform: 'linux' as const, happyCliVersion: '0.3.0',
  happyHomeDir: '/runner/home', homeDir: '/runner/home',
} };

describe('ephemeral Runner HTTP control client', () => {
  it('publishes connectivity only when the transport state changes across repeated control responses', async () => {
    let online = true;
    const connection = createEphemeralRunnerHttpControlConnection({
      activationId: '00000000-0000-4000-8000-000000000013',
      request: async () => {
        if (!online) throw new TypeError('offline');
        return { status: 'stored', progressPhase: 'checking_ai_access' };
      },
      createProjectionProof: () => ({ projection: true }),
      createProgressProof: (phase) => ({ signedPhase: phase }),
    });
    const states = vi.fn();
    const unsubscribe = connection.onConnectionState(states);
    const signal = new AbortController().signal;
    try {
      for (let response = 0; response < 100; response += 1) {
        await connection.reportProgress({ phase: 'checking_ai_access', signal });
      }
      expect(states.mock.calls).toEqual([['connected']]);

      online = false;
      for (let failure = 0; failure < 20; failure += 1) {
        await expect(connection.decline({ claim: {} as never, signal }))
          .rejects.toMatchObject({ cause: expect.any(TypeError) });
      }
      expect(states.mock.calls).toEqual([['connected'], ['reconnecting']]);

      online = true;
      await connection.reportProgress({ phase: 'checking_ai_access', signal });
      expect(states.mock.calls).toEqual([['connected'], ['reconnecting'], ['connected']]);
    } finally {
      unsubscribe();
      await connection.close();
    }
  });

  it('returns the materialized winner of endpoint decline instead of claiming cancellation', async () => {
    const connection = createEphemeralRunnerHttpControlConnection({
      activationId: '00000000-0000-4000-8000-000000000013',
      request: async () => ({ status: 'unavailable', reason: 'already_materialized' }),
      createProjectionProof: () => ({ projection: true }),
    });
    await expect(connection.decline({ claim: {} as never, signal: new AbortController().signal }))
      .resolves.toEqual({ status: 'unavailable', reason: 'already_materialized' });
  });

  it('rejects a malformed decline response rather than treating it as cancellation', async () => {
    const connection = createEphemeralRunnerHttpControlConnection({
      activationId: '00000000-0000-4000-8000-000000000013',
      request: async () => ({ status: 'ok' }),
      createProjectionProof: () => ({ projection: true }),
    });
    await expect(connection.decline({ claim: {} as never, signal: new AbortController().signal })).rejects.toThrow();
  });

  it('does not wait for reconnection when the endpoint decline transport is unavailable', async () => {
    const request = vi.fn(async () => { throw new Error('offline'); });
    const connection = createEphemeralRunnerHttpControlConnection({
      activationId: '00000000-0000-4000-8000-000000000013', request,
      pollIntervalMs: 0,
      createProjectionProof: () => ({ projection: true }),
    });
    const abort = new AbortController();
    const declining = connection.decline({ claim: {} as never, signal: abort.signal });
    // The current retry loop would repeat until this lifecycle cancellation;
    // the corrected single attempt surfaces the original transport failure.
    request.mockImplementationOnce(async () => { throw new Error('offline'); })
      .mockImplementationOnce(async () => { abort.abort(new Error('close_cancelled')); throw abort.signal.reason; });
    await expect(declining).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'offline' }) });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('sends the signed creator phase through the proof-only endpoint route', async () => {
    const request = vi.fn(async () => ({ status: 'stored', progressPhase: 'checking_ai_access' }));
    const connection = createEphemeralRunnerHttpControlConnection({
      activationId: '00000000-0000-4000-8000-000000000013',
      request,
      createProjectionProof: () => ({ projection: true }),
      createProgressProof: (phase) => ({ signedPhase: phase }),
    });

    await connection.reportProgress({
      phase: 'checking_ai_access',
      signal: new AbortController().signal,
    });

    expect(request).toHaveBeenCalledWith(
      '/v1/ephemeral-runners/activations/00000000-0000-4000-8000-000000000013/endpoint/progress',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ signedPhase: 'checking_ai_access' }) }),
      expect.any(AbortSignal),
    );
  });

  it.each([
    // The creator committed materialization while this presentation-only
    // publication was in flight. The Session exists; abandoning the run here
    // would strand it with no endpoint runtime.
    { status: 404, phase: 'checking_ai_access' as const },
    // The recorded phase is already at or beyond this one, which is the
    // outcome the endpoint wanted from the publication in the first place.
    { status: 409, phase: 'checking_ai_access' as const },
  ])('continues after the Home rejects a $status progress publication', async ({ status, phase }) => {
    const request = vi.fn(async () => { throw new EphemeralRunnerControlHttpError(status); });
    const connection = createEphemeralRunnerHttpControlConnection({
      activationId: '00000000-0000-4000-8000-000000000013',
      request,
      createProjectionProof: () => ({ projection: true }),
      createProgressProof: (value) => ({ signedPhase: value }),
    });

    await expect(connection.reportProgress({
      phase,
      signal: new AbortController().signal,
    })).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('still fails a rejected progress proof rather than continuing unauthenticated', async () => {
    const request = vi.fn(async () => { throw new EphemeralRunnerControlHttpError(400); });
    const connection = createEphemeralRunnerHttpControlConnection({
      activationId: '00000000-0000-4000-8000-000000000013',
      request,
      createProjectionProof: () => ({ projection: true }),
      createProgressProof: (phase) => ({ signedPhase: phase }),
    });

    await expect(connection.reportProgress({
      phase: 'checking_ai_access',
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ status: 400 });
  });

  it('leaves materialization cancellation reconciliation to the controller instead of starting an unabortable request', async () => {
    const stop = new AbortController();
    const materialized = {
      status: 'materialized',
      activation: { state: 'materialized' },
      runtimeToken: 'runner-token',
      sealedBootstrap: 'sealed-bootstrap',
    } as const;
    let projectionReads = 0;
    const requests: Array<{ path: string; method: string | undefined }> = [];
    const request = vi.fn(async (path: string, init: RequestInit, signal: AbortSignal) => {
      requests.push({ path, method: init.method });
      if (path.endsWith('/endpoint/projection')) {
        projectionReads += 1;
        if (projectionReads === 1) {
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        }
        return materialized;
      }
      if (init.method === 'DELETE') {
        return { status: 'unavailable', reason: 'already_materialized' };
      }
      throw new Error('unexpected_request');
    });
    const connection = createEphemeralRunnerHttpControlConnection({
      activationId: '00000000-0000-4000-8000-000000000013',
      request,
      pollIntervalMs: 0,
      createProjectionProof: () => ({ proof: true }),
      parseProjection: (value) => value as never,
    });

    const waiting = connection.waitForMaterialization({
      launchManifestCommitment: 'manifest-commitment',
      signal: stop.signal,
    });
    stop.abort(new Error('runner_stopped'));

    await expect(waiting).rejects.toThrow('runner_stopped');
    expect(requests).toEqual([
      {
        path: '/v1/ephemeral-runners/activations/00000000-0000-4000-8000-000000000013/endpoint/projection',
        method: 'POST',
      },
    ]);
  });

  it('fails a materialized-winner recovery read immediately when the Home transport is unavailable', async () => {
    const request = vi.fn(async () => { throw new Error('offline'); });
    const connection = createEphemeralRunnerHttpControlConnection({
      activationId: '00000000-0000-4000-8000-000000000013',
      request,
      pollIntervalMs: 0,
      createProjectionProof: () => ({ proof: true }),
    });

    await expect(connection.waitForMaterialization({
      launchManifestCommitment: 'manifest-commitment',
      signal: new AbortController().signal,
      retryTransportErrors: false,
    })).rejects.toMatchObject({ cause: expect.objectContaining({ message: 'offline' }) });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('uses only proof-bound endpoint routes and opens the exact immutable review', async () => {
    const box = tweetnacl.box.keyPair();
    const manifest = { v: 1, purpose: 'happier.ephemeral-session-runner.launch-manifest', endpointFacts: endpointFactsContent, machineContentKeyBinding: null, displayFacts, credentialSelectionBinding };
    const sealedLaunchManifest = encodeBase64(sealBoxBundle({
      plaintext: new TextEncoder().encode(JSON.stringify(manifest)),
      recipientPublicKey: box.publicKey,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    }), 'base64url');
    const launchManifestCommitment = encodeBase64(new Uint8Array(32).fill(9), 'base64url');
    const requests: Array<{ path: string; init: RequestInit }> = [];
    let projectionReads = 0;
    const request = vi.fn(async (path: string, init: RequestInit) => {
      requests.push({ path, init });
      if (path.endsWith('/endpoint/projection')) {
        projectionReads += 1;
        return projectionReads === 1
          ? { status: 'pending', activation: { review: null } }
          : { status: 'pending', activation: { review: { sealedLaunchManifest, authoringCommitment, launchManifestCommitment, endpointFactsProof, agentTargetKey, machineContentKeyBinding: null, displayFacts, credentialSelectionBinding } } };
      }
      return init.method === 'DELETE' ? { status: 'declined' } : { status: 'ok' };
    });
    const connection = createEphemeralRunnerHttpControlConnection({
      activationId: '00000000-0000-4000-8000-000000000013',
      request,
      pollIntervalMs: 0,
      createProjectionProof: () => ({ proof: true }),
      parseProjection: (value) => value as never,
      parseManifest: (value) => value as typeof manifest,
      computeManifestCommitment: () => launchManifestCommitment,
      deriveManifestAgentTargetKey: () => agentTargetKey,
    });

    await connection.storeEndpointFacts({ endpointFacts, endpointFactsContent, signal: new AbortController().signal });
    const review = await connection.waitForReview({
      binding: { authoringCommitment } as never,
      claim: {} as never,
      runnerBoxSecretKey: box.secretKey,
      directory: '/work',
      signal: new AbortController().signal,
    });

    expect(review).toEqual({
      manifest,
      launchManifestCommitment,
      authoringCommitment: encodeBase64(new Uint8Array(32).fill(3), 'base64url'),
      directory: '/work',
    });
    expect(requests.map(({ path }) => path)).toEqual([
      '/v1/ephemeral-runners/activations/00000000-0000-4000-8000-000000000013/endpoint/facts',
      '/v1/ephemeral-runners/activations/00000000-0000-4000-8000-000000000013/endpoint/projection',
      '/v1/ephemeral-runners/activations/00000000-0000-4000-8000-000000000013/endpoint/projection',
    ]);
    expect(requests.every(({ init }) => !new Headers(init.headers).has('authorization'))).toBe(true);

    await connection.decline({ claim: {} as never, signal: new AbortController().signal });
    expect(requests.at(-1)).toMatchObject({
      path: '/v1/ephemeral-runners/activations/00000000-0000-4000-8000-000000000013/endpoint',
      init: { method: 'DELETE' },
    });

  });

  it('rejects a tampered sealed manifest before it reaches consent', async () => {
    const box = tweetnacl.box.keyPair();
    const connection = createEphemeralRunnerHttpControlConnection({
      activationId: '00000000-0000-4000-8000-000000000013',
      request: async () => ({
        status: 'pending',
        activation: {
          review: {
            sealedLaunchManifest: encodeBase64(new Uint8Array(80).fill(1), 'base64url'),
            authoringCommitment,
            launchManifestCommitment: encodeBase64(new Uint8Array(32).fill(2), 'base64url'),
            endpointFactsProof,
            agentTargetKey,
            machineContentKeyBinding: null,
          },
        },
      }),
      pollIntervalMs: 0,
      createProjectionProof: () => ({ proof: true }),
      parseProjection: (value) => value as never,
      parseManifest: (value) => value,
      computeManifestCommitment: computeRunnerLaunchManifestCommitmentV1,
      deriveManifestAgentTargetKey: () => agentTargetKey,
    });
    await connection.storeEndpointFacts({ endpointFacts, endpointFactsContent, signal: new AbortController().signal });
    await expect(connection.waitForReview({
      binding: { authoringCommitment } as never,
      claim: {} as never,
      runnerBoxSecretKey: box.secretKey,
      directory: '/work',
      signal: new AbortController().signal,
    })).rejects.toThrow('runner_review_invalid');
  });

  it('rejects a Machine content-key sidecar substituted after the manifest was sealed', async () => {
    const box = tweetnacl.box.keyPair();
    const manifest = { v: 1, purpose: 'happier.ephemeral-session-runner.launch-manifest', endpointFacts: endpointFactsContent, machineContentKeyBinding: null, displayFacts, credentialSelectionBinding };
    const sealedLaunchManifest = encodeBase64(sealBoxBundle({
      plaintext: new TextEncoder().encode(JSON.stringify(manifest)),
      recipientPublicKey: box.publicKey,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    }), 'base64url');
    const launchManifestCommitment = encodeBase64(new Uint8Array(32).fill(9), 'base64url');
    const connection = createEphemeralRunnerHttpControlConnection({
      activationId: '00000000-0000-4000-8000-000000000013',
      request: async () => ({
        status: 'pending',
        activation: { review: { sealedLaunchManifest, authoringCommitment, launchManifestCommitment, endpointFactsProof, agentTargetKey, displayFacts, credentialSelectionBinding, machineContentKeyBinding: {
          v: 1,
          purpose: 'happier.ephemeral-runner.machine-content-key',
          homeServerIdentityId: 'home-1',
          activationId: '00000000-0000-4000-8000-000000000013',
          creatorAccountId: 'account-1',
          machineId: 'machine-1',
          installationId: 'installation-1',
          machineContentKeyFingerprint: `runner-machine-content-key-sha256:${'a'.repeat(64)}`,
          accountSignatureBase64Url: encodeBase64(new Uint8Array(64).fill(4), 'base64url'),
        } } },
      }),
      pollIntervalMs: 0,
      createProjectionProof: () => ({ proof: true }),
      parseProjection: (value) => value as never,
      parseManifest: (value) => value as typeof manifest,
      computeManifestCommitment: () => launchManifestCommitment,
      deriveManifestAgentTargetKey: () => agentTargetKey,
    });

    await connection.storeEndpointFacts({ endpointFacts, endpointFactsContent, signal: new AbortController().signal });

    await expect(connection.waitForReview({
      binding: { authoringCommitment } as never,
      claim: {} as never,
      runnerBoxSecretKey: box.secretKey,
      directory: '/work',
      signal: new AbortController().signal,
    })).rejects.toThrow('runner_review_binding_mismatch');
  });

  it('rejects a reviewed Agent target substituted after the manifest was sealed', async () => {
    const box = tweetnacl.box.keyPair();
    const manifest = { v: 1, purpose: 'happier.ephemeral-session-runner.launch-manifest', endpointFacts: endpointFactsContent, machineContentKeyBinding: null, displayFacts, credentialSelectionBinding };
    const sealedLaunchManifest = encodeBase64(sealBoxBundle({
      plaintext: new TextEncoder().encode(JSON.stringify(manifest)),
      recipientPublicKey: box.publicKey,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    }), 'base64url');
    const launchManifestCommitment = encodeBase64(new Uint8Array(32).fill(9), 'base64url');
    const connection = createEphemeralRunnerHttpControlConnection({
      activationId: '00000000-0000-4000-8000-000000000013',
      request: async () => ({
        status: 'pending',
        activation: { review: {
          sealedLaunchManifest,
          authoringCommitment,
          launchManifestCommitment,
          endpointFactsProof,
          agentTargetKey: 'agent:happier.agent.opencode/opencode',
          machineContentKeyBinding: null,
          displayFacts,
          credentialSelectionBinding,
        } },
      }),
      pollIntervalMs: 0,
      createProjectionProof: () => ({ proof: true }),
      parseProjection: (value) => value as never,
      parseManifest: (value) => value as typeof manifest,
      computeManifestCommitment: () => launchManifestCommitment,
      deriveManifestAgentTargetKey: () => agentTargetKey,
    });

    await connection.storeEndpointFacts({ endpointFacts, endpointFactsContent, signal: new AbortController().signal });

    await expect(connection.waitForReview({
      binding: { authoringCommitment } as never,
      claim: {} as never,
      runnerBoxSecretKey: box.secretKey,
      directory: '/work',
      signal: new AbortController().signal,
    })).rejects.toThrow('runner_review_invalid');
  });

  it('rejects display facts substituted after the committed manifest was sealed', async () => {
    const box = tweetnacl.box.keyPair();
    const manifest = { v: 1, purpose: 'happier.ephemeral-session-runner.launch-manifest', endpointFacts: endpointFactsContent, machineContentKeyBinding: null, displayFacts, credentialSelectionBinding };
    const sealedLaunchManifest = encodeBase64(sealBoxBundle({
      plaintext: new TextEncoder().encode(JSON.stringify(manifest)),
      recipientPublicKey: box.publicKey,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    }), 'base64url');
    const launchManifestCommitment = encodeBase64(new Uint8Array(32).fill(9), 'base64url');
    const connection = createEphemeralRunnerHttpControlConnection({
      activationId: '00000000-0000-4000-8000-000000000013',
      request: async () => ({
        status: 'pending',
        activation: { review: {
          sealedLaunchManifest,
          authoringCommitment,
          launchManifestCommitment,
          endpointFactsProof,
          agentTargetKey,
          machineContentKeyBinding: null,
          displayFacts: { ...displayFacts, homeName: 'Substituted Home' },
          credentialSelectionBinding,
        } },
      }),
      pollIntervalMs: 0,
      createProjectionProof: () => ({ proof: true }),
      parseProjection: (value) => value as never,
      parseManifest: (value) => value as typeof manifest,
      computeManifestCommitment: () => launchManifestCommitment,
      deriveManifestAgentTargetKey: () => agentTargetKey,
    });
    await connection.storeEndpointFacts({ endpointFacts, endpointFactsContent, signal: new AbortController().signal });
    await expect(connection.waitForReview({
      binding: { authoringCommitment } as never,
      claim: {} as never,
      runnerBoxSecretKey: box.secretKey,
      directory: '/work',
      signal: new AbortController().signal,
    })).rejects.toThrow('runner_review_binding_mismatch');
  });

  it('rejects a credential selection sidecar substituted after the manifest was sealed', async () => {
    const box = tweetnacl.box.keyPair();
    const manifest = {
      v: 1,
      purpose: 'happier.ephemeral-session-runner.launch-manifest',
      endpointFacts: endpointFactsContent,
      machineContentKeyBinding: null,
      displayFacts,
      credentialSelectionBinding,
    };
    const sealedLaunchManifest = encodeBase64(sealBoxBundle({
      plaintext: new TextEncoder().encode(JSON.stringify(manifest)),
      recipientPublicKey: box.publicKey,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    }), 'base64url');
    const launchManifestCommitment = encodeBase64(new Uint8Array(32).fill(9), 'base64url');
    const connection = createEphemeralRunnerHttpControlConnection({
      activationId: '00000000-0000-4000-8000-000000000013',
      request: async (path) => path.endsWith('/endpoint/projection')
        ? { status: 'pending', activation: { review: {
            sealedLaunchManifest, authoringCommitment, launchManifestCommitment, endpointFactsProof,
            agentTargetKey, displayFacts, machineContentKeyBinding: null,
            // The Home-readable sidecar drives its own broker readiness
            // projection and admission, so a substituted resource must fail
            // before the endpoint user is asked to allow the launch.
            credentialSelectionBinding: { ...credentialSelectionBinding, resourceId: 'resource-substituted' },
          } } }
        : { status: 'stored' },
      pollIntervalMs: 0,
      createProjectionProof: () => ({ proof: true }),
      parseProjection: (value) => value as never,
      parseManifest: (value) => value as typeof manifest,
      computeManifestCommitment: () => launchManifestCommitment,
      deriveManifestAgentTargetKey: () => agentTargetKey,
    });
    await connection.storeEndpointFacts({ endpointFacts, endpointFactsContent, signal: new AbortController().signal });

    await expect(connection.waitForReview({
      binding: { authoringCommitment } as never,
      claim: {} as never,
      runnerBoxSecretKey: box.secretKey,
      directory: '/work',
      signal: new AbortController().signal,
    })).rejects.toThrow('runner_review_binding_mismatch');
  });

  it('rejects a review prepared from endpoint facts replaced before publication', async () => {
    const box = tweetnacl.box.keyPair();
    const manifest = { v: 1, purpose: 'happier.ephemeral-session-runner.launch-manifest', endpointFacts: endpointFactsContent, machineContentKeyBinding: null, displayFacts, credentialSelectionBinding };
    const sealedLaunchManifest = encodeBase64(sealBoxBundle({
      plaintext: new TextEncoder().encode(JSON.stringify(manifest)),
      recipientPublicKey: box.publicKey,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    }), 'base64url');
    const launchManifestCommitment = encodeBase64(new Uint8Array(32).fill(9), 'base64url');
    const staleEndpointFactsProof = {
      activationSignature: encodeBase64(new Uint8Array(64).fill(10), 'base64url'),
      installationSignature: encodeBase64(new Uint8Array(64).fill(11), 'base64url'),
    };
    const connection = createEphemeralRunnerHttpControlConnection({
      activationId: '00000000-0000-4000-8000-000000000013',
      request: async (path) => path.endsWith('/endpoint/projection')
        ? { status: 'pending', activation: { review: {
            sealedLaunchManifest, authoringCommitment, launchManifestCommitment, endpointFactsProof: staleEndpointFactsProof,
            agentTargetKey, displayFacts, machineContentKeyBinding: null, credentialSelectionBinding,
          } } }
        : { status: 'stored' },
      pollIntervalMs: 0,
      createProjectionProof: () => ({ proof: true }),
      parseProjection: (value) => value as never,
      parseManifest: (value) => value as typeof manifest,
      computeManifestCommitment: () => launchManifestCommitment,
      deriveManifestAgentTargetKey: () => agentTargetKey,
    });
    await connection.storeEndpointFacts({ endpointFacts, endpointFactsContent, signal: new AbortController().signal });

    await expect(connection.waitForReview({
      binding: { authoringCommitment } as never,
      claim: {} as never,
      runnerBoxSecretKey: box.secretKey,
      directory: '/work',
      signal: new AbortController().signal,
    })).rejects.toThrow('runner_review_binding_mismatch');
  });

  it('rejects endpoint facts substituted inside the opened manifest', async () => {
    const box = tweetnacl.box.keyPair();
    const manifest = {
      v: 1,
      purpose: 'happier.ephemeral-session-runner.launch-manifest',
      endpointFacts: { ...endpointFactsContent, directory: '/work/substituted' },
      machineContentKeyBinding: null,
      displayFacts,
    };
    const sealedLaunchManifest = encodeBase64(sealBoxBundle({
      plaintext: new TextEncoder().encode(JSON.stringify(manifest)),
      recipientPublicKey: box.publicKey,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    }), 'base64url');
    const launchManifestCommitment = encodeBase64(new Uint8Array(32).fill(9), 'base64url');
    const connection = createEphemeralRunnerHttpControlConnection({
      activationId: '00000000-0000-4000-8000-000000000013',
      request: async (path) => path.endsWith('/endpoint/projection')
        ? { status: 'pending', activation: { review: {
            sealedLaunchManifest, authoringCommitment, launchManifestCommitment, endpointFactsProof,
            agentTargetKey, displayFacts, machineContentKeyBinding: null, credentialSelectionBinding,
          } } }
        : { status: 'stored' },
      pollIntervalMs: 0,
      createProjectionProof: () => ({ proof: true }),
      parseProjection: (value) => value as never,
      parseManifest: (value) => value as typeof manifest,
      computeManifestCommitment: () => launchManifestCommitment,
      deriveManifestAgentTargetKey: () => agentTargetKey,
    });
    await connection.storeEndpointFacts({ endpointFacts, endpointFactsContent, signal: new AbortController().signal });

    await expect(connection.waitForReview({
      binding: { authoringCommitment } as never,
      claim: {} as never,
      runnerBoxSecretKey: box.secretKey,
      directory: '/work',
      signal: new AbortController().signal,
    })).rejects.toThrow('runner_review_binding_mismatch');
  });

  it('retries an idempotent endpoint mutation after a lost response with the exact same body', async () => {
    const attempts: string[] = [];
    const connection = createEphemeralRunnerHttpControlConnection({
      activationId: '00000000-0000-4000-8000-000000000013',
      request: async (_path, init) => {
        attempts.push(String(init.body));
        if (attempts.length === 1) throw new Error('response_lost_after_commit');
        return { claim: { installed: true } };
      },
      pollIntervalMs: 0,
      createProjectionProof: () => ({ proof: true }),
    });

    await expect(connection.claim({ claim: { exact: 'claim' } as never, signal: new AbortController().signal }))
      .resolves.toEqual({ installed: true });
    expect(attempts).toEqual(['{"exact":"claim"}', '{"exact":"claim"}']);
  });

  it('does not retry a semantic HTTP rejection', async () => {
    const request = vi.fn(async () => { throw new EphemeralRunnerControlHttpError(409); });
    const connection = createEphemeralRunnerHttpControlConnection({
      activationId: '00000000-0000-4000-8000-000000000013',
      request,
      pollIntervalMs: 0,
      createProjectionProof: () => ({ proof: true }),
    });

    await expect(connection.claim({ claim: {} as never, signal: new AbortController().signal }))
      .rejects.toMatchObject({ status: 409 });
    expect(request).toHaveBeenCalledTimes(1);
  });

});
