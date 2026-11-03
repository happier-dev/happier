import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema, AccountSettingsV2UpdateRequestSchema, accountSettingsParse } from '@happier-dev/protocol';
import type { AccountSettingsStoredContentEnvelope } from '@happier-dev/protocol';
import { ACCOUNT_SETTING_DECLARATIONS_V1 } from '@happier-dev/protocol/actions/accountSettingDeclarations';
import { SettingsDeclarationActionOutputSchemasV1 } from '@happier-dev/protocol/actions/settingsDeclarationActionFamily';

import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { createCliActionExecutor } from './createCliActionExecutor';
import { createCliActionExecutorHarness } from './createCliActionExecutorHarness';
import { createSignedInSummaryCatalogFixture } from './settingsCatalog.test-support';
import { createCliSettingsCatalogServices } from './settingsCatalogServices';
import { emptyConnectedAccountCatalogRecordV1 } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';

const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1, actions: { 'settings.set': { enabled: true } } });

describe('CLI declared Account settings', () => {
  let content: AccountSettingsStoredContentEnvelope;
  let version: number;
  let conflict: boolean;
  let concurrentContent: AccountSettingsStoredContentEnvelope | null;

  beforeEach(() => {
    resetInMemoryAccountSettingsContextForTests();
    content = { t: 'plain', v: { favoriteMachines: ['neighbor'] } };
    version = 1;
    conflict = false;
    concurrentContent = null;
    // HTTP is the system boundary. Admission, declarations, validation, encryption-mode
    // checks, sparse mutation and the existing CAS retry owner remain real.
    vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: version,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (url.endsWith('/v1/account/entity-rows/connected-accounts/purposes')) return { status: 200, data: {
        status: 'present', revision: 1, content: { t: 'plain', v: emptyConnectedAccountCatalogRecordV1('purposes') },
      } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content, version } };
      throw new Error(`Unexpected HTTP read: ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      if (!url.endsWith('/v2/account/settings')) throw new Error(`Unexpected HTTP write: ${url}`);
      const request = AccountSettingsV2UpdateRequestSchema.parse(raw);
      if (conflict) {
        conflict = false;
        version += 1;
        content = concurrentContent ?? { t: 'plain', v: { favoriteMachines: ['concurrent'], futureSetting: 'preserved',
          ...(content.t === 'plain' && content.v.sessionAgentSpawnPolicyV1 ? { sessionAgentSpawnPolicyV1: {
            ...accountSettingsParse(content.v).sessionAgentSpawnPolicyV1, allowModelOverride: false,
          } } : {}),
        } };
        return { status: 200, data: { success: false, error: 'version-mismatch', currentVersion: version, currentContent: content } };
      }
      expect(request.expectedVersion).toBe(version);
      if (!request.content) throw new Error('Expected stored settings');
      content = request.content;
      version += 1;
      return { status: 200, data: { success: true, version } };
    });
  });

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetInMemoryAccountSettingsContextForTests(); });

  function executor(token = 'settings-parity-test') {
    return createCliActionExecutorHarness({
      token, sessionId: 'settings-parity', mode: 'plain', ctx: null, serverId: 'settings-home',
      serverHttpBaseUrl: 'https://settings-home.test',
      credentials: { token, encryption: null },
    }).executor;
  }
  const user = { surface: 'cli', authority: 'present_user', actionsSettings,
    presentUserConfirmation: { actionId: 'settings.set' } } as const;

  it('applies typed global, placement and tool policy intents through the real Account CAS owner', async () => {
    content = { t: 'plain', v: { favoriteMachines: ['neighbor'], actionsSettingsV1: { v: 1, actions: {
      'capture.view': { futurePolicy: { retained: true } },
    } } } };
    concurrentContent = { t: 'plain', v: { favoriteMachines: ['concurrent'], actionsSettingsV1: { v: 1, actions: {
      'capture.view': { futurePolicy: { retained: true }, disabledSurfaces: ['cli'] },
      'session.stop': { enabled: false },
    } } } };
    conflict = true;
    const owner = executor();
    const context = { ...user, presentUserConfirmation: { actionId: 'actions.policy.set' } } as const;
    for (const change of [
      { kind: 'enabled', enabled: false },
      { kind: 'audience_enabled', audience: 'agent', enabled: false },
      { kind: 'placement', placement: 'agent_input_chips', enabled: true },
      { kind: 'placement_policy', placement: 'slash_command', mode: 'ask_first' },
      { kind: 'tool_exposure', surface: 'mcp', mode: 'discoverable_only' },
      { kind: 'plugin_host_capture', pluginId: 'acme.capture', approvalRequired: false },
    ]) {
      const input = { actionId: change.kind === 'tool_exposure' ? 'settings.get' : 'capture.view', change };
      expect(await owner.execute('actions.policy.set', input, context))
        .toMatchObject({ ok: true, result: input });
    }
    expect(content).toMatchObject({ t: 'plain', v: { favoriteMachines: ['concurrent'], actionsSettingsV1: { actions: {
      'capture.view': { enabled: false, disabledSurfaces: ['cli', 'agent'], enabledPlacements: ['agent_input_chips'],
        approvalRequiredSurfaces: ['ui'], futurePolicy: { retained: true } },
      'settings.get': { toolExposureModes: { mcp: 'discoverable_only' } },
      'session.stop': { enabled: false },
    }, pluginHostCaptureApprovalWaived: ['acme.capture'] } } });
  });

  it('changes exact Action policy headlessly and restores Default over a conflicting Account snapshot', async () => {
    const prior = { v: 1, actions: {
      'prompt_doc.update': { enabled: false, disabledSurfaces: ['agent', 'cli'], approvalRequiredSurfaces: ['mcp'],
        enabledPlacements: ['agent_input_chips'], toolExposureModes: { agent: 'discoverable_only' } },
      'future.action': { enabled: false, futurePreference: 'retained' },
    } };
    content = { t: 'plain', v: { favoriteMachines: ['neighbor'], actionsSettingsV1: prior } };
    concurrentContent = { t: 'plain', v: { futureSetting: 'preserved', actionsSettingsV1: { ...prior,
      actions: { ...prior.actions, 'prompt_doc.create': { disabledSurfaces: ['mcp'] } },
    } } };
    conflict = true;
    const owner = executor();
    const target = { actionId: 'prompt_doc.update', audience: 'agent' } as const;
    const context = { ...user, presentUserConfirmation: { actionId: 'actions.policy.set' } } as const;
    for (const mode of ['allowed', 'ask_first', 'off', 'default'] as const) {
      const written = await owner.execute('actions.policy.set', { ...target, mode }, context);
      expect(written, JSON.stringify(written)).toMatchObject({ ok: true, result: { ...target, mode, actionEnabled: false, enabled: false } });
      expect(await owner.execute('actions.policy.get', target, context))
        .toMatchObject({ ok: true, result: { ...target, mode, actionEnabled: false, enabled: false } });
      expect(content).toMatchObject({ t: 'plain', v: { futureSetting: 'preserved', actionsSettingsV1: { actions: {
        'prompt_doc.update': { enabled: false, enabledPlacements: ['agent_input_chips'], toolExposureModes: { agent: 'discoverable_only' },
          approvalRequiredSurfaces: mode === 'ask_first' ? ['mcp', 'agent'] : ['mcp'],
          disabledSurfaces: mode === 'off' ? ['cli', 'agent'] : ['cli'] },
        'prompt_doc.create': { disabledSurfaces: ['mcp'] },
        'future.action': { enabled: false, futurePreference: 'retained' },
      } } } });
    }
    expect(content.t === 'plain' && accountSettingsParse(content.v).actionsSettingsV1.approvalWaivedSurfaces?.['prompt_doc.update']).toBeUndefined();
    expect(await owner.execute('actions.policy.set', { ...target, mode: 'off' }, context)).toMatchObject({ ok: true });
    expect(await owner.execute('actions.policy.reset', target, { ...context, presentUserConfirmation: { actionId: 'actions.policy.reset' } }))
      .toMatchObject({ ok: true, result: { ...target, mode: 'default', actionEnabled: false, enabled: false } });
    expect(content).toMatchObject({ t: 'plain', v: { actionsSettingsV1: { actions: {
      'prompt_doc.update': { enabled: false, disabledSurfaces: ['cli'], approvalRequiredSurfaces: ['mcp'] },
      'future.action': { enabled: false, futurePreference: 'retained' },
    } } } });
    expect(await owner.execute('actions.policy.set', { ...target, mode: 'allowed', reversal: { kind: 'restore' } }, context))
      .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await owner.execute('settings.set', { anchor: 'actionsSettingsV1', value: { v: 1, actions: {} } }, user))
      .toMatchObject({ ok: false, errorCode: 'setting_not_found' });
  });

  it('discovers the shared Settings catalog without an answering client and reads Account declarations headlessly', async () => {
    const owner = executor();
    const listed = await owner.execute('settings.list', {}, user);
    expect(listed).toMatchObject({ ok: true, result: { items: expect.arrayContaining([
      expect.objectContaining({ anchor: 'delegation.workDepthLimit', storageScope: 'account', readable: true, writable: true }),
      expect.objectContaining({ anchor: 'actions.createSession.allowEnvironmentVariables', storageScope: 'account' }),
      expect.objectContaining({ anchor: 'appearance.themeMode', storageScope: 'local' }),
      expect.objectContaining({ anchor: 'appearance.avatarStyle', storageScope: 'account' }),
    ]) } });
    expect(axios.get).not.toHaveBeenCalled();
    expect(await owner.execute('settings.get', { anchor: 'delegation.workDepthLimit' }, user)).toEqual({ ok: true, result: { anchor: 'delegation.workDepthLimit', value: 4 } });
    expect(await owner.execute('settings.get', { anchor: 'delegation.approvalReviewerEnabled' }, user)).toEqual({ ok: true, result: { anchor: 'delegation.approvalReviewerEnabled', value: false } });
  });

  it('writes ordinary shared Account declarations headlessly with canonical validation and readback', async () => {
    const anchor = 'appearance.tabBarGitBadge';
    expect(await executor().execute('settings.set', { anchor, value: 'off' }, user))
      .toMatchObject({ ok: true, result: { anchor, value: 'off' } });
    expect(await executor().execute('settings.get', { anchor }, user))
      .toMatchObject({ ok: true, result: { anchor, value: 'off' } });
    expect(await executor().execute('settings.set', { anchor, value: 'invented-mode' }, user))
      .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
    expect(content).toEqual({ t: 'plain', v: { favoriteMachines: ['neighbor'], tabBarGitBadgeMode: 'off' } });
  });

  it('rebases a keyed terminal-host change over another Machine without replacing Account settings', async () => {
    concurrentContent = { t: 'plain', v: {
      favoriteMachines: ['concurrent'], futureSetting: 'preserved',
      sessionTmuxByMachineId: { neighbor: { useTmux: true, sessionName: 'neighbor-work', isolated: true, tmpDir: null } },
      sessionTerminalHostByMachineId: { neighbor: 'zellij' },
    } };
    conflict = true;
    const owner = executor();
    const anchor = 'machines.terminal.host';
    const key = 'machine-a';
    const value = { host: 'herdr', tmux: { sessionName: 'my-work' } } as const;
    expect(await owner.execute('settings.set', { anchor, key, value }, user))
      .toMatchObject({ ok: true, result: { anchor, value } });
    expect(await owner.execute('settings.get', { anchor, key }, user))
      .toMatchObject({ ok: true, result: { anchor, value: { host: 'herdr', tmux: { sessionName: 'my-work' } } } });
    expect(content).toMatchObject({ t: 'plain', v: {
      favoriteMachines: ['concurrent'], futureSetting: 'preserved',
      sessionTmuxByMachineId: {
        neighbor: { useTmux: true, sessionName: 'neighbor-work', isolated: true, tmpDir: null },
        'machine-a': { useTmux: false, sessionName: 'my-work' },
      },
      sessionTerminalHostByMachineId: { neighbor: 'zellij', 'machine-a': 'herdr' },
    } });
  });

  it('resets only the declared Account preference through the current CAS writer', async () => {
    content = { t: 'plain', v: { favoriteMachines: ['neighbor'], tabBarGitBadgeMode: 'off',
      futurePreference: { preserved: true } } };
    const anchor = 'appearance.tabBarGitBadge';
    const value = accountSettingsParse({}).tabBarGitBadgeMode;
    expect(await executor().execute('settings.reset', { anchor }, { ...user,
      presentUserConfirmation: { actionId: 'settings.reset' } }))
      .toEqual({ ok: true, result: { anchor, value } });
    expect(version).toBe(2);
    expect(content).toEqual({ t: 'plain', v: { favoriteMachines: ['neighbor'], tabBarGitBadgeMode: value,
      futurePreference: { preserved: true } } });
  });

  it('sets and resets one Machine connection choice through the discovered Account Action and preserves CAS siblings', async () => {
    const anchor = 'machines.connection.direct';
    const policy = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'settings.set': ['agent'] } });
    const flows = { machine_rpc: { direct: 'disabled' } } as const;
    const neighbor = { flows: { machine_rpc: { direct: 'enabled' } } } as const;
    concurrentContent = { t: 'plain', v: { futureSetting: 'preserved', peerMediationPreferencesV1: {
      v: 1, flows, byMachineId: { neighbor },
    } } };
    conflict = true;
    const owner = executor();
    const agent = { surface: 'agent', authority: 'account_automation', actionsSettings: policy } as const;
    expect(await owner.execute('settings.list', { pageId: 'machines' }, agent)).toMatchObject({ ok: true, result: {
      items: expect.arrayContaining([expect.objectContaining({ anchor, readable: true, writable: true, storageScope: 'account' })]),
    } });
    for (const value of ['direct', 'relay', 'default'] as const) {
      const set = await owner.execute('settings.set', { anchor, key: 'machine-a', value }, agent);
      expect(set).toMatchObject({ ok: true, result: { anchor, value } });
      if (set.ok) SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(set.result);
      const get = await owner.execute('settings.get', { anchor, key: 'machine-a' }, agent);
      expect(get).toMatchObject({ ok: true, result: { anchor, value } });
      if (get.ok) SettingsDeclarationActionOutputSchemasV1['settings.get'].parse(get.result);
      expect(content).toMatchObject({ t: 'plain', v: { futureSetting: 'preserved', peerMediationPreferencesV1: {
        flows, byMachineId: { neighbor },
      } } });
    }
    expect(content.t === 'plain' && accountSettingsParse(content.v).peerMediationPreferencesV1.byMachineId['machine-a']).toBeUndefined();
    expect(await owner.execute('settings.set', { anchor, value: 'direct' }, agent)).toMatchObject({ ok: false, errorCode: 'setting_key_required' });
    expect(await owner.execute('settings.set', { anchor, key: 'machine-a', value: { direct: true } }, agent)).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
    expect(await owner.execute('settings.set', { anchor, key: 'machine-a', value: 'direct', target: { kind: 'home', serverId: 'other-home' } }, agent))
      .toMatchObject({ ok: false, errorCode: 'setting_target_mismatch' });
  });

  it('conditionally resets raw presence without a receipt across unrelated Account writes and refuses affected-key drift', async () => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'settings-account' })).toString('base64url')}.signature`;
    const owner = executor(token);
    const anchor = 'sourceControl.explainChanges';
    content = { t: 'plain', v: { favoriteMachines: ['neighbor'], 'scm.diffSummary.enabled': true } };
    version = 1235;
    concurrentContent = { t: 'plain', v: { favoriteMachines: ['concurrent'], 'scm.diffSummary.enabled': true } };
    conflict = true;
    const context = { ...user, presentUserConfirmation: { actionId: 'settings.reset' as const } };
    const reset = await owner.execute('settings.reset', { anchor, expected: { value: true } }, context);
    expect(reset).toEqual({ ok: true, result: { anchor, value: true } });
    if (reset.ok) SettingsDeclarationActionOutputSchemasV1['settings.reset'].parse(reset.result);
    expect(content).toEqual({ t: 'plain', v: { favoriteMachines: ['concurrent'] } });
    content = { t: 'plain', v: { favoriteMachines: ['concurrent'], 'scm.diffSummary.enabled': false } };
    version += 1;
    expect(await owner.execute('settings.reset', { anchor, expected: { value: true } }, context))
      .toMatchObject({ ok: false, errorCode: 'account_settings_conflict' });
    expect(content).toEqual({ t: 'plain', v: { favoriteMachines: ['concurrent'], 'scm.diffSummary.enabled': false } });
  });

  it('conditionally resets a nested declaration leaf without comparing its enclosing storage object', async () => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'settings-account' })).toString('base64url')}.signature`;
    const homeAtmosphere = accountSettingsParse({}).homeAtmosphere;
    const anchor = 'appearance.atmospherePlanetDigits';
    content = { t: 'plain', v: { favoriteMachines: ['neighbor'], homeAtmosphere: {
      ...homeAtmosphere, planet: { ...homeAtmosphere.planet, digits: false },
    } } };
    const context = { ...user, presentUserConfirmation: { actionId: 'settings.reset' as const } };
    expect(await executor(token).execute('settings.reset', { anchor, expected: { value: false } }, context))
      .toMatchObject({ ok: true, result: { anchor, value: true } });
    expect(content).toMatchObject({ t: 'plain', v: { favoriteMachines: ['neighbor'],
      homeAtmosphere: { planet: { digits: true } },
    } });

    expect(await executor(token).execute('settings.reset', { anchor, expected: { value: false } }, context))
      .toMatchObject({ ok: false, errorCode: 'account_settings_conflict' });
  });

  it('isolates provider state through the consent owner without requiring catalog evidence or replacing configuration', async () => {
    const sharing = accountSettingsParse({}).connectedServicesProviderStateSharingSettingsV1;
    content = { t: 'plain', v: { favoriteMachines: ['neighbor'], connectedServicesProviderStateSharingSettingsV1: {
      ...sharing, defaults: { ...sharing.defaults, configMode: 'copied', stateMode: 'shared' },
    } } };
    const anchor = 'connectedServicesAgentSignIn.sharingState';
    expect(await executor().execute('settings.set', { anchor, value: false }, user))
      .toMatchObject({ ok: true, result: { anchor, value: false } });
    expect(await executor().execute('settings.get', { anchor }, user))
      .toMatchObject({ ok: true, result: { anchor, value: false } });
    expect(content).toMatchObject({ t: 'plain', v: { favoriteMachines: ['neighbor'],
      connectedServicesProviderStateSharingSettingsV1: { defaults: { configMode: 'copied', stateMode: 'isolated' } },
    } });
    expect(await executor().execute('settings.set', { anchor, value: 'false' }, user))
      .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
  });

  it.each([
    ['connectedServicesAgentSignIn.sharingState', true],
    ['connectedServicesAgentSignIn.sharingPerAgent', { agentId: 'codex', stateMode: 'shared' }],
  ] as const)('honors an Agent Action waiver when sharing state through %s', async (anchor, value) => {
    const policy = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'settings.set': ['agent'] } });
    content = { t: 'plain', v: { actionsSettingsV1: policy, favoriteMachines: ['neighbor'],
      connectedServicesProviderStateSharingSettingsV1: { v: 1,
        defaults: { configMode: 'copied', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
      },
    } };
    expect(await executor().execute('settings.set', { anchor, value }, {
      surface: 'agent', authority: 'account_automation', actionsSettings: policy,
    })).toMatchObject({ ok: true, result: { anchor, value } });
    expect(content).toMatchObject({ t: 'plain', v: { favoriteMachines: ['neighbor'],
      connectedServicesProviderStateSharingSettingsV1: {
        defaults: { configMode: 'copied', stateMode: anchor.endsWith('sharingState') ? 'shared' : 'isolated' },
        acknowledgedRisksByAgentId: { codex: { sharedStatePrivacy: true } },
        ...(anchor.endsWith('sharingPerAgent') ? { byAgentId: { codex: { stateMode: 'shared' } } } : {}),
      },
    } });
  });

  it('writes Voice choices through their canonical persistence projection without replacing neighboring settings', async () => {
    content = { t: 'plain', v: { favoriteMachines: ['neighbor'], voice: {
      assistantLanguage: 'fr', privacy: { shareSessionSummary: true },
    } } };
    const anchor = 'voicePrivacy.shareSessionSummary';
    expect(await executor().execute('settings.set', { anchor, value: false }, user))
      .toMatchObject({ ok: true, result: { anchor, value: false } });
    expect(await executor().execute('settings.get', { anchor }, user))
      .toMatchObject({ ok: true, result: { anchor, value: false } });
    expect(content).toMatchObject({ t: 'plain', v: {
      favoriteMachines: ['neighbor'],
      voiceSettingsV1: { assistantLanguage: 'fr', privacy: { shareSessionSummary: false } },
      voice: { assistantLanguage: 'fr', privacy: { shareSessionSummary: false }, happierVoiceSettingsV1: true },
    } });
    expect(await executor().execute('settings.set', { anchor: 'voicePrivacy.diagnosticsEnabled', value: true }, user))
      .toMatchObject({ ok: false, errorCode: 'setting_read_only' });
  });

  it('captures and restores exact raw Account presence without a client and refuses a stale reversal', async () => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'settings-account' })).toString('base64url')}.signature`;
    const owner = executor(token);
    const anchor = 'delegation.workDepthLimit';
    expect(await owner.execute('settings.get', { anchor, includeVersion: true }, user))
      .toMatchObject({ ok: true, result: { value: 4, settingsVersion: 1 } });
    const changed = await owner.execute('settings.set', { anchor, value: 8,
      expectedSettingsVersion: 1, reversal: { kind: 'capture' } }, user);
    expect(changed).toMatchObject({ ok: true, result: { anchor, value: 8, settingsVersion: 2, reversal: {
      scope: { serverId: 'settings-home', accountId: 'settings-account' },
      beforeVersion: 1, appliedVersion: 2, before: { unset: true }, applied: { value: 8 },
    } } });
    const reversal = { kind: 'restore', scope: { serverId: 'settings-home', accountId: 'settings-account' },
      beforeVersion: 1, appliedVersion: 2, before: { unset: true }, applied: { value: 8 } } as const;
    content = { t: 'plain', v: { ...(content.t === 'plain' ? content.v : {}), favoriteMachines: ['concurrent'] } };
    version += 1;
    concurrentContent = { t: 'plain', v: { ...(content.t === 'plain' ? content.v : {}), futureSetting: 'preserved' } };
    conflict = true;
    expect(await owner.execute('settings.set', { anchor, value: 4, reversal }, user))
      .toMatchObject({ ok: true, result: { value: 4 } });
    expect(content).toEqual({ t: 'plain', v: { favoriteMachines: ['concurrent'], futureSetting: 'preserved' } });
    expect(await owner.execute('settings.set', { anchor, value: 4, reversal }, user))
      .toMatchObject({ ok: false, errorCode: 'account_settings_conflict' });
    expect(version).toBe(5);
  });

  it.each([
    { anchor: 'sourceControl.explainChanges', baseline: true, value: false },
    { anchor: 'sourceControl.investigateSurroundingFiles', baseline: false, value: true },
    { anchor: 'sourceControl.outputLanguage', baseline: '', value: 'fr' },
    { anchor: 'sourceControl.summaryModel', baseline: '', value: '' },
    { anchor: 'sourceControl.prepareAfterTurn', baseline: false, value: false },
  ])('uses the real Settings Action and declaration to capture and reverse $anchor', async ({ anchor, baseline, value }) => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'settings-account' })).toString('base64url')}.signature`;
    const owner = executor(token);
    expect(await owner.execute('settings.get', { anchor, includeVersion: true }, user))
      .toMatchObject({ ok: true, result: { value: baseline, settingsVersion: 1 } });
    const changed = await owner.execute('settings.set', { anchor, value, reversal: { kind: 'capture' } }, user);
    expect(changed).toMatchObject({ ok: true, result: { anchor, value, reversal: {
      before: { unset: true }, applied: { value }, beforeVersion: 1, appliedVersion: 2,
    } } });
    if (!changed.ok) throw new Error(JSON.stringify(changed));
    const receipt = SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(changed.result);
    if (!('reversal' in receipt) || !receipt.reversal) throw new Error('Missing reversal');
    expect(await owner.execute('settings.get', { anchor }, user)).toMatchObject({ ok: true, result: { value } });
    const reversal = { kind: 'restore', ...receipt.reversal };
    expect(await owner.execute('settings.set', { anchor, value: baseline, reversal }, user))
      .toMatchObject({ ok: true, result: { value: baseline } });
    expect(content).toEqual({ t: 'plain', v: { favoriteMachines: ['neighbor'] } });
    expect(await owner.execute('settings.set', { anchor, value: baseline, reversal }, user))
      .toMatchObject({ ok: false, errorCode: 'account_settings_conflict' });
  });

  it('keeps catalog and scalar admission when a walkthrough setting requests a reversal', async () => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'settings-account' })).toString('base64url')}.signature`;
    const owner = executor(token);
    for (const input of [
      { anchor: 'sourceControl.investigateSurroundingFiles', value: 'true' },
      { anchor: 'sourceControl.outputLanguage', value: 'not a language' },
    ]) expect(await owner.execute('settings.set', { ...input, reversal: { kind: 'capture' } }, user))
      .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
    content = { t: 'plain', v: { favoriteMachines: ['neighbor'], 'scm.diffSummary.modelProfileOverride': 'invented-model' } };
    const before = content;
    for (const input of [
      { anchor: 'sourceControl.summaryModel', value: 'invented-model' },
      { anchor: 'sourceControl.prepareAfterTurn', value: true },
    ]) expect(await owner.execute('settings.set', { ...input, reversal: { kind: 'capture' } }, user))
      .toMatchObject({ ok: false, errorCode: 'setting_value_unavailable' });
    expect(content).toEqual(before);
    expect(version).toBe(1);
  });

  it('sets Source control routing and one backend diff preference through the shared Settings owner without replacing neighbors', async () => {
    content = { t: 'plain', v: { favoriteMachines: ['neighbor'], scmDefaultDiffModeByBackend: {
      git: 'included', 'happier.scm.backend.git/git': 'included', neighbor: 'both',
    } } };
    const owner = executor();
    expect(await owner.execute('settings.set', { anchor: 'sourceControl.gitRouting', value: 'sapling' }, user))
      .toMatchObject({ ok: true, result: { value: 'sapling' } });
    expect(await owner.execute('settings.get', { anchor: 'sourceControl.gitRouting' }, user))
      .toMatchObject({ ok: true, result: { value: 'happier.scm.backend.sapling/sapling' } });
    expect(await owner.execute('settings.set', { anchor: 'sourceControl.backendDefaultDiff',
      value: { backendId: 'git', mode: 'pending' } }, user))
      .toMatchObject({ ok: true });
    expect(await owner.execute('settings.get', { anchor: 'sourceControl.backendDefaultDiff' }, user))
      .toMatchObject({ ok: true, result: { value: { neighbor: 'both', 'happier.scm.backend.git/git': 'pending' } } });
    expect(content).toEqual({ t: 'plain', v: { favoriteMachines: ['neighbor'], scmGitRepoPreferredBackend: 'sapling',
      scmGitRepoPreferredBackendQualifiedId: null, scmDefaultDiffModeByBackend: { neighbor: 'both', 'happier.scm.backend.git/git': 'pending' } } });
  });

  it('captures and reverses an admitted catalog model and prefetch-on through the real Settings Action', async () => {
    const admitted = await createSignedInSummaryCatalogFixture();
    try {
      const catalog = await createCliSettingsCatalogServices({}).readScmDiffSummaryCatalog!(accountSettingsParse({}), '');
      const model = catalog?.profiles.find(profile => profile.costTier === 'low' && profile.structuredOutput === 'supported');
      if (!model) throw new Error(JSON.stringify({ reason: 'Admitted Agent must produce a supported low-cost model',
        profiles: catalog?.profiles, diagnostics: admitted.registry.pluginDiagnosticsByPluginId['happier.agent.claude'] }));
      const token = `e30.${Buffer.from(JSON.stringify({ sub: 'settings-account' })).toString('base64url')}.signature`;
      const owner = executor(token);
      for (const [anchor, value, baseline] of [
        ['sourceControl.summaryModel', model.catalogId, ''],
        ['sourceControl.prepareAfterTurn', true, false],
      ] as const) {
        const changed = await owner.execute('settings.set', { anchor, value, reversal: { kind: 'capture' } }, user);
        expect(changed).toMatchObject({ ok: true, result: { anchor, value, reversal: { before: { unset: true }, applied: { value } } } });
        if (!changed.ok) throw new Error(JSON.stringify(changed));
        const receipt = SettingsDeclarationActionOutputSchemasV1['settings.set'].parse(changed.result);
        if (!('reversal' in receipt) || !receipt.reversal) throw new Error('Missing reversal');
        expect(await owner.execute('settings.get', { anchor }, user)).toMatchObject({ ok: true, result: { value } });
        expect(await owner.execute('settings.set', { anchor, value: baseline,
          reversal: { kind: 'restore', ...receipt.reversal } }, user)).toMatchObject({ ok: true, result: { value: baseline } });
        expect(content).toEqual({ t: 'plain', v: { favoriteMachines: ['neighbor'] } });
      }
    } finally {
      await admitted.dispose();
      vi.unstubAllEnvs();
    }
  });

  it('rejects resource targets on Account declarations before reading or writing preferences', async () => {
    const target = { kind: 'team', serverId: 'target-home', teamId: 'target-team' } as const;
    for (const actionId of ['settings.get', 'settings.set'] as const) {
      const input = { anchor: 'delegation.workDepthLimit', target, ...(actionId === 'settings.set' ? { value: 8 } : {}) };
      expect(await executor().execute(actionId, input, user))
        .toMatchObject({ ok: false, errorCode: 'setting_target_mismatch', details: { targetKinds: [] } });
    }
    expect(version).toBe(1);
    expect(content).toEqual({ t: 'plain', v: { favoriteMachines: ['neighbor'] } });
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('writes through Account CAS, rebases conflicts, and reads back through another CLI owner', async () => {
    conflict = true;
    expect(await executor().execute('settings.set', { anchor: 'delegation.workDepthLimit', value: 8 }, user)).toEqual({ ok: true, result: { anchor: 'delegation.workDepthLimit', value: 8 } });
    expect(await executor().execute('settings.set', { anchor: 'delegation.approvalReviewerEnabled', value: true }, user)).toEqual({ ok: true, result: { anchor: 'delegation.approvalReviewerEnabled', value: true } });
    expect(await executor().execute('settings.get', { anchor: 'delegation.workDepthLimit' }, user)).toEqual({ ok: true, result: { anchor: 'delegation.workDepthLimit', value: 8 } });
    expect(await executor().execute('settings.get', { anchor: 'delegation.approvalReviewerEnabled' }, user)).toEqual({ ok: true, result: { anchor: 'delegation.approvalReviewerEnabled', value: true } });
    expect(content).toEqual({ t: 'plain', v: { favoriteMachines: ['concurrent'], futureSetting: 'preserved', workDepthLimit: 8, approvalReviewerEnabled: true } });
  });

  it.each(['cli', 'agent', 'mcp'] as const)('invokes Machines Defaults through the real %s executor and rebases sibling preferences through Account CAS', async surface => {
    const token = `machines-defaults-${surface}`;
    const policy = ActionsSettingsV1Schema.parse({ v: 1, actions: {},
      approvalWaivedSurfaces: { 'settings.set': ['cli', 'agent', 'mcp'] } });
    const siblingPolicy = { retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } as const;
    const changedPolicy = { retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: true } as const;
    content = { t: 'plain', v: { actionsSettingsV1: policy, favoriteMachines: ['neighbor'],
      machineRetentionDefaultsV1: { v: 1, unknown: siblingPolicy } } };
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse(content.v),
      rawSettings: content.v, settingsVersion: version, loadedAtMs: 1, settingsSecretsReadKeys: [],
      scopeKey: resolveAccountSettingsScopeKeyForToken(token) });
    const createOwner = () => createCliActionExecutor({ token, sessionId: 'settings-parity',
      getCurrentSessionMetadata: () => ({ path: '/repo', machineId: 'machine' }), serverId: 'settings-home',
      serverHttpBaseUrl: 'http://settings.test', mode: 'plain', ctx: null, credentials: { token, encryption: null } });
    const invoke = (actionId: 'settings.set' | 'settings.get', input: unknown) => {
      const owner = createOwner();
      if (surface === 'cli') return owner.execute(actionId, input, { surface, authority: 'account_automation' });
      return createActionToolExecutorBridge({ executor: owner, surface, actionsSettings: policy })
        .executeActionByToolName('action_execute', { actionId, input }, 'settings-parity');
    };
    // A different category arrives at the HTTP CAS boundary after the initial read.
    // The real category binding must rebase, not replace the retention preference map.
    concurrentContent = { t: 'plain', v: { actionsSettingsV1: policy, favoriteMachines: ['concurrent'], futureSetting: 'preserved',
      machineRetentionDefaultsV1: { v: 1, unknown: siblingPolicy, 'stopped-billed': siblingPolicy } } };
    conflict = true;
    expect(await invoke('settings.set', { anchor: 'machines.defaults.local', value: changedPolicy }))
      .toMatchObject({ ok: true, result: { anchor: 'machines.defaults.local', value: changedPolicy } });
    expect(await invoke('settings.get', { anchor: 'machines.defaults.local' }))
      .toMatchObject({ ok: true, result: { value: changedPolicy } });
    expect(await invoke('settings.set', { anchor: 'machines.defaults.local', value: { ...changedPolicy, wakeOnAcceptedMessage: 'true' } }))
      .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
    expect(version).toBe(3);
    expect(await invoke('settings.set', { anchor: 'machines.defaults.creationEnabled', value: false }))
      .toMatchObject({ ok: true, result: { value: false } });
    expect(await invoke('settings.get', { anchor: 'machines.defaults.creationEnabled' }))
      .toMatchObject({ ok: true, result: { value: false } });
    expect(content).toEqual({ t: 'plain', v: { actionsSettingsV1: policy, favoriteMachines: ['concurrent'], futureSetting: 'preserved',
      machineRetentionDefaultsV1: { v: 1, unknown: siblingPolicy, 'stopped-billed': siblingPolicy, local: changedPolicy },
      managedMachineCreationEnabled: false } });
    expect(version).toBe(4);
  });

  it('rejects invalid values without falling back to persisted defaults or writing', async () => {
    for (const value of [-1, 1.5, '4']) {
      expect(await executor().execute('settings.set', { anchor: 'delegation.workDepthLimit', value }, user)).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
    }
    expect(await executor().execute('settings.set', { anchor: 'delegation.approvalReviewerEnabled', value: 'true' }, user)).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
    expect(version).toBe(1);
  });

  it('reads and changes nested Actions policy through Account CAS while preserving concurrent restrictions', async () => {
    content = { t: 'plain', v: { sessionAgentSpawnPolicyV1: { v: 1, allowCrossMachine: false }, favoriteMachines: ['neighbor'] } };
    const anchor = 'actions.createSession.allowEnvironmentVariables';
    expect(await executor().execute('settings.get', { anchor }, user)).toMatchObject({ ok: true, result: { value: true } });
    expect(await executor().execute('settings.set', { anchor, value: 'false' }, user)).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
    conflict = true;
    expect(await executor().execute('settings.set', { anchor, value: false }, user)).toMatchObject({ ok: true, result: { value: false } });
    expect(await executor().execute('settings.get', { anchor }, user)).toMatchObject({ ok: true, result: { value: false } });
    expect(accountSettingsParse(content.t === 'plain' ? content.v : {}).sessionAgentSpawnPolicyV1)
      .toMatchObject({ allowCrossMachine: false, allowEnvironmentVariables: false, allowModelOverride: false });
    expect(content.t === 'plain' && content.v.favoriteMachines).toEqual(['concurrent']);
  });

  it('keeps new allow-lists outside the released spawn policy and rejects malformed list values', async () => {
    const anchor = 'actions.createSession.allowedRoleIds';
    expect(await executor().execute('settings.get', { anchor }, user)).toMatchObject({ ok: true, result: { value: null } });
    for (const value of ['builder', [''], [false]]) {
      expect(await executor().execute('settings.set', { anchor, value }, user)).toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
    }
    expect(await executor().execute('settings.set', { anchor, value: ['builder'] }, user)).toMatchObject({ ok: true, result: { value: ['builder'] } });
    expect(content).toEqual({ t: 'plain', v: { favoriteMachines: ['neighbor'], sessionAgentStartAllowListsV1: {
      v: 1, allowedRoleIds: ['builder'], allowedAgentTargetKeys: null,
    } } });
  });

  it('exposes both memory creation defaults through strict Account settings Actions without changing neighboring preferences', async () => {
    content = { t: 'plain', v: { favoriteMachines: ['neighbor'], memoryUseInNewSessions: 'malformed', memoryUseInNewBots: false } };
    for (const [key, recovered, next] of [
      ['memoryUseInNewSessions', false, true], ['memoryUseInNewBots', false, true],
    ] as const) {
      // Discover the canonical binding rather than inventing a second anchor in this consumer.
      const declaration = Object.values(ACCOUNT_SETTING_DECLARATIONS_V1).find(item => String(item.storage.key) === key);
      expect(declaration, `Missing public Account setting declaration for ${key}`).toBeDefined();
      if (!declaration) throw new Error(`Missing Account setting declaration: ${key}`);
      const owner = executor();
      expect(await owner.execute('settings.get', { anchor: declaration.anchor }, user))
        .toMatchObject({ ok: true, result: { value: recovered } });
      expect(await owner.execute('settings.set', { anchor: declaration.anchor, value: 'true' }, user))
        .toMatchObject({ ok: false, errorCode: 'invalid_setting_value' });
      const applied = await owner.execute('settings.set', { anchor: declaration.anchor, value: next }, user);
      expect(applied, JSON.stringify(applied))
        .toMatchObject({ ok: true, result: { value: next } });
      expect(await executor().execute('settings.get', { anchor: declaration.anchor }, user))
        .toMatchObject({ ok: true, result: { value: next } });
    }
    expect(version).toBe(3);
    expect(content).toEqual({ t: 'plain', v: { favoriteMachines: ['neighbor'], memoryUseInNewSessions: true, memoryUseInNewBots: true } });
  });

  it('refuses device-local reads with the existing no-client result', async () => {
    expect(await executor().execute('settings.get', { anchor: 'appearance.themeMode' }, user)).toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient',
      details: { reason: 'client_unavailable', recovery: { kind: 'connect_client', rpcMethod: 'ui.actions.execute.v1' } } });
    expect(version).toBe(1);
  });

  it('does not guess a web or native Account key without target-platform evidence', async () => {
    for (const actionId of ['settings.get', 'settings.set'] as const) {
      expect(await executor().execute(actionId, { anchor: 'session.composer.enterToSend',
        ...(actionId === 'settings.set' ? { value: true } : {}) }, user))
        .toMatchObject({ ok: false, errorCode: 'setting_value_unavailable', details: { prerequisite: 'ui_platform' } });
    }
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('keeps memory defaults under ordinary Account settings approval policy on Agent and MCP surfaces', async () => {
    const ordinaryPolicy = ActionsSettingsV1Schema.parse({ v: 1, actions: {
      'settings.set': { enabled: true, approvalRequiredSurfaces: [] },
    }, approvalWaivedSurfaces: { 'settings.set': ['agent', 'mcp'] } });
    for (const [surface, key] of [['agent', 'memoryUseInNewSessions'], ['mcp', 'memoryUseInNewBots']] as const) {
      const declaration = Object.values(ACCOUNT_SETTING_DECLARATIONS_V1).find(item => String(item.storage.key) === key);
      if (!declaration) throw new Error(`Missing Account setting declaration: ${key}`);
      const result = await executor().execute('settings.set', { anchor: declaration.anchor, value: true }, {
        surface, authority: 'account_automation', actionsSettings: ordinaryPolicy,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { value: true } });
    }
    expect(content).toEqual({ t: 'plain', v: { favoriteMachines: ['neighbor'], memoryUseInNewSessions: true, memoryUseInNewBots: true } });
  });

  it('does not report defaults as Account values when the Account read is unavailable', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('Account unavailable'));
    expect(await executor().execute('settings.get', { anchor: 'delegation.workDepthLimit' }, user))
      .toMatchObject({ ok: false, errorCode: 'account_settings_content_unavailable' });
  });

  it('reads defaults from an observed empty Account document', async () => {
    content = { t: 'plain', v: {} };
    expect(await executor().execute('settings.get', { anchor: 'delegation.workDepthLimit' }, user))
      .toMatchObject({ ok: true, result: { value: 4 } });
  });

  it('lets agents read Account defaults but refuses an unbound configuration approval without writing', async () => {
    const agent = { surface: 'agent', authority: 'account_automation', actionsSettings } as const;
    expect(await executor().execute('settings.get', { anchor: 'delegation.workDepthLimit' }, agent)).toMatchObject({ ok: true, result: { value: 4 } });
    expect(await executor().execute('settings.set', { anchor: 'delegation.approvalReviewerEnabled', value: true }, agent)).toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
    expect(accountSettingsParse(content.t === 'plain' ? content.v : {}).approvalReviewerEnabled).toBe(false);
    expect(version).toBe(1);
  });
});
