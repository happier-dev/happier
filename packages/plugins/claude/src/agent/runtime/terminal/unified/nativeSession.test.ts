import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { SessionPermissionsService } from '@happier-dev/plugin-sdk/sessions';
import { join } from 'node:path';

import {
  createNativePermissionDecisionAdapter,
  openClaudeNativeUnifiedTerminalSession,
  resolveClaudeNativeUnifiedResume,
} from './nativeSession.js';
import { getClaudeProjectPath } from '../../../surfaces/sessions/handoff/path.js';

function createContext(): AgentSessionRuntimeContext {
  return {
    services: {
      settings: { forScope: vi.fn(() => ({ get: vi.fn(async () => null), snapshot: async () => ({ values: {} }) })) },
      storage: { daemonSession: { get: vi.fn(), set: vi.fn() } },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      exec: {},
      interactions: {
        confirm: vi.fn(async () => ({ status: 'approved' as const })),
        askQuestions: vi.fn(),
      },
    },
    ui: { askQuestions: vi.fn(), confirm: vi.fn() },
    session: {
      services: {
        features: { isEnabled: vi.fn(() => true) },
        terminalHost: {
          resolve: vi.fn(),
          createOrAttachHost: vi.fn(),
        },
        activeInput: { bind: () => ({ dispose() {} }), publishStatus: vi.fn() },
        models: { bind: () => ({ dispose() {} }) },
        sessionHooks: {},
        transcripts: { fileFollow: {} },
        accountUsage: {},
        auth: {},
        workflowActivity: {},
      },
    },
    workState: {
      publisher: () => ({ publish: vi.fn(async () => undefined) }),
    },
  } as unknown as AgentSessionRuntimeContext;
}

describe('openClaudeNativeUnifiedTerminalSession', () => {
  it('acknowledges an accepted native permission decision before resolving it', async () => {
    const requestDecision = createNativePermissionDecisionAdapter(createContext())
      .requestDecision as SessionPermissionsService['requestDecision'];
    const acknowledgeDecisionApplication = vi.fn(async () => undefined);

    const result = await requestDecision({
      provider: 'claude',
      requestId: 'dialog-1',
      toolCallId: 'dialog-1',
      toolName: 'Read',
      input: { file_path: '/tmp/example' },
    }, { acknowledgeDecisionApplication });

    expect(result.decision).toBe('approved');
    expect(acknowledgeDecisionApplication).toHaveBeenCalledWith(result);
  });

  it('projects native question answers onto the canonical permission result', async () => {
    const context = createContext();
    vi.mocked(context.services.interactions.askQuestions).mockResolvedValue({
      requestId: 'questions-1',
      kind: 'questions',
      status: 'answered',
      answers: {
        'resume-how': {
          kind: 'singleChoice',
          answer: { kind: 'choice', choiceId: 'full' },
        },
      },
    });
    const requestDecision = createNativePermissionDecisionAdapter(context)
      .requestDecision as SessionPermissionsService['requestDecision'];

    const result = await requestDecision({
      provider: 'claude',
      requestId: 'dialog-1',
      toolCallId: 'dialog-1',
      toolName: 'AskUserQuestion',
      input: {
        questions: [{
          question: 'Resume how?',
          header: 'Resume how',
          options: [{ label: 'Full', value: 'full' }],
        }],
      },
    });

    expect(result).toMatchObject({
      decision: 'approved',
      answers: { 'Resume how?': ['Full'] },
      updatedInput: { answers: { 'Resume how?': 'Full' } },
    });
  });

  it('preserves the requested provider identity and canonical transcript path for native resume', async () => {
    const cwd = '/tmp/claude-native-resume';
    const providerSessionId = 'provider-session-resume';

    expect(resolveClaudeNativeUnifiedResume({
      request: {
        kind: 'resume',
        sessionId: 'happier-session-resume',
        cwd,
        providerSessionId,
      },
      launchEnv: {},
    })).toEqual({
      knownProviderSession: {
        providerSessionId,
        transcriptPath: join(getClaudeProjectPath(cwd, undefined), `${providerSessionId}.jsonl`),
      },
      launchIntent: {
        kind: 'resume_native',
        providerSessionId,
      },
    });

    const operations = await openClaudeNativeUnifiedTerminalSession({
      request: {
        kind: 'resume',
        sessionId: 'happier-session-resume',
        cwd,
        providerSessionId,
      },
      context: createContext(),
    });
    await operations.disposeProviderSession('test_complete');
  });
});
