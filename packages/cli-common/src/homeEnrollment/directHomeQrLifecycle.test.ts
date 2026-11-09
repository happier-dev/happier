import { describe, expect, it, vi } from 'vitest';

import {
  computeHomeQrBindingProofV2,
  encodeBase64,
  type FeaturesResponse,
  type HomeConnectionDescriptorV1,
} from '@happier-dev/protocol';

import {
  admitDirectHomeQrV2,
  DirectHomeQrCompletionError,
  runDirectHomeQrCompletion,
  startDirectHomeQrLifecycle,
  type DirectHomeQrLifecycleAdapters,
  type DirectHomeQrPairingStatus,
} from './directHomeQrLifecycle.js';
import { CredentialRequestRedirectError } from '../homeTarget/credentialRequestRedirectPolicy.js';

const NOW = 1_900_000_000_000;
const DESCRIPTOR: HomeConnectionDescriptorV1 = {
  v: 1,
  homeServerIdentityId: 'srv_home',
  canonicalServerUrl: 'https://home.example',
  revision: 1,
  endpoints: [{ kind: 'https', url: 'https://home.example' }],
};

function features(boundQrV2: unknown): FeaturesResponse {
  return {
    features: {
      auth: {
        pairing: {
          boundQrV2: { enabled: boundQrV2 },
        },
      },
    },
  } as FeaturesResponse;
}

function requested(overrides: Partial<Extract<DirectHomeQrPairingStatus, { state: 'requested' }>> = {}) {
  const requesterPublicKey = new Uint8Array(32).fill(8);
  return {
    state: 'requested' as const,
    pairId: 'pair-1',
    expiresAt: new Date(NOW + 60_000).toISOString(),
    requestedPublicKey: encodeBase64(requesterPublicKey),
    requestedDeviceLabel: 'Phone',
    bindingProof: computeHomeQrBindingProofV2({
      direction: 'trusted_home_displays',
      qrSecret: new Uint8Array(32).fill(7),
      pairId: 'pair-1',
      homeServerIdentityId: DESCRIPTOR.homeServerIdentityId,
      requesterPublicKey,
      expiresAtMs: NOW + 60_000,
    }),
    homeServerIdentityId: DESCRIPTOR.homeServerIdentityId,
    ...overrides,
  };
}

function harness(input: Readonly<{
  status?: readonly DirectHomeQrPairingStatus[];
  qrAvailable?: boolean;
  nowValues?: readonly number[];
  now?: DirectHomeQrLifecycleAdapters['now'];
  start?: DirectHomeQrLifecycleAdapters['start'];
  poll?: DirectHomeQrLifecycleAdapters['poll'];
  consume?: DirectHomeQrLifecycleAdapters['consume'];
  complete?: DirectHomeQrLifecycleAdapters['complete'];
}> = {}) {
  const statuses = [...(input.status ?? [requested()])];
  const nowValues = [...(input.nowValues ?? [NOW, NOW, NOW])];
  const start = vi.fn(input.start ?? (async () => ({ ok: true as const, pairId: 'pair-1', expiresAt: new Date(NOW + 60_000).toISOString() })));
  const poll = vi.fn(input.poll ?? (async () => ({ ok: true as const, status: statuses.shift() ?? requested() })));
  const consume = vi.fn(input.consume ?? (async () => ({ ok: true as const, outcome: 'cancelled' as const })));
  const complete = vi.fn(input.complete ?? (async () => 'completed' as const));
  const close = vi.fn(async () => undefined);
  const sleep = vi.fn<DirectHomeQrLifecycleAdapters['sleep']>(async () => undefined);
  const adapters: DirectHomeQrLifecycleAdapters = {
    randomBytes: () => new Uint8Array(32).fill(7),
    now: input.now ?? (() => nowValues.shift() ?? NOW),
    start,
    poll,
    consume,
    complete,
    buildRenderableInvite: (invite) => input.qrAvailable === false
      ? { ok: false, link: 'happier:///pair?v=2&payload=opaque', reason: 'qr_unavailable' }
      : { ok: true, link: 'happier:///pair?v=2&payload=opaque', invite },
    sleep,
    close,
  };
  return { adapters, start, poll, consume, complete, close, sleep };
}

