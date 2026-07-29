import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agent-runtime';
import { join } from 'node:path';

import {
  openClaudeNativeUnifiedTerminalSession,
  resolveClaudeNativeUnifiedResume,
} from './nativeSession.js';
import { getClaudeProjectPath } from '../../../surfaces/sessions/handoff/path.js';

function createContext(): AgentSessionRuntimeContext {
  return {
    services: {
      settings: { get: vi.fn(async () => null) },
      storage: { session: { get: vi.fn(), set: vi.fn() } },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      exec: {},
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
        systemRecords: {},
        workflowActivity: {},
      },
    },
    workState: {
      publisher: () => ({ publish: vi.fn(async () => undefined) }),
    },
  } as unknown as AgentSessionRuntimeContext;
}

describe('openClaudeNativeUnifiedTerminalSession', () => {
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
