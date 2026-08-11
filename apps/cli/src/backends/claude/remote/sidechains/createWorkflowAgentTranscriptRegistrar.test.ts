import { describe, expect, it, vi } from 'vitest';

import type { ClaudeRemoteSubagentFileCollector } from './claudeRemoteSubagentFileCollector';
import { createWorkflowAgentTranscriptRegistrar } from './createWorkflowAgentTranscriptRegistrar';

const registration = {
  workflowToolUseId: 'toolu_wf',
  agentId: 'a1',
  sidechainId: 'workflow-agent:toolu_wf:a1',
  filePath: '/runs/wf/agent-a1.jsonl',
} as const;

describe('createWorkflowAgentTranscriptRegistrar', () => {
  it('refuses to report success when no importer is wired', async () => {
    const register = createWorkflowAgentTranscriptRegistrar({ getCollector: () => null });

    await expect(register(registration)).rejects.toThrow(/workflow-agent:toolu_wf:a1/);
  });

  it('hands the file to the collector once one exists', async () => {
    const registerSidechainFile = vi.fn(async () => {});
    const collector = { registerSidechainFile } as unknown as ClaudeRemoteSubagentFileCollector;
    const register = createWorkflowAgentTranscriptRegistrar({ getCollector: () => collector });

    await register(registration);

    expect(registerSidechainFile).toHaveBeenCalledWith({
      sidechainId: 'workflow-agent:toolu_wf:a1',
      agentId: 'a1',
      filePath: '/runs/wf/agent-a1.jsonl',
      source: 'workflow-agent',
    });
  });

  it('surfaces a collector rejection rather than swallowing it', async () => {
    const collector = {
      registerSidechainFile: async () => { throw new Error('disk gone'); },
    } as unknown as ClaudeRemoteSubagentFileCollector;
    const register = createWorkflowAgentTranscriptRegistrar({ getCollector: () => collector });

    await expect(register(registration)).rejects.toThrow('disk gone');
  });
});
