import { describe, expect, it, vi } from 'vitest';
import { resolveHomeTargetFromDescriptor } from '@happier-dev/cli-common/homeTarget';
import type { HappierJsonExecutor } from '@happier-dev/cli-common/systemTasks';

const { approveTerminalAuthRequest } = vi.hoisted(() => ({
  approveTerminalAuthRequest: vi.fn(async () => undefined),
}));
vi.mock('@/auth/terminalAuthApproval', () => ({ approveTerminalAuthRequest }));
vi.mock('@/server/serverSelection', () => ({ applyServerSelectionFromArgs: async (args: string[]) => args }));
vi.mock('@/cli/output/jsonEnvelope', () => ({ writeJsonStdout: vi.fn(async () => undefined) }));

import { handleAuthPairRemote } from './auth/pairRemote';

describe('auth pair-remote Home enrollment', () => {
  it('does not resolve or create a remote executor when the command is already cancelled', async () => {
    const caller = new AbortController();
    caller.abort();
    const resolveHomeTarget = vi.fn();
    const createEnrollmentExecutor = vi.fn();

    await expect(handleAuthPairRemote(
      ['--ssh', 'user@host', '--json', '--no-post-check'],
      caller.signal,
      { resolveHomeTarget, createEnrollmentExecutor },
    )).rejects.toMatchObject({ name: 'AbortError' });

    expect(resolveHomeTarget).not.toHaveBeenCalled();
    expect(createEnrollmentExecutor).not.toHaveBeenCalled();
  });

  it('pairs an Iroh-only Home through one streaming command and returns no bearer', async () => {
    const target = resolveHomeTargetFromDescriptor({
      descriptor: {
        v: 1,
        homeServerIdentityId: 'srv_pair_remote_iroh',
        canonicalServerUrl: 'http://localhost:3010',
        revision: 1,
        endpoints: [{ kind: 'iroh', endpointId: 'd'.repeat(64) }],
      },
      authority: 'trusted_enrollment',
    });
    const seen: Array<{ args: readonly string[]; input?: string }> = [];
    const executor: HappierJsonExecutor = {
      runHappierJson: async () => { throw new Error('split JSON command not allowed'); },
      runHappierText: async (args, options) => {
        seen.push({ args, input: options?.input });
        const request = JSON.stringify({
          kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
          publicKey: Buffer.alloc(32, 1).toString('base64'),
          homeServerIdentityId: target.homeServerIdentityId,
          pairing: {
            secretB64Url: Buffer.alloc(32, 2).toString('base64url'),
            createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000,
          },
          supportsTokenOnly: true, pairingRequirement: 'v3',
        });
        const result = JSON.stringify({
          kind: 'remote_home_enrollment_result', protocolVersion: 1, success: true,
          homeServerIdentityId: target.homeServerIdentityId, machineId: 'machine-remote',
          encryptionType: 'tokenOnly', pairingAuthentication: 'v3', remoteProfileId: 'remote-home-profile',
        });
        options?.onStdoutChunk?.(`${request}\n${result}\n`);
        return { status: 0, stdout: `${request}\n${result}\n`, stderr: '' };
      },
    };

    const caller = new AbortController();
    await handleAuthPairRemote(
      ['--ssh', 'user@host', '--home-descriptor-file', '-', '--json', '--no-post-check'],
      caller.signal,
      {
      resolveHomeTarget: async () => target,
      parseHomeTargetArgs: async (args) => ({
        target: { kind: 'descriptor', descriptor: target.descriptor!, authority: 'trusted_enrollment' },
        source: '--home-descriptor-file',
        rest: args.filter((entry) => entry !== '--home-descriptor-file' && entry !== '-'),
      }),
      createEnrollmentExecutor: () => executor,
      },
    );

    expect(seen).toEqual([expect.objectContaining({
      args: ['auth', 'enroll-remote', '--json-lines', '--home-target-stdin'],
    })]);
    expect(seen[0]?.input).toContain('srv_pair_remote_iroh');
    expect(approveTerminalAuthRequest).toHaveBeenCalledWith(expect.objectContaining({ target, signal: caller.signal }));
    expect(JSON.stringify(seen)).not.toContain('access-token');
  });

  it('propagates caller cancellation into the canonical SSH enrollment executor', async () => {
    const target = resolveHomeTargetFromDescriptor({
      descriptor: {
        v: 1,
        homeServerIdentityId: 'srv_pair_remote_abort',
        canonicalServerUrl: 'https://home.example.test',
        revision: 1,
        endpoints: [{ kind: 'https', url: 'https://home.example.test' }],
      },
      authority: 'trusted_enrollment',
    });
    const caller = new AbortController();
    let executorSignal: AbortSignal | undefined;
    const executor: HappierJsonExecutor = {
      runHappierJson: async () => { throw new Error('split JSON command not allowed'); },
      runHappierText: async (_args, options) => {
        executorSignal = options?.signal;
        return await new Promise<never>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        });
      },
    };

    const pending = handleAuthPairRemote(
      ['--ssh', 'user@host', '--home-descriptor-file', '-', '--json', '--no-post-check'],
      caller.signal,
      {
        resolveHomeTarget: async () => target,
        parseHomeTargetArgs: async (args) => ({
          target: { kind: 'descriptor', descriptor: target.descriptor!, authority: 'trusted_enrollment' },
          source: '--home-descriptor-file',
          rest: args.filter((entry) => entry !== '--home-descriptor-file' && entry !== '-'),
        }),
        createEnrollmentExecutor: ({ signal }) => {
          executorSignal = signal;
          return executor;
        },
      },
    );
    await vi.waitFor(() => expect(executorSignal).toBeDefined());

    caller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(executorSignal?.aborted).toBe(true);
  });
});
