import { deriveHomeQrRendezvousVerifierV2, parseHomeQrPairingStatusV2, verifyHomeQrRequesterProofV2 } from '@happier-dev/protocol/crypto/qrProvisioningV2';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import type { FeaturesResponse, HomeConnectionDescriptorV1, HomeQrInviteV2, HomeQrPairingStatusV2 } from '@happier-dev/protocol';

import { ENROLLMENT_POLL_IDLE_DELAY_MS, enrollmentPollingBackoffMs } from './enrollmentPollingBackoff.js';

const DIRECT_HOME_QR_CLEANUP_TIMEOUT_MS = 5_000;

export type DirectHomeQrPairingStatus = HomeQrPairingStatusV2;

export type DirectHomeQrCancellationResult =
  | Readonly<{ ok: true; outcome: 'cancelled' | 'completion_won' }>
  | Readonly<{ ok: false }>;

export class DirectHomeQrCompletionError extends Error {
  constructor(readonly classification: 'invalid' | 'retryable' | 'failed') {
    super(`Direct Home QR completion ${classification}`);
    this.name = 'DirectHomeQrCompletionError';
  }
}

export type DirectHomeQrLifecycleAdapters = Readonly<{
  randomBytes(length: number): Uint8Array | Promise<Uint8Array>;
  now(): number;
  start(input: Readonly<{
    direction: 'trusted_home_displays';
    secretHash: string;
    signal: AbortSignal;
  }>): Promise<
    | Readonly<{ ok: true; pairId: string; expiresAt: string }>
    | Readonly<{ ok: false; status: number }>
  >;
  poll(input: Readonly<{ pairId: string; signal: AbortSignal; timeoutMs: number }>): Promise<
    | Readonly<{ ok: true; status: unknown }>
    | Readonly<{ ok: false; reason: 'not_found' | 'invalid' | 'transient'; status: number }>
  >;
  consume(input: Readonly<{ pairId: string; intent: 'cancel' | 'reject'; signal: AbortSignal; timeoutMs: number }>): Promise<DirectHomeQrCancellationResult>;
  complete(input: Readonly<{
    context: Readonly<{
      direction: HomeQrInviteV2['direction'];
      pairId: string;
      /** The Home identity the requester proof was verified against. */
      homeServerIdentityId: string;
      qrSecret: Uint8Array;
      issuedAtMs: number;
      expiresAtMs: number;
    }>;
    requesterPublicKey: Uint8Array;
    requestedDeviceLabel: string | null;
    signal: AbortSignal;
  }>): Promise<'completed' | 'already_completed'>;
  buildRenderableInvite(invite: HomeQrInviteV2):
    | Readonly<{ ok: true; link: string; invite: HomeQrInviteV2 }>
    | Readonly<{ ok: false; reason: 'qr_unavailable'; link: string }>
    | Readonly<{ ok: false; reason: 'invalid_invite' }>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}>;

/** The adapters the approver completion loop needs once a pairing row exists. */
export type DirectHomeQrCompletionAdapters = Pick<
  DirectHomeQrLifecycleAdapters,
  'now' | 'poll' | 'consume' | 'complete' | 'sleep' | 'close'
>;

export type DirectHomeQrCompletionRun = Readonly<{
  completion: Promise<DirectHomeQrCompletionOutcome>;
  cancel(): Promise<DirectHomeQrCancellationResult>;
}>;

export type DirectHomeQrCompletionOutcome =
  | Readonly<{ kind: 'completed'; requestedDeviceLabel: string | null }>
  | Readonly<{ kind: 'cancelled' | 'expired' | 'invalid_request' }>
  | Readonly<{ kind: 'failed'; status: number }>;

export type DirectHomeQrStartResult =
  | Readonly<{ kind: 'update_required' }>
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'failed'; status: number; reason: 'invalid_invite' | 'start_failed' }>
  | Readonly<{
      kind: 'started';
      invite: HomeQrInviteV2;
      link: string;
      qrAvailable: boolean;
      completion: Promise<DirectHomeQrCompletionOutcome>;
      cancel(): Promise<DirectHomeQrCancellationResult>;
    }>;

