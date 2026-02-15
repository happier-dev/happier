import { describe, expect, it } from 'vitest';

import { ClaudeTaskOutputSidechainImporter } from './claudeTaskOutputSidechainImporter';

function makeJsonl(lines: any[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('ClaudeTaskOutputSidechainImporter', () => {
  it('imports TaskOutput JSONL records into sidechains once agentId is mapped to the Task tool-call id', () => {
    const importer = new ClaudeTaskOutputSidechainImporter();

    // Task tool call exists
    importer.observeToolUse({
      toolUseId: 'tool_task_1',
      toolName: 'Task',
      input: { prompt: 'do the thing' },
    });

    // Task tool-result contains agentId for background task.
    importer.ingestToolResult({
      toolUseId: 'tool_task_1',
      toolResultText: 'agentId: agent_123',
    });

    // TaskOutput call + result for that agentId
    importer.observeToolUse({
      toolUseId: 'tool_taskoutput_1',
      toolName: 'TaskOutput',
      input: { task_id: 'agent_123', block: true, timeout: 2000 },
    });

    const res = importer.ingestToolResult({
      toolUseId: 'tool_taskoutput_1',
      toolResultText: makeJsonl([
        {
          type: 'assistant',
          uuid: 'u1',
          parentUuid: null,
          timestamp: new Date().toISOString(),
          sessionId: 'sess_1',
          userType: 'external',
          cwd: '/tmp',
          version: '0.0.0',
          gitBranch: 'main',
          isSidechain: true,
          agentId: 'agent_123',
          message: { role: 'assistant', content: [{ type: 'text', text: 'SUBTASK_OK' }] },
        },
      ]),
    });

    expect(res.imported.length).toBe(1);
    expect((res.imported[0]?.body as any).sidechainId).toBe('tool_task_1');
    expect((res.imported[0]?.body as any).isSidechain).toBe(true);
    expect(res.imported[0]?.meta).toEqual(
      expect.objectContaining({
        importedFrom: 'claude-taskoutput',
        claudeTaskId: 'agent_123',
        claudeAgentId: 'agent_123',
        claudeRemoteSessionId: 'sess_1',
        claudeTaskOutputToolUseId: 'tool_taskoutput_1',
      }),
    );
  });

  it('skips duplicate TaskOutput records by uuid', () => {
    const importer = new ClaudeTaskOutputSidechainImporter();
    importer.observeToolUse({ toolUseId: 'tool_task_1', toolName: 'Task', input: {} });
    importer.ingestToolResult({ toolUseId: 'tool_task_1', toolResultText: 'agentId=agent_1' });
    importer.observeToolUse({ toolUseId: 'tool_taskoutput_1', toolName: 'TaskOutput', input: { task_id: 'agent_1' } });

    const jsonl = makeJsonl([
      {
        type: 'assistant',
        uuid: 'u1',
        parentUuid: null,
        timestamp: new Date().toISOString(),
        sessionId: 'sess_1',
        userType: 'external',
        cwd: '/tmp',
        version: '0.0.0',
        gitBranch: 'main',
        isSidechain: true,
        agentId: 'agent_1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
      },
    ]);

    const r1 = importer.ingestToolResult({ toolUseId: 'tool_taskoutput_1', toolResultText: jsonl });
    const r2 = importer.ingestToolResult({ toolUseId: 'tool_taskoutput_1', toolResultText: jsonl });
    expect(r1.imported.length).toBe(1);
    expect(r2.imported.length).toBe(0);
  });

  it('skips imported prompt-root user messages (string content) to avoid duplicates', () => {
    const importer = new ClaudeTaskOutputSidechainImporter();
    importer.observeToolUse({ toolUseId: 'tool_task_1', toolName: 'Task', input: {} });
    importer.ingestToolResult({ toolUseId: 'tool_task_1', toolResultText: 'agentId=agent_1' });
    importer.observeToolUse({ toolUseId: 'tool_taskoutput_1', toolName: 'TaskOutput', input: { task_id: 'agent_1' } });

    const res = importer.ingestToolResult({
      toolUseId: 'tool_taskoutput_1',
      toolResultText: makeJsonl([
        {
          type: 'user',
          uuid: 'u_prompt',
          parentUuid: null,
          timestamp: new Date().toISOString(),
          sessionId: 'sess_1',
          userType: 'external',
          cwd: '/tmp',
          version: '0.0.0',
          gitBranch: 'main',
          isSidechain: true,
          agentId: 'agent_1',
          message: { role: 'user', content: 'do work' },
        },
      ]),
    });

    expect(res.imported.length).toBe(0);
  });

  it('buffers TaskOutput records until the Task tool-result mapping is observed', () => {
    const importer = new ClaudeTaskOutputSidechainImporter();

    importer.observeToolUse({ toolUseId: 'tool_task_1', toolName: 'Task', input: {} });
    importer.observeToolUse({ toolUseId: 'tool_taskoutput_1', toolName: 'TaskOutput', input: { task_id: 'agent_1' } });

    const pending = importer.ingestToolResult({
      toolUseId: 'tool_taskoutput_1',
      toolResultText: makeJsonl([
        {
          type: 'assistant',
          uuid: 'u1',
          parentUuid: null,
          timestamp: new Date().toISOString(),
          sessionId: 'sess_1',
          userType: 'external',
          cwd: '/tmp',
          version: '0.0.0',
          gitBranch: 'main',
          isSidechain: true,
          agentId: 'agent_1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
        },
      ]),
    });
    expect(pending.imported.length).toBe(0);

    const flush = importer.ingestToolResult({ toolUseId: 'tool_task_1', toolResultText: 'agentId=agent_1' });
    expect(flush.imported.length).toBe(1);
    expect((flush.imported[0]?.body as any).sidechainId).toBe('tool_task_1');
    expect(flush.imported[0]?.meta).toEqual(
      expect.objectContaining({
        importedFrom: 'claude-taskoutput',
        claudeTaskId: 'agent_1',
        claudeAgentId: 'agent_1',
        claudeRemoteSessionId: 'sess_1',
        claudeTaskOutputToolUseId: 'tool_taskoutput_1',
      }),
    );
  });
});
