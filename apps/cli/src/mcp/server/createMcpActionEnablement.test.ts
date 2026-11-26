import { describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, accountSettingsParse, isApprovalRequiredByActionsSettings } from '@happier-dev/protocol';

import {
  createMcpActionEnablementWithServerFeatureAvailability,
  createMcpActionSettingsProvider,
} from './createMcpActionEnablement';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';

function readySnapshot(features: unknown, capabilities: unknown = {}): CliServerFeaturesSnapshot {
  return {
    status: 'ready',
    provenance: 'authenticated',
    features: FeaturesResponseSchema.parse({ features, capabilities }),
  };
}

const EXTERNAL_API_READY = Object.freeze({
  teams: {
    credentialResources: {
      externalApi: {
        available: true,
        baseUrl: 'https://home.example.com/api/provider-broker/v1',
        protocols: ['openai_responses', 'openai_chat_completions', 'anthropic_messages'],
      },
    },
  },
});

function createEnablement(snapshot: CliServerFeaturesSnapshot | undefined) {
  return createMcpActionEnablementWithServerFeatureAvailability({
    actionSettingsProvider: createMcpActionSettingsProvider({ accountSettings: null }),
    surface: 'api',
    hasAuthenticatedRuntime: true,
    readServerFeaturesSnapshot: () => snapshot,
    env: {},
  });
}

