// Initialize the real Protocol entry before the narrower enrollment graph.
import '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import { parseHomeTargetInput } from '../../homeTarget/homeTarget.js';
import type { HappierJsonExecutor } from '../executors/happierJsonExecutor.js';

import { runRemoteHomeEnrollmentFlow } from './remoteHomeEnrollmentFlow.js';
import { createOpenSshHappierJsonExecutor } from '../executors/openSshHappierJsonExecutor.js';
import { readRemoteEnrollmentCommandFailure } from '@happier-dev/protocol/ssh/commandFailure';
import { createSystemTasksRunner } from '../interactiveTaskKinds.js';

const descriptor = {
  v: 1 as const,
  homeServerIdentityId: 'srv_home_remote_1',
  canonicalServerUrl: 'http://127.0.0.1:4123',
  revision: 1,
  endpoints: [{
    kind: 'iroh' as const,
    endpointId: 'a'.repeat(64),
  }],
};
const PUBLIC_KEY = Buffer.alloc(32, 1).toString('base64');
const PAIRING_SECRET = Buffer.alloc(32, 2).toString('base64url');
const pairing = { secretB64Url: PAIRING_SECRET, createdAtMs: Date.now(), expiresAtMs: Date.now() + 15 * 60_000 };

// Ordinary stdout from cli-v0.2.16 (b8d1c449c46ab4dfa8637db36b66f643d149e66d),
// apps/cli/src/cli/commands/auth/request.ts#handleAuthRequest; values redacted.
const olderAuthRequest: Record<string, unknown> = JSON.parse(readFileSync(
  new URL('./fixtures/authRequest.cli-v0.2.16.json', import.meta.url), 'utf8',
));

