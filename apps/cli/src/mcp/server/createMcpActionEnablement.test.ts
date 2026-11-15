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
