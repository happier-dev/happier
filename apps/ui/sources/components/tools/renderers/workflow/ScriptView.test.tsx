import {
  createTestSessionTranscriptSource,
  renderWithSessionTranscriptSource,
} from '@/dev/testkit';
import type {
  Message,
  ToolCall,
  ToolCallMessage,
} from '@happier-dev/session-core/messages';
import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

const { ScriptView } = await import('./ScriptView');

const SCRIPT_CODE =
  "const prs = await mcp.github.list_pull_requests({ q: 'is:open' });\nreturn prs.items.length;";

function scriptTool(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'toolu_script_1',
    name: 'Script',
    state: 'completed',
    input: {
      code: SCRIPT_CODE,
      language: 'javascript',
      title: 'Check CI on checkout pull requests',
    },
    result: {
      output: [{ pr: 2481, checks: 'passing' }],
      stdout: 'Checked 4 pull requests\n',
    },
    createdAt: 10,
    startedAt: 10,
    completedAt: 6_410,
    description: null,
    ...overrides,
  };
}

function child(id: string, tool: Partial<ToolCall>): ToolCallMessage {
  return {
    kind: 'tool-call',
    id,
    localId: null,
    createdAt: tool.createdAt ?? 11,
    children: [],
    tool: {
      name: 'Read',
      state: 'completed',
      input: { file_path: `/repo/${id}.ts` },
      createdAt: 11,
      startedAt: 11,
      completedAt: 12,
      description: null,
      ...tool,
    },
  };
}

/** A first-party Action call refused by the Machine admission owner, as the transcript stores it. */
function refusedActionChild(id: string): ToolCallMessage {
  const text = JSON.stringify({
    ok: false,
    errorCode: 'credential_scope_denied',
    error: 'credential_scope_denied',
    failureCause: {
      phase: 'execution_authorization',
      errorClass: 'Error',
      errorCode: 'machine_manage_required',
      httpStatus: null,
    },
  });
  return child(id, {
    name: 'mcp__happier__action_execute',
    input: { actionId: 'machine.services.restart', input: {} },
    result: {
      content: [{ type: 'text', text }],
      structuredContent: null,
      text,
      _mcp: { serverId: 'happier', toolId: 'action_execute' },
    },
  });
}

const SIX_CHILDREN: Message[] = ['a', 'b', 'c', 'd', 'e', 'f'].map(
  (id, index) => child(id, { createdAt: 11 + index }),
);

async function render(element: React.ReactElement, navigate = vi.fn()) {
  return renderWithSessionTranscriptSource(
    element,
    createTestSessionTranscriptSource({ navigate }),
  );
}

