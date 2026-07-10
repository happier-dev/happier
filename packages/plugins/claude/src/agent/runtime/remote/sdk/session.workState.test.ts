import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  SessionMetadataWriteRequestV1,
  SessionSystemRecordReadRequestV1,
  SessionSystemRecordReadResultV1,
  SessionSystemRecordWriteRequestV1,
} from '@happier-dev/plugin-sdk';

import {
  createEventsFixture,
  createPluginContextFixture,
  createSdkExecFixture,
  createTerminalHostFixture,
  expectRuntimeEnvelope,
} from '../../engine.testkit.js';
import { getClaudeProjectPath } from '../../../surfaces/sessions/handoff/path.js';
import { bindClaudeAgentSdkFallbackSession, createClaudeAgentSdkTurnOperations } from './session.js';

/**
 * Agent-SDK runner parity for goals + Dynamic Workflows.
 *
 * The SDK runner consumes the live `query()` `SDKMessage` stream (workflow activity + the
 * system-init `/goal` capability) and side-follows the persisted transcript JSONL for the
 * file-only `goal_status` attachments. These tests assert the work-state ingress lands through
 * the real workflow/goal runtimes and the host record/metadata writers.
 */

const TWO_AGENT_PROGRESS: unknown[] = [
  { type: 'workflow_phase', index: 1, title: 'Research' },
  { type: 'workflow_phase', index: 2, title: 'Implementation' },
  { type: 'workflow_agent', agentId: 'agent_1', label: 'web_search', phaseIndex: 1, phaseTitle: 'Research', state: 'done' },
  { type: 'workflow_agent', agentId: 'agent_2', label: 'coder', phaseIndex: 2, phaseTitle: 'Implementation', state: 'running' },
];

function applyMetadataWrite(
  current: Record<string, unknown>,
  request: SessionMetadataWriteRequestV1,
): Record<string, unknown> {
  if (request.kind === 'set') return { ...request.metadata };
  return { ...request.handler(current) };
}

