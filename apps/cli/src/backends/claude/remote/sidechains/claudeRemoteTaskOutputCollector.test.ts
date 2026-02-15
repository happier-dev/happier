import { describe, expect, it } from 'vitest';

import type { SDKAssistantMessage, SDKUserMessage } from '../../sdk';
import { ClaudeRemoteTaskOutputCollector } from './claudeRemoteTaskOutputCollector';

function makeJsonl(lines: any[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('ClaudeRemoteTaskOutputCollector', () => {
  it('buffers TaskOutput records until Task tool_result maps agentId -> sidechainId, then flushes with meta', () => {
    const collector = new ClaudeRemoteTaskOutputCollector();

    const assistant: SDKAssistantMessage = {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool_task_1', name: 'Task', input: { prompt: 'do work' } },
          { type: 'tool_use', id: 'tool_taskoutput_1', name: 'TaskOutput', input: { task_id: 'agent_1', block: true } },
        ],
      },
    } as any;

    collector.observe(assistant);

    const taskOutputResult: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool_taskoutput_1',
            content: [
              {
                type: 'text',
                text: makeJsonl([
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
                    message: { role: 'assistant', content: [{ type: 'text', text: 'SUBTASK_OK' }] },
                  },
                ]),
              },
            ],
          },
        ],
      },
    } as any;

    const beforeMap = collector.observe(taskOutputResult);
    expect(beforeMap.imported.length).toBe(0);
    expect(beforeMap.taskOutputToolResults).toEqual([
      expect.objectContaining({
        toolUseId: 'tool_taskoutput_1',
        taskId: 'agent_1',
        importedCount: 0,
        bufferedCount: 1,
      }),
    ]);

    const taskResult: SDKUserMessage = {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool_task_1', content: 'agentId=agent_1' }],
      },
    } as any;

    const afterMap = collector.observe(taskResult);
    expect(afterMap.taskOutputToolResults).toEqual([]);
    expect(afterMap.imported.length).toBe(1);
    expect((afterMap.imported[0]?.body as any).sidechainId).toBe('tool_task_1');
    expect(afterMap.imported[0]?.meta).toEqual(
      expect.objectContaining({
        importedFrom: 'claude-taskoutput',
        claudeTaskOutputToolUseId: 'tool_taskoutput_1',
        claudeTaskId: 'agent_1',
        claudeAgentId: 'agent_1',
        claudeRemoteSessionId: 'sess_1',
      }),
    );
  });
});