function createExecutor(params: Readonly<{
  lines: readonly Record<string, unknown>[];
  status?: number;
  seen: Array<Readonly<{ args: readonly string[]; input?: string; includeStdoutInError?: boolean }>>;
}>): HappierJsonExecutor {
  return {
    runHappierText: async (args, opts) => {
      params.seen.push({
        args,
        ...(opts?.input ? { input: opts.input } : {}),
        ...(typeof opts?.includeStdoutInError === 'boolean'
          ? { includeStdoutInError: opts.includeStdoutInError }
          : {}),
      });
      const stdout = `${params.lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
      for (const chunk of [stdout.slice(0, 37), stdout.slice(37)]) {
        opts?.onStdoutChunk?.(chunk);
        await Promise.resolve();
      }
      return { status: params.status ?? 0, stdout, stderr: '' };
    },
    runHappierJson: async () => {
      throw new Error('not used');
    },
  };
}

describe('runRemoteHomeEnrollmentFlow', () => {
  it.each([true, false])('names the selected Home when the guest cannot connect (buffered=%s)', async buffered => {
    const homeDescriptor = { ...descriptor, endpoints: [{ kind: 'https' as const, url: 'https://home.example.test:9443' }] };
    const seen: Array<Readonly<{ args: readonly string[] }>> = [];
    const envelope = { v: 1, ok: false, kind: buffered ? 'auth_request' : 'auth_enroll_remote', error: {
      code: 'AUTH_ENROLL_REMOTE_CARRIER_UNAVAILABLE', category: 'network_error',
      carrierFailure: { attemptedCarrier: 'https', reason: 'home_unreachable' },
    } };
    const failure = await runRemoteHomeEnrollmentFlow({ ...(buffered ? { processIO: 'buffered' as const } : {}),
      executor: createExecutor({ lines: [envelope], seen, status: 1 }),
      homeTargetInput: { kind: 'descriptor', descriptor: homeDescriptor, authority: 'trusted_enrollment' },
      approvePairingRequest: async () => { throw new Error('Unexpected approval'); },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'home_not_guest_reachable',
      details: { kind: 'managedGuestHome', homeOrigin: 'https://home.example.test:9443' } });
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw failure;
    expect(failure.message).toContain('home.example.test:9443');
    expect(seen).toHaveLength(1);
  });
  it.each([
    { category: 'tls_error', attemptedCarrier: 'https' },
    { category: 'http_error', attemptedCarrier: 'https' },
    { category: 'network_error', attemptedCarrier: 'iroh' },
  ] as const)('preserves $attemptedCarrier $category instead of reporting unreachable HTTPS Home', async ({ category, attemptedCarrier }) => {
    const seen: Array<Readonly<{ args: readonly string[] }>> = [];
    const envelope = { v: 1, ok: false, kind: 'auth_enroll_remote', error: {
      code: 'AUTH_ENROLL_REMOTE_CARRIER_UNAVAILABLE', category,
      ...(category === 'http_error' ? { status: 401 } : {}),
      carrierFailure: { attemptedCarrier, reason: 'home_unreachable' },
    } };
    const failure = await runRemoteHomeEnrollmentFlow({
      executor: createExecutor({ lines: [envelope], seen, status: 1 }),
      homeTargetInput: { kind: 'descriptor', descriptor: { ...descriptor,
        endpoints: [...descriptor.endpoints, { kind: 'https', url: 'https://home.example.test:9443' }] }, authority: 'trusted_enrollment' },
      approvePairingRequest: async () => { throw new Error('Unexpected approval'); },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'remote_command_failed' });
    if (!(failure instanceof Error)) throw failure;
    expect(failure.message).toContain(`guestAuthCategory ${category}`);
  });
  it.each(['exit', 'transport', 'incomplete', 'cancel', 'success'] as const)('retires unanswered consent on failure and preserves it on success (%s)', async outcome => {
    vi.useFakeTimers();
    const runner = createSystemTasksRunner({ kinds: {} });
    const taskId = `terminal-consent-${outcome}`;
    const transportError = Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' });
    let finishProcess!: () => void;
    const processFinished = new Promise<void>(resolve => { finishProcess = resolve; });
    let observedFailure: unknown;
    try {
      await runner.startAdmitted({ taskId, kind: 'remote.ssh.bootstrapMachine.v1', params: {} }, {
        async run(ctx) {
          try {
            return await runRemoteHomeEnrollmentFlow({
              homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
              signal: ctx.signal,
              approvePairingRequest: async () => { await ctx.prompt({ kind: 'auth.approveRemoteProvisioning', message: 'Approve guest', data: {} }); },
              executor: {
                runHappierJson: async () => { throw new Error('unused'); },
                runHappierText: async (_args, options) => {
                  let stdout = `${JSON.stringify({ kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
                    publicKey: PUBLIC_KEY, homeServerIdentityId: descriptor.homeServerIdentityId,
                    pairing: { ...pairing, createdAtMs: Date.now(), expiresAtMs: Date.now() + 900_000 },
                    supportsTokenOnly: true, pairingRequirement: 'v3' })}\n`;
                  options?.onStdoutChunk?.(stdout);
                  await processFinished;
                  if (outcome === 'transport') throw transportError;
                  if (outcome === 'success') {
                    const completion = `${JSON.stringify({ kind: 'remote_home_enrollment_result', protocolVersion: 1,
                      success: true, homeServerIdentityId: descriptor.homeServerIdentityId, machineId: 'remote-machine',
                      encryptionType: 'tokenOnly', pairingAuthentication: 'v3', remoteProfileId: 'remote-home-profile' })}\n`;
                    stdout += completion;
                    options?.onStdoutChunk?.(completion);
                  }
                  return { status: outcome === 'success' || outcome === 'incomplete' ? 0 : 1, stdout, stderr: '' };
                },
              },
            });
          } catch (error) { observedFailure = error; throw error; }
        },
      });
      expect((await runner.poll({ taskId, cursor: 0 })).pendingPrompt?.kind).toBe('auth.approveRemoteProvisioning');
      if (outcome === 'cancel') await runner.cancel({ taskId });
      finishProcess();
      // Drain completion without advancing to the signed pairing expiry.
      await vi.advanceTimersByTimeAsync(0);
      if (outcome === 'success') {
        expect((await runner.poll({ taskId, cursor: 0 })).result).toBeNull();
        expect((await runner.poll({ taskId, cursor: 0 })).pendingPrompt?.kind).toBe('auth.approveRemoteProvisioning');
        const answering = runner.respond({ taskId, answer: { approved: true } });
        await vi.advanceTimersByTimeAsync(0);
        await answering;
        await runner.wait({ taskId });
      }
      const settled = await runner.poll({ taskId, cursor: 0 });
      if (outcome === 'success') expect(settled.result).toMatchObject({ ok: true, data: { machineId: 'remote-machine' } });
      else expect(settled.result).toMatchObject({ ok: false, error: { code: outcome === 'cancel' ? 'cancelled'
        : outcome === 'exit' ? 'remote_command_failed' : outcome === 'incomplete' ? 'invalid_cli_response' : 'system_task_failed' } });
      expect(settled.pendingPrompt).toBeNull();
      if (outcome === 'transport') expect(observedFailure).toBe(transportError);
      expect(vi.getTimerCount()).toBe(0);
      await expect(runner.respond({ taskId, answer: { approved: true } })).rejects.toThrow();
    } finally {
      finishProcess();
      await runner.cancel({ taskId });
      await vi.advanceTimersByTimeAsync(900_000);
      await runner.wait({ taskId });
      vi.useRealTimers();
    }
  });
  it.each([false, true])('retains closed authority facts through the real guest failure path (buffered=%s)', async buffered => {
    const seen: Array<Readonly<{ args: readonly string[] }>> = [];
    const facts = { authorityReason: 'destination_not_allowed', authorityPhase: 'first_contact',
      authorityCarrier: 'https', authorityDescriptorPresent: true };
    const envelope = { v: 1, ok: false, kind: buffered ? 'auth_request' : 'auth_enroll_remote', error: {
      code: 'HOME_AUTHORITY_MISMATCH', category: 'auth_error', ...facts, url: 'https://private', token: 'private-token',
    } };
    const failure = await runRemoteHomeEnrollmentFlow({
      executor: createExecutor({ lines: [envelope], seen, status: 1 }),
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      ...(buffered ? { processIO: 'buffered' as const } : {}),
      approvePairingRequest: async () => { throw new Error('Unexpected approval'); },
    }).catch((error: unknown) => error);
    if (!(failure instanceof Error) || !('code' in failure)) throw failure;
    expect(readRemoteEnrollmentCommandFailure(failure.code, failure.message)).toMatchObject({
      code: 'remote_command_failed', details: { kind: 'homeAuthorityMismatch', ...facts },
    });
    expect(failure.message).not.toMatch(/https:\/\/private|private-token/);
    expect(seen).toHaveLength(1);
  });
  it.each([
    ['transport_closed', 'transport_timeout'],
    ['transport_closed', 'private-native-detail'],
    ['private-native-detail', 'transport_timeout'],
  ])(
    'retains only closed carrier diagnostics through SSH failure presentation (%s, prior %s)', async (reason, irohReason) => {
      const seen: Array<Readonly<{ args: readonly string[] }>> = [];
      const envelope = { v: 1, ok: false, kind: 'auth_enroll_remote', error: {
        code: 'AUTH_ENROLL_REMOTE_CARRIER_UNAVAILABLE', category: 'auth_error', carrierFailure: {
          attemptedCarrier: 'https', reason,
          irohAttempt: { outcome: 'unavailable', reason: irohReason, token: 'private-token' },
          url: 'https://private.example.test', token: 'private-token',
        },
      } };
      const failure = await runRemoteHomeEnrollmentFlow({
        executor: createExecutor({ lines: [envelope], seen, status: 1 }),
        homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
        approvePairingRequest: async () => { throw new Error('Unexpected approval'); },
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'remote_command_failed' });
      if (!(failure instanceof Error) || !('code' in failure)) throw failure;
      if (reason === 'transport_closed') {
        expect(failure.message).toContain('attemptedCarrier https; carrierReason transport_closed');
        if (irohReason === 'transport_timeout') expect(failure.message).toContain('irohOutcome unavailable; irohReason transport_timeout');
        else expect(failure.message).not.toContain('irohOutcome');
      }
      else expect(failure.message).not.toContain('attemptedCarrier');
      expect(failure.message).not.toMatch(/private-native-detail|private.example|private-token/);
      expect(readRemoteEnrollmentCommandFailure(failure.code, failure.message)?.message).toBe(failure.message);
      expect(seen).toHaveLength(1);
    },
  );

  it.each(['caller_abort', 'pairing_deadline'] as const)('keeps controller %s distinct from a guest auth timeout', async category => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      const pending = runRemoteHomeEnrollmentFlow({ homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
        signal: controller.signal, approvePairingRequest: async () => {},
        executor: { runHappierJson: async () => { throw new Error('unused'); },
          runHappierText: async (_args, options) => new Promise<never>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('private-abort-output')), { once: true });
            if (category === 'caller_abort') controller.abort();
            else options?.onStdoutChunk?.(`${JSON.stringify({ kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
              publicKey: PUBLIC_KEY, homeServerIdentityId: descriptor.homeServerIdentityId,
              pairing: { ...pairing, createdAtMs: Date.now(), expiresAtMs: Date.now() + 1000 },
              supportsTokenOnly: true, pairingRequirement: 'v3' })}\n`);
          }) } }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1000);
      const failure = await pending;
      expect(failure).toMatchObject({ code: category === 'caller_abort' ? 'cancelled' : 'auth_request_expired',
        message: expect.stringContaining(`controllerAbortCategory ${category}`) });
      if (!(failure instanceof Error) || !('code' in failure)) throw failure;
      expect(failure.message).toContain('exitStatus unknown; signal unknown; stdoutPresent unknown; stderrPresent unknown');
      expect(readRemoteEnrollmentCommandFailure(failure.code, failure.message)?.message).toBe(failure.message);
      expect(failure.message).not.toContain('private-abort-output');
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('preserves the original guest timeout and streaming observations through the real SSH adapter', async () => {
    const startedAt = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    let commands = 0;
    const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
      publicKey: PUBLIC_KEY, homeServerIdentityId: descriptor.homeServerIdentityId, pairing: {
        ...pairing, createdAtMs: startedAt, expiresAtMs: startedAt + 900_000 }, supportsTokenOnly: true, pairingRequirement: 'v3' };
    const envelope = { v: 1, ok: false, kind: 'auth_enroll_remote', error: { code: 'AUTH_ENROLL_REMOTE_TIMEOUT', category: 'deadline_elapsed', message: 'private-error' } };
    try {
      const failure = await runRemoteHomeEnrollmentFlow({ executor: createOpenSshHappierJsonExecutor({
        ssh: { target: 'guest.example.test', auth: 'agent' }, auth: { mode: 'agent' }, knownHostsMode: 'system',
        runRemoteText: async params => {
          commands++;
          const stdout = `${JSON.stringify(request)}\n${JSON.stringify(envelope)}\n`;
          params.onStdoutChunk?.(`${JSON.stringify(request)}\n`);
          clock.mockReturnValue(startedAt + 600_000);
          params.onStdoutChunk?.(`${JSON.stringify(envelope)}\n`);
          return { status: 1, stdout, stderr: 'private-stderr' };
        },
      }), homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      approvePairingRequest: async () => {}, }).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: 'remote_command_failed', message: expect.stringContaining('guestCliCode AUTH_ENROLL_REMOTE_TIMEOUT') });
      if (!(failure instanceof Error) || !('code' in failure)) throw failure;
      expect(failure.message).toContain('elapsedBucket at_least_600s; requestEventSeen true; finalResultEventSeen false');
      expect(failure.message).toContain('guestAuthCategory deadline_elapsed; controllerAbortCategory none');
      expect(readRemoteEnrollmentCommandFailure(failure.code, failure.message)?.message).toBe(failure.message);
      expect(failure.message).not.toMatch(/private-|guest.example|secretB64Url/);
      expect(commands).toBe(1);
    } finally { clock.mockRestore(); }
  });
  it.each(['streaming', 'buffered'] as const)('preserves kill-compatible process facts over %s IO without guessing OOM', async processIO => {
    const execute = vi.fn(async () => ({ status: 137, stdout: '', stderr: '' }));
    const approvePairingRequest = vi.fn(async () => {});
    const failure = await runRemoteHomeEnrollmentFlow({
      processIO,
      executor: createOpenSshHappierJsonExecutor({ ssh: { target: 'guest.example.test', auth: 'agent' },
        auth: { mode: 'agent' }, knownHostsMode: 'system', runRemoteText: execute }),
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      approvePairingRequest,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'remote_command_failed', message: expect.stringContaining(
      `Remote Home enrollment failed. (phase auth.${processIO === 'streaming' ? 'enroll-remote' : 'request'}; exitStatus 137; signal SIGKILL-compatible; stdoutPresent false; stderrPresent false`) });
    if (!(failure instanceof Error) || !('code' in failure)) throw failure;
    expect(readRemoteEnrollmentCommandFailure(failure.code, failure.message))
      .toEqual({ code: 'remote_command_failed', message: failure.message });
    expect(String(failure)).not.toContain('OOM');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(approvePairingRequest).not.toHaveBeenCalled();
  });

  it.each([
    { status: 1, stdout: '', stderr: '' },
    { status: 126, stdout: '', stderr: '' },
    { status: 127, stdout: '', stderr: 'private stderr and pairing secrets' },
    { status: 0, stdout: '', stderr: '' },
  ])('preserves streaming termination facts without disclosing output ($status)', async commandResult => {
    let approvals = 0;
    const failure = await runRemoteHomeEnrollmentFlow({
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      executor: { runHappierJson: async () => { throw new Error('not used'); }, runHappierText: async () => commandResult },
      approvePairingRequest: async () => { approvals++; },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: commandResult.status ? 'remote_command_failed' : 'invalid_cli_response' });
    expect(failure).toHaveProperty('message', expect.stringContaining(commandResult.status
      ? `phase auth.enroll-remote; exitStatus ${commandResult.status}; signal unknown; stdoutPresent false; stderrPresent ${Boolean(commandResult.stderr)}`
      : 'exit 0; stdout absent; stderr absent'));
    expect(String(failure)).not.toContain('private');
    expect(approvals).toBe(0);
  });

  it('accepts four-minute consent and gives wait the remainder of the pairing lifetime', async () => {
    vi.useFakeTimers();
    try {
      const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
        publicKey: PUBLIC_KEY, homeServerIdentityId: descriptor.homeServerIdentityId,
        pairing: { ...pairing, createdAtMs: Date.now(), expiresAtMs: Date.now() + 15 * 60_000 },
        supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: 'remote-home-profile' };
      const budgets: Array<number | null> = [];
      const completed = runRemoteHomeEnrollmentFlow({ processIO: 'buffered',
        homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
        executor: { runHappierJson: async () => { throw new Error('not used'); },
          runHappierText: async (args, options) => {
            budgets.push(options!.timeoutMs!);
            return { status: 0, stderr: '', stdout: JSON.stringify(args[1] === 'request' ? request : {
              kind: 'remote_home_enrollment_result', protocolVersion: 1, success: true,
              homeServerIdentityId: descriptor.homeServerIdentityId, machineId: 'joined',
              encryptionType: 'tokenOnly', pairingAuthentication: 'v3', remoteProfileId: 'remote-home-profile',
            }) };
          } },
        approvePairingRequest: async () => { await new Promise(resolve => setTimeout(resolve, 4 * 60_000)); },
      });
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      await expect(completed).resolves.toMatchObject({ machineId: 'joined' });
      expect(budgets).toEqual([null, 11 * 60_000]);
    } finally { vi.useRealTimers(); }
  });

  it('allows streaming setup beyond ten minutes before learning the actual pairing deadline', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
        publicKey: PUBLIC_KEY, homeServerIdentityId: descriptor.homeServerIdentityId,
        pairing: { ...pairing, createdAtMs: now, expiresAtMs: now + 15 * 60_000 },
        supportsTokenOnly: true, pairingRequirement: 'v3' };
      const result = { kind: 'remote_home_enrollment_result', protocolVersion: 1, success: true,
        homeServerIdentityId: descriptor.homeServerIdentityId, machineId: 'joined',
        encryptionType: 'tokenOnly', pairingAuthentication: 'v3', remoteProfileId: 'remote-home-profile' };
      let commandTimeout: number | null | undefined;
      const completed = runRemoteHomeEnrollmentFlow({
        homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
        executor: { runHappierJson: async () => { throw new Error('not used'); },
          runHappierText: async (_args, options) => {
            commandTimeout = options?.timeoutMs;
            await new Promise(resolve => setTimeout(resolve, 11 * 60_000));
            options?.onStdoutChunk?.(`${JSON.stringify(request)}\n${JSON.stringify(result)}\n`);
            return { status: 0, stdout: '', stderr: '' };
          } },
        approvePairingRequest: async () => {},
      });
      const expected = expect(completed).resolves.toMatchObject({ machineId: 'joined' });
      // Only the remote-process fixture's delay is scheduled before pairing.
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      await expected;
      expect(commandTimeout).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each([
    { phase: 'request', stream: 'stdout', code: 'ERR_BAD_REQUEST' }, { phase: 'wait', stream: 'stdout', code: 'ERR_BAD_REQUEST' },
    { phase: 'request', stream: 'stderr', code: 'ERR_BAD_REQUEST' }, { phase: 'wait', stream: 'stderr', code: 'ERR_BAD_REQUEST' },
    { phase: 'request', stream: 'stdout', code: 'UNKNOWN_PRIVATE_CODE' }, { phase: 'request', stream: 'stderr', code: 'UNKNOWN_PRIVATE_CODE' },
  ] as const)('retains safe $phase facts from $stream ($code) without subprocess secrets', async ({ phase, stream, code }) => {
    const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
      publicKey: PUBLIC_KEY, homeServerIdentityId: descriptor.homeServerIdentityId,
      pairing,
      supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: 'remote-home-profile' };
    const failure = await runRemoteHomeEnrollmentFlow({ processIO: 'buffered',
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      executor: { runHappierJson: async () => { throw new Error('not used'); },
        runHappierText: async args => {
          if (args[1] !== phase) return { status: 0, stdout: JSON.stringify(request), stderr: '' };
          const envelope = JSON.stringify({ v: 1, ok: false, kind: `auth_${phase}`,
            error: { code, category: 'http_error', status: 409, serverCode: 'database_transaction_conflict_exhausted', token: 'private-token', message: 'private-message' } });
          return { status: 1, stdout: stream === 'stdout' ? envelope : '', stderr: stream === 'stderr' ? envelope : 'private-stderr' };
        } },
      approvePairingRequest: async () => {},
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'remote_command_failed',
      message: `Remote Home enrollment failed during auth ${phase} (exit 1${code === 'ERR_BAD_REQUEST' ? '; code ERR_BAD_REQUEST' : ''}; category http_error; HTTP 409; server code database_transaction_conflict_exhausted).` });
    if (!(failure instanceof Error) || !('code' in failure)) throw failure;
    expect(readRemoteEnrollmentCommandFailure(failure.code, failure.message))
      .toEqual({ code: 'remote_command_failed', message: failure.message });
    expect(JSON.stringify(failure)).not.toMatch(/private-token|private-message|private-stderr|UNKNOWN_PRIVATE_CODE/);
  });

  it.each(['older-text', 'wrong-kind'] as const)('retains only phase and exit for an untrusted failure envelope (%s)', async variant => {
    const failure = await runRemoteHomeEnrollmentFlow({ processIO: 'buffered',
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      executor: { runHappierJson: async () => { throw new Error('not used'); },
        runHappierText: async () => ({ status: 1, stderr: 'private-stderr',
          stdout: variant === 'older-text' ? 'private-stdout' : JSON.stringify({ v: 1, ok: false,
            kind: 'auth_wait', error: { code: 'UNTRUSTED_CODE', category: 'http_error', status: 409 } }) }) },
      approvePairingRequest: async () => {},
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'remote_command_failed',
      message: 'Remote Home enrollment failed during auth request (exit 1).' });
    expect(JSON.stringify(failure)).not.toMatch(/private-|UNTRUSTED_CODE|http_error|409/);
  });

  it.each([
    '',
    'private-malformed-output',
    'private-warning\n' + JSON.stringify({ v: 1, ok: false, kind: 'auth_wait', error: { code: 'AUTH_WAIT_FAILED' } }),
    JSON.stringify({ v: 1, ok: false, kind: 'auth_wait', error: { code: 'AUTH_WAIT_FAILED' } }) + '\n{}',
  ])('classifies a wait process failure with absent or invalid diagnostics (%s)', async stdout => {
    const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
      publicKey: PUBLIC_KEY, homeServerIdentityId: descriptor.homeServerIdentityId,
      pairing, supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: 'remote-home-profile' };
    const failure = await runRemoteHomeEnrollmentFlow({ processIO: 'buffered',
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      executor: { runHappierJson: async () => { throw new Error('not used'); },
        runHappierText: async args => args[1] === 'request'
          ? { status: 0, stdout: JSON.stringify(request), stderr: '' }
          : { status: 1, stdout, stderr: 'private-native-error' } },
      approvePairingRequest: async () => {},
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'remote_command_failed',
      message: `Remote Home enrollment failed during auth wait (exit 1; code AUTH_WAIT_PROCESS_FAILED; diagnostic ${stdout ? 'invalid; check parse' : 'absent'}).` });
    expect(String(failure)).not.toMatch(/private-native-error|private-malformed-output|private-warning/);
  });

  it.each([
    { response: { v: 2, ok: false, kind: 'auth_wait', error: { code: 'PRIVATE_CODE' } }, check: 'v' },
    { response: { v: 1, ok: true, kind: 'auth_wait', error: { code: 'PRIVATE_CODE' } }, check: 'ok' },
    { response: { v: 1, ok: false, kind: 'auth_request', error: { code: 'PRIVATE_CODE' } }, check: 'kind' },
    { response: { v: 1, ok: false, kind: 'auth_wait', error: { code: 'private/secret' } }, check: 'code' },
    { response: { v: 1, ok: false, kind: 'auth_wait', error: { code: 'private_secret' } }, check: 'code' },
    { response: { v: 1, ok: false, kind: 'auth_wait', error: { code: 'AUTH_FUTURE_POST_CLAIM_FAILURE', serverCode: 'PRIVATE_TOKEN', message: 'private-message' } }, check: 'code' },
    { response: { v: 1, ok: false, kind: 'auth_wait' }, check: 'code' },
    { response: null, check: 'v' },
  ])('identifies the failed diagnostic check without copying rejected fields ($check)', async ({ response, check }) => {
    const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
      publicKey: PUBLIC_KEY, homeServerIdentityId: descriptor.homeServerIdentityId,
      pairing, supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: 'remote-home-profile' };
    const failure = await runRemoteHomeEnrollmentFlow({ processIO: 'buffered',
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      executor: { runHappierJson: async () => { throw new Error('not used'); },
        runHappierText: async args => args[1] === 'request'
          ? { status: 0, stdout: JSON.stringify(request), stderr: '' }
          : { status: 1, stdout: JSON.stringify(response), stderr: 'private-native-error' } },
      approvePairingRequest: async () => {},
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'remote_command_failed',
      message: `Remote Home enrollment failed during auth wait (exit 1; code AUTH_WAIT_PROCESS_FAILED; diagnostic invalid; check ${check}).` });
    expect(String(failure)).not.toMatch(/PRIVATE_CODE|private\/secret|private_secret|AUTH_FUTURE_POST_CLAIM_FAILURE|PRIVATE_TOKEN|private-message|private-native-error/);
  });

  it.each(['descriptor', 'https_url'] as const)('targets the selected Home even when a released CLI ignores descriptor stdin (%s)', async kind => {
    let contactedServer = '';
    const selectedUrl = 'https://self-hosted.example.test';
    const failure = await runRemoteHomeEnrollmentFlow({ processIO: 'buffered',
      homeTargetInput: kind === 'descriptor'
        ? { kind, descriptor: { ...descriptor, canonicalServerUrl: selectedUrl,
          endpoints: [{ kind: 'https', url: selectedUrl }] }, authority: 'trusted_enrollment' }
        : { kind, url: selectedUrl },
      executor: {
        // Released cli-v0.2.16 handleAuthRequest ignores the new stdin flags,
        // but its applyServerSelectionFromArgs honors this released selector.
        runHappierText: async (args, options) => {
          const index = args.indexOf('--server-url');
          contactedServer = index < 0 ? 'https://api.happier.dev' : args[index + 1]!;
          expect(options?.includeStdoutInError).toBe(false);
          return { status: 0, stdout: JSON.stringify({ ...olderAuthRequest, serverUrl: contactedServer }), stderr: '' };
        },
        runHappierJson: async () => { throw new Error('unused'); },
      },
      approvePairingRequest: async () => { throw new Error('Legacy pairing must remain refused'); },
    }).catch((error: unknown) => error);
    expect(contactedServer).toBe(selectedUrl);
    expect(failure).toMatchObject({ code: 'remote_cli_update_required' });
    expect(String(failure)).not.toContain('redacted-claim-secret');
    expect(JSON.stringify(failure)).not.toContain('redacted-pairing-secret');
  });

  it('requires a remote CLI update for released ordinary auth request stdout without disclosing it', async () => {
    const seen: Array<Readonly<{ args: readonly string[]; input?: string; includeStdoutInError?: boolean }>> = [];
    const approvePairingRequest = vi.fn(async () => {});
    const error = await runRemoteHomeEnrollmentFlow({
      executor: createExecutor({ seen, lines: [olderAuthRequest] }), processIO: 'buffered',
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      approvePairingRequest,
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'remote_cli_update_required' });
    expect(approvePairingRequest).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.includeStdoutInError).toBe(false);
    for (const secret of ['redacted-claim-secret', 'redacted-pairing-secret', '/redacted/auth/pending']) {
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });

  it.each(['released', 'wrong-status', 'wrong-stderr', 'malformed'] as const)(
    'classifies only the released unsupported streaming command through the SSH executor (%s)', async variant => {
      const released: { status: number; stdout: string; stderr: string } = JSON.parse(readFileSync(
        new URL('./fixtures/authEnrollRemote.cli-v0.2.16.json', import.meta.url), 'utf8',
      ));
      const response = { ...released,
        ...(variant === 'wrong-status' ? { status: 0 } : {}),
        ...(variant === 'wrong-stderr' ? { stderr: 'Authentication failed\n' } : {}),
        ...(variant === 'malformed' ? { stdout: 'not JSON\n' } : {}),
      };
      const approvePairingRequest = vi.fn(async () => {});
      const runRemoteText = vi.fn(async (params: Parameters<Parameters<typeof createOpenSshHappierJsonExecutor>[0]['runRemoteText']>[0]) => {
        expect(params.remoteCommand).toContain("'enroll-remote' '--json-lines' '--home-target-stdin'");
        expect(params.includeStdoutInError).toBe(false);
        for (const chunk of [response.stdout.slice(0, 37), response.stdout.slice(37)]) params.onStdoutChunk?.(chunk);
        return response;
      });
      const error = await runRemoteHomeEnrollmentFlow({
        executor: createOpenSshHappierJsonExecutor({ ssh: { target: 'guest.example.test', auth: 'agent' },
          auth: { mode: 'agent' }, knownHostsMode: 'system', runRemoteText }),
        homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
        approvePairingRequest,
      }).catch((error: unknown) => error);
      expect(error).toMatchObject({ code: variant === 'released' ? 'remote_cli_update_required'
        : variant === 'wrong-stderr' ? 'remote_command_failed' : 'invalid_cli_response' });
      expect(approvePairingRequest).not.toHaveBeenCalled();
      expect(runRemoteText).toHaveBeenCalledTimes(1);
      expect(String(error)).not.toContain('Authentication management');
      expect(JSON.stringify(error)).not.toContain('Authentication management');
    },
  );

  it.each(['buffered', 'streaming'] as const)('keeps malformed or unrecognized stdout invalid over %s IO', async (processIO) => {
    for (const response of [{}, { ...olderAuthRequest, pairing: null }, { ...olderAuthRequest, kind: 'unknown_event' }]) {
      const approvePairingRequest = vi.fn(async () => {});
      await expect(runRemoteHomeEnrollmentFlow({
        executor: createExecutor({ seen: [], lines: [response] }), processIO,
        homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
        approvePairingRequest,
      })).rejects.toMatchObject({ code: 'invalid_cli_response' });
      expect(approvePairingRequest).not.toHaveBeenCalled();
    }
  });

  it('enrolls over buffered exec only, approving between the finite request and wait commands', async () => {
    const seen: Array<Readonly<{ args: readonly string[]; input?: string }>> = [];
    let approved = false;
    const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
      publicKey: PUBLIC_KEY, homeServerIdentityId: descriptor.homeServerIdentityId,
      pairing,
      supportsTokenOnly: true, pairingRequirement: 'v3', remoteProfileId: 'remote-home-profile' };
    const completion = { kind: 'remote_home_enrollment_result', protocolVersion: 1, success: true,
      homeServerIdentityId: descriptor.homeServerIdentityId, machineId: 'remote-machine',
      encryptionType: 'tokenOnly', pairingAuthentication: 'v3', remoteProfileId: 'remote-home-profile' };
    const executor: HappierJsonExecutor = {
      runHappierText: async (args, opts) => {
        seen.push({ args, input: opts?.input });
        // A buffered carrier never invokes onStdoutChunk. The request returns
        // before approval; waiting is a separate invocation of normal auth.
        if (args[1] === 'request') return { status: 0, stdout: JSON.stringify(request), stderr: '' };
        expect(approved).toBe(true);
        expect(args).toEqual(['auth', 'wait', '--json', '--remote-enrollment', '--server', 'remote-home-profile', '--no-persist', '--public-key', PUBLIC_KEY]);
        return { status: 0, stdout: JSON.stringify(completion), stderr: '' };
      },
      runHappierJson: async () => { throw new Error('not used'); },
    };
    const result = await runRemoteHomeEnrollmentFlow({ executor, processIO: 'buffered',
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      approvePairingRequest: async () => { approved = true; }, });
    expect(seen[0]!.args).toEqual(['auth', 'request', '--json', '--remote-enrollment', '--home-target-stdin',
      '--server-url', descriptor.canonicalServerUrl, '--no-persist']);
    expect(JSON.parse(seen[0]!.input!)).toEqual(parseHomeTargetInput({ kind: 'descriptor', descriptor, authority: 'trusted_enrollment' }));
    expect(seen[1]!.input).toBeUndefined();
    expect(result.machineId).toBe('remote-machine');
    expect(JSON.stringify(result)).not.toContain(PAIRING_SECRET);
  });

  it('rejects a managed enrollment for another Home before starting the guest process', async () => {
    const seen: Array<Readonly<{ args: readonly string[]; input?: string }>> = [];
    await expect(runRemoteHomeEnrollmentFlow({
      executor: createExecutor({ seen, lines: [] }),
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      managedEnrollment: {
        homeId: 'srv_other_home', managedId: 'managed-1', expectedIntentRevision: 1,
        requestId: 'request-1', controller: { machineId: 'controller', installationId: 'installation' },
        resource: { contributionRef: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, value: { instance: 'paid-1' } },
      },
      approvePairingRequest: async () => {},
    })).rejects.toMatchObject({ code: 'home_identity_mismatch' });
    expect(seen).toEqual([]);
  });

  it('carries managed correlation only in protected guest input', async () => {
    const seen: Array<Readonly<{ args: readonly string[]; input?: string }>> = [];
    const managedEnrollment = {
      homeId: descriptor.homeServerIdentityId, managedId: 'managed-1', expectedIntentRevision: 1,
      requestId: 'request-1', controller: { machineId: 'controller', installationId: 'installation' },
      resource: { contributionRef: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, value: { instance: 'paid-1' } },
    };
    await expect(runRemoteHomeEnrollmentFlow({
      executor: createExecutor({ seen, lines: [] }), managedEnrollment,
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      approvePairingRequest: async () => {},
    })).rejects.toMatchObject({ code: 'invalid_cli_response' });
    expect(JSON.parse(seen[0]!.input!)).toEqual({
      homeTarget: parseHomeTargetInput({ kind: 'descriptor', descriptor, authority: 'trusted_enrollment' }), managedEnrollment,
    });
    expect(seen[0]!.args).not.toContain('managed-1');
  });

  it('uses one descriptor-aware remote process and returns only non-secret completion facts', async () => {
    const seen: Array<Readonly<{ args: readonly string[]; input?: string; includeStdoutInError?: boolean }>> = [];
    const approved: Array<Record<string, unknown>> = [];
    const result = await runRemoteHomeEnrollmentFlow({
      executor: createExecutor({
        seen,
        lines: [
          {
            kind: 'remote_home_enrollment_pairing_request',
            protocolVersion: 1,
            publicKey: PUBLIC_KEY,
            homeServerIdentityId: descriptor.homeServerIdentityId,
            pairing,
            supportsTokenOnly: true,
            pairingRequirement: 'v3',
          },
          {
            kind: 'remote_home_enrollment_result',
            protocolVersion: 1,
            success: true,
            homeServerIdentityId: descriptor.homeServerIdentityId,
            machineId: 'remote-machine',
            encryptionType: 'tokenOnly',
            pairingAuthentication: 'v3',
            remoteProfileId: 'remote-home-profile',
          },
        ],
      }),
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      approvePairingRequest: async (request) => {
        approved.push(request);
      },
    });

    expect(seen).toEqual([{
      args: ['auth', 'enroll-remote', '--json-lines', '--home-target-stdin'],
      input: JSON.stringify(parseHomeTargetInput({
        kind: 'descriptor',
        descriptor,
        authority: 'trusted_enrollment',
      })),
      includeStdoutInError: false,
    }]);
    expect(approved).toHaveLength(1);
    expect(result).toEqual({
      success: true,
      homeServerIdentityId: descriptor.homeServerIdentityId,
      machineId: 'remote-machine',
      encryptionType: 'tokenOnly',
      pairingAuthentication: 'v3',
      remoteProfileId: 'remote-home-profile',
    });
    expect(JSON.stringify(result)).not.toContain(PAIRING_SECRET);
  });

  it('aborts the one remote process when approval fails without disclosing its output', async () => {
    let observedAbort = false;
    const executor: HappierJsonExecutor = {
      runHappierText: async (_args, opts) => {
        opts?.onStdoutChunk?.(`${JSON.stringify({
          kind: 'remote_home_enrollment_pairing_request',
          protocolVersion: 1,
          publicKey: PUBLIC_KEY,
          homeServerIdentityId: descriptor.homeServerIdentityId,
          pairing,
          supportsTokenOnly: true,
          pairingRequirement: 'v3',
        })}\n`);
        await new Promise<void>((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            observedAbort = true;
            reject(new Error('command aborted with sensitive stdout'));
          }, { once: true });
        });
        throw new Error('unreachable');
      },
      runHappierJson: async () => {
        throw new Error('not used');
      },
    };

    await expect(runRemoteHomeEnrollmentFlow({
      executor,
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      approvePairingRequest: async () => {
        throw new Error('approval rejected');
      },
    })).rejects.toThrow('approval rejected');
    expect(observedAbort).toBe(true);
  });

  it('rejects extra protocol events instead of accepting the last plausible result', async () => {
    const seen: Array<Readonly<{ args: readonly string[]; input?: string }>> = [];
    await expect(runRemoteHomeEnrollmentFlow({
      executor: createExecutor({
        seen,
        lines: [
          {
            kind: 'remote_home_enrollment_pairing_request',
            protocolVersion: 1,
            publicKey: PUBLIC_KEY,
            homeServerIdentityId: descriptor.homeServerIdentityId,
            pairing,
            supportsTokenOnly: true,
            pairingRequirement: 'v3',
          },
          { kind: 'unexpected_event' },
          {
            kind: 'remote_home_enrollment_result',
            protocolVersion: 1,
            success: true,
            homeServerIdentityId: descriptor.homeServerIdentityId,
            machineId: 'remote-machine',
            encryptionType: 'tokenOnly',
            pairingAuthentication: 'v3',
            remoteProfileId: 'remote-home-profile',
          },
        ],
      }),
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      approvePairingRequest: async () => undefined,
    })).rejects.toThrow('invalid event sequence');
  });

  it('rejects a descriptor identity mismatch before requesting local approval', async () => {
    const approvePairingRequest = vi.fn(async () => undefined);
    await expect(runRemoteHomeEnrollmentFlow({
      executor: createExecutor({
        seen: [],
        lines: [
          {
            kind: 'remote_home_enrollment_pairing_request',
            protocolVersion: 1,
            publicKey: PUBLIC_KEY,
            homeServerIdentityId: 'srv_other_home',
            pairing,
            supportsTokenOnly: true,
            pairingRequirement: 'v3',
          },
          {
            kind: 'remote_home_enrollment_result',
            protocolVersion: 1,
            success: true,
            homeServerIdentityId: 'srv_other_home',
            machineId: 'remote-machine',
            encryptionType: 'tokenOnly',
            pairingAuthentication: 'v3',
            remoteProfileId: 'remote-home-profile',
          },
        ],
      }),
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      approvePairingRequest,
    })).rejects.toMatchObject({ code: 'home_identity_mismatch' });
    expect(approvePairingRequest).not.toHaveBeenCalled();
  });
});
