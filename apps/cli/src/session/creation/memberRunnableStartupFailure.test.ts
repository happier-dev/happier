import { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { normalizeSpawnSessionNonceResolution } from '@happier-dev/protocol/sessions/spawnSessionNonce';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { resolveAgentDisplayTitle } from '@/agent/catalog/agentDisplayTitle';
import { awaitTrackedRunnerAgentSessionOpen } from '@/daemon/agentRuntime/runnerAgentSessionOpenAttestation';
import type { TrackedSession } from '@/daemon/types';
import { projectSessionSpawnFailure } from './projectSessionSpawnFailure';

describe('member-runnable Agent startup refusal', () => {
  it.each(['preflight', 'native'] as const)('keeps the trusted Agent identity through %s nonce settlement', phase => {
    const settled = normalizeSpawnSessionNonceResolution({ status: 'error', agentId: 'codex',
      errorCode: phase === 'preflight' ? 'SPAWN_VALIDATION_FAILED' : 'SPAWN_FAILED',
      errorMessage: phase === 'preflight' ? 'agent_cli_not_runnable' : 'PRIVATE_RUNTIME',
      ...(phase === 'native' ? { errorDetail: { kind: 'launch_error', code: 'agent_cli_not_runnable',
        message: 'PRIVATE_RUNTIME' } } : {}),
    });
    expect(settled).toMatchObject({ status: 'error', agentId: 'codex' });
    if (settled.status !== 'error') throw new Error('Expected settled refusal');
    const result = projectSessionSpawnFailure(settled);
    expect(result).toMatchObject({ retryable: false, launchError: { code: 'agent_cli_not_runnable' } });
    if (result.code !== 'spawn_failed') throw new Error('Expected spawn failure');
    expect(result.launchError?.message).toContain(resolveAgentDisplayTitle('codex'));
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
  });
  it('publishes only the selected Agent title and managed-runtime remedy', () => {
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'codex',
      error: new PluginError({ code: 'agent_cli_not_runnable', retryable: false,
        message: 'PRIVATE_ACCOUNT /private/runtime', details: { agentId: 'PRIVATE_AGENT', remedy: 'PRIVATE_TOKEN' } }),
      occurredAt: 101 });
    expect(issue).toMatchObject({ code: 'agent_cli_not_runnable', source: 'dependency_failure', agentId: 'codex' });
    expect(resolveAgentDisplayTitle('codex')).toBeTruthy();
    expect(issue.sanitizedPreview).toContain(resolveAgentDisplayTitle('codex'));
    expect(issue.sanitizedPreview).toMatch(/install.*managed runtime/iu);
    expect(JSON.stringify(issue)).not.toContain('PRIVATE_');
  });

  it.each(['current', 'predecessor', 'foreign-source'] as const)(
    'retains the refusal only from the %s runner through the public launch result', async age => {
      // Child exit is an OS fact. Classification, attribution and projection are real owners.
      const childProcess = new ChildProcess();
      Object.defineProperty(childProcess, 'exitCode', { value: 1 });
      const tracked: TrackedSession = { pid: 123, startedBy: 'daemon', happySessionId: 'member-session',
        processStartTimeMs: 100, processCommandHash: 'a'.repeat(64), childProcess };
      const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'codex',
        error: { code: 'agent_cli_not_runnable' }, occurredAt: age === 'predecessor' ? 99 : 101 });
      const observed = await awaitTrackedRunnerAgentSessionOpen({ sessionId: 'member-session',
        getTrackedSessions: () => [tracked], readStartupFailure: async () => age === 'foreign-source'
          ? { ...issue, source: 'auth_error' } : issue, timeoutMs: null });
      expect(observed).toEqual(age === 'current' ? { status: 'runner_exited', code: 'agent_cli_not_runnable' }
        : { status: 'runner_exited' });
      if (age !== 'current') return;
      const result = SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({ errorCode: 'SPAWN_VALIDATION_FAILED',
        errorMessage: 'agent_cli_not_runnable', agentId: 'codex' }));
      expect(result).toMatchObject({ type: 'error', code: 'spawn_failed', retryable: false,
        launchError: { code: 'agent_cli_not_runnable' } });
      if (result.type !== 'error' || result.code !== 'spawn_failed') throw new Error('Expected refusal');
      expect(result.launchError?.message).toContain(resolveAgentDisplayTitle('codex'));
      expect(result.launchError?.message).toMatch(/install.*managed runtime/iu);
    });
});