describe('Claude agent-SDK session work-state ingress', () => {
  it('publishes a Dynamic Workflow run (phases/agents) from the SDK stream and binds the host writers', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const systemRecords: SessionSystemRecordWriteRequestV1[] = [];
    let metadata: Record<string, unknown> = {};
    let persistedRunRecord: SessionSystemRecordReadResultV1 | null = {
      namespace: 'activity',
      kind: 'workflow_run.v1',
      localId: 'activity:workflow_run:v1:wf-tool-1',
      payload: {
        v: 1,
        projectionVersion: 1,
        runId: 'wf-tool-1',
        backendId: 'claude',
        agentId: 'claude',
        title: 'Implement Feature',
        status: 'active',
        workflowToolUseId: 'wf-tool-1',
        recordRevision: '7',
        updatedAt: 1,
        totalAgents: 0,
        completedAgents: 0,
        phases: [],
        agents: [],
      },
    };
    const writeSystemRecord = vi.fn(async (request: SessionSystemRecordWriteRequestV1) => {
      systemRecords.push(request);
      persistedRunRecord = {
        namespace: request.namespace,
        kind: request.kind,
        localId: request.localId,
        payload: request.payload,
      };
    });
    const writeMetadata = vi.fn(async (request: SessionMetadataWriteRequestV1) => {
      metadata = applyMetadataWrite(metadata, request);
    });
    const readSystemRecord = vi.fn(async (
      request: SessionSystemRecordReadRequestV1,
    ): Promise<SessionSystemRecordReadResultV1 | null> => (
      request.localId === persistedRunRecord?.localId ? persistedRunRecord : null
    ));
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionWriteSystemRecord: writeSystemRecord,
      sessionReadSystemRecord: readSystemRecord,
      sessionWriteMetadata: writeMetadata,
    });

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        sessionId: 'happy-session-1',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('run a workflow');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      await exec.emit({ type: 'system', subtype: 'init', session_id: 'claude-session-1' });
      await exec.emit({
        type: 'assistant',
        session_id: 'claude-session-1',
        uuid: 'uuid-wf-1',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'wf-tool-1',
            name: 'Workflow',
            input: { script: "export const meta = { name: 'Implement Feature' }" },
          }],
        },
      });
      await exec.emit({
        type: 'system',
        subtype: 'task_progress',
        task_id: 'w1',
        tool_use_id: 'wf-tool-1',
        task_type: 'local_workflow',
        session_id: 'claude-session-1',
        workflow_progress: TWO_AGENT_PROGRESS,
      });
      await exec.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'claude-session-1',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await runtime.waitForTurnCompletion();

      await vi.waitFor(() => {
        expect(writeSystemRecord).toHaveBeenCalled();
      });

      // Record FIRST: a durable activity/workflow_run.v1 record keyed by the run id; the latest
      // write for the run carries the parsed phases and agents from the progress event.
      await vi.waitFor(() => {
        const latest = [...systemRecords].reverse().find((record) => record.localId.includes('wf-tool-1'));
        expect((latest?.payload as { totalAgents?: number } | undefined)?.totalAgents).toBe(2);
      });
      const runRecord = [...systemRecords].reverse().find((record) => record.localId.includes('wf-tool-1'));
      expect(runRecord?.namespace).toBe('activity');
      expect(runRecord?.kind).toBe('workflow_run.v1');
      const snapshot = runRecord?.payload as {
        runId: string;
        totalAgents: number;
        phases: unknown[];
        agents: unknown[];
      };
      expect(snapshot.totalAgents).toBe(2);
      expect(snapshot.phases).toHaveLength(2);
      expect(snapshot.agents).toHaveLength(2);
      // The SDK path observes the Workflow start and then the progress event as two material
      // changes, so a persisted revision 7 advances monotonically to the latest revision 9.
      expect(snapshot).toMatchObject({ recordRevision: '9' });
      expect(readSystemRecord).toHaveBeenCalledWith({
        namespace: 'activity',
        localId: 'activity:workflow_run:v1:wf-tool-1',
        reason: 'claude_workflow_activity_record_readback',
      });

      // Headline SECOND: the locked metadata key points at the run.
      await vi.waitFor(() => {
        const currentHeadline = metadata.sessionWorkflowActivityHeadlineV1 as
          | { activeRuns: Array<{ runId: string; totalAgents: number }> }
          | undefined;
        expect(currentHeadline?.activeRuns?.[0]?.totalAgents).toBe(2);
      });
      const headline = metadata.sessionWorkflowActivityHeadlineV1 as
        | { activeRuns: Array<{ runId: string; totalAgents: number }> }
        | undefined;
      expect(headline?.activeRuns?.[0]?.runId).toBe('wf-tool-1');
      expect(headline?.activeRuns?.[0]?.totalAgents).toBe(2);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('flips a workflow run terminal on a system task_notification(status:completed)', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const systemRecords: SessionSystemRecordWriteRequestV1[] = [];
    const writeSystemRecord = vi.fn(async (request: SessionSystemRecordWriteRequestV1) => {
      systemRecords.push(request);
    });
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionWriteSystemRecord: writeSystemRecord,
      sessionWriteMetadata: vi.fn(async () => undefined),
    });

    const sessionRuntime = await bindClaudeAgentSdkFallbackSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        sessionId: 'happy-session-1',
        permissionMode: 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('run a workflow');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      await exec.emit({ type: 'system', subtype: 'init', session_id: 'claude-session-1' });
      await exec.emit({
        type: 'assistant',
        session_id: 'claude-session-1',
        uuid: 'uuid-wf-1',
        message: {
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: 'wf-tool-1',
            name: 'Workflow',
            input: { script: "export const meta = { name: 'Implement Feature' }" },
          }],
        },
      });
      await exec.emit({
        type: 'system',
        subtype: 'task_progress',
        task_id: 'w1',
        tool_use_id: 'wf-tool-1',
        task_type: 'local_workflow',
        session_id: 'claude-session-1',
        workflow_progress: TWO_AGENT_PROGRESS,
      });
      await exec.emit({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'w1',
        tool_use_id: 'wf-tool-1',
        session_id: 'claude-session-1',
        status: 'completed',
        summary: 'workflow finished',
      });
      await exec.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'claude-session-1',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await runtime.waitForTurnCompletion();

      await vi.waitFor(() => {
        const last = [...systemRecords].reverse().find((record) => record.localId.includes('wf-tool-1'));
        expect((last?.payload as { status?: string } | undefined)?.status).toBe('complete');
      });
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('surfaces the goal work-state item from a goal_status attachment tailed off the persisted transcript JSONL', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();

    const providerSessionId = 'claude-provider-session-goal';
    const baseDir = await mkdtemp(join(tmpdir(), 'claude-sdk-goal-'));
    const configDir = join(baseDir, '.claude');
    const cwd = join(baseDir, 'project');
    await mkdir(cwd, { recursive: true });
    const transcriptPath = join(getClaudeProjectPath(cwd, configDir), `${providerSessionId}.jsonl`);
    await mkdir(dirname(transcriptPath), { recursive: true });
    const goalRow = {
      type: 'attachment',
      uuid: 'goal-row-1',
      sessionId: providerSessionId,
      attachment: { type: 'goal_status', met: false, condition: 'Ship the SDK goal parity' },
    };
    await writeFile(transcriptPath, `${JSON.stringify(goalRow)}\n`, 'utf8');

    let metadata: Record<string, unknown> = {};
    const writeMetadata = vi.fn(async (request: SessionMetadataWriteRequestV1) => {
      metadata = applyMetadataWrite(metadata, request);
    });
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
      sessionWriteMetadata: writeMetadata,
    });

    const sessionRuntime = createClaudeAgentSdkTurnOperations({
      ctx,
      directory: cwd,
      launchEnv: { CLAUDE_CONFIG_DIR: configDir },
      permissionMode: 'default',
      happierSessionId: 'happy-session-goal',
      publishTranscriptMessages: true,
      enableSessionWorkState: true,
    });
    const runtime = expectRuntimeEnvelope(sessionRuntime).operations;

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('set a goal');
      await vi.waitFor(() => {
        expect(exec.spawnClient).toHaveBeenCalledTimes(1);
      });

      // Learning the provider session id arms the narrow goal_status JSONL tail.
      await exec.emit({ type: 'system', subtype: 'init', session_id: providerSessionId });

      await vi.waitFor(() => {
        expect(writeMetadata).toHaveBeenCalled();
        const workState = metadata.sessionWorkStateV1 as
          | { items?: Array<{ id: string; kind: string }> }
          | undefined;
        const goalItem = workState?.items?.find((item) => item.id === 'goal:claude');
        expect(goalItem?.kind).toBe('goal');
      });

      await exec.emit({
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: providerSessionId,
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 10,
        duration_api_ms: 8,
      });
      await runtime.waitForTurnCompletion();
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });
});
