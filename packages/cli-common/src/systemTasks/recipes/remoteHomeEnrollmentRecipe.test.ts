import { describe, expect, it, vi } from 'vitest';

import { parseHomeTargetInput } from '../../homeTarget/homeTarget.js';
import type { HappierJsonExecutor } from '../executors/happierJsonExecutor.js';

import { runRemoteHomeEnrollmentRecipe } from './remoteHomeEnrollmentRecipe.js';

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

function createExecutor(params: Readonly<{
  lines: readonly Record<string, unknown>[];
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
      return { status: 0, stdout, stderr: '' };
    },
    runHappierJson: async () => {
      throw new Error('not used');
    },
  };
}

describe('runRemoteHomeEnrollmentRecipe', () => {
  it('enrolls over buffered exec only, approving between the finite request and wait commands', async () => {
    const seen: Array<Readonly<{ args: readonly string[]; input?: string }>> = [];
    let approved = false;
    const request = { kind: 'remote_home_enrollment_pairing_request', protocolVersion: 1,
      publicKey: PUBLIC_KEY, homeServerIdentityId: descriptor.homeServerIdentityId,
      pairing: { secretB64Url: PAIRING_SECRET, createdAtMs: 10, expiresAtMs: 20 },
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
    const result = await runRemoteHomeEnrollmentRecipe({ executor, processIO: 'buffered',
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      approvePairingRequest: async () => { approved = true; }, timeoutMs: 5_000 });
    expect(seen[0]!.args).toEqual(['auth', 'request', '--json', '--remote-enrollment', '--home-target-stdin']);
    expect(JSON.parse(seen[0]!.input!)).toEqual(parseHomeTargetInput({ kind: 'descriptor', descriptor, authority: 'trusted_enrollment' }));
    expect(seen[1]!.input).toBeUndefined();
    expect(result.machineId).toBe('remote-machine');
    expect(JSON.stringify(result)).not.toContain(PAIRING_SECRET);
  });

  it('rejects a managed enrollment for another Home before starting the guest process', async () => {
    const seen: Array<Readonly<{ args: readonly string[]; input?: string }>> = [];
    await expect(runRemoteHomeEnrollmentRecipe({
      executor: createExecutor({ seen, lines: [] }),
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      managedEnrollment: {
        homeId: 'srv_other_home', managedId: 'managed-1', expectedIntentRevision: 1,
        requestId: 'request-1', controller: { machineId: 'controller', installationId: 'installation' },
        resource: { contributionRef: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, value: { instance: 'paid-1' } },
      },
      approvePairingRequest: async () => {},
      timeoutMs: 5_000,
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
    await expect(runRemoteHomeEnrollmentRecipe({
      executor: createExecutor({ seen, lines: [] }), managedEnrollment,
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      approvePairingRequest: async () => {}, timeoutMs: 5_000,
    })).rejects.toMatchObject({ code: 'invalid_cli_response' });
    expect(JSON.parse(seen[0]!.input!)).toEqual({
      homeTarget: parseHomeTargetInput({ kind: 'descriptor', descriptor, authority: 'trusted_enrollment' }), managedEnrollment,
    });
    expect(seen[0]!.args).not.toContain('managed-1');
  });

  it('uses one descriptor-aware remote process and returns only non-secret completion facts', async () => {
    const seen: Array<Readonly<{ args: readonly string[]; input?: string; includeStdoutInError?: boolean }>> = [];
    const approved: Array<Record<string, unknown>> = [];
    const result = await runRemoteHomeEnrollmentRecipe({
      executor: createExecutor({
        seen,
        lines: [
          {
            kind: 'remote_home_enrollment_pairing_request',
            protocolVersion: 1,
            publicKey: PUBLIC_KEY,
            homeServerIdentityId: descriptor.homeServerIdentityId,
            pairing: { secretB64Url: PAIRING_SECRET, createdAtMs: 10, expiresAtMs: 20 },
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
      timeoutMs: 5_000,
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
          pairing: { secretB64Url: PAIRING_SECRET, createdAtMs: 10, expiresAtMs: 20 },
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

    await expect(runRemoteHomeEnrollmentRecipe({
      executor,
      homeTargetInput: { kind: 'descriptor', descriptor, authority: 'trusted_enrollment' },
      approvePairingRequest: async () => {
        throw new Error('approval rejected');
      },
      timeoutMs: 5_000,
    })).rejects.toThrow('approval rejected');
    expect(observedAbort).toBe(true);
  });

  it('rejects extra protocol events instead of accepting the last plausible result', async () => {
    const seen: Array<Readonly<{ args: readonly string[]; input?: string }>> = [];
    await expect(runRemoteHomeEnrollmentRecipe({
      executor: createExecutor({
        seen,
        lines: [
          {
            kind: 'remote_home_enrollment_pairing_request',
            protocolVersion: 1,
            publicKey: PUBLIC_KEY,
            homeServerIdentityId: descriptor.homeServerIdentityId,
            pairing: { secretB64Url: PAIRING_SECRET, createdAtMs: 10, expiresAtMs: 20 },
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
      timeoutMs: 5_000,
    })).rejects.toThrow('invalid event sequence');
  });

  it('rejects a descriptor identity mismatch before requesting local approval', async () => {
    const approvePairingRequest = vi.fn(async () => undefined);
    await expect(runRemoteHomeEnrollmentRecipe({
      executor: createExecutor({
        seen: [],
        lines: [
          {
            kind: 'remote_home_enrollment_pairing_request',
            protocolVersion: 1,
            publicKey: PUBLIC_KEY,
            homeServerIdentityId: 'srv_other_home',
            pairing: { secretB64Url: PAIRING_SECRET, createdAtMs: 10, expiresAtMs: 20 },
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
      timeoutMs: 5_000,
    })).rejects.toMatchObject({ code: 'home_identity_mismatch' });
    expect(approvePairingRequest).not.toHaveBeenCalled();
  });
});