export function admitDirectHomeQrV2(features: FeaturesResponse): Readonly<{ kind: 'admitted' | 'update_required' }> {
  return readServerEnabledBit(features, 'auth.pairing.boundQrV2') === true
    ? { kind: 'admitted' }
    : { kind: 'update_required' };
}

export async function startDirectHomeQrLifecycle(input: Readonly<{
  features: FeaturesResponse;
  descriptor: HomeConnectionDescriptorV1;
  adapters: DirectHomeQrLifecycleAdapters;
  signal?: AbortSignal;
}>): Promise<DirectHomeQrStartResult> {
  if (input.signal?.aborted) {
    await input.adapters.close().catch(() => undefined);
    return { kind: 'cancelled' };
  }
  if (admitDirectHomeQrV2(input.features).kind !== 'admitted') {
    await input.adapters.close().catch(() => undefined);
    return { kind: 'update_required' };
  }

  let qrSecret: Uint8Array;
  try {
    qrSecret = await input.adapters.randomBytes(32);
  } catch {
    await input.adapters.close().catch(() => undefined);
    return input.signal?.aborted
      ? { kind: 'cancelled' }
      : { kind: 'failed', status: 500, reason: 'start_failed' };
  }
  if (input.signal?.aborted) {
    await input.adapters.close().catch(() => undefined);
    return { kind: 'cancelled' };
  }
  if (qrSecret.byteLength !== 32) {
    await input.adapters.close().catch(() => undefined);
    return { kind: 'failed', status: 500, reason: 'start_failed' };
  }
  const secretHash = encodeBase64(deriveHomeQrRendezvousVerifierV2(qrSecret), 'base64url');
  let started: Awaited<ReturnType<DirectHomeQrLifecycleAdapters['start']>>;
  try {
    started = await input.adapters.start({
      direction: 'trusted_home_displays',
      secretHash,
      signal: input.signal ?? new AbortController().signal,
    });
  } catch {
    await input.adapters.close().catch(() => undefined);
    return input.signal?.aborted
      ? { kind: 'cancelled' }
      : { kind: 'failed', status: 0, reason: 'start_failed' };
  }
  if (input.signal?.aborted) {
    if (started.ok) {
      await input.adapters.consume({
        pairId: started.pairId,
        intent: 'cancel',
        signal: AbortSignal.timeout(DIRECT_HOME_QR_CLEANUP_TIMEOUT_MS),
        timeoutMs: DIRECT_HOME_QR_CLEANUP_TIMEOUT_MS,
      }).catch(() => ({ ok: false }));
    }
    await input.adapters.close().catch(() => undefined);
    return { kind: 'cancelled' };
  }
  if (!started.ok) {
    await input.adapters.close().catch(() => undefined);
    return { kind: 'failed', status: started.status, reason: 'start_failed' };
  }
  const issuedAtMs = input.adapters.now();
  const expiresAtMs = Date.parse(started.expiresAt);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= issuedAtMs) {
    const timeoutMs = Math.min(DIRECT_HOME_QR_CLEANUP_TIMEOUT_MS, Math.max(1, expiresAtMs - input.adapters.now()));
    await input.adapters.consume({ pairId: started.pairId, intent: 'cancel', signal: AbortSignal.timeout(timeoutMs), timeoutMs }).catch(() => ({ ok: false }));
    await input.adapters.close().catch(() => undefined);
    return { kind: 'failed', status: 502, reason: 'start_failed' };
  }

  const invite: HomeQrInviteV2 = {
    v: 2,
    intent: 'home_device',
    direction: 'trusted_home_displays',
    pairId: started.pairId,
    home: input.descriptor,
    qrSecretBase64Url: encodeBase64(qrSecret, 'base64url'),
    issuedAtMs,
    expiresAtMs,
  };
  const rendered = input.adapters.buildRenderableInvite(invite);
  if (!rendered.ok && rendered.reason === 'invalid_invite') {
    const timeoutMs = Math.min(DIRECT_HOME_QR_CLEANUP_TIMEOUT_MS, Math.max(1, expiresAtMs - input.adapters.now()));
    await input.adapters.consume({ pairId: started.pairId, intent: 'cancel', signal: AbortSignal.timeout(timeoutMs), timeoutMs }).catch(() => ({ ok: false }));
    await input.adapters.close().catch(() => undefined);
    return { kind: 'failed', status: 422, reason: 'invalid_invite' };
  }

  const run = runDirectHomeQrCompletion({
    direction: 'trusted_home_displays',
    pairId: started.pairId,
    homeServerIdentityId: input.descriptor.homeServerIdentityId,
    qrSecret,
    issuedAtMs,
    expiresAtMs,
    adapters: input.adapters,
    ...(input.signal ? { signal: input.signal } : {}),
  });

  return {
    kind: 'started',
    invite,
    link: rendered.link,
    qrAvailable: rendered.ok,
    completion: run.completion,
    cancel: run.cancel,
  };
}

