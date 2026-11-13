import { describe, expect, it, vi } from 'vitest';

import type { AgentBackend, AgentMessage, AgentMessageHandler, SessionId } from '@/agent/core/AgentBackend';
import { resolveExecutionRunIntentProfile } from '@/agent/executionRuns/profiles/intentRegistry';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createEncryptedRpcTestClient } from './encryptedRpc.testkit';
import { registerExecutionRunHandlers } from './executionRuns';

vi.mock('@/persistence', () => ({
  readCredentials: vi.fn(async () => null),
}));

const delegateOutput = JSON.stringify({ summary: 'Done.', deliverables: [] });

function createRecordingBackend(responseText: string): Readonly<{ backend: AgentBackend; prompts: string[] }> {
  let handler: AgentMessageHandler | null = null;
  const prompts: string[] = [];
  const backend: AgentBackend = {
    async startSession() {
      return { sessionId: 'child_session_1' as SessionId };
    },
    async sendPrompt(_sessionId: SessionId, prompt: string) {
      prompts.push(prompt);
      handler?.({ type: 'model-output', fullText: responseText } as AgentMessage);
    },
    async cancel() {},
    onMessage(next) {
      handler = next;
    },
    async dispose() {},
    async waitForResponseComplete() {},
  };
  return { backend, prompts };
}

const accountSettings = {
  // The display alias is presentation only: run roles, echoes and prompts keep the canonical name.
  sessionRoleProfilesV1: { v: 1, instructionsByRole: { reviewer: 'Account reviewer rules.' }, displayNamesByRole: { reviewer: 'QA Gate' } },
};

function createClient(options: Readonly<{
  responseText?: string;
  enqueueParentSessionInput?: (input: Readonly<{ text: string; meta: Record<string, unknown> }>) => Promise<void>;
}> = {}) {
  const recording = createRecordingBackend(options.responseText ?? delegateOutput);
  const createBackend = vi.fn(() => recording.backend);
  const client = createEncryptedRpcTestClient({
    scopePrefix: 'sess_1',
    registerHandlers: (rpc) => {
      registerExecutionRunHandlers(rpc, {
        sessionId: 'sess_1',
        cwd: process.cwd(),
        parentProvider: 'claude',
        createBackend,
        sendAcp: () => {},
        resolveAccountSettings: () => accountSettings,
        ...(options.enqueueParentSessionInput ? { enqueueParentSessionInput: options.enqueueParentSessionInput } : {}),
      });
    },
  });
  return { client, createBackend, prompts: recording.prompts };
}

const hiddenStart = {
  intent: 'delegate',
  backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
  instructions: 'Implement it.',
  permissionMode: 'workspace_write',
  retentionPolicy: 'ephemeral',
  runClass: 'bounded',
  ioMode: 'request_response',
} as const;

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('execution.run.start rejects v2-only fields (fail closed, no fallback)', () => {
  it.each([
    ['visibility', { visibility: 'session' }, 'execution_run_visibility_unsupported'],
    ['explicit hidden visibility', { visibility: 'hidden' }, 'execution_run_visibility_unsupported'],
    ['targetSessionId', { targetSessionId: 'child' }, 'execution_run_visibility_unsupported'],
    ['role', { role: 'worker' }, 'execution_run_role_unsupported'],
    ['roleSource', { roleSource: 'explicit' }, 'execution_run_role_unsupported'],
  ] as const)('execution.run.start rejects %s without starting a run', async (_case, extra, errorCode) => {
    const { client, createBackend } = createClient();
    const res = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, { ...hiddenStart, ...extra });
    expect(res).toEqual(expect.objectContaining({ ok: false, errorCode }));
    expect(createBackend).not.toHaveBeenCalled();
    const listed = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_LIST, {});
    expect(listed.runs ?? []).toHaveLength(0);
  });

  it('execution.run.ensureOrStart rejects v2-only fields in its embedded start', async () => {
    const { client, createBackend } = createClient();
    const res = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START, {
      start: { ...hiddenStart, role: 'worker', roleSource: 'explicit' },
    });
    expect(res).toEqual(expect.objectContaining({ ok: false, errorCode: 'execution_run_role_unsupported' }));
    expect(createBackend).not.toHaveBeenCalled();
  });

  it('keeps a hidden roleless start byte-identical: the backend receives exactly the profile prompt', async () => {
    const { client, prompts } = createClient();
    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START, hiddenStart);
    expect(started.runId).toMatch(/^run_/);
    await settle();
    const profile = resolveExecutionRunIntentProfile('delegate');
    expect(prompts[0]).toBe(profile.buildPrompt({
      sessionId: 'sess_1', runId: started.runId, callId: started.callId, sidechainId: started.sidechainId,
      intent: 'delegate', backendId: 'claude', backendTarget: hiddenStart.backendTarget, instructions: hiddenStart.instructions,
      permissionMode: hiddenStart.permissionMode, retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response', startedAtMs: 0,
    }));
    expect(prompts[0]).not.toContain('Current run role:');
    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run.role).toBeUndefined();
    expect(got.run.visibility).toBeUndefined();
  });
});

describe('execution.run.start.v2', () => {
  it('starts a hidden role-bearing run with the catalog role snapshot, echo, run-scoped prompt, readback, and completion role', async () => {
    const enqueued: Array<Readonly<{ text: string; meta: Record<string, unknown> }>> = [];
    const { client, prompts } = createClient({
      responseText: JSON.stringify({ findings: [], summary: 'No findings.' }),
      enqueueParentSessionInput: async (input) => {
        enqueued.push(input);
      },
    });
    const started = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, {
      ...hiddenStart,
      intent: 'review',
      instructions: 'Review the plan.',
      permissionMode: 'read_only',
      retentionPolicy: 'resumable',
      notifyParentOnCompletion: true,
      visibility: 'hidden',
      role: 'reviewer',
      roleSource: 'explicit',
    });
    expect(started).toEqual(expect.objectContaining({
      runId: expect.stringMatching(/^run_/),
      visibility: 'hidden',
      binding: null,
      linkedSessionId: null,
      role: { id: 'reviewer', name: 'Reviewer', assignmentId: expect.any(String) },
      roleSource: 'explicit',
      permissionMode: 'read_only',
      modelId: null,
    }));
    await settle();
    expect(prompts[0]!.startsWith('Current run role: Reviewer\n\nAccount reviewer rules.\n\n')).toBe(true);
    expect(prompts[0]).not.toContain('QA Gate');
    expect(prompts[0]).toContain('Review the plan.');

    const got = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_GET, { runId: started.runId });
    expect(got.run).toEqual(expect.objectContaining({
      visibility: 'hidden',
      role: { id: 'reviewer', name: 'Reviewer', assignmentId: started.role.assignmentId },
      roleSource: 'explicit',
    }));
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.text).toContain('Role: Reviewer');
  });

  it('fails closed for a role missing from the hosting account catalog and for project_lead', async () => {
    const { client, createBackend } = createClient();
    const missing = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, {
      ...hiddenStart,
      visibility: 'hidden',
      role: 'custom:0b8f1a2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c',
      roleSource: 'explicit',
    });
    expect(missing).toEqual(expect.objectContaining({ ok: false, errorCode: 'execution_run_role_unsupported' }));
    const lead = await client.call<any, any>(SESSION_RPC_METHODS.EXECUTION_RUN_START_V2, {
      ...hiddenStart,
      visibility: 'hidden',
      role: 'project_lead',
      roleSource: 'explicit',
    });
    expect(lead).toEqual(expect.objectContaining({ ok: false }));
    expect(createBackend).not.toHaveBeenCalled();
  });
});
