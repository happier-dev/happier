import { describe, expect, it } from 'vitest';

import { resolveDaemonExecutionRunBrokerAuthority } from './executionRunBrokerAuthority';

const request = {
  v: 1 as const,
  requestNonce: '11111111-1111-4111-8111-111111111111',
  serverIdentityId: 'srv_home_one',
  requestingAccountId: 'account-one',
  workerMachineId: 'machine-one',
  executionRunId: 'run-one',
  expectedIntent: 'voice_agent' as const,
  expectedOccurrenceId: 'occurrence-one',
};

describe('resolveDaemonExecutionRunBrokerAuthority', () => {
  const liveCurrent = async () => ({
    status: 'current' as const,
    executionRunId: 'run-one',
    occurrenceId: 'occurrence-one',
    parentSessionId: 'session-one',
    intent: 'voice_agent' as const,
    runtimeState: 'active_turn' as const,
    activeTurnId: 'voice-turn-1',
    teamCredentialProviderModel: { resourceId: 'resource-one', deliveryMode: 'brokered' as const },
  });

  it('returns only the exact current Session-owned occurrence and active-turn state', async () => {
    await expect(resolveDaemonExecutionRunBrokerAuthority(request, {
      currentIdentity: { serverIdentityId: 'srv_home_one', accountId: 'account-one', machineId: 'machine-one' },
      listMarkers: async () => [{
        runId: 'run-one', happySessionId: 'session-one', intent: 'voice_agent', status: 'running', pid: 41,
        executionRunBrokerAuthorityV1: { occurrenceId: 'occurrence-one', turnState: 'active_turn' },
      }],
      isPidAlive: async pid => pid === 41,
      resolveLiveAuthority: liveCurrent,
    })).resolves.toEqual({
      status: 'current',
      requestNonce: request.requestNonce,
      serverIdentityId: request.serverIdentityId,
      requestingAccountId: request.requestingAccountId,
      workerMachineId: request.workerMachineId,
      executionRunId: request.executionRunId,
      occurrenceId: 'occurrence-one',
      parentSessionId: 'session-one',
      intent: 'voice_agent',
      runtimeState: 'active_turn',
      activeTurnId: 'voice-turn-1',
      // The Run owner's own accepted selection travels to the Home unchanged.
      teamCredentialProviderModel: { resourceId: 'resource-one', deliveryMode: 'brokered' },
    });
  });

  it('routes a detached Run to the daemon-owned live controller without fabricating a Session', async () => {
    const detachedRequest = { ...request, expectedIntent: 'agent' as const };
    await expect(resolveDaemonExecutionRunBrokerAuthority(detachedRequest, {
      currentIdentity: { serverIdentityId: 'srv_home_one', accountId: 'account-one', machineId: 'machine-one' },
      listMarkers: async () => [{
        runId: 'run-one', happySessionId: null, intent: 'agent', status: 'running', pid: 41,
      }],
      isPidAlive: async pid => pid === 41,
      resolveLiveAuthority: async ({ sessionId }) => ({
        status: 'current',
        executionRunId: 'run-one',
        occurrenceId: 'occurrence-one',
        parentSessionId: sessionId,
        intent: 'agent',
        runtimeState: 'idle',
        teamCredentialProviderModel: null,
      }),
    })).resolves.toEqual({
      status: 'current',
      requestNonce: request.requestNonce,
      serverIdentityId: request.serverIdentityId,
      requestingAccountId: request.requestingAccountId,
      workerMachineId: request.workerMachineId,
      executionRunId: request.executionRunId,
      occurrenceId: 'occurrence-one',
      parentSessionId: null,
      intent: 'agent',
      runtimeState: 'idle',
      activeTurnId: null,
      teamCredentialProviderModel: null,
    });
  });

  it('routes a foreign recipient attached Run to its exact Session authority without using custodian identity as recipient identity', async () => {
    const result = await resolveDaemonExecutionRunBrokerAuthority(request, {
      currentIdentity: { serverIdentityId: 'srv_home_one', accountId: 'worker-custodian', machineId: 'machine-one' },
      listMarkers: async () => [{ runId: 'run-one', happySessionId: 'session-one', intent: 'voice_agent', status: 'running', pid: 41 }],
      isPidAlive: async () => true,
      resolveLiveAuthority: async input => {
        expect(input).toMatchObject({ sessionId: 'session-one', requestingAccountId: 'account-one' });
        return liveCurrent();
      },
    });
    expect(result).toMatchObject({ status: 'current', requestingAccountId: 'account-one', parentSessionId: 'session-one' });
  });

  it('never lends a detached custodian Run to a foreign recipient', async () => {
    let reads = 0;
    await expect(resolveDaemonExecutionRunBrokerAuthority(request, {
      currentIdentity: { serverIdentityId: 'srv_home_one', accountId: 'worker-custodian', machineId: 'machine-one' },
      listMarkers: async () => [{ runId: 'run-one', happySessionId: null, intent: 'voice_agent', status: 'running', pid: 41 }],
      isPidAlive: async () => true,
      resolveLiveAuthority: async () => { reads += 1; return { ...await liveCurrent(), parentSessionId: null }; },
    })).resolves.toMatchObject({ status: 'not_current', reason: 'identity_mismatch' });
    expect(reads).toBe(0);
  });

  it.each([
    ['wrong Home', { ...request, serverIdentityId: 'srv_other' }, 'identity_mismatch'],
    ['wrong Machine', { ...request, workerMachineId: 'machine-other' }, 'identity_mismatch'],
    ['wrong occurrence', { ...request, expectedOccurrenceId: 'occurrence-old' }, 'occurrence_mismatch'],
  ] as const)('rejects %s', async (_label, candidate, reason) => {
    await expect(resolveDaemonExecutionRunBrokerAuthority(candidate, {
      currentIdentity: { serverIdentityId: 'srv_home_one', accountId: 'account-one', machineId: 'machine-one' },
      listMarkers: async () => [{
        runId: 'run-one', happySessionId: 'session-one', intent: 'voice_agent', status: 'running', pid: 41,
        executionRunBrokerAuthorityV1: { occurrenceId: 'occurrence-one', turnState: 'idle' },
      }],
      isPidAlive: async () => true,
      resolveLiveAuthority: liveCurrent,
    })).resolves.toEqual({ status: 'not_current', requestNonce: candidate.requestNonce, reason });
  });

  it('rejects a current Run of the wrong runtime intent', async () => {
    await expect(resolveDaemonExecutionRunBrokerAuthority(request, {
      currentIdentity: { serverIdentityId: 'srv_home_one', accountId: 'account-one', machineId: 'machine-one' },
      listMarkers: async () => [{
        runId: 'run-one', happySessionId: 'session-one', intent: 'agent', status: 'running', pid: 41,
        executionRunBrokerAuthorityV1: { occurrenceId: 'occurrence-one', turnState: 'active_turn' },
      }],
      isPidAlive: async () => true,
      resolveLiveAuthority: async () => ({ status: 'not_current', reason: 'identity_mismatch' }),
    })).resolves.toEqual({
      status: 'not_current',
      requestNonce: request.requestNonce,
      reason: 'identity_mismatch',
    });
  });

  it.each([
    ['missing', [], 'not_found'],
    ['terminal', [{ runId: 'run-one', happySessionId: 'session-one', intent: 'voice_agent', status: 'succeeded', pid: 41 }], 'terminal'],
    ['unwitnessed', [{ runId: 'run-one', happySessionId: 'session-one', intent: 'voice_agent', status: 'running', pid: 41 }], null],
  ] as const)('handles a %s Run through marker routing plus live authority', async (_label, markers, reason) => {
    await expect(resolveDaemonExecutionRunBrokerAuthority(request, {
      currentIdentity: { serverIdentityId: 'srv_home_one', accountId: 'account-one', machineId: 'machine-one' },
      listMarkers: async () => markers,
      isPidAlive: async () => true,
      resolveLiveAuthority: reason === null
        ? liveCurrent
        : async () => ({ status: 'not_current' as const, reason }),
    })).resolves.toEqual(reason === null
      ? expect.objectContaining({ status: 'current', occurrenceId: 'occurrence-one' })
      : { status: 'not_current', requestNonce: request.requestNonce, reason });
  });

  it('fails closed when the owning runtime process is gone', async () => {
    await expect(resolveDaemonExecutionRunBrokerAuthority(request, {
      currentIdentity: { serverIdentityId: 'srv_home_one', accountId: 'account-one', machineId: 'machine-one' },
      listMarkers: async () => [{
        runId: 'run-one', happySessionId: 'session-one', intent: 'voice_agent', status: 'running', pid: 41,
        executionRunBrokerAuthorityV1: { occurrenceId: 'occurrence-one', turnState: 'idle' },
      }],
      isPidAlive: async () => false,
      resolveLiveAuthority: liveCurrent,
    })).resolves.toEqual({ status: 'not_current', requestNonce: request.requestNonce, reason: 'runtime_unavailable' });
  });

  it('denies stale active marker authority after the live owner settled while its PID remains alive', async () => {
    await expect(resolveDaemonExecutionRunBrokerAuthority(request, {
      currentIdentity: { serverIdentityId: 'srv_home_one', accountId: 'account-one', machineId: 'machine-one' },
      listMarkers: async () => [{
        runId: 'run-one', happySessionId: 'session-one', intent: 'voice_agent', status: 'running', pid: 41,
        executionRunBrokerAuthorityV1: { occurrenceId: 'occurrence-one', turnState: 'active_turn' },
      }],
      isPidAlive: async () => true,
      resolveLiveAuthority: async () => ({ status: 'not_current', reason: 'terminal' }),
    })).resolves.toEqual({ status: 'not_current', requestNonce: request.requestNonce, reason: 'terminal' });
  });

  it('denies an old occurrence after the live owner replaced it even when the marker write failed', async () => {
    await expect(resolveDaemonExecutionRunBrokerAuthority(request, {
      currentIdentity: { serverIdentityId: 'srv_home_one', accountId: 'account-one', machineId: 'machine-one' },
      listMarkers: async () => [{
        runId: 'run-one', happySessionId: 'session-one', intent: 'voice_agent', status: 'running', pid: 41,
        executionRunBrokerAuthorityV1: { occurrenceId: 'occurrence-one', turnState: 'active_turn' },
      }],
      isPidAlive: async () => true,
      resolveLiveAuthority: async () => ({ status: 'not_current', reason: 'occurrence_mismatch' }),
    })).resolves.toEqual({ status: 'not_current', requestNonce: request.requestNonce, reason: 'occurrence_mismatch' });
  });

  it('fails closed when the live Session owner cannot be reached', async () => {
    await expect(resolveDaemonExecutionRunBrokerAuthority(request, {
      currentIdentity: { serverIdentityId: 'srv_home_one', accountId: 'account-one', machineId: 'machine-one' },
      listMarkers: async () => [{
        runId: 'run-one', happySessionId: 'session-one', intent: 'voice_agent', status: 'running', pid: 41,
      }],
      isPidAlive: async () => true,
      resolveLiveAuthority: async () => { throw new Error('socket unavailable'); },
    })).resolves.toEqual({ status: 'not_current', requestNonce: request.requestNonce, reason: 'runtime_unavailable' });
  });
});
