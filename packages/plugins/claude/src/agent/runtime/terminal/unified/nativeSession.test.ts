import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import type { SessionPermissionsService } from '@happier-dev/plugin-sdk/sessions';
import { join } from 'node:path';

import {
  openClaudeNativeUnifiedTerminalSession,
  resolveClaudeNativeUnifiedResume,
} from './nativeSession.js';
import { getClaudeProjectPath, resolveClaudeProjectId } from '../../../surfaces/sessions/handoff/path.js';
import { createClaudeNativeAgentSdkContext } from '../../nativeServices.js';
import { withPermissionDecisionApplication } from '../../engine.testkit.js';
import { buildClaudePermissionChoices } from '../../../permissions/permissionChoices.js';

function createContext(requestDecision?: SessionPermissionsService['requestDecision']): AgentSessionRuntimeContext {
  return {
    services: {
      settings: { forScope: vi.fn(() => ({ get: vi.fn(async () => null), snapshot: async () => ({ values: {} }) })) },
      storage: { daemonSession: { get: vi.fn(), set: vi.fn() } },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      exec: { readEnvironment: () => ({}) },
      sessions: { current: { permissions: { requestDecision } } },
      interactions: {
        requestApproval: vi.fn(async () => ({ status: 'approved' as const })),
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
  it('keeps resumed transcript paths in each admitted Session home', () => {
    const cwd = '/tmp/claude-native-resume';
    const projectId = resolveClaudeProjectId(cwd);
    const homes = ['/tmp/claude-session-home-a', '/tmp/claude-session-home-b'];
    const resumes = homes.map((home, index) => resolveClaudeNativeUnifiedResume({
      request: { kind: 'resume', sessionId: `hosted-${index}`, cwd, providerSessionId: `native-${index}` },
      launchEnv: { HOME: home, USERPROFILE: home },
    }));

    expect(resumes.map(resume => resume.knownProviderSession?.transcriptPath)).toEqual(
      homes.map((home, index) => join(home, '.claude', 'projects', projectId, `native-${index}.jsonl`)),
    );
  });

  it('acknowledges an accepted native permission decision before resolving it', async () => {
    const hostDecision = withPermissionDecisionApplication(async () => ({ decision: 'approved' }));
    const requestDecision = createClaudeNativeAgentSdkContext(createContext(hostDecision))
      .sessions.current.permissions.requestDecision as SessionPermissionsService['requestDecision'];
    let releaseAcknowledgement!: () => void;
    const acknowledgement = new Promise<void>(resolve => { releaseAcknowledgement = resolve; });
    const acknowledgeDecisionApplication = vi.fn(() => acknowledgement);
    let settled = false;

    const input = { file_path: '/tmp/example' };
    const pendingDecision = requestDecision({
      provider: 'claude',
      requestId: 'dialog-1',
      toolCallId: 'dialog-1',
      toolName: 'Read',
      input,
      nativeChoices: buildClaudePermissionChoices({ requestId: 'dialog-1', toolName: 'Read', toolInput: input }),
    }, { acknowledgeDecisionApplication }).then(result => {
      settled = true;
      return result;
    });

    try {
      await vi.waitFor(() => expect(acknowledgeDecisionApplication).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
    } finally {
      releaseAcknowledgement();
    }
    const result = await pendingDecision;

    expect(result.decision).toBe('approved');
    expect(acknowledgeDecisionApplication).toHaveBeenCalledWith(result);
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
