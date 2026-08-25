import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  createPublisherHeader: vi.fn(),
  readAvailabilityInventory: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { post: mocks.post },
}));
vi.mock('@/plugins/installations/publisherProof', () => ({
  createDefaultPluginInstallationPublisherHeader: mocks.createPublisherHeader,
}));
vi.mock('@/plugins/store/registry/currentState', () => ({
  createPluginRegistryStateStore: () => ({
    readAvailabilityInventory: mocks.readAvailabilityInventory,
  }),
}));

import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol';
import {
  createPluginWebhookDaemonHttpTransportV1,
  startPluginWebhookDaemonWorkerV1,
} from './pluginWebhookDaemonWorker';

const credentials = {
  token: 'token_test',
  encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
};
const target = {
  materialization: {
    machineId: 'machine-1',
    materializationId: 'materialization-1',
    pluginId: 'acme.github',
  },
  machineInstallationId: 'installation-1',
} as const;

describe('plugin webhook daemon HTTP transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createPublisherHeader.mockResolvedValue('signed-machine-proof');
    mocks.post.mockResolvedValue({ data: { kind: 'none', retryAfterMs: 5_000 } });
    mocks.readAvailabilityInventory.mockResolvedValue({
      revision: 1,
      releasePublications: [],
      materializations: [{
        materializationId: 'materialization-1',
        pluginId: 'acme.github',
        version: '1.0.0',
        sourceClass: 'registryPackage',
        portableRelease: true,
        uiArtifacts: [],
        enabled: true,
        trustState: 'trusted',
        observedAt: 1,
      }],
    });
  });

  it('binds every daemon request to the canonical signed machine-installation proof', async () => {
    const transport = createPluginWebhookDaemonHttpTransportV1(credentials);

    await expect(transport.claim(target)).resolves.toEqual({ kind: 'none', retryAfterMs: 5_000 });

    const body = { v: 1, policyVersion: 1, target };
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
    } finally {
      rejectClaim(signal?.reason ?? new Error('test_cleanup'));
      await stopped?.catch(() => undefined);
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
      expect(mocks.readAvailabilityInventory).not.toHaveBeenCalled();
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
    mocks.readAvailabilityInventory.mockRejectedValueOnce(new Error(
      'client_secret=webhook-worker-secret at /Users/alice/private/plugin-webhooks.json',
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
});
