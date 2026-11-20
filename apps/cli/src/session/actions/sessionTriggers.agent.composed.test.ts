import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { accountSettingsParse, AutomationDefinitionDetailSchema, AutomationDefinitionListItemSchema, AutomationDefinitionReconcileRequestSchema,
  createActionExecutor, createRoleSourceReaderV1, FeaturesResponseSchema, WorkflowDefinitionV1Schema,
  type ActionExecutorContext } from '@happier-dev/protocol';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createAccountEncryptionCurrentnessFixture, createSessionReadBatchResponseFixture,
  createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createCliActionDeps } from './createCliActionDeps';

afterEach(() => {
  vi.restoreAllMocks();
  resetActiveAccountSettingsSnapshotForTests();
});

it.each(['list', 'remove'] as const)('admits a led child trigger %s through real CLI caller resolution without injected start context', async operation => {
  const parentId = 'session-parent';
  const childId = 'session-child';
  const machineId = 'machine-one';
  const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'account-owner' })).toString('base64url')}.signature`;
  const serverHttpBaseUrl = 'https://trigger-agent.test';
  const backendTarget = { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' } as const;
  const metadata = { machineId, path: '/repo', flavor: 'codex' };
  const child = createSessionRecordFixture({ id: childId, encryptionMode: 'plain', active: false,
    machineId, metadata: JSON.stringify(metadata) });
  const definition = WorkflowDefinitionV1Schema.parse({ version: 1, blocks: [{ kind: 'wait', id: 'review',
    document: { text: 'Review', references: [], attachments: [] } }] });
  let row = AutomationDefinitionDetailSchema.parse({ id: 'automation-child', name: 'Child Habit', description: null,
    enabled: true, targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
    workflowDefinitionId: null, scopeSessionId: childId,
    executionRecipe: { v: 2, templateVersion: 1, workflow: { t: 'plain', v: { workspace: { directory: '/repo' },
      executionTarget: { kind: 'session' }, inlineDefinition: definition } }, triggerEvidence: null },
    assignments: [{ machineId, enabled: true, priority: 0, updatedAt: 1 }],
    triggers: [{ id: 'child-clock', revision: 0, kind: 'schedule', enabled: true, createdAt: 1, updatedAt: 1,
      nextRunAt: 2, triggerDefinitionEnvelope: null,
      schedule: { kind: 'interval', everyMs: 60_000, scheduleExpr: null, timezone: null } }],
  });
  let membershipReads = 0;
  let writes = 0;
  let led = true;
  // Only HTTP is substituted. The default CLI composition, caller snapshot
  // resolver, Session admission, Account codec and Action dispatch remain real.
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
    if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
    if (path === `/v2/sessions/${childId}`) return { status: 200, data: { session: child } };
    if (path.startsWith('/v1/artifacts/')) return { status: 404, data: { error: 'artifact_not_found' } };
    if (path === '/v3/automations') {
      // The HTTP summary deliberately omits private recipe/trigger envelopes.
      const { executionRecipe: _recipe, ...summary } = row;
      return { status: 200, data: { automations: [AutomationDefinitionListItemSchema.parse({ ...summary,
        triggers: row.triggers.map(({ triggerDefinitionEnvelope: _envelope, ...trigger }) => trigger),
      })], nextCursor: null } };
    }
    throw new Error(`unexpected_http_read:${path}`);
  });
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v2/sessions/read-batch') {
      membershipReads++;
      expect(body).toMatchObject({ underSessionId: parentId });
      return { status: 200, data: createSessionReadBatchResponseFixture({ request: body, sessions: led ? [child] : [] }) };
    }
    if (path === '/v3/automations/query') return { status: 200, data: { automations: [row], nextCursor: null } };
    throw new Error(`unexpected_http_post:${path}`);
  });
  vi.spyOn(axios, 'request').mockImplementation(async config => {
    const path = new URL(String(config.url)).pathname;
    if (path === AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 && config.method === 'GET') {
      return { status: 200, data: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) };
    }
    if (path === `/v3/automations/${row.id}` && config.method === 'GET') return { status: 200, data: row };
    if (path === `/v3/automations/${row.id}` && config.method === 'PUT') {
      const input = AutomationDefinitionReconcileRequestSchema.parse(config.data);
      writes++;
      row = AutomationDefinitionDetailSchema.parse({ ...row, templateVersion: row.templateVersion + 1,
        triggers: row.triggers.filter(trigger => !input.removedTriggers.some(removed => removed.triggerId === trigger.id)) });
      return { status: 200, data: row };
    }
    throw new Error(`unexpected_http_request:${config.method}:${path}`);
  });
  const rawSettings = { actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'workflow.trigger.remove': ['agent'] } } };
  const settings = accountSettingsParse(rawSettings);
  const scopeKey = runWithServerHttpBaseUrl(serverHttpBaseUrl, () => resolveAccountSettingsScopeKeyForToken(token));
  setActiveAccountSettingsSnapshot({ scopeKey, source: 'network', settings, rawSettings,
    settingsVersion: 1, settingsSecretsReadKeys: [], loadedAtMs: 1,
    promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
  const deps = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: parentId,
    mode: 'plain', ctx: null, serverId: 'home', serverHttpBaseUrl,
    getCurrentSessionMetadata: () => metadata, getCurrentSessionWorkDepth: () => 0,
    getCurrentSessionBackendTarget: () => backendTarget,
    getCurrentAppliedChildSelection: () => ({ status: 'applied', backendTarget, modelId: 'lead-model', connectedServices: null }),
    readRoleSources: createRoleSourceReaderV1({}),
    actionsSettingsProvider: createActionSettingsProvider({ scopeKey }),
    resolveServerFeaturesSnapshot: () => ({ status: 'ready', provenance: 'authenticated', features: FeaturesResponseSchema.parse({
      features: { automations: { enabled: true }, workflows: { enabled: true } }, capabilities: {},
    }) }),
  });
  const executor = createActionExecutor(deps);
  const diagnostics: unknown[] = [];
  const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation', serverId: 'home',
    defaultSessionId: parentId, callerPermissionMode: 'default', sessionAgentSpawnPolicyV1: settings.sessionAgentSpawnPolicyV1,
    actionsSettings: settings.actionsSettingsV1,
    recordActionStartDiagnostic: diagnostic => { diagnostics.push(diagnostic); },
    actionCaller: { kind: 'session', sessionId: parentId, starterDepth: 0, turnDepth: 0 } };
  const actionId = `workflow.trigger.${operation}` as const;
  const input = operation === 'list'
    ? { lifetimeSession: { sessionId: childId } }
    : { automationId: row.id, triggerId: 'child-clock' };
  const result = await executor.execute(actionId, input, context);
  expect(result, JSON.stringify({ result, diagnostics })).toMatchObject({ ok: true, result: operation === 'list'
    ? { lifetimeSession: { sessionId: childId }, sets: [{ automationId: row.id, triggers: [{ id: 'child-clock' }] }] }
    : { set: { automationId: row.id, triggers: [] } } });
  expect(membershipReads).toBe(1);
  expect(writes).toBe(operation === 'remove' ? 1 : 0);
  // Withdrawal affects the next Action, not already-admitted work.
  led = false;
  membershipReads = 0;
  expect(await executor.execute(actionId, input, context))
    .toMatchObject({ ok: false, errorCode: 'subtree_denied' });
  expect(membershipReads).toBe(1);
  expect(writes).toBe(operation === 'remove' ? 1 : 0);
});
