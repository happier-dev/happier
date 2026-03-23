import { describe, expect, it } from 'vitest';
import type { StderrContext } from '@/agent/transport/TransportHandler';

import { copilotTransport } from './transport';

const DEFAULT_CONTEXT = {
  recentPromptHadChangeTitle: false,
  toolCallCountSincePrompt: 0,
} as const;

describe('CopilotTransport determineToolName', () => {
  it('canonicalizes Happier shell-bridge change_title commands instead of keeping the generic bash wrapper', () => {
    expect(
      copilotTransport.determineToolName(
        'bash',
        'tooluse-change-title-1',
        {
          command:
            'happier tools call --session-id "sess-1" --directory "/tmp/workspace" --source "happier" --tool "change_title" --args-json "{\\"title\\":\\"QA Title\\"}" --json',
        },
        DEFAULT_CONTEXT,
      ),
    ).toBe('change_title');
  });

  it('canonicalizes Happier shell-bridge custom MCP commands instead of showing them as terminal commands', () => {
    expect(
      copilotTransport.determineToolName(
        'bash',
        'tooluse-get-marker-1',
        {
          command:
            'happier tools call --session-id "sess-1" --directory "/tmp/workspace" --source "qa_marker_stdio_20260306" --tool "get_marker" --args-json "{}" --json',
        },
        DEFAULT_CONTEXT,
      ),
    ).toBe('mcp__qa_marker_stdio_20260306__get_marker');
  });
});

describe('CopilotTransport handleStderr', () => {
  const DEFAULT_STDERR_CONTEXT: StderrContext = {
    activeToolCalls: new Set(),
    hasActiveInvestigation: false,
  };

  it('points authentication failures at the current login command', () => {
    expect(copilotTransport.handleStderr('Authentication failed: unauthorized', DEFAULT_STDERR_CONTEXT)).toEqual({
      message: {
        type: 'status',
        status: 'error',
        detail: 'Authentication error. Run `copilot login` to authenticate with GitHub.',
      },
    });
  });
});
