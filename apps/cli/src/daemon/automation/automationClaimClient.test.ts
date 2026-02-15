import { describe, expect, it, vi, beforeEach } from 'vitest';

const { axiosGet, axiosPost } = vi.hoisted(() => ({
  axiosGet: vi.fn(),
  axiosPost: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    get: axiosGet,
    post: axiosPost,
  },
}));

import { createAutomationClaimClient } from './automationClaimClient';

describe('createAutomationClaimClient', () => {
  beforeEach(() => {
    axiosGet.mockReset();
    axiosPost.mockReset();
  });

  it('fetches daemon assignments with auth headers and machine query', async () => {
    axiosGet.mockResolvedValue({ data: { assignments: [] } });

    const client = createAutomationClaimClient({ token: 'token-123' });
    await client.fetchAssignments('machine-1');

    expect(axiosGet).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/automations\/daemon\/assignments$/),
      expect.objectContaining({
        params: { machineId: 'machine-1' },
        timeout: 15_000,
        headers: expect.objectContaining({
          Authorization: 'Bearer token-123',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('claims runs with machine and lease parameters', async () => {
    axiosPost.mockResolvedValue({ data: { run: null, automation: null } });

    const client = createAutomationClaimClient({ token: 'token-abc' });
    await client.claimRun({ machineId: 'machine-2', leaseDurationMs: 45_000 });

    expect(axiosPost).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/automations\/runs\/claim$/),
      {
        machineId: 'machine-2',
        leaseDurationMs: 45_000,
      },
      expect.objectContaining({
        timeout: 15_000,
        headers: expect.objectContaining({
          Authorization: 'Bearer token-abc',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('sends lifecycle events to run-scoped endpoints', async () => {
    axiosPost.mockResolvedValue({ data: undefined });

    const client = createAutomationClaimClient({ token: 'token-z' });

    await client.startRun({ runId: 'run/1', machineId: 'm1' });
    await client.heartbeatRun({ runId: 'run/1', machineId: 'm1', leaseDurationMs: 12_000 });
    await client.succeedRun({ runId: 'run/1', machineId: 'm1', producedSessionId: 's1' });
    await client.failRun({ runId: 'run/1', machineId: 'm1', errorCode: 'x', errorMessage: 'y' });

    const calls = axiosPost.mock.calls.map((call) => call[0]);
    expect(calls).toEqual([
      expect.stringMatching(/\/v2\/automations\/runs\/run%2F1\/start$/),
      expect.stringMatching(/\/v2\/automations\/runs\/run%2F1\/heartbeat$/),
      expect.stringMatching(/\/v2\/automations\/runs\/run%2F1\/succeed$/),
      expect.stringMatching(/\/v2\/automations\/runs\/run%2F1\/fail$/),
    ]);
  });
});