describe('ScriptView', () => {
  it('keeps the script source and console unmounted until their disclosure opens', async () => {
    const screen = await render(
      <ScriptView
        tool={scriptTool()}
        metadata={null}
        messages={[]}
        sessionId="s1"
        messageId="m1"
        detailLevel="summary"
      />,
    );

    expect(screen.findAllByTestId('script-view-code')).toHaveLength(0);
    expect(screen.findAllByTestId('script-view-output')).toHaveLength(0);
    expect(screen.findAllByTestId('code-block-view')).toHaveLength(0);

    await screen.pressByTestIdAsync('script-view-code-toggle');
    expect(screen.findAllByTestId('script-view-code').length).toBeGreaterThan(0);
    expect(screen.getTextContent()).toContain('list_pull_requests');

    await screen.pressByTestIdAsync('script-view-output-toggle');
    expect(screen.findAllByTestId('script-view-output').length).toBeGreaterThan(0);
    expect(screen.getTextContent()).toContain('Checked 4 pull requests');
  });

  it('offers Output only when the script printed something', async () => {
    const screen = await render(
      <ScriptView
        tool={scriptTool({ result: { output: 3 } })}
        metadata={null}
        messages={[]}
        sessionId="s1"
        messageId="m1"
        detailLevel="summary"
      />,
    );
    expect(screen.findAllByTestId('script-view-output-toggle')).toHaveLength(0);
    expect(screen.findAllByTestId('script-view-code-toggle').length).toBeGreaterThan(0);
  });

  it('shows the last four inner calls and folds the earlier ones into the group’s more row', async () => {
    const screen = await render(
      <ScriptView
        tool={scriptTool()}
        metadata={null}
        messages={SIX_CHILDREN}
        sessionId="s1"
        messageId="m1"
        detailLevel="summary"
      />,
    );
    const rail = screen.findByTestId('script-view-calls');
    expect(rail).toBeTruthy();
    expect(screen.findAllByTestId('transcript-tool-calls-preview-more').length).toBeGreaterThan(0);
    expect(screen.getTextContent()).toContain('/repo/f.ts');
    expect(screen.getTextContent()).not.toContain('/repo/a.ts');

    await screen.pressByTestIdAsync('transcript-tool-calls-preview-more');
    expect(
      screen.findAllByTestId('transcript-tool-calls-preview-more'),
    ).toHaveLength(0);
    expect(screen.getTextContent()).toContain('/repo/a.ts');
  });

  it('opens the script’s details page focused on the pressed inner call', async () => {
    const navigate = vi.fn();
    const screen = await render(
      <ScriptView
        tool={scriptTool()}
        metadata={null}
        messages={[child('c1', { id: 'toolu_child_1' })]}
        sessionId="s1"
        messageId="m1"
        detailLevel="summary"
      />,
      navigate,
    );

    const rail = screen.findByTestId('script-view-calls');
    const pressable = rail?.findAll((node) => typeof node.props?.onPress === 'function')[0];
    expect(pressable).toBeTruthy();
    await act(async () => { pressable!.props.onPress(); });
    expect(navigate).toHaveBeenCalledTimes(1);
    const href = String(navigate.mock.calls[0]?.[0]);
    expect(href).toContain('/session/s1/message/');
    expect(href).toContain('jumpChildId=');
    expect(href).toContain('toolu_child_1');
  });

  it('keeps a refused inner call’s typed cause in words', async () => {
    const screen = await render(
      <ScriptView
        tool={scriptTool()}
        metadata={null}
        messages={[refusedActionChild('r1')]}
        sessionId="s1"
        messageId="m1"
        detailLevel="summary"
      />,
    );
    expect(screen.getTextContent()).toContain(
      'This Action needs Manage on this Machine.',
    );
  });

  it('reads a runner’s own call records as the same rows when the transcript has no child calls', async () => {
    const tool = scriptTool({
      result: {
        output: null,
        calls: [
          {
            id: 'call-1',
            tool: 'Read',
            status: 'completed',
            summary: 'Read package.json',
          },
          { id: 'call-2', tool: 'Bash', status: 'running' },
        ],
      },
    });
    const screen = await render(
      <ScriptView
        tool={tool}
        metadata={null}
        messages={[]}
        sessionId="s1"
        messageId="m1"
        detailLevel="summary"
      />,
    );
    expect(screen.findByTestId('script-view-calls')).toBeTruthy();
    expect(
      screen.findAllByTestId('transcript-tool-calls-preview-more'),
    ).toHaveLength(0);
  });

  it('states the script’s own error in the body', async () => {
    const tool = scriptTool({
      state: 'error',
      result: {
        error: "TypeError: Cannot read properties of undefined (reading 'sha')",
      },
    });
    const screen = await render(
      <ScriptView
        tool={tool}
        metadata={null}
        messages={[]}
        sessionId="s1"
        messageId="m1"
        detailLevel="summary"
      />,
    );
    expect(screen.findAllByTestId('tool-error-body').length).toBeGreaterThan(0);
    expect(screen.getTextContent()).toContain("reading 'sha'");
  });

  it('opens everything on the details page: every call, the source and the console', async () => {
    const screen = await render(
      <ScriptView
        tool={scriptTool()}
        metadata={null}
        messages={SIX_CHILDREN}
        sessionId="s1"
        messageId="m1"
        detailLevel="full"
      />,
    );
    expect(
      screen.findAllByTestId('transcript-tool-calls-preview-more'),
    ).toHaveLength(0);
    expect(screen.findAllByTestId('script-view-code-toggle')).toHaveLength(0);
    expect(screen.getTextContent()).toContain('/repo/a.ts');
    expect(screen.getTextContent()).toContain('list_pull_requests');
    expect(screen.getTextContent()).toContain('Checked 4 pull requests');
  });
  it('marks the call a details page was opened at', async () => {
    const screen = await render(
      <ScriptView tool={scriptTool()} metadata={null} messages={SIX_CHILDREN} sessionId="s1" messageId="m1" detailLevel="full" jumpChildId="c" />,
    );
    const focused = screen.findAllByTestId('script-view-call-focused');
    expect(focused.length).toBeGreaterThan(0);
    expect(JSON.stringify(focused[0]?.props.children?.props?.toolMessage?.id)).toBe('"c"');
  });
});
