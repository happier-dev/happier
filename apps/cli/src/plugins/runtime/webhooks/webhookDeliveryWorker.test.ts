import { afterEach, describe, expect, it, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { sealBoxBundle } from '@happier-dev/protocol/crypto/boxBundle';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { PluginWebhookDeliveryContentV1Schema } from '@happier-dev/protocol/plugins/webhooks/deliveryV1';

import {
  AutomationEventAdmitInputV1Schema,
  AutomationEventAdmitResultV1Schema,
  createPluginActionInvocation,
  PluginWebhookAutomationAdmissionUnresolvedV1Schema,
} from '@happier-dev/protocol';

import { processClaimedPluginWebhookDeliveryV1 as processClaimedDelivery } from './webhookDeliveryWorker';
import {
  readCurrentPluginWebhookInvocationReferenceV1,
  recordCurrentPluginWebhookAutomationAdmissionResultV1,
} from './pluginWebhookInvocationReference';

const target = {
  materialization: { machineId: 'machine-1', materializationId: 'materialization-1', pluginId: 'acme.github' },
  machineInstallationId: 'installation-1',
} as const;

const content = {
  v: 1 as const,
  receivedAtMs: 1,
  contentType: 'application/json',
  headers: [{ name: 'x-github-event' as const, value: 'issues' }],
  rawBodyBytes: 2,
  rawBodyBase64: 'e30=',
  verified: {
    verifier: 'github_hmac_sha256_v1' as const,
    providerDeliveryId: 'provider-delivery-1',
    eventType: 'issues',
    credentialVersionId: 'credential-1',
  },
};

// These existing worker cases supply an already-admitted plugin handler.
// Canonical Action admission itself is exercised in webhookDeliveryAdmission.test.ts.
function processClaimedPluginWebhookDeliveryV1(params: Parameters<typeof processClaimedDelivery>[0]) {
  return processClaimedDelivery({
    ...params,
    execute: async (actionId, input, options) => {
      await options!.beforeHandlerInvocation();
      return params.execute(actionId, input, options);
    },
  });
}

describe('plugin webhook claimed delivery worker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dead-letters content that cannot be opened without marking execution started', async () => {
    const renew = vi.fn();
    const complete = vi.fn();
    const fail = vi.fn(async () => ({ kind: 'settled' as const, state: 'dead_letter' as const }));
    const execute = vi.fn();

    await expect(processClaimedPluginWebhookDeliveryV1({
      claim: {
        kind: 'delivery',
        deliveryId: 'delivery-content-unavailable',
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
        envelope: { t: 'encrypted', c: 'AA==' },
        lease: { leaseId: 'lease-content-unavailable', revision: 7, firstClaimAtMs: 1, expiresAtMs: 120_000, maxClaimUntilMs: 600_000 },
        pluginVersion: '1.0.0',
        target,
      },
      credentials: { token: 'token', encryption: null },
      transport: { renew, complete, fail },
      execute,
    })).resolves.toEqual({ kind: 'settled', state: 'dead_letter' });

    expect(fail).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: 'delivery-content-unavailable',
      lease: { leaseId: 'lease-content-unavailable', revision: 7 },
      result: { kind: 'deadLetter', code: 'content_unavailable' },
    }));
    expect(renew).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    ['plain', 'github_hmac_sha256_v1'], ['legacy', 'github_hmac_sha256_v1'], ['dataKey', 'github_hmac_sha256_v1'],
    ['plain', 'capabilityUrl_v1'], ['legacy', 'capabilityUrl_v1'], ['dataKey', 'capabilityUrl_v1'],
  ] as const)('drops retired %s %s stored content while dispatching the same-plugin Action and settling only the renewed lease', async (mode, verifier) => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const secret = new Uint8Array(32).fill(7);
    const selectedContent = verifier === 'capabilityUrl_v1' ? { ...content, headers: [],
      verified: { verifier, providerDeliveryId: content.verified.providerDeliveryId } } : content;
    const retainedContent = { ...selectedContent, retired: true,
      headers: selectedContent.headers.map(header => ({ ...header, retired: true })),
      verified: { ...selectedContent.verified, retired: true },
    };
    expect(PluginWebhookDeliveryContentV1Schema.safeParse(retainedContent).success).toBe(false);
    // The server seals to the Account content public key: the recovery-secret
    // derived content key pair (legacy) or the data-key machine key pair.
    const accountContentSecretKey = mode === 'legacy' ? deriveAccountMachineKeyFromRecoverySecret(secret) : secret;
    const accountContentPublicKey = tweetnacl.box.keyPair.fromSecretKey(accountContentSecretKey).publicKey;
    const sealedContent = Buffer.from(sealBoxBundle({
      plaintext: new TextEncoder().encode(JSON.stringify(retainedContent)),
      recipientPublicKey: accountContentPublicKey,
      randomBytes: length => new Uint8Array(length).fill(3),
    })).toString('base64');
    const renew = vi.fn(async () => ({ kind: 'renewed' as const, revision: 8, expiresAtMs: 120_000 }));
    let observedReference: ReturnType<typeof readCurrentPluginWebhookInvocationReferenceV1> = null;
    let releaseDetachedRead!: () => void;
    const detachedReadGate = new Promise<void>((resolve) => { releaseDetachedRead = resolve; });
    let detachedReference: ReturnType<typeof readCurrentPluginWebhookInvocationReferenceV1> = null;
    const execute = vi.fn(async (_actionId: string, input: unknown) => {
      if (verifier === 'capabilityUrl_v1') expect(input).toHaveProperty('endpoint.webhookEndpointId', 'wh_ep_AAECAwQFBgcICQoLDA0ODw');
      else expect(input).not.toHaveProperty('endpoint.webhookEndpointId');
      observedReference = readCurrentPluginWebhookInvocationReferenceV1();
      void detachedReadGate.then(() => {
        detachedReference = readCurrentPluginWebhookInvocationReferenceV1();
      });
      return { kind: 'settled' as const, disposition: 'accepted' as const };
    });
    const complete = vi.fn(async () => ({ kind: 'settled' as const, state: 'succeeded' as const }));
    const fail = vi.fn(async () => ({ kind: 'settled' as const, state: 'dead_letter' as const }));

    await expect(processClaimedPluginWebhookDeliveryV1({
      claim: {
        kind: 'delivery',
        deliveryId: 'delivery-1',
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
        envelope: mode === 'plain' ? { t: 'plain', v: retainedContent } : { t: 'encrypted', c: sealedContent },
        lease: { leaseId: 'lease-1', revision: 7, firstClaimAtMs: 1, expiresAtMs: 120_000, maxClaimUntilMs: 600_000 },
        pluginVersion: '1.0.0',
        target,
      },
      credentials: { token: 'token', encryption: mode === 'plain' ? null
        : mode === 'legacy' ? { type: 'legacy', secret }
          : { type: 'dataKey', publicKey: accountContentPublicKey, machineKey: secret } },
      transport: { renew, complete, fail },
      execute,
    })).resolves.toEqual({ kind: 'settled', state: 'succeeded' });

    expect(execute).toHaveBeenCalledWith('acme.github/handle-webhook', expect.objectContaining({
      delivery: expect.objectContaining({ deliveryId: 'delivery-1', attempt: 1 }),
      request: expect.objectContaining({ rawBodyBase64: 'e30=' }),
    }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: 'delivery-1',
      lease: { leaseId: 'lease-1', revision: 8 },
    }));
    expect(fail).not.toHaveBeenCalled();
    expect(observedReference).toEqual({
      v: 1,
      deliveryId: 'delivery-1',
      endpoint: {
        webhookEndpointId: 'wh_ep_AAECAwQFBgcICQoLDA0ODw',
        revision: 3,
        webhookContribution: { pluginId: 'acme.github', localId: 'github-events' },
        handlerActionLocalId: 'handle-webhook',
        sourceInstanceId: 'source-1',
      },
      target,
      lease: { leaseId: 'lease-1', revision: 8 },
    });
    expect(readCurrentPluginWebhookInvocationReferenceV1()).toBeNull();
    releaseDetachedRead();
    await detachedReadGate;
    await Promise.resolve();
    expect(detachedReference).toBeNull();
  });

  it('renews before half the active lease and settles with the latest fenced revision', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const renew = vi.fn()
      .mockResolvedValueOnce({ kind: 'renewed' as const, revision: 8, expiresAtMs: 100 })
      .mockResolvedValueOnce({ kind: 'renewed' as const, revision: 9, expiresAtMs: 200 });
    const execute = vi.fn(async (_actionId, _input, options?: Readonly<{ signal?: AbortSignal }>) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 80);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(options.signal?.reason);
        }, { once: true });
      });
      return { kind: 'settled' as const, disposition: 'accepted' as const };
    });
    const complete = vi.fn(async () => ({ kind: 'settled' as const, state: 'succeeded' as const }));

    const processing = processClaimedPluginWebhookDeliveryV1({
      claim: {
        kind: 'delivery',
        deliveryId: 'delivery-1',
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
        envelope: { t: 'plain', v: content },
        lease: { leaseId: 'lease-1', revision: 7, firstClaimAtMs: 0, expiresAtMs: 100, maxClaimUntilMs: 600_000 },
        pluginVersion: '1.0.0',
        target,
      },
      credentials: { token: 'token', encryption: null },
      transport: { renew, complete, fail: vi.fn() },
      execute,
    });

    await vi.advanceTimersByTimeAsync(55);
    expect(renew).toHaveBeenNthCalledWith(2, expect.objectContaining({
      transition: 'renew',
      lease: { leaseId: 'lease-1', revision: 8 },
    }));
    await vi.advanceTimersByTimeAsync(30);
    await expect(processing).resolves.toEqual({ kind: 'settled', state: 'succeeded' });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      lease: { leaseId: 'lease-1', revision: 9 },
    }));
  });

  it('withdraws the reference when custody is lost and never exposes it to unrelated work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const renew = vi.fn()
      .mockResolvedValueOnce({ kind: 'renewed' as const, revision: 8, expiresAtMs: 100 })
      .mockResolvedValueOnce({ kind: 'leaseLost' as const });
    let referenceBeforeLoss: ReturnType<typeof readCurrentPluginWebhookInvocationReferenceV1> = null;
    let referenceAfterLoss: ReturnType<typeof readCurrentPluginWebhookInvocationReferenceV1> = null;
    const execute = vi.fn(async (_actionId, _input, options?: Readonly<{ signal?: AbortSignal }>) => {
      referenceBeforeLoss = readCurrentPluginWebhookInvocationReferenceV1();
      await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      referenceAfterLoss = readCurrentPluginWebhookInvocationReferenceV1();
      return { kind: 'settled' as const, disposition: 'accepted' as const };
    });
    expect(readCurrentPluginWebhookInvocationReferenceV1()).toBeNull();

    const processing = processClaimedPluginWebhookDeliveryV1({
      claim: {
        kind: 'delivery',
        deliveryId: 'delivery-1',
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
        envelope: { t: 'plain', v: content },
        lease: { leaseId: 'lease-1', revision: 7, firstClaimAtMs: 0, expiresAtMs: 100, maxClaimUntilMs: 600_000 },
        pluginVersion: '1.0.0',
        target,
      },
      credentials: { token: 'token', encryption: null },
      transport: {
        renew,
        complete: vi.fn(async () => ({ kind: 'settled' as const, state: 'succeeded' as const })),
        fail: vi.fn(),
      },
      execute,
    });

    await vi.advanceTimersByTimeAsync(55);
    // Custody loss withdraws the live reference immediately, so nothing the
    // Action does afterwards can reach the host under this delivery. The
    // final settlement attempt is a separate, exact-lease server decision.
    await expect(processing).resolves.toEqual({ kind: 'settled', state: 'succeeded' });
    expect(referenceBeforeLoss).toMatchObject({ lease: { leaseId: 'lease-1', revision: 8 } });
    expect(referenceAfterLoss).toBeNull();
    expect(readCurrentPluginWebhookInvocationReferenceV1()).toBeNull();
  });

  it('contains a rejected renewal as unavailable custody, aborts the Action, and never settles a resultless attempt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const renewalError = new Error('renewal transport failed');
    const renew = vi.fn()
      .mockResolvedValueOnce({ kind: 'renewed' as const, revision: 8, expiresAtMs: 100 })
      .mockRejectedValueOnce(renewalError);
    const complete = vi.fn();
    const fail = vi.fn();
    let referenceBeforeFailure: ReturnType<typeof readCurrentPluginWebhookInvocationReferenceV1> = null;
    let referenceAfterFailure: ReturnType<typeof readCurrentPluginWebhookInvocationReferenceV1> = null;
    let actionSignal: AbortSignal | undefined;
    // The handler is cancelled and throws instead of returning. There is no
    // plugin-authored result to preserve, so the contained custody answer
    // stands and the durable server recovery owner makes the next transition.
    const execute = vi.fn(async (_actionId, _input, options?: Readonly<{ signal?: AbortSignal }>) => {
      actionSignal = options?.signal;
      referenceBeforeFailure = readCurrentPluginWebhookInvocationReferenceV1();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 80);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          referenceAfterFailure = readCurrentPluginWebhookInvocationReferenceV1();
          resolve();
        }, { once: true });
      });
      throw new Error('handler cancelled without a result');
    });
    const unhandledRejections: unknown[] = [];
    const captureUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.prependListener('unhandledRejection', captureUnhandledRejection);

    try {
      const processing = processClaimedPluginWebhookDeliveryV1({
        claim: {
          kind: 'delivery',
          deliveryId: 'delivery-renewal-error',
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
          envelope: { t: 'plain', v: content },
          lease: { leaseId: 'lease-renewal-error', revision: 7, firstClaimAtMs: 0, expiresAtMs: 100, maxClaimUntilMs: 600_000 },
          pluginVersion: '1.0.0',
          target,
        },
        credentials: { token: 'token', encryption: null },
        transport: { renew, complete, fail },
        execute,
      });

      await vi.advanceTimersByTimeAsync(80);
      await expect(processing).resolves.toEqual({ kind: 'unavailable', code: 'delivery_lease_unavailable' });
      expect(actionSignal?.aborted).toBe(true);
      expect(referenceBeforeFailure).toMatchObject({ lease: { leaseId: 'lease-renewal-error', revision: 8 } });
      expect(referenceAfterFailure).toBeNull();
      expect(readCurrentPluginWebhookInvocationReferenceV1()).toBeNull();
      expect(complete).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', captureUnhandledRejection);
    }
  });

  it('makes one exact final settlement attempt for a known result after a renewal reports the lease lost', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // Renewal refuses because the plugin generation stopped being current, not
    // because this worker stopped holding the lease. The Action already
    // produced a schema-valid result under `executionStartedAt`; dropping it
    // here leaves the row claimed until the lease expires and then re-runs the
    // same delivery. Only the server's exact delivery/target/installation/
    // lease/revision CAS can decide, so ask it once.
    const renew = vi.fn()
      .mockResolvedValueOnce({ kind: 'renewed' as const, revision: 8, expiresAtMs: 100 })
      .mockResolvedValueOnce({ kind: 'leaseLost' as const });
    const complete = vi.fn(async () => ({ kind: 'settled' as const, state: 'succeeded' as const }));
    const fail = vi.fn();
    const execute = vi.fn(async (_actionId, _input, options?: Readonly<{ signal?: AbortSignal }>) => {
      await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { kind: 'settled' as const, disposition: 'accepted' as const };
    });

    const processing = processClaimedPluginWebhookDeliveryV1({
      claim: {
        kind: 'delivery',
        deliveryId: 'delivery-known-result',
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
        envelope: { t: 'plain', v: content },
        lease: { leaseId: 'lease-known-result', revision: 7, firstClaimAtMs: 0, expiresAtMs: 100, maxClaimUntilMs: 600_000 },
        pluginVersion: '1.0.0',
        target,
      },
      credentials: { token: 'token', encryption: null },
      transport: { renew, complete, fail },
      execute,
    });

    await vi.advanceTimersByTimeAsync(55);
    await expect(processing).resolves.toEqual({ kind: 'settled', state: 'succeeded' });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: 'delivery-known-result',
      target,
      lease: { leaseId: 'lease-known-result', revision: 8 },
    }));
    expect(fail).not.toHaveBeenCalled();
    expect(readCurrentPluginWebhookInvocationReferenceV1()).toBeNull();
  });

  it('returns the server lease verdict when the one final settlement attempt is refused', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const renew = vi.fn()
      .mockResolvedValueOnce({ kind: 'renewed' as const, revision: 8, expiresAtMs: 100 })
      .mockResolvedValueOnce({ kind: 'leaseLost' as const });
    const complete = vi.fn(async () => ({ kind: 'leaseLost' as const }));
    const execute = vi.fn(async (_actionId, _input, options?: Readonly<{ signal?: AbortSignal }>) => {
      await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
      return { kind: 'settled' as const, disposition: 'accepted' as const };
    });

    const processing = processClaimedPluginWebhookDeliveryV1({
      claim: {
        kind: 'delivery',
        deliveryId: 'delivery-refused-settlement',
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
        envelope: { t: 'plain', v: content },
        lease: { leaseId: 'lease-refused', revision: 7, firstClaimAtMs: 0, expiresAtMs: 100, maxClaimUntilMs: 600_000 },
        pluginVersion: '1.0.0',
        target,
      },
      credentials: { token: 'token', encryption: null },
      transport: { renew, complete, fail: vi.fn() },
      execute,
    });

    await vi.advanceTimersByTimeAsync(55);
    await expect(processing).resolves.toEqual({ kind: 'leaseLost' });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('contains an initial execution-start renewal rejection before dispatch and never settles', async () => {
    const renew = vi.fn().mockRejectedValueOnce(new Error('initial renewal transport failed'));
    const complete = vi.fn();
    const fail = vi.fn();
    const execute = vi.fn();

    await expect(processClaimedPluginWebhookDeliveryV1({
      claim: {
        kind: 'delivery',
        deliveryId: 'delivery-initial-renewal-error',
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
        envelope: { t: 'plain', v: content },
        lease: { leaseId: 'lease-initial-renewal-error', revision: 7, firstClaimAtMs: 0, expiresAtMs: 120_000, maxClaimUntilMs: 600_000 },
        pluginVersion: '1.0.0',
        target,
      },
      credentials: { token: 'token', encryption: null },
      transport: { renew, complete, fail },
      execute,
    })).resolves.toEqual({ kind: 'unavailable', code: 'delivery_lease_unavailable' });

    expect(renew).toHaveBeenCalledWith(expect.objectContaining({ transition: 'executionStarted' }));
    expect(execute).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it('settles an abort-ignoring canonical Action at its deadline, withdraws currentness, and records a typed retry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const renew = vi.fn(async () => ({ kind: 'renewed' as const, revision: 8, expiresAtMs: 120_000 }));
    const fail = vi.fn(async () => ({ kind: 'settled' as const, state: 'queued' as const }));
    const complete = vi.fn();
    let referenceBeforeDeadline: ReturnType<typeof readCurrentPluginWebhookInvocationReferenceV1> = null;
    let referenceAfterDeadline: ReturnType<typeof readCurrentPluginWebhookInvocationReferenceV1> = null;
    const generation = new AbortController();
    const action = createPluginActionInvocation({
      pluginId: 'acme.github',
      localId: 'handle-webhook',
      declaration: { readOnly: true },
      occurrenceSignal: generation.signal,
      isCurrent: () => true,
    });
    const execute = vi.fn(async (_actionId, input, options?: Readonly<{ signal?: AbortSignal }>) => {
      const execution = await action.invoke(input, {
        ...(options?.signal ? { signal: options.signal } : {}),
        handler: ({ signal }) => {
          referenceBeforeDeadline = readCurrentPluginWebhookInvocationReferenceV1();
          signal.addEventListener('abort', () => {
            referenceAfterDeadline = readCurrentPluginWebhookInvocationReferenceV1();
          }, { once: true });
          return new Promise<never>(() => {});
        },
      });
      return execution.status === 'executed'
        ? { kind: 'settled' as const, disposition: 'accepted' as const }
        : { kind: 'retry' as const, code: 'handler_unavailable' };
    });

    const processing = processClaimedPluginWebhookDeliveryV1({
      claim: {
        kind: 'delivery',
        deliveryId: 'delivery-deadline',
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
        envelope: { t: 'plain', v: content },
        lease: { leaseId: 'lease-deadline', revision: 7, firstClaimAtMs: 0, expiresAtMs: 120_000, maxClaimUntilMs: 600_000 },
        pluginVersion: '1.0.0',
        target,
      },
      credentials: { token: 'token', encryption: null },
      transport: { renew, complete, fail },
      execute,
      handlerDeadlineMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);
    await expect(processing).resolves.toEqual({ kind: 'settled', state: 'queued' });
    expect(referenceBeforeDeadline).toMatchObject({ deliveryId: 'delivery-deadline' });
    expect(referenceAfterDeadline).toBeNull();
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: 'delivery-deadline',
      lease: { leaseId: 'lease-deadline', revision: 8 },
      result: { kind: 'retry', code: 'handler_timeout' },
    }));
    expect(complete).not.toHaveBeenCalled();
  });

  it('settles an abort-ignoring canonical Action on daemon shutdown and leaves its lease un-settled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const shutdown = new AbortController();
    const renew = vi.fn(async () => ({ kind: 'renewed' as const, revision: 8, expiresAtMs: 120_000 }));
    const complete = vi.fn();
    const fail = vi.fn();
    let markActionStarted!: () => void;
    const actionStarted = new Promise<void>((resolve) => { markActionStarted = resolve; });
    let actionSignal: AbortSignal | undefined;
    const generation = new AbortController();
    const action = createPluginActionInvocation({
      pluginId: 'acme.github',
      localId: 'handle-webhook',
      declaration: { readOnly: true },
      occurrenceSignal: generation.signal,
      isCurrent: () => true,
    });
    const execute = vi.fn(async (_actionId, input, options?: Readonly<{ signal?: AbortSignal }>) => {
      const execution = await action.invoke(input, {
        ...(options?.signal ? { signal: options.signal } : {}),
        handler: ({ signal }) => {
          actionSignal = signal;
          markActionStarted();
          return new Promise<never>(() => {});
        },
      });
      return execution.status === 'executed'
        ? { kind: 'settled' as const, disposition: 'accepted' as const }
        : { kind: 'retry' as const, code: 'handler_unavailable' };
    });

    const processing = processClaimedPluginWebhookDeliveryV1({
      claim: {
        kind: 'delivery',
        deliveryId: 'delivery-daemon-stop',
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
        envelope: { t: 'plain', v: content },
        lease: { leaseId: 'lease-daemon-stop', revision: 7, firstClaimAtMs: 0, expiresAtMs: 120_000, maxClaimUntilMs: 600_000 },
        pluginVersion: '1.0.0',
        target,
      },
      credentials: { token: 'token', encryption: null },
      transport: { renew, complete, fail },
      execute,
      signal: shutdown.signal,
    });

    await actionStarted;
    shutdown.abort();

    await expect(processing).resolves.toEqual({ kind: 'unavailable', code: 'daemon_stopped' });
    expect(actionSignal?.aborted).toBe(true);
    expect(complete).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
  });

  it('carries only a host-collected unresolved Automation admission summary on a retry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const renew = vi.fn(async () => ({ kind: 'renewed' as const, revision: 8, expiresAtMs: 120_000 }));
    const complete = vi.fn();
    const fail = vi.fn(async () => ({ kind: 'settled' as const, state: 'queued' as const }));
    const execute = vi.fn(async () => {
      recordCurrentPluginWebhookAutomationAdmissionResultV1({
        input: AutomationEventAdmitInputV1Schema.parse({
          eventRef: { pluginId: 'acme.github', localId: 'automation/repository-pushed-v1' },
          occurrenceId: 'delivery-1',
          occurredAt: 1,
          observationReceivedAt: 1,
          payload: {},
          definitions: [
            {
              automationId: 'automation-b',
              triggerId: 'trigger-b',
              triggerRevision: 1,
              sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
            },
            {
              automationId: 'automation-a',
              triggerId: 'trigger-a',
              triggerRevision: 1,
              sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
            },
            {
              automationId: 'automation-safe',
              triggerId: 'trigger-safe',
              triggerRevision: 1,
              sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
            },
            {
              automationId: 'automation-rejoined',
              triggerId: 'trigger-rejoined',
              triggerRevision: 1,
              sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
            },
            {
              automationId: 'automation-skipped',
              triggerId: 'trigger-skipped',
              triggerRevision: 1,
              sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
            },
          ],
        }),
        result: AutomationEventAdmitResultV1Schema.parse({
          results: [
            { kind: 'blocked', reason: 'capacity', checkpointSafe: false },
            { kind: 'refreshDefinition', reason: 'definitionStale', checkpointSafe: false },
            { kind: 'admitted', runId: 'run-1', checkpointSafe: true },
            { kind: 'rejoined', runId: 'run-2', checkpointSafe: true },
            { kind: 'skipped', reason: 'filtered', checkpointSafe: true },
          ],
        }),
      });
      return { kind: 'retry' as const, code: 'github.automation-unavailable' };
    });

    await expect(processClaimedPluginWebhookDeliveryV1({
      claim: {
        kind: 'delivery',
        deliveryId: 'delivery-automation-summary',
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
        envelope: { t: 'plain', v: content },
        lease: { leaseId: 'lease-automation-summary', revision: 7, firstClaimAtMs: 1, expiresAtMs: 120_000, maxClaimUntilMs: 600_000 },
        pluginVersion: '1.0.0',
        target,
      },
      credentials: { token: 'token', encryption: null },
      transport: { renew, complete, fail },
      execute,
    })).resolves.toEqual({ kind: 'settled', state: 'queued' });

    expect(fail).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: 'delivery-automation-summary',
      result: { kind: 'retry', code: 'github.automation-unavailable' },
      automationAdmissionUnresolved: {
        v: 1,
        kind: 'automationAdmissionUnresolved',
        totalCount: 2,
        entries: [
          {
            automationId: 'automation-a',
            status: { kind: 'refreshDefinition', reason: 'definitionStale' },
          },
          {
            automationId: 'automation-b',
            status: { kind: 'blocked', reason: 'capacity' },
          },
        ],
        omittedCount: 0,
      },
    }));
    expect(complete).not.toHaveBeenCalled();
  });

  it('drops a collected Automation diagnostic when the handler times out', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const renew = vi.fn(async () => ({ kind: 'renewed' as const, revision: 8, expiresAtMs: 120_000 }));
    const complete = vi.fn();
    const fail = vi.fn(async (_input: unknown) => ({ kind: 'settled' as const, state: 'queued' as const }));
    const execute = vi.fn(async (_actionId: string, _input: unknown, options?: Readonly<{ signal?: AbortSignal }>) => {
      recordCurrentPluginWebhookAutomationAdmissionResultV1({
        input: AutomationEventAdmitInputV1Schema.parse({
          eventRef: { pluginId: 'acme.github', localId: 'automation/repository-pushed-v1' },
          occurrenceId: 'delivery-timeout-summary',
          occurredAt: 1,
          observationReceivedAt: 1,
          payload: {},
          definitions: [{
            automationId: 'automation-timeout',
            triggerId: 'trigger-timeout',
            triggerRevision: 1,
            sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
          }],
        }),
        result: AutomationEventAdmitResultV1Schema.parse({
          results: [{ kind: 'blocked', reason: 'temporarilyUnavailable', checkpointSafe: false }],
        }),
      });
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { kind: 'retry' as const, code: 'github.automation-unavailable' };
    });
    const processing = processClaimedPluginWebhookDeliveryV1({
      claim: {
        kind: 'delivery',
        deliveryId: 'delivery-timeout-summary',
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
        envelope: { t: 'plain', v: content },
        lease: { leaseId: 'lease-timeout-summary', revision: 7, firstClaimAtMs: 1, expiresAtMs: 120_000, maxClaimUntilMs: 600_000 },
        pluginVersion: '1.0.0',
        target,
      },
      credentials: { token: 'token', encryption: null },
      transport: { renew, complete, fail },
      execute,
      handlerDeadlineMs: 10,
    });

    await vi.advanceTimersByTimeAsync(10);
    await expect(processing).resolves.toEqual({ kind: 'settled', state: 'queued' });
    expect(fail).toHaveBeenCalledWith(expect.objectContaining({
      result: { kind: 'retry', code: 'handler_timeout' },
    }));
    expect(fail.mock.calls[0]?.[0]).not.toHaveProperty('automationAdmissionUnresolved');
    expect(complete).not.toHaveBeenCalled();
  });

  it('retains the exact sorted Automation-ID prefix that fits the 16 KiB diagnostic bound', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const renew = vi.fn(async () => ({ kind: 'renewed' as const, revision: 8, expiresAtMs: 120_000 }));
    const complete = vi.fn();
    const fail = vi.fn(async (_input: unknown) => ({ kind: 'settled' as const, state: 'queued' as const }));
    const automationIds = Array.from(
      { length: 100 },
      (_unused, index) => `a${String(index).padStart(3, '0')}${'x'.repeat(252)}`,
    );
    const execute = vi.fn(async () => {
      recordCurrentPluginWebhookAutomationAdmissionResultV1({
        input: AutomationEventAdmitInputV1Schema.parse({
          eventRef: { pluginId: 'acme.github', localId: 'automation/repository-pushed-v1' },
          occurrenceId: 'delivery-byte-bounded-summary',
          occurredAt: 1,
          observationReceivedAt: 1,
          payload: {},
          definitions: automationIds.map((automationId, index) => ({
            automationId,
            triggerId: `trigger-${index}`,
            triggerRevision: 1,
            sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
          })),
        }),
        result: AutomationEventAdmitResultV1Schema.parse({
          results: automationIds.map(() => ({
            kind: 'blocked' as const,
            reason: 'capacity' as const,
            checkpointSafe: false as const,
          })),
        }),
      });
      return { kind: 'retry' as const, code: 'github.automation-unavailable' };
    });

    await expect(processClaimedPluginWebhookDeliveryV1({
      claim: {
        kind: 'delivery',
        deliveryId: 'delivery-byte-bounded-summary',
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
        envelope: { t: 'plain', v: content },
        lease: { leaseId: 'lease-byte-bounded-summary', revision: 7, firstClaimAtMs: 1, expiresAtMs: 120_000, maxClaimUntilMs: 600_000 },
        pluginVersion: '1.0.0',
        target,
      },
      credentials: { token: 'token', encryption: null },
      transport: { renew, complete, fail },
      execute,
    })).resolves.toEqual({ kind: 'settled', state: 'queued' });

    const failure = fail.mock.calls[0]?.[0] as Readonly<{
      automationAdmissionUnresolved?: Readonly<{
        totalCount: number;
        entries: ReadonlyArray<Readonly<{ automationId: string }>>;
        omittedCount: number;
      }>;
    }>;
    const summary = failure.automationAdmissionUnresolved;
    if (!summary) throw new Error('expected bounded unresolved Automation summary');
    expect(summary).toMatchObject({ totalCount: 100 });
    expect(summary.entries.length).toBeGreaterThan(0);
    expect(summary.entries.length).toBeLessThan(100);
    expect(summary.entries.map((entry) => entry.automationId)).toEqual(
      automationIds.slice(0, summary.entries.length),
    );
    expect(summary.omittedCount).toBe(
      100 - summary.entries.length,
    );
    expect(PluginWebhookAutomationAdmissionUnresolvedV1Schema.safeParse({
      ...summary,
      entries: [...summary.entries, {
        automationId: automationIds[summary.entries.length],
        status: { kind: 'blocked', reason: 'capacity' },
      }],
      omittedCount: summary.omittedCount - 1,
    }).success).toBe(false);
  });
});