describe('Lane 10 Action feature availability', () => {
  it('preserves explicitly scoped invocation getters without borrowing focused Account policy', () => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({
      scopeKey: 'focused-bob', source: 'network', settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      settings: accountSettingsParse({ actionsSettingsV1: { v: 1, actions: { 'session.message.send': { enabled: true } } } }),
    });
    let admittedSettings: ReturnType<typeof accountSettingsParse> | null = accountSettingsParse({
      actionsSettingsV1: { v: 1, actions: { 'session.message.send': { enabled: false } } },
    });
    const provider = createMcpActionSettingsProvider({
      credentials: { token: 'runtime-alice' }, scopeKey: 'owning-alice', getAccountSettings: () => admittedSettings,
    });
    try {
      expect(provider.getActionsSettings().actions['session.message.send']?.enabled).toBe(false);
      admittedSettings = null;
      expect(provider.getAccountSettings()).toBeNull();
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });

  it('retains the Account role authority for Session-only policy readers', () => {
    resetActiveAccountSettingsSnapshotForTests();
    const rawSettings = { rolesV1: { overrides: { builder: { roleId: 'builder', workspaceWrites: 'deny' } } } };
    setActiveAccountSettingsSnapshot({ scopeKey: 'host-account', source: 'network', settingsVersion: 1,
      settings: accountSettingsParse(rawSettings), rawSettings, settingsSecretsReadKeys: [], loadedAtMs: 1,
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    try {
      const provider = createMcpActionSettingsProvider({ sessionCredentials: { token: 'session-policy-fixture' } });
      expect(provider.getAccountRoleOverrides()).toEqual({ status: 'ready',
        overrides: { builder: { roleId: 'builder', workspaceWrites: 'deny' } } });
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });

  it('retains a Session-only runtime approval waiver over ambient standalone CLI policy', () => {
    vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', JSON.stringify({ v: 1, actions: {} }));
    const params = {
      sessionCredentials: { token: 'session-policy-fixture' },
      accountSettings: accountSettingsParse({ actionsSettingsV1: {
        v: 1, approvalWaivedSurfaces: { 'browser.view.open': ['agent'] },
      } }),
    };
    try {
      const provider = createMcpActionSettingsProvider(params);
      expect(isApprovalRequiredByActionsSettings('browser.view.open', provider.getActionsSettings(), {
        surface: 'agent', authority: 'account_automation',
      })).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  it('reads the current host Session memory choice while preserving standalone Account and unrelated Actions', () => {
    let memoryEnabled = false;
    const policy = {
      actionSettingsProvider: createMcpActionSettingsProvider({ accountSettings: null }),
      surface: 'agent' as const,
      hasAuthenticatedRuntime: true,
      readServerFeaturesSnapshot: () => undefined,
      env: {},
    };
    const bound = createMcpActionEnablementWithServerFeatureAvailability({
      ...policy, readSessionMemoryEnabled: () => memoryEnabled,
    });
    for (const id of ['memory.remember', 'memory.update', 'memory.forget'] as const) {
      expect(bound(id), id).toBe(false);
      expect(createMcpActionEnablementWithServerFeatureAvailability({ ...policy, surface: 'mcp' })(id), id).toBe(true);
    }
    expect(bound('session.title.set')).toBe(true);
    memoryEnabled = true;
    for (const id of ['memory.remember', 'memory.update', 'memory.forget'] as const) expect(bound(id), id).toBe(true);
  });

  it('uses automation availability for native browser navigation even when sidecar is enabled', () => {
    const snapshot = (enabled: boolean) => readySnapshot({ browser: {
      enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true }, automation: { enabled },
    } });
    for (const id of ['browser.navigate', 'browser.goBack', 'browser.goForward', 'browser.reload', 'browser.stop'] as const) {
      expect(createEnablement(snapshot(false))(id)).toBe(false);
      expect(createEnablement(snapshot(true))(id)).toBe(true);
      expect(createEnablement(undefined)(id)).toBe(false);
    }
    expect(createEnablement(snapshot(false))('browser.control.handBack')).toBe(true);
  });
  it('advertises Account Actions for authenticated session agents without bypassing feature gates', () => {
    const snapshot = readySnapshot({
      sessions: { enabled: true, board: { enabled: true }, conversations: { enabled: true } },
      sharing: { session: { enabled: true } },
    });
    const policy = {
      actionSettingsProvider: createMcpActionSettingsProvider({ accountSettings: null }),
      surface: 'agent' as const,
      hasAuthenticatedRuntime: true,
      readServerFeaturesSnapshot: () => snapshot,
      env: {},
    };
    const restricted = createMcpActionEnablementWithServerFeatureAvailability({
      ...policy,
      authorityScope: 'session',
    });
    expect(restricted('machines.list')).toBe(true);
    expect(restricted('notifications.notify_me')).toBe(true);
    expect(restricted('workflow.trigger.list')).toBe(false);
    expect(restricted('session.board.get')).toBe(true);
    expect(restricted('discussion.list')).toBe(true);
    // Transcript reads are Machine-placed, but the exact Session read remains
    // a supported runtime capability. Scope is not a Session-only allowlist.
    expect(restricted('session.transcript.get')).toBe(true);
    expect(createMcpActionEnablementWithServerFeatureAvailability(policy)('machines.list')).toBe(true);
  });

  it('fails closed for false, missing, and malformed exact-Home feature bits', () => {
    expect(createEnablement(readySnapshot({
      teams: { enabled: true, credentialResources: { enabled: true } },
    }))('teams.credentials.create')).toBe(true);
    expect(createEnablement(readySnapshot({
      teams: { enabled: true, credentialResources: { enabled: false } },
    }))('teams.credentials.create')).toBe(false);
    // Saved Secrets are Account-owned. A Team audience is admitted by the
    // operation owner; the catalog does not impose a blanket Teams gate.
    expect(createEnablement(readySnapshot({}))('secrets.shared.create')).toBe(true);
    expect(createEnablement(readySnapshot({ teams: { enabled: false } }))('secrets.shared.create')).toBe(true);
    expect(createEnablement(readySnapshot({ teams: { enabled: true } }))('secrets.shared.create')).toBe(true);

    // Malformation of the bit this family actually depends on: not a boolean is
    // not `true`, and a malformed sibling credential bit cannot stand in for it.
    const malformed = {
      status: 'ready',
      provenance: 'authenticated',
      features: {
        features: { teams: { enabled: 'yes', credentialResources: { enabled: true } } },
        capabilities: {},
      },
    } as unknown as CliServerFeaturesSnapshot;
    expect(createEnablement(malformed)('secrets.shared.update')).toBe(true);
    expect(createEnablement(malformed)('teams.create')).toBe(false);
    expect(createEnablement(malformed)('teams.credentials.create')).toBe(false);
  });

  it('requires the external API child bit only for external-key Actions', () => {
    const parentOnly = readySnapshot({
      teams: { enabled: true, credentialResources: { enabled: true } },
    });
    expect(createEnablement(parentOnly)('teams.credentials.create')).toBe(true);
    expect(createEnablement(parentOnly)('teams.credentials.externalKeys.create')).toBe(false);

    const externalEnabled = readySnapshot({
      teams: {
        enabled: true,
        credentialResources: { enabled: true, externalApi: { enabled: true } },
      },
    }, EXTERNAL_API_READY);
    expect(createEnablement(externalEnabled)('teams.credentials.externalKeys.create')).toBe(true);
    expect(createEnablement(externalEnabled)('account.apiTokens.create')).toBe(true);
  });

  it('advertises external-key Actions only when the Home can actually serve the external API', () => {
    const features = {
      teams: {
        enabled: true,
        credentialResources: { enabled: true, externalApi: { enabled: true } },
      },
    };
    // The child bit says the capability is switched on; the canonical readiness
    // owner says this deployment cannot serve it. Advertisement follows the
    // composed operation decision, not the bit alone.
    const notPublicHttps = readySnapshot(features, {
      teams: {
        credentialResources: {
          externalApi: { available: false, reason: 'home_not_public_https' },
        },
      },
    });
    expect(createEnablement(notPublicHttps)('teams.credentials.externalKeys.create')).toBe(false);
    // A Home whose projection carries no readiness at all is equally unusable.
    expect(createEnablement(readySnapshot(features))('teams.credentials.externalKeys.create')).toBe(false);
    // Sibling families keep depending on their own bit only.
    expect(createEnablement(notPublicHttps)('teams.credentials.create')).toBe(true);
  });
});

describe('Voice MCP target-policy handoff', () => {
  it('lets the App apply the target profile instead of the carrier Account Off', async () => {
    const actionSettingsProvider = createMcpActionSettingsProvider({ accountSettings: accountSettingsParse({
      actionsSettingsV1: { v: 1, actions: { 'memory.remember': { enabled: false } } },
    }) });
    const params = { actionSettingsProvider, hasAuthenticatedRuntime: true,
      readServerFeaturesSnapshot: () => undefined, env: {} };
    expect(createMcpActionEnablementWithServerFeatureAvailability({ ...params, surface: 'agent' })('memory.remember')).toBe(false);
    expect(createMcpActionEnablementWithServerFeatureAvailability({ ...params, surface: 'voice' })('memory.remember')).toBe(true);
    const { applyApprovalProfileOverlayV1 } = await import('@happier-dev/protocol/actions/approvalProfiles');
    const { isActionEnabledByActionsSettings } = await import('@happier-dev/protocol/actions/actionSettings');
    const targetPolicy = applyApprovalProfileOverlayV1(actionSettingsProvider.getActionsSettings(), {
      id: 'working-session', name: 'Working Session',
      actions: { 'memory.remember': { enabled: true, approvalRequiredSurfaces: ['voice'] } },
    });
    expect(isActionEnabledByActionsSettings('memory.remember', targetPolicy, { surface: 'voice' })).toBe(true);
    expect(isApprovalRequiredByActionsSettings('memory.remember', targetPolicy, { surface: 'voice' })).toBe(true);
    expect(actionSettingsProvider.getActionsSettings().actions['memory.remember']?.enabled).toBe(false);
    const targetOff = applyApprovalProfileOverlayV1(actionSettingsProvider.getActionsSettings(), {
      id: 'target-off', name: 'Target Off', actions: { 'memory.remember': { enabled: false } },
    });
    expect(isActionEnabledByActionsSettings('memory.remember', targetOff, { surface: 'voice' })).toBe(false);
  });

  it('carries the exact Home feature refusal into Action availability', async () => {
    const { resolveActionSurfaceAvailability } = await import('@happier-dev/protocol/actions/actionSurfaceAvailability');
    let snapshot = readySnapshot({ sessions: { enabled: true, conversations: { enabled: true } }, sharing: { session: { enabled: true } } });
    const isActionEnabled = createMcpActionEnablementWithServerFeatureAvailability({
      actionSettingsProvider: createMcpActionSettingsProvider({ accountSettings: null }),
      surface: 'voice', hasAuthenticatedRuntime: true,
      readServerFeaturesSnapshot: () => snapshot, env: {},
    });
    expect(resolveActionSurfaceAvailability({ actionId: 'discussion.list', surface: 'voice', isActionEnabled }).available).toBe(true);
    snapshot = readySnapshot({ sessions: { enabled: true, conversations: { enabled: false } }, sharing: { session: { enabled: true } } });
    expect(isActionEnabled('discussion.list')).toBe(false);
    expect(resolveActionSurfaceAvailability({ actionId: 'discussion.list', surface: 'voice', isActionEnabled })).toMatchObject({
      available: false, featureDecision: { featureId: 'sessions.conversations', state: 'disabled', blockedBy: 'server', blockerCode: 'feature_disabled' },
    });
  });

  it('distinguishes absence of authenticated runtime from Actions policy', async () => {
    const { resolveActionSurfaceAvailability } = await import('@happier-dev/protocol/actions/actionSurfaceAvailability');
    const isActionEnabled = createMcpActionEnablementWithServerFeatureAvailability({
      actionSettingsProvider: createMcpActionSettingsProvider({ accountSettings: null }),
      surface: 'voice', hasAuthenticatedRuntime: false,
      readServerFeaturesSnapshot: () => readySnapshot({ sessions: { enabled: true, conversations: { enabled: true } }, sharing: { session: { enabled: true } } }), env: {},
    });
    expect(resolveActionSurfaceAvailability({ actionId: 'discussion.list', surface: 'voice', isActionEnabled })).toMatchObject({
      available: false, authenticatedRuntime: false,
    });
  });
});

describe('MCP availability consumers', () => {
  it('uses the Voice handoff view for inventory while retaining agent Account Off', async () => {
    const { createSessionActionSettingsView } = await import('@/settings/actionsSettingsProvider');
    const { createHappierToolInventory } = await import('@/agent/tools/happierTools/listBuiltInHappierTools');
    const { resolveSessionNativeToolDescriptors } = await import('@/agent/tools/happierTools/resolveSessionNativeToolBridge');
    const provider = createMcpActionSettingsProvider({ accountSettings: accountSettingsParse({
      actionsSettingsV1: { v: 1, actions: { 'session.title.set': { enabled: false }, 'memory.remember': { enabled: false } } },
    }) });
    const agentView = createSessionActionSettingsView(provider, () => null, 'agent');
    expect(agentView.getActionsSettings()).toBe(provider.getActionsSettings());
    const profiledProvider = { ...provider, getApprovalProfiles: () => [{ id: 'carrier-off', access: 'owner' as const,
      profile: { id: 'carrier-off', name: 'Carrier Off', actions: { 'session.title.set': { enabled: false }, 'memory.remember': { enabled: false } } },
      revision: { headerVersion: 1, bodyVersion: 1 } }] };
    for (const surface of ['voice', 'agent'] as const) {
      const view = createSessionActionSettingsView(profiledProvider, () => ({ approvalProfileId: 'carrier-off' }), surface);
      const isActionEnabled = createMcpActionEnablementWithServerFeatureAvailability({ actionSettingsProvider: view,
        surface, hasAuthenticatedRuntime: true, readServerFeaturesSnapshot: () => undefined, env: {} });
      const inventory = createHappierToolInventory({ surface, isActionEnabled, actionsSettings: view.getActionsSettings() });
      expect(inventory.tools.some(tool => tool.name === 'memory_remember')).toBe(surface === 'voice');
      const descriptors = resolveSessionNativeToolDescriptors({ surface, accountSettings: { actionsSettingsV1: provider.getActionsSettings() },
        sessionId: 'carrier', memoryRecallGuidanceEnabled: false, sessionMemoryEnabled: false, isServerFeatureEnabled: () => true });
      expect(descriptors.some(tool => tool.name === 'change_title')).toBe(false);
      expect(descriptors.some(tool => tool.name === 'memory_remember')).toBe(surface === 'voice');
    }
  });

  it('returns the typed feature cause through direct and generic MCP dispatch', async () => {
    const { createActionToolExecutorBridge } = await import('@/agent/tools/happierTools/createActionToolExecutorBridge');
    const { createActionExecutor } = await import('@happier-dev/protocol/actions/actionExecutor');
    const { formatHappierMcpToolFailure } = await import('@/mcp/server/registerHappierMcpBuiltInTools');
    const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
    let snapshot = readySnapshot({ sessions: { enabled: true, conversations: { enabled: true } }, sharing: { session: { enabled: true } } });
    const isActionEnabled = createMcpActionEnablementWithServerFeatureAvailability({
      actionSettingsProvider: createMcpActionSettingsProvider({ accountSettings: null }),
      surface: 'voice', hasAuthenticatedRuntime: true, readServerFeaturesSnapshot: () => snapshot, env: {},
    });
    const bridge = createActionToolExecutorBridge({ surface: 'voice', executor: createActionExecutor({}), isActionEnabled });
    expect(bridge.isActionEnabled('discussion.list')).toBe(true);
    snapshot = readySnapshot({ sessions: { enabled: true, conversations: { enabled: false } }, sharing: { session: { enabled: true } } });
    const toolName = getActionSpec('discussion.list').bindings!.mcpToolName!;
    for (const [name, input] of [[toolName, {}], ['action_execute', { actionId: 'discussion.list', input: {} }]] as const) {
      const result = await bridge.executeActionByToolName(name, input, 'carrier');
      expect(result).toMatchObject({
        ok: false, errorCode: 'action_disabled', details: { featureDecision: {
          featureId: 'sessions.conversations', state: 'disabled', blockerCode: 'feature_disabled', blockedBy: 'server',
        } },
      });
      if (result.ok) throw new Error('Expected feature refusal');
      const formatted = formatHappierMcpToolFailure(result, { actionId: 'discussion.list' });
      const text = formatted.content.find(block => block.type === 'text');
      if (text?.type !== 'text') throw new Error('Expected MCP text failure');
      expect(JSON.parse(text.text)).toMatchObject({ errorCode: 'action_disabled', details: {
        reason: 'disabled_by_policy', featureDecision: { featureId: 'sessions.conversations', blockerCode: 'feature_disabled' },
      } });
    }
  });
});