describe('direct Home QR lifecycle', () => {
  it.each(['start', 'poll', 'complete'] as const)('preserves a closed redirect refusal from %s without polling, cleanup mutation, or retry', async (phase) => {
    const refusal = new CredentialRequestRedirectError(307);
    let now = NOW;
    const fail = async (): Promise<never> => { now = NOW + 60_001; throw refusal; };
    const h = harness({ [phase]: fail, now: () => now });
    const started = startDirectHomeQrLifecycle({ features: features(true), descriptor: DESCRIPTOR, adapters: h.adapters });
    if (phase === 'start') {
      await expect(started).rejects.toBe(refusal);
      expect(h.poll).not.toHaveBeenCalled();
    } else {
      const result = await started;
      if (result.kind !== 'started') throw new Error('Expected a started lifecycle');
      await expect(result.completion).rejects.toBe(refusal);
      expect(h.poll).toHaveBeenCalledOnce();
      if (phase === 'complete') expect(h.complete).toHaveBeenCalledOnce();
    }
    expect(h.sleep).not.toHaveBeenCalled();
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('preserves cancellation redirect refusal and closes the active transport without retrying', async () => {
    const refusal = new CredentialRequestRedirectError(307);
    const h = harness({
      poll: async ({ signal }) => await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
      consume: async () => { throw refusal; },
    });
    const result = await startDirectHomeQrLifecycle({ features: features(true), descriptor: DESCRIPTOR, adapters: h.adapters });
    if (result.kind !== 'started') throw new Error('Expected a started lifecycle');
    const completionRefusal = expect(result.completion).rejects.toBe(refusal);
    await expect(result.cancel()).rejects.toBe(refusal);
    await completionRefusal;
    expect(h.poll).toHaveBeenCalledOnce();
    expect(h.consume).toHaveBeenCalledOnce();
    expect(h.sleep).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('preserves a redirect refusal during expired-start cleanup and still closes its transport', async () => {
    const refusal = new CredentialRequestRedirectError(307);
    const h = harness({
      start: async () => ({ ok: true, pairId: 'pair-1', expiresAt: new Date(NOW).toISOString() }),
      consume: async () => { throw refusal; },
    });
    await expect(startDirectHomeQrLifecycle({
      features: features(true), descriptor: DESCRIPTOR, adapters: h.adapters,
    })).rejects.toBe(refusal);
    expect(h.consume).toHaveBeenCalledOnce();
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.poll).not.toHaveBeenCalled();
  });

  it('returns cancelled without starting pairing when the caller already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness();

    await expect(startDirectHomeQrLifecycle({
      features: features(true),
      descriptor: DESCRIPTOR,
      adapters: h.adapters,
      signal: controller.signal,
    })).resolves.toEqual({ kind: 'cancelled' });

    expect(h.start).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('returns cancelled when the caller aborts a pending pairing start', async () => {
    const controller = new AbortController();
    let startEntered!: () => void;
    const startPending = new Promise<void>((resolve) => { startEntered = resolve; });
    const h = harness({
      start: async ({ signal }) => {
        expect(signal).toBe(controller.signal);
        startEntered();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
          }, { once: true });
        });
        throw new Error('unreachable');
      },
    });

    const result = startDirectHomeQrLifecycle({
      features: features(true),
      descriptor: DESCRIPTOR,
      adapters: h.adapters,
      signal: controller.signal,
    });
    await startPending;
    controller.abort();

    await expect(result).resolves.toEqual({ kind: 'cancelled' });
    expect(h.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['missing', features(undefined)],
    ['malformed', features('yes')],
    ['disabled preview', features(false)],
  ])('refuses %s bound-qr-v2 admission before QR mutation', async (_label, payload) => {
    const h = harness();

    expect(admitDirectHomeQrV2(payload)).toEqual({ kind: 'update_required' });
    const result = await startDirectHomeQrLifecycle({
      features: payload,
      descriptor: DESCRIPTOR,
      adapters: h.adapters,
    });

    expect(result).toEqual({ kind: 'update_required' });
    expect(h.start).not.toHaveBeenCalled();
    expect(h.poll).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.consume).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('runs the bound forward V2 lifecycle to completion and releases the target', async () => {
    const h = harness();
    const result = await startDirectHomeQrLifecycle({ features: features(true), descriptor: DESCRIPTOR, adapters: h.adapters });

    expect(result.kind).toBe('started');
    if (result.kind !== 'started') throw new Error('expected started lifecycle');
    expect(result.invite).toMatchObject({ v: 2, intent: 'home_device', direction: 'trusted_home_displays' });
    expect(result.qrAvailable).toBe(true);
    await expect(result.completion).resolves.toEqual({ kind: 'completed', requestedDeviceLabel: 'Phone' });
    expect(h.start).toHaveBeenCalledWith(expect.objectContaining({ direction: 'trusted_home_displays' }));
    expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ direction: 'trusted_home_displays', homeServerIdentityId: DESCRIPTOR.homeServerIdentityId }),
    }));
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('keeps an oversize valid invite live as an exact copied-link presentation', async () => {
    const h = harness({ qrAvailable: false });
    const result = await startDirectHomeQrLifecycle({ features: features(true), descriptor: DESCRIPTOR, adapters: h.adapters });

    expect(result.kind).toBe('started');
    if (result.kind !== 'started') throw new Error('expected started lifecycle');
    expect(result).toMatchObject({ qrAvailable: false, link: 'happier:///pair?v=2&payload=opaque' });
    await expect(result.completion).resolves.toMatchObject({ kind: 'completed' });
  });

  it('cancels the exact live session without completing credentials', async () => {
    let pollStarted!: () => void;
    const startedPolling = new Promise<void>((resolve) => { pollStarted = resolve; });
    const h = harness({
      status: [{ state: 'pending', pairId: 'pair-1', expiresAt: new Date(NOW + 60_000).toISOString() }],
      nowValues: [NOW, NOW, NOW, NOW + 59_999],
      poll: async ({ signal }) => {
        pollStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
        });
        throw new Error('unreachable');
      },
      consume: async ({ timeoutMs }) => {
        expect(timeoutMs).toBe(1);
        return { ok: true, outcome: 'cancelled' };
      },
    });
    const result = await startDirectHomeQrLifecycle({ features: features(true), descriptor: DESCRIPTOR, adapters: h.adapters });
    if (result.kind !== 'started') throw new Error('expected started lifecycle');

    await startedPolling;
    await result.cancel();
    await expect(result.completion).resolves.toEqual({ kind: 'cancelled' });
    expect(h.consume).toHaveBeenCalledWith(expect.objectContaining({ pairId: 'pair-1', intent: 'cancel' }));
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('adopts immutable completion when cancellation loses the server decision CAS', async () => {
    let completionStarted!: () => void;
    const startedCompleting = new Promise<void>((resolve) => { completionStarted = resolve; });
    const completionSignals: AbortSignal[] = [];
    const h = harness({
      complete: async ({ signal }) => {
        completionSignals.push(signal);
        if (completionSignals.length === 1) {
          completionStarted();
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DirectHomeQrCompletionError('retryable')), { once: true });
          });
        }
        return 'already_completed';
      },
      consume: async () => ({ ok: true, outcome: 'completion_won' }),
    });
    const result = await startDirectHomeQrLifecycle({ features: features(true), descriptor: DESCRIPTOR, adapters: h.adapters });
    if (result.kind !== 'started') throw new Error('expected started lifecycle');

    await startedCompleting;
    await expect(result.cancel()).resolves.toEqual({ ok: true, outcome: 'completion_won' });
    expect(completionSignals[0]?.aborted).toBe(true);

    await expect(result.completion).resolves.toEqual({ kind: 'completed', requestedDeviceLabel: 'Phone' });
    expect(h.complete).toHaveBeenCalledTimes(2);
    expect(completionSignals[1]?.aborted).toBe(false);
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('keeps polling after cancellation loses the CAS while an idle wait is being interrupted', async () => {
    let sleepStarted!: () => void;
    const startedSleeping = new Promise<void>((resolve) => { sleepStarted = resolve; });
    const h = harness({
      status: [
        { state: 'pending', pairId: 'pair-1', expiresAt: new Date(NOW + 60_000).toISOString() },
        requested(),
      ],
      consume: async () => ({ ok: true, outcome: 'completion_won' }),
    });
    h.sleep.mockImplementationOnce(async (_ms, signal) => {
      sleepStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })), { once: true });
      });
    });
    const result = await startDirectHomeQrLifecycle({ features: features(true), descriptor: DESCRIPTOR, adapters: h.adapters });
    if (result.kind !== 'started') throw new Error('expected started lifecycle');

    await startedSleeping;
    await expect(result.cancel()).resolves.toEqual({ ok: true, outcome: 'completion_won' });

    await expect(result.completion).resolves.toEqual({ kind: 'completed', requestedDeviceLabel: 'Phone' });
    expect(h.poll).toHaveBeenCalledTimes(2);
    expect(h.complete).toHaveBeenCalledOnce();
  });

  it('bounds each poll by the owner-derived expiry deadline', async () => {
    const h = harness({
      nowValues: [NOW, NOW, NOW, NOW + 60_000],
      poll: async ({ timeoutMs }) => {
        expect(timeoutMs).toBe(60_000);
        return { ok: false, reason: 'transient', status: 408 };
      },
    });
    const result = await startDirectHomeQrLifecycle({ features: features(true), descriptor: DESCRIPTOR, adapters: h.adapters });
    if (result.kind !== 'started') throw new Error('expected started lifecycle');

    await expect(result.completion).resolves.toEqual({ kind: 'expired' });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('expires at the bounded invite deadline without completing credentials', async () => {
    const h = harness({
      status: [{ state: 'pending', pairId: 'pair-1', expiresAt: new Date(NOW + 60_000).toISOString() }],
      nowValues: [NOW, NOW, NOW, NOW + 60_000],
    });
    const result = await startDirectHomeQrLifecycle({ features: features(true), descriptor: DESCRIPTOR, adapters: h.adapters });
    if (result.kind !== 'started') throw new Error('expected started lifecycle');

    await expect(result.completion).resolves.toEqual({ kind: 'expired' });
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('rejects an invalid bound request and never enters terminal-pairing semantics', async () => {
    const h = harness({ status: [requested({ bindingProof: 'invalid-proof' })] });
    const result = await startDirectHomeQrLifecycle({ features: features(true), descriptor: DESCRIPTOR, adapters: h.adapters });
    if (result.kind !== 'started') throw new Error('expected started lifecycle');

    await expect(result.completion).resolves.toEqual({ kind: 'invalid_request' });
    expect(h.consume).toHaveBeenCalledWith(expect.objectContaining({ pairId: 'pair-1', intent: 'reject' }));
    expect(h.start).not.toHaveBeenCalledWith(expect.objectContaining({ direction: 'requester_displays' }));
    expect(h.complete).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed status', { ...requested(), extra: true }],
    ['noncanonical requester key', requested({ requestedPublicKey: encodeBase64(new Uint8Array(32).fill(8)).replace(/={1,2}$/u, '') })],
    ['wrong pair', requested({ pairId: 'pair-other' })],
    ['wrong Home', requested({ homeServerIdentityId: 'srv_other' })],
    ['wrong expiry', requested({ expiresAt: new Date(NOW + 59_999).toISOString() })],
  ])('rejects %s before the platform completion callback', async (_label, status) => {
    const h = harness({ status: [status as DirectHomeQrPairingStatus] });
    const result = await startDirectHomeQrLifecycle({ features: features(true), descriptor: DESCRIPTOR, adapters: h.adapters });
    if (result.kind !== 'started') throw new Error('expected started lifecycle');

    await expect(result.completion).resolves.toEqual({ kind: 'invalid_request' });
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.consume).toHaveBeenCalledWith(expect.objectContaining({ intent: 'reject' }));
  });
});

describe('runDirectHomeQrCompletion (approver completion for a requester-displayed QR)', () => {
  const requesterPublicKey = new Uint8Array(32).fill(8);
  function approverRun(h: ReturnType<typeof harness>) {
    return runDirectHomeQrCompletion({
      direction: 'requester_displays',
      pairId: 'pair-1',
      homeServerIdentityId: DESCRIPTOR.homeServerIdentityId,
      qrSecret: new Uint8Array(32).fill(7),
      issuedAtMs: NOW,
      expiresAtMs: NOW + 60_000,
      expectedRequesterPublicKey: requesterPublicKey,
      adapters: h.adapters,
      signal: new AbortController().signal,
    });
  }
  function requesterDisplayed() {
    return requested({
      bindingProof: computeHomeQrBindingProofV2({
        direction: 'requester_displays',
        qrSecret: new Uint8Array(32).fill(7),
        pairId: 'pair-1',
        homeServerIdentityId: DESCRIPTOR.homeServerIdentityId,
        requesterPublicKey,
        expiresAtMs: NOW + 60_000,
      }),
    });
  }

  it('completes the exact requested device with the requester-displayed direction', async () => {
    const h = harness({ status: [requesterDisplayed()] });

    await expect(approverRun(h).completion).resolves.toEqual({ kind: 'completed', requestedDeviceLabel: 'Phone' });
    expect(h.complete).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ direction: 'requester_displays', pairId: 'pair-1' }),
      requesterPublicKey,
    }));
  });

  it('rejects the pairing row when the requester proof does not verify', async () => {
    // A trusted_home_displays proof is not valid for the requester-displayed direction.
    const h = harness({ status: [requested()] });

    await expect(approverRun(h).completion).resolves.toEqual({ kind: 'invalid_request' });
    expect(h.complete).not.toHaveBeenCalled();
    expect(h.consume).toHaveBeenCalledWith(expect.objectContaining({ pairId: 'pair-1', intent: 'reject' }));
  });

  it('rejects the pairing row when the Home refuses the completion as invalid', async () => {
    const h = harness({
      status: [requesterDisplayed()],
      complete: async () => { throw new DirectHomeQrCompletionError('invalid'); },
    });

    await expect(approverRun(h).completion).resolves.toEqual({ kind: 'invalid_request' });
    expect(h.consume).toHaveBeenCalledWith(expect.objectContaining({ intent: 'reject' }));
  });

  it('reports a pairing row the Home no longer has as expired', async () => {
    const h = harness({ poll: async () => ({ ok: false, reason: 'not_found', status: 404 }) });

    await expect(approverRun(h).completion).resolves.toEqual({ kind: 'expired' });
    expect(h.complete).not.toHaveBeenCalled();
  });
});
