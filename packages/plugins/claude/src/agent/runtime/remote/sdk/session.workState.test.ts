import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type {
  SessionSystemRecordReadRequestV1,
  SessionSystemRecordReadResultV1,
  SessionSystemRecordWriteRequestV1,
} from '@happier-dev/agents';
import {
  SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY,
  type SessionActivityHeadlineBundleV1,
  type SessionWorkStateV1,
} from '@happier-dev/plugin-sdk/sessions/work-state';

import {
  createEventsFixture,
  createPluginContextFixture,
  createSdkExecFixture,
  createSessionHooksFixture,
  createTerminalHostFixture,
  expectRuntimeEnvelope,
} from '../../engine.testkit.js';
import { getClaudeProjectPath } from '../../../surfaces/sessions/handoff/path.js';
import { createClaudeNativeSessionRuntimeFromOperations } from '../../nativeRuntime.js';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { createClaudeAgentSdkTurnOperations as createClaudeAgentSdkProviderOperations } from './session.js';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { AgentSessionRuntimeEvent } from '@happier-dev/protocol/runtime';
import { bindClaudeAgentSdkFallbackSession, createClaudeAgentSdkTurnOperations } from './session.testkit.js';

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
    const publishHeadline = vi.fn(async (bundle: SessionActivityHeadlineBundleV1) => {
      // One mutation, both keys — the same merge the host performs.
      metadata = {
        ...metadata,
        sessionWorkflowActivityHeadlineV1: bundle.workflow,
        [SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY]: bundle.agentActivity,
      };
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
      sessionPublishWorkflowHeadline: publishHeadline,
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
      sessionPublishWorkflowHeadline: vi.fn(async () => undefined),
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

    const goalSnapshots: SessionWorkStateV1[] = [];
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      exec: exec.service,
    });

    const sessionRuntime = createClaudeAgentSdkTurnOperations({
      ctx,
      directory: cwd,
      launchEnv: { CLAUDE_CONFIG_DIR: configDir },
      permissionMode: 'default',
      happierSessionId: 'happy-session-goal',
      publishTranscriptMessages: true,
      enableSessionWorkState: true,
      publishGoalWorkState: (snapshot) => { goalSnapshots.push(snapshot); },
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
        const workState = goalSnapshots.at(-1);
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


describe('SDK workflow hook resumption', () => {
  it('publishes unknown when required ordered history fails and preserves the admission error', async () => {
    const terminalHost = createTerminalHostFixture();
    const exec = createSdkExecFixture();
    const sessionHooks = createSessionHooksFixture();
    const baselineFailure = new Error('required history unavailable');
    const baseCtx = createPluginContextFixture(terminalHost.service, createEventsFixture().service);
    const ctx = createPluginContextFixture(terminalHost.service, createEventsFixture().service, {
      exec: exec.service, sessionHooks: sessionHooks.service,
      transcripts: { ...baseCtx.agentRuntime.transcripts,
        followSource: vi.fn(async () => { throw baselineFailure; }) },
    });
    const runtime = createClaudeAgentSdkProviderOperations({
      ctx, directory: '/tmp/claude-project', happierSessionId: 'happy-sdk-history-failed',
      launchEnv: {}, permissionMode: 'default', enableSessionWorkState: true, enableSessionResumability: true,
    });
    // Host service registration is an external boundary; the native adapter and ledger stay real.
    const context = { session: { services: {
      activeInput: { bind: () => ({ dispose() {} }) },
      models: { bind: () => ({ dispose() {} }) },
    } } } as unknown as AgentSessionRuntimeContext;
    const session = createClaudeNativeSessionRuntimeFromOperations(runtime, {
      kind: 'create', sessionId: 'happy-sdk-history-failed', cwd: '/tmp/claude-project',
    }, context);
    const activityEvents: AgentSessionRuntimeEvent[] = [];
    const subscription = session.watch(event => activityEvents.push(event));
    try {
      runtime.beginProviderTurn('sdk-resume');
      await runtime.sendProviderTurnPrompt('resume workers');
      await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledTimes(1));
      const hookRequest = sessionHooks.service.startServer.mock.calls[0]?.[0];
      if (!hookRequest?.onSessionHook) throw new Error('session hook server was not started');
      await expect(hookRequest.onSessionHook('claude-provider-session-1', {
        hook_event_name: 'SessionStart', session_id: 'claude-provider-session-1', source: 'resume',
        transcript_path: '/tmp/claude-provider-session-1.jsonl',
      })).rejects.toBe(baselineFailure);
      await vi.waitFor(() => expect(activityEvents.at(-1)).toMatchObject({
        kind: 'runtime-activity-snapshot', state: 'unknown', activeCount: 0,
      }));
    } finally { subscription.dispose(); await session.dispose(); }
  });

  it('reconciles a native restart received before ordered SDK resume history', async () => {
    const terminalHost = createTerminalHostFixture();
    const exec = createSdkExecFixture();
    const sessionHooks = createSessionHooksFixture();
    const records: unknown[] = [];
    let replayHistory: (() => Promise<void>) | undefined;
    const baseCtx = createPluginContextFixture(terminalHost.service, createEventsFixture().service);
    const ctx = createPluginContextFixture(terminalHost.service, createEventsFixture().service, {
      exec: exec.service, sessionHooks: sessionHooks.service,
      transcripts: { ...baseCtx.agentRuntime.transcripts, followSource: vi.fn(async () => {
        await replayHistory?.();
        return { dispose: vi.fn(async () => undefined) };
      }) },
      sessionWriteSystemRecord: vi.fn(async (request: SessionSystemRecordWriteRequestV1) => { records.push(request.payload); }),
    });
    const runtime = createClaudeAgentSdkProviderOperations({
      ctx, directory: '/tmp/claude-project', happierSessionId: 'happy-sdk-ordered-history',
      launchEnv: {}, permissionMode: 'default', enableSessionWorkState: true, enableSessionResumability: true,
    });
    // Host registration services are genuine boundaries; the SDK operations and adapter stay real.
    const context = { session: { services: {
      activeInput: { bind: () => ({ dispose() {} }) },
      models: { bind: () => ({ dispose() {} }) },
    } } } as unknown as AgentSessionRuntimeContext;
    const session = createClaudeNativeSessionRuntimeFromOperations(runtime, {
      kind: 'create', sessionId: 'happy-sdk-ordered-history', cwd: '/tmp/claude-project',
    }, context);
    const activityEvents: AgentSessionRuntimeEvent[] = [];
    const subscription = session.watch(event => activityEvents.push(event));
    try {
      runtime.beginProviderTurn('sdk-resume');
      await runtime.sendProviderTurnPrompt('resume workers');
      await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledTimes(1));
      const hookRequest = sessionHooks.service.startServer.mock.calls[0]?.[0] as Readonly<{
        onSessionHook?: (providerSessionId: string, payload: Readonly<Record<string, unknown>>) => void | Promise<void>;
      }> | undefined;
      if (!hookRequest?.onSessionHook) throw new Error('session hook server was not started');
      const rows: JsonValue[] = [{
        type: 'assistant', session_id: 'claude-provider-session-1', uuid: 'sdk-history-start', timestamp: '2026-01-02T03:04:05.000Z',
        message: { content: ['a', 'b'].map(id => ({ type: 'tool_use', id, name: 'Agent', input: { description: id } })) },
      }];
      for (const id of ['a', 'b']) rows.push({
        type: 'user', session_id: 'claude-provider-session-1', uuid: `sdk-history-alias-${id}`, timestamp: '2026-01-02T03:04:06.000Z',
        message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'launched' }] },
        toolUseResult: { status: 'async_launched', agentId: `native-${id}` },
      }, {
        type: 'user', session_id: 'claude-provider-session-1', uuid: `sdk-history-complete-${id}`, timestamp: '2026-01-02T03:04:07.000Z',
        origin: { kind: 'task-notification' },
        message: { content: `<task-notification><task-id>native-${id}</task-id><status>completed</status></task-notification>` },
      });
      replayHistory = async () => {
        await hookRequest.onSessionHook?.('claude-provider-session-1', {
          hook_event_name: 'SubagentStart', session_id: 'claude-provider-session-1', agent_id: 'native-a',
        });
        for (const [index, row] of rows.entries()) await session.observeSourceTranscript?.({
          providerSessionId: 'claude-provider-session-1', sourceId: `sdk-history:${index}`, row, phase: 'initial_replay',
        });
        expect(activityEvents.some(event => event.kind === 'runtime-activity-snapshot' && event.state === 'active')).toBe(false);
        expect(records).toHaveLength(0);
      };
      await hookRequest.onSessionHook('claude-provider-session-1', {
        hook_event_name: 'SessionStart', session_id: 'claude-provider-session-1', source: 'resume',
        transcript_path: '/tmp/claude-provider-session-1.jsonl',
      });
      await vi.waitFor(() => expect(activityEvents.at(-1)).toMatchObject({ state: 'active', activeCount: 1 }));
      await vi.waitFor(() => expect(records.at(-1)).toMatchObject({
        status: 'active', agents: [{ id: 'a', status: 'active' }, { id: 'b', status: 'complete' }],
      }));
      await exec.emit({ type: 'system', subtype: 'task_notification', session_id: 'claude-provider-session-1',
        task_id: 'native-a', tool_use_id: 'send-message-a', status: 'completed',
      });
      await vi.waitFor(() => expect(records.at(-1)).toMatchObject({ status: 'complete', completedAgents: 2 }));
      await vi.waitFor(() => expect(activityEvents.at(-1)).toMatchObject({ state: 'idle', activeCount: 0 }));
    } finally { subscription.dispose(); await session.dispose(); }
  });

  it('reopens the exact completed child through an authenticated SubagentStart hook', async () => {
    const terminalHost = createTerminalHostFixture();
    const exec = createSdkExecFixture();
    const sessionHooks = createSessionHooksFixture();
    const records: unknown[] = [];
    const ctx = createPluginContextFixture(terminalHost.service, createEventsFixture().service, {
      exec: exec.service, sessionHooks: sessionHooks.service,
      transcripts: { ...createPluginContextFixture(terminalHost.service, createEventsFixture().service).agentRuntime.transcripts, followSource: vi.fn(async () => ({ dispose: vi.fn(async () => undefined) })) },
      sessionWriteSystemRecord: vi.fn(async (request: SessionSystemRecordWriteRequestV1) => { records.push(request.payload); }),
    });
    const runtime = expectRuntimeEnvelope(await bindClaudeAgentSdkFallbackSession({ ctx, sessionParams: {
      cwd: '/tmp/claude-project', sessionId: 'happy-sdk-hook-resume', permissionMode: 'default',
    } })).operations;
    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('run agents');
      await vi.waitFor(() => expect(exec.spawnClient).toHaveBeenCalledTimes(1));
      await exec.emit({ type: 'system', subtype: 'init', session_id: 'claude-provider-session-1' });
      const hookRequest = sessionHooks.service.startServer.mock.calls[0]?.[0] as Readonly<{
        onSessionHook?: (providerSessionId: string, payload: Readonly<Record<string, unknown>>) => void | Promise<void>;
      }> | undefined;
      if (!hookRequest?.onSessionHook) throw new Error('session hook server was not started');
      await hookRequest.onSessionHook('claude-provider-session-1', {
        hook_event_name: 'SessionStart', session_id: 'claude-provider-session-1', source: 'startup',
        transcript_path: '/tmp/claude-provider-session-1.jsonl',
      });
      const launch = {
        type: 'assistant', session_id: 'claude-provider-session-1', uuid: 'hook-child-launch',
        message: { role: 'assistant', content: ['a', 'b'].map(id => ({ type: 'tool_use', id, name: 'Agent', input: { description: id } })) },
      };
      await exec.emit(launch);
      await vi.waitFor(() => expect(records.at(-1)).toMatchObject({ totalAgents: 2 }));
      for (const id of ['a', 'b']) {
        await hookRequest.onSessionHook('claude-provider-session-1', {
          hook_event_name: 'PostToolUse', session_id: 'claude-provider-session-1',
          tool_name: 'Agent', tool_use_id: id, tool_response: { status: 'async_launched', agentId: `native-${id}` },
        });
        await exec.emit({ type: 'system', subtype: 'task_notification', session_id: 'claude-provider-session-1',
          uuid: `hook-complete-${id}`, task_id: `native-${id}`, tool_use_id: id, status: 'completed',
        });
      }
      await vi.waitFor(() => expect(records.at(-1)).toMatchObject({ status: 'complete', completedAgents: 2 }));
      await hookRequest.onSessionHook('claude-provider-session-1', {
        hook_event_name: 'SubagentStart', session_id: 'claude-provider-session-1', agent_id: 'unknown-child',
      });
      // Unadmitted hook identities create no agent/run and cannot reopen a terminal row.
      expect(records.at(-1)).toMatchObject({ status: 'complete', totalAgents: 2 });
      await exec.emit({ type: 'system', subtype: 'task_started', session_id: 'claude-provider-session-1',
        uuid: 'late-start', task_id: 'native-a', tool_use_id: 'a', task_type: 'local_agent',
      });
      expect(records.at(-1)).toMatchObject({ status: 'complete' });
      await hookRequest.onSessionHook('claude-provider-session-1', {
        hook_event_name: 'SubagentStart', session_id: 'claude-provider-session-1', agent_id: 'native-a',
      });
      await vi.waitFor(() => expect(records.at(-1)).toMatchObject({
        status: 'active', agents: [{ id: 'a', status: 'active' }, { id: 'b', status: 'complete' }],
      }));
      await exec.emit({ type: 'system', subtype: 'task_notification', session_id: 'claude-provider-session-1',
        uuid: 'hook-resumed-complete', task_id: 'native-a', status: 'completed',
      });
      await vi.waitFor(() => expect(records.at(-1)).toMatchObject({ status: 'complete', completedAgents: 2 }));

    } finally { await runtime.resetOrDisposeRuntime(); }
  });
});
