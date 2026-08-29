import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  createPublisherHeader: vi.fn(),
  processClaimedDelivery: vi.fn(),
  acquireRuntimeLease: vi.fn(),
  executeContributedAction: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { post: mocks.post },
}));
vi.mock('@/plugins/installations/publisherProof', () => ({
  createDefaultPluginInstallationPublisherHeader: mocks.createPublisherHeader,
}));
vi.mock('./webhookDeliveryWorker', async (importOriginal) => ({
  ...await importOriginal<typeof import('./webhookDeliveryWorker')>(),
  processClaimedPluginWebhookDeliveryV1: mocks.processClaimedDelivery,
}));
vi.mock('@/plugins/runtime/reload/runtimeLease', () => ({
  acquireAuthoritativePluginRuntimeRegistryLease: mocks.acquireRuntimeLease,
}));
vi.mock('@/plugins/runtime/invocation/actions/executeContributedAction', () => ({
  executeContributedAction: mocks.executeContributedAction,
}));

import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol';
import {
  createPluginWebhookDaemonHttpTransportV1,
  executeWebhookHandlerV1,
  startPluginWebhookDaemonWorkerV1,
} from './pluginWebhookDaemonWorker';

const credentials = {
  token: 'token_test',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
};
const machine = {
  machineId: 'machine-1',
  machineInstallationId: 'installation-1',
} as const;
const target = {
  materialization: {
    machineId: 'machine-1',
    materializationId: 'materialization-server-selected',
    pluginId: 'acme.github',
  },
  machineInstallationId: 'installation-1',
} as const;
const actionInput = {
  v: 1 as const,
  endpoint: {
    webhookContribution: { pluginId: 'acme.github', localId: 'github-events' },
    sourceInstanceId: 'source-1',
  },
  delivery: {
    deliveryId: 'delivery-materialization-server-selected',
    attempt: 1,
    replay: 0,
    receivedAtMs: 1,
    providerDeliveryId: 'provider-materialization-server-selected',
  },
  request: {
    contentType: 'application/json',
    headers: [],
    rawBodyBytes: 2,
    rawBodyBase64: 'e30=',
  },
  verified: { verifier: 'github_hmac_sha256_v1' as const },
};

function claimDeliveryFor(materializationId: string) {
  return {
    kind: 'delivery' as const,
    deliveryId: `delivery-${materializationId}`,
    target: {
      ...target,
      materialization: { ...target.materialization, materializationId },
    },
    pluginVersion: '1.0.0',
    endpoint: {
      webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
      revision: 3,
      webhookContribution: { pluginId: 'acme.github', localId: 'github-events' },
      handlerActionLocalId: 'handle-webhook',
      sourceInstanceId: 'source-1',
    },
    attempt: 1,
    replay: 0,
    receivedAtMs: 1,
    envelope: {
      t: 'plain' as const,
      v: {
        v: 1 as const,
        receivedAtMs: 1,
        contentType: 'application/json',
        headers: [],
        rawBodyBytes: 2,
        rawBodyBase64: 'e30=',
        verified: {
          verifier: 'github_hmac_sha256_v1' as const,
          providerDeliveryId: `provider-${materializationId}`,
          credentialVersionId: 'credential-1',
        },
      },
    },
    lease: {
      leaseId: `lease-${materializationId}`,
      revision: 1,
      firstClaimAtMs: 1,
      expiresAtMs: 120_000,
      maxClaimUntilMs: 600_000,
    },
  };
}