/**
 * The one approver completion loop for a direct Home QR pairing row: poll the
 * row, verify the requester's proof for the row's direction, complete it on the
 * Home, and settle on exactly one outcome. It owns cancellation (a `cancel`
 * consume, or adopting a completion that already won) and closes the adapters.
 *
 * `expectedRequesterPublicKey` pins the requester when the approver scanned the
 * requester's own QR (`requester_displays`); a mismatched proof is rejected.
 */
export function runDirectHomeQrCompletion(input: Readonly<{
  direction: HomeQrInviteV2['direction'];
  pairId: string;
  homeServerIdentityId: string;
  qrSecret: Uint8Array;
  issuedAtMs: number;
  expiresAtMs: number;
  expectedRequesterPublicKey?: Uint8Array;
  adapters: DirectHomeQrCompletionAdapters;
  signal?: AbortSignal;
}>): DirectHomeQrCompletionRun {
  const { adapters, pairId, qrSecret, issuedAtMs, expiresAtMs } = input;
  const cleanupTimeoutMs = () => Math.min(DIRECT_HOME_QR_CLEANUP_TIMEOUT_MS, Math.max(1, expiresAtMs - adapters.now()));
  const reject = async (): Promise<void> => {
    const timeoutMs = cleanupTimeoutMs();
    await adapters.consume({ pairId, intent: 'reject', signal: AbortSignal.timeout(timeoutMs), timeoutMs }).catch(() => ({ ok: false }));
  };

  let controller = new AbortController();
  let cancelled = false;
  let cancellationRequested = false;
  let cancelStarted: Promise<DirectHomeQrCancellationResult> | null = null;
  // Keep reads behind a function boundary because cancellation is initiated by
  // callbacks that TypeScript's flow analysis cannot observe synchronously.
  const readPendingCancellation = (): Promise<DirectHomeQrCancellationResult> | null => cancelStarted;
  const cancel = (): Promise<DirectHomeQrCancellationResult> => {
    cancellationRequested = true;
    cancelStarted ??= (async () => {
      const interruptedController = controller;
      interruptedController.abort();
      const timeoutMs = cleanupTimeoutMs();
      const outcome = await adapters.consume({
        pairId,
        intent: 'cancel',
        signal: AbortSignal.timeout(timeoutMs),
        timeoutMs,
      }).catch(() => ({ ok: false as const }));
      if (outcome.ok && outcome.outcome === 'cancelled') {
        cancelled = true;
      } else if (outcome.ok && outcome.outcome === 'completion_won' && controller === interruptedController) {
        controller = new AbortController();
      }
      return outcome;
    })();
    return cancelStarted;
  };
  const onExternalAbort = () => { void cancel(); };
  input.signal?.addEventListener('abort', onExternalAbort, { once: true });
  const completion = (async (): Promise<DirectHomeQrCompletionOutcome> => {
    let transientFailures = 0;
    try {
      if (input.signal?.aborted) await cancel();
      while (!cancelled) {
        if (adapters.now() >= expiresAtMs) return { kind: 'expired' };
        let result: Awaited<ReturnType<DirectHomeQrCompletionAdapters['poll']>>;
        try {
          result = await adapters.poll({
            pairId,
            signal: controller.signal,
            timeoutMs: Math.max(1, expiresAtMs - adapters.now()),
          });
        } catch {
          result = { ok: false, reason: 'transient', status: 0 };
        }
        const pendingCancellation = cancellationRequested ? readPendingCancellation() : null;
        if (pendingCancellation) {
          const cancellation = await pendingCancellation;
          if (cancellation.ok && cancellation.outcome === 'cancelled') return { kind: 'cancelled' };
          if (!cancellation.ok) return { kind: 'failed', status: 0 };
        }
        if (cancelled) return { kind: 'cancelled' };
        if (!result.ok) {
          if (result.reason === 'not_found') return { kind: 'expired' };
          if (result.reason !== 'transient') {
            await reject();
            return { kind: 'invalid_request' };
          }
          transientFailures += 1;
        } else {
          const parsedStatus = parseHomeQrPairingStatusV2(result.status);
          const statusMatchesLifecycle = parsedStatus !== null
            && parsedStatus.pairId === pairId
            && Date.parse(parsedStatus.expiresAt) === expiresAtMs;
          if (!statusMatchesLifecycle) {
            await reject();
            return { kind: 'invalid_request' };
          }
          if (parsedStatus.state === 'pending') {
            transientFailures = 0;
          } else {
            const pendingCancellation = cancellationRequested ? readPendingCancellation() : null;
            if (pendingCancellation) {
              const cancellation = await pendingCancellation;
              if (cancellation.ok && cancellation.outcome === 'cancelled') return { kind: 'cancelled' };
              if (!cancellation.ok) return { kind: 'failed', status: 0 };
              // The server's immutable completion decision won. Continue with
              // the same exact completion input so the local lifecycle adopts it.
            }
            const requesterPublicKey = verifyHomeQrRequesterProofV2({
              direction: input.direction,
              qrSecret,
              pairId,
              homeServerIdentityId: input.homeServerIdentityId,
              expiresAtMs,
              issuedAtMs,
              nowMs: adapters.now(),
              status: parsedStatus,
              ...(input.expectedRequesterPublicKey ? { expectedRequesterPublicKey: input.expectedRequesterPublicKey } : {}),
            });
            if (!requesterPublicKey) {
              await reject();
              return { kind: 'invalid_request' };
            }
            try {
              await adapters.complete({
                context: {
                  direction: input.direction,
                  pairId,
                  homeServerIdentityId: input.homeServerIdentityId,
                  qrSecret,
                  issuedAtMs,
                  expiresAtMs,
                },
                requesterPublicKey,
                requestedDeviceLabel: parsedStatus.requestedDeviceLabel,
                signal: controller.signal,
              });
              return cancelled
                ? { kind: 'cancelled' }
                : { kind: 'completed', requestedDeviceLabel: parsedStatus.requestedDeviceLabel };
            } catch (error) {
              const pendingCancellation = cancellationRequested ? readPendingCancellation() : null;
              if (pendingCancellation) {
                const cancellation = await pendingCancellation;
                if (cancellation.ok && cancellation.outcome === 'cancelled') return { kind: 'cancelled' };
                if (!cancellation.ok) return { kind: 'failed', status: 0 };
                transientFailures += 1;
                continue;
              }
              if (cancelled) return { kind: 'cancelled' };
              if (error instanceof DirectHomeQrCompletionError && error.classification === 'retryable') {
                transientFailures += 1;
              } else if (error instanceof DirectHomeQrCompletionError && error.classification === 'invalid') {
                await reject();
                return { kind: 'invalid_request' };
              } else {
                return { kind: 'failed', status: 500 };
              }
            }
          }
        }
        const remainingMs = expiresAtMs - adapters.now();
        if (remainingMs <= 0) return { kind: 'expired' };
        const delayMs = Math.min(
          transientFailures === 0 ? ENROLLMENT_POLL_IDLE_DELAY_MS : enrollmentPollingBackoffMs(transientFailures),
          remainingMs,
        );
        try {
          await adapters.sleep(delayMs, controller.signal);
        } catch {
          const pendingCancellation = cancellationRequested ? readPendingCancellation() : null;
          if (pendingCancellation) {
            const cancellation = await pendingCancellation;
            if (cancellation.ok && cancellation.outcome === 'cancelled') return { kind: 'cancelled' };
            if (!cancellation.ok) return { kind: 'failed', status: 0 };
            // A completed server decision replaced the interrupted controller;
            // resume the owner loop and adopt that immutable result.
            continue;
          }
          if (cancelled || controller.signal.aborted) return { kind: 'cancelled' };
        }
      }
      return { kind: 'cancelled' };
    } finally {
      input.signal?.removeEventListener('abort', onExternalAbort);
      await adapters.close().catch(() => undefined);
    }
  })();

  return { completion, cancel };
}
