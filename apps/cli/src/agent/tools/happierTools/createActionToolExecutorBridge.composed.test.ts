import { describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { AccountSettingsSchema, ActionsSettingsV1Schema, ApprovalRequestSchema, createRoleSourceReaderV1, SessionAgentSpawnPolicyV1StrictSchema, SessionSpawnNewInputV2Schema } from '@happier-dev/protocol';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createActionToolExecutorBridge } from './createActionToolExecutorBridge';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createBotTemplateActionExecuteV1 } from '@happier-dev/protocol/bots/templates/botTemplateOperations';
import { projectBotTemplateArtifactHeaderV1, type BotTemplateReleaseV1 } from '@happier-dev/protocol/bots/templates/botTemplateV1';

describe('createActionToolExecutorBridge composed host policy', () => {
  it.each([
    { surface: 'agent', accountId: 'owner', expectedRevision: { headerVersion: 1, bodyVersion: 1 } },
    { surface: 'mcp', accountId: 'owner', expectedRevision: { headerVersion: 1, bodyVersion: 1 } },
    { surface: 'agent', accountId: 'recipient', expectedRevision: undefined },
    { surface: 'mcp', accountId: 'recipient', expectedRevision: undefined },
  ] as const)('offers Copy approval through $surface for $accountId with the authenticated Session Machine and Agent', async ({ surface, accountId, expectedRevision }) => {
    const sessionId = 'parent-session';
    const artifactId = '84a6bc9c-0418-44f6-a593-8a751bde13e0';
    const agentTarget = { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } as const;
    const release: BotTemplateReleaseV1 = { v: 1, version: '1.0.0', changelog: '', releasedAtMs: 1,
      content: { v: 1, identity: { name: 'Helper', description: 'Reusable helper' }, instructions: { markdown: 'Help.' },
        memoryRules: [], skills: [], needs: { software: [], connectedAccounts: [], mcpServers: [] } } };
    const envelope = { v: 1 as const, state: 'released' as const, release };
    const forbiddenEffect = async (): Promise<never> => { throw new Error('Copy effects require person approval'); };
    // Only Artifact/Session persistence and native launch are system boundaries.
    // Tool dispatch, inherited-choice normalization and reviewed-child admission remain real.
    const template = createBotTemplateActionExecuteV1({ artifacts: {
      read: async id => id === artifactId ? { artifactId, ownerAccountId: 'owner', access: accountId === 'owner' ? 'owner' : 'view', shared: accountId !== 'owner',
        header: projectBotTemplateArtifactHeaderV1(envelope), body: JSON.stringify(envelope), revision: { headerVersion: 1, bodyVersion: 1 } } : null,
      create: forbiddenEffect, update: forbiddenEffect,
    }, readSourceDraftRef: async () => null, writeSourceDraftRef: forbiddenEffect, grant: forbiddenEffect,
      randomId: () => 'new-content', recipient: { readSession: forbiddenEffect, writeInstance: forbiddenEffect } });
    const approvals: unknown[] = [];
    let startContextAvailable = true;
    const executor = createActionExecutor({ botTemplateAction: template,
      prepareBotTemplateInstantiation: request => template.prepareInstantiation(request),
      approvalsCreate: async ({ request }) => { approvals.push(ApprovalRequestSchema.parse(request)); return { artifactId: 'copy-review' }; },
      sessionSpawnNew: forbiddenEffect,
    });
    const bridge = createActionToolExecutorBridge({ surface, executor: { execute: (id, input, context) => executor.execute(id, input, {
      ...context, serverId: 'home', serverIdentityId: 'home', runtimeAccountId: accountId,
      actionsSettings: ActionsSettingsV1Schema.parse({ v: 1 }),
      actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
      agentStartContext: startContextAvailable ? { caller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
        baseline: { machineId: 'current-machine', directory: '/repo', configuration: { agentTarget } },
        roles: {}, ledSubtreeSessionIds: [], workDepthLimit: 4, callerPermissionCeiling: 'default' } : undefined,
    }) }, resolveCallerPermissionMode: () => 'default',
      resolveActiveTurnPermissionWitness: () => ({ turnId: 'copy-turn', causalPermissionAuthority: {
        kind: 'admittedSessionInputV1', admittedPermissionCeiling: 'default' } }),
    });
    const input = { source: { kind: 'artifact', serverId: 'home', artifactId }, expectedVersion: '1.0.0',
      ...(expectedRevision ? { expectedRevision } : {}),
      creation: { creationKey: 'copy-current-machine', directory: { kind: 'managed' } } };
    const result = await bridge.executeActionByToolName('action_execute', { actionId: 'template.instantiate', input }, sessionId,
      { actionRequestId: 'copy-request' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: 'copy-review' } });
    expect(approvals).toEqual([expect.objectContaining({ actionId: 'template.instantiate', actionArgs: expect.objectContaining({
      expectedRevision: { headerVersion: 1, bodyVersion: 1 },
      creation: expect.objectContaining({ executionTarget: { serverId: 'home', machineId: 'current-machine' }, agentTarget }),
    }), preview: expect.objectContaining({ hostReviewedContent: expect.objectContaining({
      source: input.source, release, revision: { headerVersion: 1, bodyVersion: 1 },
    }), hostReviewedChildren: { children: expect.arrayContaining([
      { action: 'session.spawn_new', role: 'create_bot', input: expect.objectContaining({
        executionTarget: { serverId: 'home', machineId: 'current-machine' }, agentTarget,
        identity: { bot: { kind: 'bot' }, createdAsBot: true },
      }) },
    ]) } }) })]);
    approvals.length = 0;
    const explicit = { executionTarget: { serverId: 'home', machineId: 'chosen-machine' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
    const chosen = await bridge.executeActionByToolName('action_execute', { actionId: 'template.instantiate',
      input: { ...input, creation: { ...input.creation, ...explicit } } }, sessionId, { actionRequestId: 'chosen-copy' });
    expect(chosen, JSON.stringify(chosen)).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
    expect(approvals).toEqual([expect.objectContaining({ actionArgs: expect.objectContaining({
      creation: expect.objectContaining(explicit),
    }) })]);
    approvals.length = 0;
    for (const stale of [{ expectedVersion: '2.0.0' }, { expectedRevision: { headerVersion: 2, bodyVersion: 1 } }]) {
      const refused = await bridge.executeActionByToolName('action_execute', { actionId: 'template.instantiate',
        input: { ...input, ...stale } }, sessionId);
      expect(refused).toMatchObject({ ok: false, errorCode: 'version_mismatch' });
    }
    expect(approvals).toEqual([]);
    for (const malformed of [{ agentTarget: null }, { executionTarget: {} }, { sessionId: 'another-session' }]) {
      const refused = await bridge.executeActionByToolName('action_execute', { actionId: 'template.instantiate',
        input: { ...input, creation: { ...input.creation, ...malformed } } }, sessionId);
      expect(refused).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    }
    expect(approvals).toEqual([]);
    startContextAvailable = false;
    const unavailable = await bridge.executeActionByToolName('action_execute', { actionId: 'template.instantiate', input }, sessionId);
    expect(unavailable).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
    expect(approvals).toEqual([]);
  });

  it.each(['agent', 'mcp'] as const)('preserves canonical input diagnostics through the %s tool bridge', async surface => {
    const executor = createActionExecutor({} as ActionExecutorDeps);
    const bridge = createActionToolExecutorBridge({ surface, executor });
    const input = SessionSpawnNewInputV2Schema.parse({ creationKey: 'invalid-directory-bridge',
      executionTarget: { serverId: 'fixture-home', machineId: 'machine' }, directory: { kind: 'path', path: '/repo' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    });
    const result = await bridge.executeActionByToolName('action_execute', { actionId: 'session.spawn_new', input: {
      ...input,
      directory: { kind: 'local', path: '/private/submitted-path' },
    } }, 'parent-session');
    expect(ActionExecuteFailureSchema.parse(result)).toMatchObject({ errorCode: 'invalid_parameters', details: {
      issues: [{ code: 'invalid_union', path: ['directory', 'kind'], acceptedValues: ['path', 'managed'] }],
    } });
    expect(JSON.stringify(result)).not.toContain('/private/submitted-path');
  });

  it('reads current host permission mode and spawn policy for each Agent invocation', async () => {
    const credentials = { token: 'live-host-account', encryption: null };
    const accountSettings = AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1, actions: {
      'session.spawn_new': { approvalRequiredSurfaces: ['agent'] },
    } } });
    const previousSnapshot = getActiveAccountSettingsSnapshot();
    setActiveAccountSettingsSnapshot({ scopeKey: resolveAccountSettingsScopeKey(credentials), source: 'network',
      settings: accountSettings, rawSettings: {}, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    const app = fastify();
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture({ mode: 'plain' }));
    app.get('/v1/account/entity-rows/acp', async () => ({ status: 'present', revision: 1,
      content: { t: 'plain', v: { v: 1, definitions: [] } } }));
    const restoreHttp = installAxiosFastifyAdapter({ app, origin: resolveServerHttpBaseUrl() });
    const approvals: unknown[] = [];
    const spawn = vi.fn(async () => { throw new Error('Unapproved child must not start'); });
    // Only Home HTTP, Machine IPC and approval persistence are substituted.
    // Caller resolution, current policy, start admission and approval production stay real.
    const { executor } = createCliActionExecutorHarness({ token: credentials.token, credentials,
      sessionId: 'live-host', mode: 'plain', ctx: null,
      rawSession: { path: '/repo/current', machineId: 'live-machine', workDepth: 0 },
      getCurrentSessionMetadata: () => ({ path: '/repo/current', machineId: 'live-machine', permissionMode: 'read-only' }),
      getCurrentSessionBackendTarget: () => ({ kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } }),
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings, allowEnvironmentOverride: false }),
      readRoleSources: createRoleSourceReaderV1({}),
      sessionSpawnDirectTargetTransport: { machineId: 'live-machine',
        prepare: async () => ({ ok: true, directory: '/repo/child', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
        spawnedSession: { spawn, resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) },
      },
    }, { approvalsCreate: async ({ request }) => {
      approvals.push(ApprovalRequestSchema.parse(request));
      return { artifactId: 'child-approval' };
    } });
    let permissionMode = 'default';
    let spawnPolicy = SessionAgentSpawnPolicyV1StrictSchema.parse({ allowCustomDirectory: false });
    const bridge = createActionToolExecutorBridge({ surface: 'agent', executor,
      resolveCallerPermissionMode: () => permissionMode,
      getSessionAgentSpawnPolicyV1: () => spawnPolicy,
    });
    const input = { executionTarget: { serverId: 'fixture-home', machineId: 'live-machine' },
      directory: { kind: 'path', path: '/repo/child' }, permissionMode: 'yolo',
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    };
    const execute = () => bridge.executeActionByToolName('action_execute', { actionId: 'session.spawn_new', input }, 'live-host',
      { actionRequestId: 'live-child-request' });
    try {
      await expect(execute()).resolves.toMatchObject({ ok: false, errorCode: 'policy_denied_field', details: { field: 'directory' } });
      spawnPolicy = SessionAgentSpawnPolicyV1StrictSchema.parse({ allowCustomDirectory: true });
      await expect(execute()).resolves.toMatchObject({ ok: false, errorCode: 'permission_exceeds_ceiling' });
      expect(approvals).toEqual([]);
      permissionMode = 'yolo';
      const accepted = await execute();
      expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true,
        result: { kind: 'approval_request_created', artifactId: 'child-approval' } });
      expect(approvals).toEqual([expect.objectContaining({ actionId: 'session.spawn_new', actionArgs: expect.objectContaining(input) })]);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      restoreHttp();
      await app.close();
      if (previousSnapshot) setActiveAccountSettingsSnapshot(previousSnapshot);
      else resetActiveAccountSettingsSnapshotForTests();
    }
  });
});
