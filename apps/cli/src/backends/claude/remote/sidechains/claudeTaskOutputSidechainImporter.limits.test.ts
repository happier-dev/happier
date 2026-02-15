import { describe, expect, it, vi } from 'vitest';

function makeJsonl(lines: any[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

describe('ClaudeTaskOutputSidechainImporter (limits)', () => {
  it('bounds pending TaskOutput records per agent when configured', async () => {
    vi.resetModules();
    process.env.HAPPIER_CLAUDE_TASKOUTPUT_MAX_PENDING_PER_AGENT = '1';

    const { ClaudeTaskOutputSidechainImporter } = await import('./claudeTaskOutputSidechainImporter');
    const importer = new ClaudeTaskOutputSidechainImporter();

    importer.observeToolUse({ toolUseId: 'tool_task_1', toolName: 'Task', input: {} });
    importer.observeToolUse({ toolUseId: 'tool_taskoutput_1', toolName: 'TaskOutput', input: { task_id: 'agent_1' } });

    importer.ingestToolResult({
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
        {
          type: 'assistant',
          uuid: 'u2',
          parentUuid: null,
          timestamp: new Date().toISOString(),
          sessionId: 'sess_1',
          userType: 'external',
          cwd: '/tmp',
          version: '0.0.0',
          gitBranch: 'main',
          isSidechain: true,
          agentId: 'agent_1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'y' }] },
        },
      ]),
    });

    const flush = importer.ingestToolResult({ toolUseId: 'tool_task_1', toolResultText: 'agentId=agent_1' });
    expect(flush.imported.length).toBe(1);
    expect((flush.imported[0]?.body as any).uuid).toBe('u2');
  });
});