describe('plugin webhook daemon HTTP transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createPublisherHeader.mockResolvedValue('signed-machine-proof');
    mocks.post.mockResolvedValue({ data: { kind: 'none', retryAfterMs: 5_000 } });
    mocks.processClaimedDelivery.mockReset();
    mocks.processClaimedDelivery.mockResolvedValue({ kind: 'settled', state: 'succeeded' });
    mocks.acquireRuntimeLease.mockReset();
    mocks.executeContributedAction.mockReset();
  });

  it('fails before handler invocation when the server-selected target is not the leased runtime target', async () => {
    const release = vi.fn(async () => undefined);
    mocks.acquireRuntimeLease.mockResolvedValue({
      registry: {},
      resolveCurrentPluginMaterializationRef: () => ({
        ...target.materialization,
        materializationId: 'materialization-reloaded',
      }),
      release,
    });

    await expect(executeWebhookHandlerV1(
      'acme.github/handle-webhook',
      actionInput,
      { target },
    )).resolves.toEqual({ kind: 'retry', code: 'handler_unavailable' });
    expect(mocks.executeContributedAction).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('dispatches only while the leased runtime still matches the exact server-selected target', async () => {
    const release = vi.fn(async () => undefined);
    mocks.acquireRuntimeLease.mockResolvedValue({
      registry: {},
      resolveCurrentPluginMaterializationRef: () => target.materialization,
      release,
    });
    mocks.executeContributedAction.mockResolvedValue({
      matched: true,
      result: { ok: true, result: { kind: 'settled', disposition: 'accepted' } },
    });

    await expect(executeWebhookHandlerV1(
      'acme.github/handle-webhook',
      actionInput,
      { target },
    )).resolves.toEqual({ kind: 'settled', disposition: 'accepted' });
    expect(mocks.executeContributedAction).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it('binds every daemon request to the canonical signed machine-installation proof', async () => {
    const transport = createPluginWebhookDaemonHttpTransportV1(credentials);

    await expect(transport.claim(machine)).resolves.toEqual({ kind: 'none', retryAfterMs: 5_000 });

    const body = { v: 1, policyVersion: 1, machine };
    expect(mocks.createPublisherHeader).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/daemon/plugins/webhooks/claim',
      body,
    });
    expect(mocks.post).toHaveBeenCalledWith(
      expect.stringContaining('/v1/daemon/plugins/webhooks/claim'),
      body,
      expect.objectContaining({
        headers: expect.objectContaining({
          [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]: 'signed-machine-proof',
        }),
      }),
    );
  });

  it('transports only the host-collected unresolved Automation summary on a retry fail', async () => {
    const transport = createPluginWebhookDaemonHttpTransportV1(credentials);
    const automationAdmissionUnresolved = {
      v: 1 as const,
      kind: 'automationAdmissionUnresolved' as const,
      totalCount: 1,
      entries: [{
        automationId: 'automation-1',
        status: { kind: 'blocked' as const, reason: 'capacity' as const },
      }],
      omittedCount: 0,
    };
    mocks.post.mockResolvedValueOnce({ data: { kind: 'settled', state: 'queued' } });

    await expect(transport.fail({
      deliveryId: 'delivery-1',
      target,
      lease: { leaseId: 'lease-1', revision: 2 },
      result: { kind: 'retry', code: 'github.automation-unavailable' },
      automationAdmissionUnresolved,
    })).resolves.toEqual({ kind: 'settled', state: 'queued' });

    const body = {
      v: 1,
      target,
      lease: { leaseId: 'lease-1', revision: 2 },
      result: { kind: 'retry', code: 'github.automation-unavailable' },
      automationAdmissionUnresolved,
    };
    expect(mocks.createPublisherHeader).toHaveBeenCalledWith({
      method: 'POST',
      path: '/v1/daemon/plugins/webhooks/delivery-1/fail',
      body,
    });
  });

  it('aborts and waits for an in-flight claim when the daemon worker stops', async () => {
    let signal: AbortSignal | undefined;
    let rejectClaim: (reason?: unknown) => void = () => undefined;
    let markClaimStarted!: () => void;
    const claimStarted = new Promise<void>((resolve) => {
      markClaimStarted = resolve;
    });
    mocks.post.mockImplementation((_url: string, _body: unknown, options: unknown) => new Promise((_resolve, reject) => {
      signal = (options as Readonly<{ signal?: AbortSignal }>).signal;
      rejectClaim = reject;
      markClaimStarted();
    }));
    const worker = startPluginWebhookDaemonWorkerV1({
      credentials,
      machineId: () => 'machine-1',
      machineInstallationId: 'installation-1',
      enabled: () => true,
      logger: { debug: vi.fn() },
      intervalMs: 60_000,
    });
    let stopped: Promise<void> | null = null;

    try {
      await claimStarted;
      stopped = Promise.resolve(worker.stop());

      await expect(Promise.race([
        stopped.then(() => ({ kind: 'stopped' as const })),
        new Promise<Readonly<{ kind: 'stillPending' }>>((resolve) => {
          setTimeout(() => resolve({ kind: 'stillPending' }), 25);
        }),
      ])).resolves.toEqual({ kind: 'stillPending' });
      expect(signal?.aborted).toBe(true);

      rejectClaim(signal?.reason);
      await expect(stopped).resolves.toBeUndefined();

      // Shutdown aborts and awaits; it never reissues a claim afterwards.
      const claimCallsAtStop = mocks.post.mock.calls.length;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
      expect(mocks.post).toHaveBeenCalledTimes(claimCallsAtStop);
    } finally {
      rejectClaim(signal?.reason ?? new Error('test_cleanup'));
      await stopped?.catch(() => undefined);
    }
  });

  it('a wake trigger aborts the parked claim HTTP request and coalesces exactly one reissued claim', async () => {
    let parkedSignal: AbortSignal | undefined;
    let rejectParkedClaim: (reason?: unknown) => void = () => undefined;
    let markParkedClaimStarted!: () => void;
    const parkedClaimStarted = new Promise<void>((resolve) => {
      markParkedClaimStarted = resolve;
    });
    mocks.post.mockImplementationOnce((_url: string, _body: unknown, options: unknown) => new Promise((_resolve, reject) => {
      parkedSignal = (options as Readonly<{ signal?: AbortSignal }>).signal;
      rejectParkedClaim = reject;
      markParkedClaimStarted();
    }));
    mocks.post.mockResolvedValue({ data: { kind: 'none', retryAfterMs: 5_000 } });
    const worker = startPluginWebhookDaemonWorkerV1({
      credentials,
      machineId: () => 'machine-1',
      machineInstallationId: 'installation-1',
      enabled: () => true,
      logger: { debug: vi.fn() },
      intervalMs: 60_000,
    });

    try {
      await parkedClaimStarted;

      worker.trigger();
      expect(parkedSignal?.aborted).toBe(true);
      expect(parkedSignal?.reason).toEqual({ kind: 'pluginWebhookClaimWakeAbortV1' });

      rejectParkedClaim(parkedSignal?.reason);

      await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
      expect(String(mocks.post.mock.calls[1]?.[0])).toContain('/v1/daemon/plugins/webhooks/claim');
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
      expect(mocks.post).toHaveBeenCalledTimes(2);
    } finally {
      await worker.stop();
    }
  });

  it('a wake trigger while a claimed delivery is processing never overlaps and reruns once after it settles', async () => {
    mocks.post.mockResolvedValueOnce({ data: claimDeliveryFor('materialization-server-selected') });
    mocks.post.mockResolvedValue({ data: { kind: 'none', retryAfterMs: 5_000 } });
    let releaseProcessing!: () => void;
    const processing = new Promise<void>((resolve) => {
      releaseProcessing = resolve;
    });
    mocks.processClaimedDelivery.mockImplementationOnce(() => processing);
    const worker = startPluginWebhookDaemonWorkerV1({
      credentials,
      machineId: () => 'machine-1',
      machineInstallationId: 'installation-1',
      enabled: () => true,
      logger: { debug: vi.fn() },
      intervalMs: 60_000,
    });

    try {
      await vi.waitFor(() => expect(mocks.processClaimedDelivery).toHaveBeenCalledTimes(1));
      expect(mocks.post).toHaveBeenCalledTimes(1);

      // Nothing is parked while a delivery is processing, so the wake only
      // queues one rerun: no second claim runs concurrently.
      worker.trigger();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
      expect(mocks.post).toHaveBeenCalledTimes(1);
      expect(mocks.processClaimedDelivery).toHaveBeenCalledTimes(1);

      releaseProcessing();
      await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
      expect(String(mocks.post.mock.calls[1]?.[0])).toContain('/v1/daemon/plugins/webhooks/claim');
    } finally {
      await worker.stop();
    }
  });

  it('suppresses exactly the intentional wake cancellation without failure logging or backoff', async () => {
    const debug = vi.fn();
    let parkedSignal: AbortSignal | undefined;
    let rejectParkedClaim: (reason?: unknown) => void = () => undefined;
    let markParkedClaimStarted!: () => void;
    const parkedClaimStarted = new Promise<void>((resolve) => {
      markParkedClaimStarted = resolve;
    });
    mocks.post.mockImplementationOnce((_url: string, _body: unknown, options: unknown) => new Promise((_resolve, reject) => {
      parkedSignal = (options as Readonly<{ signal?: AbortSignal }>).signal;
      rejectParkedClaim = reject;
      markParkedClaimStarted();
    }));
    mocks.post.mockResolvedValue({ data: { kind: 'none', retryAfterMs: 5_000 } });
    const worker = startPluginWebhookDaemonWorkerV1({
      credentials,
      machineId: () => 'machine-1',
      machineInstallationId: 'installation-1',
      enabled: () => true,
      logger: { debug },
      intervalMs: 60_000,
    });

    try {
      await parkedClaimStarted;
      worker.trigger();
      rejectParkedClaim(parkedSignal?.reason);

      await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
      expect(mocks.post).toHaveBeenCalledTimes(2);
      expect(debug).not.toHaveBeenCalled();
    } finally {
      await worker.stop();
    }
  });

  it('never claims against a server that does not advertise webhook capability, then resumes when it does', async () => {
    // A daemon newer than its server sees no `plugins.webhooks` bit. The worker
    // must stay entirely off the wire rather than probing the missing route.
    let serverAdvertisesWebhooks = false;
    const worker = startPluginWebhookDaemonWorkerV1({
      credentials,
      machineId: () => 'machine-1',
      machineInstallationId: 'installation-1',
      enabled: () => serverAdvertisesWebhooks,
      logger: { debug: vi.fn() },
      intervalMs: 5,
    });

    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 40);
      });
      expect(mocks.post).not.toHaveBeenCalled();

      // Positive twin: the same live loop claims as soon as the server
      // advertises the capability, so the silence above was the gate.
      serverAdvertisesWebhooks = true;
      await vi.waitFor(() => expect(mocks.post).toHaveBeenCalled());
      expect(mocks.post.mock.calls[0]?.[0]).toContain('/v1/daemon/plugins/webhooks/claim');
    } finally {
      await worker.stop();
    }
  });

  it('projects iteration failures before they reach the generic daemon logger', async () => {
    const debug = vi.fn();
    mocks.post.mockRejectedValueOnce(new Error(
      'claim rejected client_secret=webhook-worker-secret at /Users/alice/private/plugin-webhooks.json',
    ));
    const worker = startPluginWebhookDaemonWorkerV1({
      credentials,
      machineId: () => 'machine-1',
      machineInstallationId: 'installation-1',
      enabled: () => true,
      logger: { debug },
      intervalMs: 60_000,
    });

    try {
      await vi.waitFor(() => expect(debug).toHaveBeenCalled());
      const details = debug.mock.calls[0]?.[1] as Readonly<{ error?: unknown }> | undefined;
      expect(details?.error).toBeTypeOf('string');
      expect(details?.error).toContain('[REDACTED]');
      expect(details?.error).toContain('[REDACTED_PATH]');
      expect(details?.error).not.toContain('webhook-worker-secret');
      expect(details?.error).not.toContain('/Users/alice/private');
    } finally {
      await worker.stop();
    }
  });

  it('issues exactly one machine claim per wake and dispatches the server-selected target', async () => {
    // Server selection replaces the per-materialization claim loop: one wake
    // carries one Account/machine claim regardless of how many materializations
    // the machine hosts, and the daemon dispatches exactly the returned target
    // authority it never chose itself.
    mocks.post.mockResolvedValueOnce({ data: claimDeliveryFor('materialization-server-selected') });
    const worker = startPluginWebhookDaemonWorkerV1({
      credentials,
      machineId: () => 'machine-1',
      machineInstallationId: 'installation-1',
      enabled: () => true,
      logger: { debug: vi.fn() },
      intervalMs: 60_000,
    });

    try {
      await vi.waitFor(() => expect(mocks.processClaimedDelivery).toHaveBeenCalledTimes(1));

      const claimCalls = mocks.post.mock.calls.filter((call) => (
        String(call[0]).includes('/v1/daemon/plugins/webhooks/claim')
      ));
      expect(claimCalls).toHaveLength(1);
      expect(claimCalls[0]?.[1]).toEqual({ v: 1, policyVersion: 1, machine });

      expect(mocks.processClaimedDelivery).toHaveBeenCalledWith(expect.objectContaining({
        claim: expect.objectContaining({
          kind: 'delivery',
          deliveryId: 'delivery-materialization-server-selected',
          target: {
            ...target,
            materialization: expect.objectContaining({
              materializationId: 'materialization-server-selected',
            }),
          },
          pluginVersion: '1.0.0',
        }),
      }));
    } finally {
      await worker.stop();
    }
  });

  it('suppresses automatic retries after no work but lets a manual wake claim immediately', async () => {
    mocks.post.mockResolvedValue({ data: { kind: 'none', retryAfterMs: 5_000 } });
    const worker = startPluginWebhookDaemonWorkerV1({
      credentials,
      machineId: () => 'machine-1',
      machineInstallationId: 'installation-1',
      enabled: () => true,
      logger: { debug: vi.fn() },
      intervalMs: 5,
    });

    try {
      await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 30);
      });
      expect(mocks.post).toHaveBeenCalledTimes(1);

      worker.trigger();
      await vi.waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
      expect(mocks.processClaimedDelivery).not.toHaveBeenCalled();
    } finally {
      await worker.stop();
    }
  });
});
