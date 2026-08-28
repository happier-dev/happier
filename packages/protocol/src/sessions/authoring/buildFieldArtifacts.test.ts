import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  SESSION_AUTHORING_FIELD_IDS,
  SESSION_AUTHORING_FIELD_DESCRIPTORS,
  SYNCED_SESSION_AUTHORING_FIELD_IDS_V1,
  SyncedSessionAuthoringFieldIdV1Schema,
  SyncedSessionAuthoringValueV1Schema,
  SessionAuthoringValueV1Schema,
  type SessionAuthoringFieldId,
  type SessionAuthoringValueV1,
} from './index.js';

describe('sessionAuthoring field artifacts', () => {
  it('derives synchronized draft fields from explicit safe catalog dispositions', () => {
    expect(SYNCED_SESSION_AUTHORING_FIELD_IDS_V1).toEqual(
      SESSION_AUTHORING_FIELD_IDS.filter((fieldId) => (
        SESSION_AUTHORING_FIELD_DESCRIPTORS[fieldId].draftStorage === 'sync'
      )),
    );
    expect(SYNCED_SESSION_AUTHORING_FIELD_IDS_V1).toEqual(expect.arrayContaining([
      'executionTarget',
      'directory',
      'checkoutCreationDraft',
      'organizationPlacement',
      'agentTarget',
      'modelSelection',
      'connectedServices',
      'terminal',
      'automation',
    ]));
    expect(SYNCED_SESSION_AUTHORING_FIELD_IDS_V1).not.toEqual(expect.arrayContaining([
      'prompt',
      'environmentVariables',
      'sessionConfigOptionOverrides',
      'sessionEncryptionKeyBase64',
    ]));
    expect(SyncedSessionAuthoringFieldIdV1Schema.safeParse('environmentVariables').success).toBe(false);
    expect(SyncedSessionAuthoringValueV1Schema.shape.terminal.safeParse({
      mode: 'tmux',
      tmux: { sessionName: 'safe', tmpDir: '/private/local/path' },
    }).success).toBe(false);
  });
  it('derives stable field ids and descriptors from one catalog', () => {
    expect(SESSION_AUTHORING_FIELD_IDS).toContain('targetType');
    expect(SESSION_AUTHORING_FIELD_IDS.slice(0, 5)).toEqual([
      'targetType',
      'executionTarget',
      'directory',
      'checkoutCreationDraft',
      'organizationPlacement',
    ]);
    expect(SESSION_AUTHORING_FIELD_IDS).toContain('directory');
    expect(SESSION_AUTHORING_FIELD_IDS).toContain('agentTarget');
    expect(SESSION_AUTHORING_FIELD_IDS).toContain('modelSelection');
    expect(SESSION_AUTHORING_FIELD_IDS).toContain('automation');
    expect(SESSION_AUTHORING_FIELD_IDS).not.toContain('workspaceId');
    expect(SESSION_AUTHORING_FIELD_IDS).not.toContain('workspaceLocationId');
    expect(SESSION_AUTHORING_FIELD_IDS).not.toContain('workspaceCheckoutId');
    expect(SESSION_AUTHORING_FIELD_IDS).not.toEqual(expect.arrayContaining([
      'machineId',
      'serverId',
      'agentId',
      'backendTarget',
    ]));

    expect(SESSION_AUTHORING_FIELD_DESCRIPTORS.targetType.storageClass).toBe('template');
    expect(SESSION_AUTHORING_FIELD_DESCRIPTORS.existingSessionId.defaultEditabilityByContext.automationExistingSession).toBe('inherited');

    expectTypeOf<SessionAuthoringFieldId>().toMatchTypeOf<(typeof SESSION_AUTHORING_FIELD_IDS)[number]>();
  });

  it('parses the shared authored value shape', () => {
    const parsed = SessionAuthoringValueV1Schema.parse({
      targetType: 'new_session',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      directory: '/tmp/project',
      checkoutCreationDraft: {
        kind: 'git_worktree',
        displayName: 'feature/auth',
        baseRef: 'main',
      },
      organizationPlacement: { folderId: 'folder-1', tagIds: ['tag-1', 'tag-2'] },
      prompt: 'ship it',
      displayText: 'ship it',
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'example.agents', localId: 'review-bot' },
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
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'codex',
        agent: { backendMode: 'appServer' },
      },
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
        triggers: [{
          clientId: 'schedule-1',
          kind: 'schedule',
          persisted: null,
          enabled: true,
          definition: {
            kind: 'schedule',
            schedule: { kind: 'interval', everyMs: 3_600_000, scheduleExpr: null, timezone: 'Europe/Zurich' },
          },
        }],
      },
    });

    expect(parsed.executionTarget).toEqual({ serverId: 'server-1', machineId: 'machine-1' });
    expect(parsed.organizationPlacement).toEqual({ folderId: 'folder-1', tagIds: ['tag-1', 'tag-2'] });
    expect(parsed.agentTarget).toEqual({
      kind: 'agent',
      identity: { pluginId: 'example.agents', localId: 'review-bot' },
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
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      directory: '/tmp/project',
      organizationPlacement: { folderId: null, tagIds: [] },
      displayText: 'ship it',
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
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'example.agents', localId: 'review-bot' },
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
      runtimeDescriptorV1: null,
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
        triggers: [],
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
    expect(SessionAuthoringValueV1Schema.safeParse({
      ...parsed,
      automation: { ...parsed.automation!, futureAutomationField: 123 },
    }).success).toBe(false);

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
      executionTarget: null,
      directory: '/tmp/project',
      checkoutCreationDraft: null,
      organizationPlacement: { folderId: null, tagIds: [] },
      prompt: '',
      displayText: '',
      agentTarget: null,
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
      runtimeDescriptorV1: null,
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
    for (const fieldId of ['machineId', 'serverId', 'agentId', 'backendTarget']) {
      expect(SyncedSessionAuthoringFieldIdV1Schema.safeParse(fieldId).success).toBe(false);
      expect(SyncedSessionAuthoringValueV1Schema.safeParse({
        [fieldId]: null,
      }).success).toBe(false);
    }

    expect(SessionAuthoringValueV1Schema.shape.executionTarget.parse({
      serverId: ' server-1 ',
      machineId: ' machine-1 ',
    })).toEqual({ serverId: 'server-1', machineId: 'machine-1' });

    expect(SESSION_AUTHORING_FIELD_DESCRIPTORS.organizationPlacement.schema.safeParse({
      folderId: null,
      tagIds: ['tag-1', 'tag-1'],
    }).success).toBe(false);

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
      runtimeDescriptorV1: {
        v: 1,
        agentId: '',
        agent: {},
      },
    })).toThrow();
  });
});
