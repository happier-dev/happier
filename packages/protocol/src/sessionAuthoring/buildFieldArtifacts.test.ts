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
      modelId: 'gpt-5',
      modelUpdatedAt: 124,
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
    expectTypeOf<typeof parsed>().toMatchTypeOf<SessionAuthoringValueV1>();
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

    expect(() => SessionAuthoringValueV1Schema.parse({
      targetType: 'new_session',
      directory: '/tmp/project',
      workspaceId: 'workspace-1',
    })).toThrow();
  });
});
