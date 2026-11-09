import { Console } from 'node:console';
import { PassThrough } from 'node:stream';
import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { SessionTurnMutationV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { projectSessionSummaryV1, SessionStatusResultSchema } from '@happier-dev/protocol/sessions/control/contract';

import { createPiAgentRuntime } from '../../../../../packages/plugins/pi/src/agent/runtime/engine.js';
import { PI_OPENAI_CODEX_REQUEST_AUTH_PURPOSE_ID } from '../../../../../packages/plugins/pi/src/agent/auth/services/requestAuth/purposes.js';
import { sanitizeNativeAgentSessionBoundaryError } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionBoundaryError';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle';
import { reportSessionRunnerFailure } from '@/cli/resolveSessionRunnerFailureExitCode';
import { readSessionRunnerFailureCause } from '@/session/shared/spawnSessionContract';
import { logger } from '@/ui/logger';
import { deliverSessionTurnMutation } from '@/api/session/client/transport/mutations/deliverSessionTurnMutation';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { projectSessionSpawnFailure } from './projectSessionSpawnFailure';

vi.mock('axios');

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
      sanitizedPreview: expect.stringMatching(/choose.*model/iu),
      failureCause: { phase: 'client_start', failureReason: 'model_selection_required', retryable: false } });
    const mutations: unknown[] = [];
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: createAccountEncryptionCurrentnessFixture({ mode: 'e2ee' }) });
    const lifecycle = createSessionTurnLifecycle({ session: { sessionId: 'c1234567890123456789012345',
      enqueueSessionTurnMutation: async mutation => {
        const delivered = await deliverSessionTurnMutation({ token: 'token', mutation,
          // Only the authenticated Home transport is substituted. Keep public
          // diagnostic privacy projection, strict decoding and status reading real.
          socket: { connected: true, emit: vi.fn(), emitWithAck: async (_event: string, payload: unknown) => {
            const published = SessionTurnMutationV1Schema.parse(payload);
            mutations.push(published);
            return { ok: true, receipt: { v: published.v, sessionId: published.sessionId, mutationId: published.mutationId,
              ...('turnId' in published && published.turnId ? { turnId: published.turnId } : {}),
              action: published.action, decision: 'applied', observedAt: published.observedAt, appliedAt: published.observedAt } };
          } },
        });
        expect(delivered).toEqual({ delivered: true, path: 'socket' });
      },
    } });
    try { await lifecycle.failTurn({ issue, allocateWhenIdle: true }); }
    finally { lifecycle.dispose(); }
    expect(mutations).toContainEqual(expect.objectContaining({ action: 'fail', issue: expect.objectContaining({
      code: issue.code, sanitizedPreview: issue.sanitizedPreview, failureCause: issue.failureCause,
    }) }));
    const publishedFailure = mutations.map(mutation => SessionTurnMutationV1Schema.parse(mutation))
      .find(mutation => mutation.action === 'fail');
    if (publishedFailure?.action !== 'fail') throw new Error('Missing public failure');
    const status = SessionStatusResultSchema.parse({ session: projectSessionSummaryV1({
      row: createSessionRecordFixture({ id: publishedFailure.sessionId, lastRuntimeIssue: publishedFailure.issue }),
      metadata: null, encryption: null,
    }) });
    expect(status.session.lastRuntimeIssue).toMatchObject({ sanitizedPreview: issue.sanitizedPreview,
      failureCause: { failureReason: 'model_selection_required', retryable: false } });

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
    expect(failureCause).toMatchObject({ code: issue.code, failureReason: 'model_selection_required', retryable: false });
    const result = SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: 'spawn_failed', errorMessage: 'Session launch failed',
      errorDetail: { kind: 'launch_error', code: 'spawn_failed', message: 'Session launch failed', failureCause },
    }));
    expect(result).toMatchObject({ type: 'error', retryable: false,
      launchError: { code: issue.code, message: issue.sanitizedPreview, failureCause } });
    expect(context.services.exec.clients.spawn).not.toHaveBeenCalled();
  });
});
