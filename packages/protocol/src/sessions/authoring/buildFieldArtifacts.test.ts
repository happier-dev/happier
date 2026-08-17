import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  SESSION_AUTHORING_FIELD_IDS,
  SESSION_AUTHORING_FIELD_DESCRIPTORS,
  SessionAuthoringValueV1Schema,
  type SessionAuthoringFieldId,
  type SessionAuthoringValueV1,
} from './index.js';

describe('sessionAuthoring field artifacts', () => {
  it('derives stable field ids and descriptors from one catalog', () => {
    expect(SESSION_AUTHORING_FIELD_IDS).toContain('targetType');
    expect(SESSION_AUTHORING_FIELD_IDS).toContain('directory');
    expect(SESSION_AUTHORING_FIELD_IDS).toContain('backendTarget');
    expect(SESSION_AUTHORING_FIELD_IDS).toContain('modelSelection');
    expect(SESSION_AUTHORING_FIELD_IDS).toContain('automation');
    expect(SESSION_AUTHORING_FIELD_IDS).not.toContain('workspaceId');
    expect(SESSION_AUTHORING_FIELD_IDS).not.toContain('workspaceLocationId');
    expect(SESSION_AUTHORING_FIELD_IDS).not.toContain('workspaceCheckoutId');

    expect(SESSION_AUTHORING_FIELD_DESCRIPTORS.targetType.storageClass).toBe('template');
    expect(SESSION_AUTHORING_FIELD_DESCRIPTORS.existingSessionId.defaultEditabilityByContext.automationExistingSession).toBe('inherited');

    expectTypeOf<SessionAuthoringFieldId>().toMatchTypeOf<(typeof SESSION_AUTHORING_FIELD_IDS)[number]>();
  });

  it('parses the shared authored value shape', () => {
    const parsed = SessionAuthoringValueV1Schema.parse({
      targetType: 'new_session',
      directory: '/tmp/project',
      checkoutCreationDraft: {
        kind: 'git_worktree',
        displayName: 'feature/auth',
        baseRef: 'main',
      },
      prompt: 'ship it',
      displayText: 'ship it',
      agentId: 'codex',
      backendTarget: {
        kind: 'configuredAcpBackend',
        backendId: 'review-bot',
      },
      transcriptStorage: 'direct',
      profileId: 'profile-1',
      environmentVariables: {
        FOO: 'bar',
      },
      resumeSessionId: null,
      permissionMode: 'acceptEdits',
      permissionModeUpdatedAt: 123,
      modelSelection: {
        v: 1,
        updatedAt: 124,
        ref: {
          agentTargetKey: 'backend:review-bot',
          providerConnectionId: 'pc_work',
          modelId: 'gpt-5',
        },
      },
      mcpSelection: {
        managedServersEnabled: true,
        forceIncludeServerIds: ['mcp-a'],
        forceExcludeServerIds: [],
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          github: {
            source: 'connected',
          },
        },
      },
      terminal: {
        mode: 'tmux',
        tmux: {
          sessionName: 'dev',
        },
      },
      windowsRemoteSessionLaunchMode: null,
      windowsRemoteSessionConsole: null,
      windowsTerminalWindowName: null,
      codexBackendMode: 'appServer',
      acpSessionModeId: 'plan',
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 456,
        overrides: {
          speed: {
            updatedAt: 456,
            value: 'fast',
          },
        },
      },
      existingSessionId: null,
      sessionEncryptionMode: null,
      sessionEncryptionKeyBase64: null,
      sessionEncryptionVariant: null,
      automation: {
        enabled: true,
        name: 'Daily summary',
        description: 'Ship the summary',
        scheduleKind: 'interval',
        everyMinutes: 60,
        cronExpr: '0 * * * *',
        timezone: 'Europe/Zurich',
      },
    });

    expect(parsed.backendTarget).toEqual({
      kind: 'configuredAcpBackend',
      backendId: 'review-bot',
    });
    expect(parsed.automation?.enabled).toBe(true);
    expect(parsed.modelSelection?.ref).toEqual({
      agentTargetKey: 'backend:review-bot',
      providerConnectionId: 'pc_work',
      modelId: 'gpt-5',
    });
    expectTypeOf<typeof parsed>().toMatchTypeOf<SessionAuthoringValueV1>();
  });

  it('preserves additive authored envelopes without persisting opaque Session-create leaves', () => {
    const parsed = SessionAuthoringValueV1Schema.parse({
      targetType: 'new_session',
      directory: '/tmp/project',
      displayText: 'ship it',
      agentId: 'codex',
      prompt: 'ship it',
      transcriptStorage: 'direct',
      profileId: null,
      environmentVariables: null,
      resumeSessionId: null,
      permissionMode: null,
      permissionModeUpdatedAt: null,
      modelId: null,
      modelUpdatedAt: null,
      mcpSelection: null,
      connectedServices: null,
      backendTarget: {
        kind: 'configuredAcpBackend',
        backendId: 'review-bot',
      },
      checkoutCreationDraft: {
        kind: 'git_worktree',
        displayName: 'feature/auth',
        baseRef: 'main',
      },
      terminal: {
        mode: 'tmux',
        tmux: {
          sessionName: 'dev',
        },
      },
      windowsRemoteSessionLaunchMode: null,
      windowsRemoteSessionConsole: null,
      windowsTerminalWindowName: null,
      codexBackendMode: null,
      acpSessionModeId: null,
      sessionConfigOptionOverrides: null,
      existingSessionId: null,
      sessionEncryptionMode: null,
      sessionEncryptionKeyBase64: null,
      sessionEncryptionVariant: null,
      automation: {
        enabled: true,
        name: 'Daily summary',
        description: 'Ship the summary',
        scheduleKind: 'interval',
        everyMinutes: 60,
        cronExpr: '0 * * * *',
        timezone: 'Europe/Zurich',
        futureAutomationField: 123,
      },
      futureTopLevelField: {
        kind: 'session_authoring.v2',
        extra: true,
      },
    });

    expect((parsed as any).futureTopLevelField).toEqual({
      kind: 'session_authoring.v2',
      extra: true,
    });
    expect((parsed.automation as any)?.futureAutomationField).toBe(123);

    expect(SessionAuthoringValueV1Schema.safeParse({
      ...parsed,
      terminal: {
        mode: 'tmux',
        unrecognizedTerminalSecret: 'must-not-persist',
      },
    }).success).toBe(false);
    expect(SessionAuthoringValueV1Schema.safeParse({
      ...parsed,
      terminal: {
        mode: 'tmux',
        tmux: {
          sessionName: 'dev',
          unrecognizedTmuxSecret: 'must-not-persist',
        },
      },
    }).success).toBe(false);
    expect(SessionAuthoringValueV1Schema.safeParse({
      ...parsed,
      terminal: {
        mode: 'tmux',
        tmux: {
          sessionName: 'dev',
          target: 'existing-session:window',
        },
      },
    }).success).toBe(false);
    expect(SessionAuthoringValueV1Schema.safeParse({
      ...parsed,
      checkoutCreationDraft: {
        kind: 'git_worktree',
        displayName: 'feature/auth',
        baseRef: 'main',
        unrecognizedCheckoutSecret: 'must-not-persist',
      },
    }).success).toBe(false);
  });

  it('normalizes Windows launch semantics through the existing terminal owner', () => {
    const baseAuthoringValue = {
      targetType: 'new_session',
      directory: '/tmp/project',
      checkoutCreationDraft: null,
      prompt: '',
      displayText: '',
      agentId: null,
      backendTarget: null,
      transcriptStorage: null,
      profileId: null,
      environmentVariables: null,
      resumeSessionId: null,
      permissionMode: null,
      permissionModeUpdatedAt: null,
      modelSelection: null,
      mcpSelection: null,
      connectedServices: null,
      windowsRemoteSessionLaunchMode: null,
      windowsRemoteSessionConsole: null,
      windowsTerminalWindowName: null,
      codexBackendMode: null,
      acpSessionModeId: null,
      sessionConfigOptionOverrides: null,
      existingSessionId: null,
      sessionEncryptionMode: null,
      sessionEncryptionKeyBase64: null,
      sessionEncryptionVariant: null,
      automation: null,
    } as const;
    const parsed = SessionAuthoringValueV1Schema.parse({
      ...baseAuthoringValue,
      terminal: {
        mode: 'windows_terminal',
        windows: {
          launchMode: 'windows_terminal',
          console: 'visible',
          windowName: 'Happier QA',
        },
      },
    });

    expect(parsed.terminal).toEqual({
      mode: 'windows_terminal',
      windows: {
        launchMode: 'windows_terminal',
        console: 'visible',
        windowName: 'Happier QA',
      },
    });
    expect(SessionAuthoringValueV1Schema.safeParse({
      ...baseAuthoringValue,
      terminal: {
        windows: {
          launchMode: 'windows_terminal',
          leakedPrivateField: true,
        },
      },
    }).success).toBe(false);
  });

  it('rejects invalid authored values', () => {
    expect(() => SessionAuthoringValueV1Schema.parse({
      targetType: 'unknown',
      directory: '/tmp/project',
    })).toThrow();

    expect(() => SessionAuthoringValueV1Schema.parse({
      targetType: 'new_session',
      directory: '',
    })).toThrow();

    expect(() => SessionAuthoringValueV1Schema.parse({
      targetType: 'new_session',
      directory: '/tmp/project',
      codexBackendMode: 'bad-mode',
    })).toThrow();
  });
});
