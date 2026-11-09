import { Console } from 'node:console';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { SessionTurnMutationV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';

import { createPiAgentRuntime } from '../../../../../packages/plugins/pi/src/agent/runtime/engine.js';
import { PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID } from '../../../../../packages/plugins/pi/src/agent/auth/services/requestAuth/purposes.js';
import { sanitizeNativeAgentSessionBoundaryError } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { reportSessionRunnerFailure } from '@/cli/resolveSessionRunnerFailureExitCode';
import { readSessionRunnerFailureCause } from '@/session/shared/spawnSessionContract';
import { logger } from '@/ui/logger';
import { projectSessionSpawnFailure } from './projectSessionSpawnFailure';

describe('Pi Connected Account default refusal', () => {
  it('retains model-pick guidance through native startup, durable status and launch Action projection', async () => {
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    // The Connected Account and OS adapters are genuine host boundaries. Keep the
    // Pi preparation, refusal, host classifiers and persistence writer real.
    const context = {
      signal: new AbortController().signal,
      services: {
        connectedAccounts: {
          watch(_purpose: string, callback: () => void) { callback(); return { dispose() {} }; },
          async getBinding(purpose: string) { return purpose === PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID
            ? { purpose, service, account: { service, accountId: 'primary' }, target: { kind: 'account', displayName: 'Primary' } }
            : null; },
        },
        exec: { clients: { spawn: vi.fn(() => { throw new Error('Default model must not start native Pi'); }) } },
      },
    } as unknown as AgentSessionRuntimeContext;
    const failure = await createPiAgentRuntime().sessions.open({
      kind: 'create', sessionId: 'pi-default-refusal', cwd: '/workspace',
      configuration: { mode: { value: null, updatedAtMs: 0 }, model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: 'read-only', updatedAtMs: 0 }, options: {} },
    }, context).catch((error: unknown) => sanitizeNativeAgentSessionBoundaryError(error, true));
    const issue = classifyPrimarySessionRuntimeIssue({ cause: 'session_error', provider: 'pi', error: failure });
    expect(issue).toMatchObject({ code: 'agent_startup_model_reconciliation_failed',
      sanitizedPreview: expect.stringMatching(/model selection.*retry/iu) });
    const mutations: unknown[] = [];
    const lifecycle = createSessionTurnLifecycle({ session: { sessionId: 'c1234567890123456789012345',
      enqueueSessionTurnMutation: async mutation => { mutations.push(SessionTurnMutationV1Schema.parse(mutation)); },
    } });
    try { await lifecycle.failTurn({ issue, allocateWhenIdle: true }); }
    finally { lifecycle.dispose(); }
    expect(mutations).toContainEqual(expect.objectContaining({ action: 'fail', issue: expect.objectContaining({
      code: issue.code, sanitizedPreview: issue.sanitizedPreview,
    }) }));

    const stderr = new PassThrough();
    let output = '';
    stderr.on('data', chunk => { output += String(chunk); });
    const writer = new Console({ stdout: stderr, stderr });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(writer.error.bind(writer));
    const file = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const fatal = vi.spyOn(logger, 'fatal').mockImplementation(() => {});
    try { expect(reportSessionRunnerFailure(failure)).toBe(1); }
    finally { consoleError.mockRestore(); file.mockRestore(); fatal.mockRestore(); stderr.end(); }
    const failureCause = readSessionRunnerFailureCause(output);
    expect(failureCause).toMatchObject({ code: issue.code });
    const result = SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: 'spawn_failed', errorMessage: 'Session launch failed',
      errorDetail: { kind: 'launch_error', code: 'spawn_failed', message: 'Session launch failed', failureCause },
    }));
    expect(result).toMatchObject({ type: 'error', launchError: { code: issue.code, failureCause } });
    expect(context.services.exec.clients.spawn).not.toHaveBeenCalled();
  });
});
