import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import { createClaudeNativePermissionEngine } from './nativePermissionEngine.js';

describe('createClaudeNativePermissionEngine', () => {
  it('delivers selected native feedback to Claude when a tool is declined', async () => {
    // The public host interaction service is the plugin's process boundary.
    const context = { services: { interactions: { requestApproval: async () => ({
      requestId: 'approval-feedback', kind: 'approval', status: 'declined',
      nativeChoice: { requirementId: 'tool-feedback', choiceId: 'deny', feedback: 'Use the read-only inspection tool.' },
    }) } } } as unknown as AgentSessionRuntimeContext;
    await expect(createClaudeNativePermissionEngine(context).canCallTool('ExitPlanMode', {}, { toolUseId: 'tool-feedback' }))
      .resolves.toMatchObject({ behavior: 'deny', message: 'Use the read-only inspection tool.' });
  });
  it('keeps an MCP Session grant on the host while returning only a native once decision', async () => {
    const engine = createClaudeNativePermissionEngine({ services: { interactions: {
      requestApproval: async (request: { allowSessionPersistence?: boolean }) => request.allowSessionPersistence === true
        ? { requestId: 'permission', kind: 'approval', status: 'approved', persistence: 'session' }
        : { requestId: 'permission', kind: 'approval', status: 'declined' },
    } } } as unknown as AgentSessionRuntimeContext); // The SDK host approval transport is the external boundary.
    await expect(engine.canCallTool('mcp__docs__mutate', {})).resolves.toEqual({ behavior: 'allow', updatedInput: {} });
  });
  it('routes AskUserQuestion through the canonical interactions service and preserves every provider-native answer', async () => {
    const askQuestions = vi.fn(async () => ({
      requestId: 'questions-1',
      kind: 'questions' as const,
      status: 'answered' as const,
      answers: {
        framework: {
          kind: 'singleChoice' as const,
          answer: { kind: 'choice' as const, choiceId: 'react' },
        },
        deployment: {
          kind: 'multipleChoice' as const,
          answers: [
            { kind: 'choice' as const, choiceId: 'vercel' },
            { kind: 'custom' as const, value: 'Fly.io' },
          ],
        },
      },
    }));
    const context = {
      services: { interactions: { askQuestions } },
    } as unknown as AgentSessionRuntimeContext;
    const engine = createClaudeNativePermissionEngine(context);

    await expect(engine.canCallTool('AskUserQuestion', {
      questions: [{
        question: 'Which framework?',
        header: 'Framework',
        options: [
          { label: 'React', description: 'Use React', value: 'react' },
          { label: 'Vue', description: 'Use Vue', value: 'vue' },
        ],
        multiSelect: false,
      }, {
        question: 'Where should this deploy?',
        header: 'Deployment',
        options: [
          { label: 'Vercel', value: 'vercel' },
          { label: 'Cloudflare', value: 'cloudflare' },
        ],
        multiSelect: true,
      }],
    })).resolves.toEqual({
      behavior: 'allow',
      updatedInput: {
        questions: [expect.any(Object), expect.any(Object)],
        answers: {
          'Which framework?': 'React',
          'Where should this deploy?': 'Vercel, Fly.io',
        },
      },
    });
    expect(askQuestions).toHaveBeenCalledOnce();
  });

  it('preserves the native tool identity and input at the canonical approval owner', async () => {
    const requestApproval = vi.fn(async () => ({
      requestId: 'approval-1',
      kind: 'approval' as const,
      status: 'declined' as const,
    }));
    const confirm = vi.fn(async () => ({
      requestId: 'confirmation-1', kind: 'confirmation' as const, status: 'declined' as const,
    }));
    const context = {
      services: { interactions: { requestApproval, confirm } },
    } as unknown as AgentSessionRuntimeContext;
    const engine = createClaudeNativePermissionEngine(context);
    const signal = new AbortController().signal;

    await expect(engine.canCallTool('mcp__happier__action_execute', {
      actionId: 'session.board.item.remove',
    }, { signal, toolUseId: 'toolu-approval' })).resolves.toEqual({
      behavior: 'deny',
      message: 'Permission denied',
      interrupt: true,
    });
    expect(requestApproval).toHaveBeenCalledWith({
      kind: 'approval',
      title: 'Claude permission',
      nativeChoices: {
        requirementId: 'toolu-approval', source: 'claude',
        choices: [
          { id: 'allow', label: expect.any(String), decision: 'approved', scope: 'once', response: { approved: true, decision: 'approved' } },
          { id: 'deny', label: expect.any(String), decision: 'denied', scope: 'once', response: { approved: false, decision: 'denied' } },
          { id: 'stop', label: expect.any(String), decision: 'abort', scope: 'session', response: { approved: false, decision: 'abort', mode: 'read-only' } },
        ],
      },
      subject: {
        kind: 'tool',
        name: 'mcp__happier__action_execute',
        toolCallId: 'toolu-approval',
        input: { actionId: 'session.board.item.remove' },
      },
    }, { signal, buildNativeChoices: expect.any(Function) });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('allows an approved tool with its unchanged operands', async () => {
    const requestApproval = vi.fn(async () => ({
      requestId: 'approval-allowed',
      kind: 'approval' as const,
      status: 'approved' as const,
      persistence: 'once' as const,
    }));
    // The public host interaction service is the plugin's process boundary.
    const context = {
      services: { interactions: { requestApproval } },
    } as unknown as AgentSessionRuntimeContext;
    const input = { query: 'machine presets', surfaces: ['agent'] };

    await expect(createClaudeNativePermissionEngine(context).canCallTool(
      'mcp__happier__action_spec_search', input,
    )).resolves.toEqual({ behavior: 'allow', updatedInput: input });
  });
});
