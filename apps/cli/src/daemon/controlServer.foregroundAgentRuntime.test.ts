import { describe, expect, it, vi } from 'vitest';

import {
  FOREGROUND_AGENT_RUNTIME_ADMISSION_PATH,
  FOREGROUND_AGENT_RUNTIME_CLAIM_PATH,
  FOREGROUND_AGENT_RUNTIME_RELEASE_PATH,
} from './agentRuntime/foregroundAdmissionContract';
import { createDaemonControlApp } from './controlServer';

describe('daemon control server: foreground Agent runtime admission', () => {
  it('keeps admit/release on daemon control authority and claim on its scoped capability', async () => {
    const admit = vi.fn(async () => ({
      ok: true as const,
      capability: {
        attemptId: 'attempt-1',
        admissionFilePath: '/private/admission.json',
        bootstrapFilePath: '/private/bootstrap.json',
        authorityFilePath: '/private/authority.json',
        descriptor: {
          v: 1 as const,
          pluginId: 'happier.agent.codex',
          pluginVersion: '1.0.0',
          agentId: 'codex',
          backendId: 'codex',
          generation: 'generation-1',
        },
      },
      launchPolicy: {
        reservedEnvironmentVariableNames: [],
        profileSecretRequirementNamesMissingBinding: [],
      },
    }));
    const claimEnvironment = vi.fn(async () => ({
      ok: true as const,
      environment: { PROVIDER_TOKEN: 'secret' },
      unsetEnvironmentVariableNames: [],
      sensitiveEnvironmentVariableNames: ['PROVIDER_TOKEN'],
    }));
    const release = vi.fn(async () => undefined);
    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine-1',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => undefined,
      onHappySessionWebhook: () => undefined,
      controlToken: 'control-token',
      foregroundAgentRuntimeAdmission: {
        admit,
        claimEnvironment,
        release,
      } as never,
    });
    const admissionPayload = {
      v: 1,
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      foregroundPid: 1234,
      directory: '/workspace',
      agentId: 'codex',
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
    } as const;

    const admitted = await app.inject({
      method: 'POST',
      url: FOREGROUND_AGENT_RUNTIME_ADMISSION_PATH,
      headers: { 'x-happier-daemon-token': 'control-token' },
      payload: admissionPayload,
    });
    expect(admitted.statusCode).toBe(200);
    expect(admit).toHaveBeenCalledWith({
      ...admissionPayload,
      machineId: 'machine-1',
    });

    const claimPayload = {
      v: 1,
      attemptId: 'attempt-1',
      provisionalSessionId: 'session-1',
      canonicalSessionId: 'session-1',
      foregroundPid: 1234,
      pluginId: 'happier.agent.codex',
      agentId: 'codex',
      generation: 'generation-1',
      capability: 'scoped-capability',
      foregroundSatisfiedProfileSecretRequirementNames: [],
    } as const;
    const rejectedControlClaim = await app.inject({
      method: 'POST',
      url: FOREGROUND_AGENT_RUNTIME_CLAIM_PATH,
      headers: { 'x-happier-daemon-token': 'control-token' },
      payload: claimPayload,
    });
    expect(rejectedControlClaim.statusCode).toBe(403);
    expect(claimEnvironment).not.toHaveBeenCalled();

    const claimed = await app.inject({
      method: 'POST',
      url: FOREGROUND_AGENT_RUNTIME_CLAIM_PATH,
      headers: {
        'x-happier-daemon-token': claimPayload.capability,
      },
      payload: claimPayload,
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimEnvironment).toHaveBeenCalledWith(claimPayload);

    const released = await app.inject({
      method: 'POST',
      url: FOREGROUND_AGENT_RUNTIME_RELEASE_PATH,
      headers: { 'x-happier-daemon-token': 'control-token' },
      payload: {
        v: 1,
        attemptId: 'attempt-1',
        sessionId: 'session-1',
      },
    });
    expect(released.statusCode).toBe(200);
    expect(release).toHaveBeenCalledWith('attempt-1', 'session-1');

    await app.close();
  });
});
