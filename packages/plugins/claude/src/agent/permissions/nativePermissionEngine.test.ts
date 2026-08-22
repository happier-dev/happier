import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';

import { createClaudeNativePermissionEngine } from './nativePermissionEngine.js';

describe('createClaudeNativePermissionEngine', () => {
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

  it('uses the same current-session interaction owner for ordinary tool confirmation', async () => {
    const confirm = vi.fn(async () => ({
      requestId: 'confirmation-1',
      kind: 'confirmation' as const,
      status: 'declined' as const,
    }));
    const context = {
      services: { interactions: { confirm } },
    } as unknown as AgentSessionRuntimeContext;
    const engine = createClaudeNativePermissionEngine(context);

    await expect(engine.canCallTool('Bash', { command: 'rm -rf build' })).resolves.toEqual({
      behavior: 'deny',
      message: 'Permission denied',
      interrupt: true,
    });
    expect(confirm).toHaveBeenCalledWith({
      kind: 'confirmation',
      title: 'Claude permission',
      message: 'Allow Claude to use Bash?',
    });
  });
});
