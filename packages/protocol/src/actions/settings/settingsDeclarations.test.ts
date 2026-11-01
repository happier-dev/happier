import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '../../account/settings/accountSettings.js';
import { isApprovalRequiredByActionsSettings } from '../actionApprovalPolicy.js';
import { getActionSpec } from '../actionSpecs.js';
import { requiresPresentUserExecutionAuthorityForActionInputV1 } from '../decisionAuthority.js';
import { BUILT_IN_SETTINGS_DECLARATIONS_V1, readBuiltInSettingDeclarationV1,
  parseBuiltInAccountSettingValueV1, readBuiltInAccountSettingValueV1,
  buildBuiltInAccountSettingMutationV1, readPortablePlatformAccountSettingBindingV1,
  readBuiltInSettingsOperationPolicyV1, resolveBuiltInAccountSettingResetValueV1 } from './settingsDeclarations.js';

describe('background-work attention Settings declaration', () => {
  it('reads, writes and resets the preference through its portable account owner', () => {
    const declaration = readBuiltInSettingDeclarationV1('session.backgroundWorkAttention');
    expect(declaration).toMatchObject({ pageId: 'session', sectionId: 'session.activitySignals',
      storage: { scope: 'account', key: 'sessionListBackgroundWorkAttentionModeV1', access: 'read_write' } });
    if (!declaration) throw new Error('Background-work attention setting unavailable');
    const baseline = accountSettingsParse({});
    expect(readBuiltInAccountSettingValueV1(declaration, baseline)).toBe('keepWorking');
    for (const value of ['keepWorking', 'keepWorkingUnread', 'showUnread']) {
      expect(parseBuiltInAccountSettingValueV1(declaration, value)).toEqual({ success: true, value });
      const mutation = buildBuiltInAccountSettingMutationV1(declaration, baseline, value);
      expect(mutation).toEqual({ sessionListBackgroundWorkAttentionModeV1: value });
      expect(readBuiltInAccountSettingValueV1(declaration, accountSettingsParse({ ...baseline, ...mutation }))).toBe(value);
    }
    for (const value of ['invalid', null, false, 1]) {
      expect(buildBuiltInAccountSettingMutationV1(declaration, baseline, value)).toBeNull();
    }
    expect(resolveBuiltInAccountSettingResetValueV1(declaration)).toEqual({ success: true, value: 'keepWorking' });
  });
});

describe('portable built-in Settings declarations', () => {
  it.each([
    ['toolRendering.collapsedOverrides', 'toolViewDetailLevelByToolName', 'compact'],
    ['toolRendering.expandedOverrides', 'toolViewExpandedDetailLevelByToolName', 'summary'],
  ] as const)('strictly admits a single tool detail choice through %s', (anchor, key, neighborLevel) => {
    const declaration = readBuiltInSettingDeclarationV1(anchor);
    if (!declaration) throw new Error(`Missing tool rendering declaration ${anchor}`);
    const settings = accountSettingsParse({ toolViewDetailLevelByToolName: { Read: 'compact' },
      toolViewExpandedDetailLevelByToolName: { Read: 'summary' } });
    const value = { toolName: 'Bash', detailLevel: 'full' };
    expect(parseBuiltInAccountSettingValueV1(declaration, value)).toEqual({ success: true, value });
    const mutation = buildBuiltInAccountSettingMutationV1(declaration, settings, value);
    expect(mutation).toEqual({ [key]: { Bash: 'full', Read: neighborLevel } });
    expect(readBuiltInAccountSettingValueV1(declaration, accountSettingsParse({ ...settings, ...mutation })))
      .toEqual({ Bash: 'full', Read: neighborLevel });
    expect(buildBuiltInAccountSettingMutationV1(declaration, accountSettingsParse({ ...settings, ...mutation }),
      { toolName: 'Bash', detailLevel: 'default' })).toEqual({ [key]: { Read: neighborLevel } });
    expect(resolveBuiltInAccountSettingResetValueV1(declaration)).toEqual({ success: false });
    for (const invalid of [null, [], { Bash: 'full' }, { toolName: 'Bash', detailLevel: 'unknown' },
      { toolName: 'Bash', detailLevel: 'full', extra: true }]) {
      expect(parseBuiltInAccountSettingValueV1(declaration, invalid)).toEqual({ success: false });
      expect(buildBuiltInAccountSettingMutationV1(declaration, settings, invalid)).toBeNull();
    }
  });
  it('reads and changes coordinator creation defaults through sparse Account settings intents', () => {
    const baseline = accountSettingsParse({});
    const cases = [
      ['coordination.newCoordinatorRole', 'coordinationCoordinatorRoleId', 'orchestrator', 'reviewer', ['', null, false]],
      ['coordination.newCoordinatorKeep', 'coordinationCoordinatorKeep', 'suggest', 'list_pin', ['rail', null, false]],
      ['coordination.suggestProjectRule', 'coordinationCoordinatorSuggestProjectRule', true, false, ['yes', null, 1]],
      ['coordination.suggestHomeRule', 'coordinationCoordinatorSuggestHomeRule', true, false, ['yes', null, 1]],
      ['coordination.newCoordinatorAnswersWorkerQuestions', 'coordinationCoordinatorAnswersWorkerQuestions', true, false, ['yes', null, 1]],
    ] as const;
    for (const [anchor, key, defaultValue, changedValue, invalidValues] of cases) {
      const declaration = readBuiltInSettingDeclarationV1(anchor);
      expect(declaration, anchor).toMatchObject({ pageId: 'coordination', storage: { scope: 'account', key, access: 'read_write' } });
      if (!declaration) throw new Error(`missing coordinator setting: ${anchor}`);
      expect(readBuiltInAccountSettingValueV1(declaration, baseline)).toEqual(defaultValue);
      const mutation = buildBuiltInAccountSettingMutationV1(declaration, baseline, changedValue);
      expect(mutation).toEqual({ [key]: changedValue });
      expect(readBuiltInAccountSettingValueV1(declaration, accountSettingsParse({ ...baseline, ...mutation }))).toEqual(changedValue);
      for (const invalidValue of invalidValues) {
        expect(buildBuiltInAccountSettingMutationV1(declaration, baseline, invalidValue)).toBeNull();
      }
    }
    const keep = readBuiltInSettingDeclarationV1('coordination.newCoordinatorKeep')!;
    for (const value of ['suggest', 'rail_bot', 'list_pin', 'none']) {
      expect(buildBuiltInAccountSettingMutationV1(keep, baseline, value)).toEqual({ coordinationCoordinatorKeep: value });
    }
  });
  it('reads and changes the shared autonomous exchange check-in preference', () => {
    const declaration = readBuiltInSettingDeclarationV1('coordination.autonomousCheckIn');
    expect(declaration).toMatchObject({
      storage: { scope: 'account', key: 'coordinationAutonomousCheckIn', access: 'read_write' },
    });
    if (!declaration) throw new Error('autonomous exchange preference declaration unavailable');
    const defaults = accountSettingsParse({});
    expect(readBuiltInAccountSettingValueV1(declaration, defaults)).toEqual({ afterTurns: 5 });
    expect(buildBuiltInAccountSettingMutationV1(declaration, defaults, { afterTurns: null }))
      .toEqual({ coordinationAutonomousCheckIn: { afterTurns: null } });
    expect(buildBuiltInAccountSettingMutationV1(declaration, defaults, { afterTurns: 10_000 }))
      .toEqual({ coordinationAutonomousCheckIn: { afterTurns: 10_000 } });
    for (const value of [{ afterTurns: 0 }, { afterTurns: -1 }, { afterTurns: 1.5 }, { afterTurns: '5' },
      { afterTurns: 5, other: true }]) {
      expect(buildBuiltInAccountSettingMutationV1(declaration, defaults, value)).toBeNull();
    }
  });
  it('owns MCP startup failure policy on Sessions and preserves its Account storage key', () => {
    const declaration = readBuiltInSettingDeclarationV1('session.mcpServersStrictMode');
    expect(declaration).toMatchObject({ pageId: 'session', sectionId: 'session.mcpServersReliability',
      storage: { scope: 'account', key: 'mcpServersStrictMode', access: 'read_write' } });
    if (!declaration) throw new Error('MCP failure policy declaration unavailable');
    const settings = accountSettingsParse({ mcpServersStrictMode: false, transcriptShowToolCalls: false });
    expect(readBuiltInAccountSettingValueV1(declaration, settings)).toBe(false);
    expect(buildBuiltInAccountSettingMutationV1(declaration, settings, true)).toEqual({ mcpServersStrictMode: true });
    expect(buildBuiltInAccountSettingMutationV1(declaration, settings, 'stop')).toBeNull();
    expect(BUILT_IN_SETTINGS_DECLARATIONS_V1.some(row => row.anchor.startsWith('mcp.preview.'))).toBe(false);
  });
  it('reads and strictly mutates agent HTML network through the Account declaration without touching siblings', () => {
    const declaration = readBuiltInSettingDeclarationV1('transcript.agentHtmlNetworkPolicy');
    expect(declaration).not.toBeNull();
    if (!declaration) throw new Error('agent HTML network declaration unavailable');
    expect(readBuiltInAccountSettingValueV1(declaration, accountSettingsParse({}))).toBe('allowed');
    expect(readBuiltInAccountSettingValueV1(declaration, accountSettingsParse({ agentHtmlNetworkPolicy: 'open' }))).toBe('ask');
    for (const value of ['allowed', 'ask', 'off']) {
      expect(parseBuiltInAccountSettingValueV1(declaration, value)).toEqual({ success: true, value });
      expect(buildBuiltInAccountSettingMutationV1(declaration, accountSettingsParse({ transcriptShowToolCalls: false }), value))
        .toEqual({ agentHtmlNetworkPolicy: value });
    }
    for (const malformed of ['open', null, true, { network: 'allowed' }]) {
      expect(parseBuiltInAccountSettingValueV1(declaration, malformed)).toEqual({ success: false });
      expect(buildBuiltInAccountSettingMutationV1(declaration, accountSettingsParse({}), malformed)).toBeNull();
    }
    const input = { anchor: declaration.anchor, value: 'allowed' };
    for (const surface of ['agent', 'mcp'] as const) {
      expect(isApprovalRequiredByActionsSettings('settings.set', accountSettingsParse({}).actionsSettingsV1,
        { surface }, undefined, undefined, input)).toBe(true);
      const waived = accountSettingsParse({ actionsSettingsV1: { v: 1,
        approvalWaivedSurfaces: { 'settings.set': [surface] } } }).actionsSettingsV1;
      expect(isApprovalRequiredByActionsSettings('settings.set', waived,
        { surface }, undefined, undefined, input)).toBe(false);
    }
  });
  it('admits Dictation operations under their own purpose while retaining Conversation policies', () => {
    for (const operation of ['stt_prepare', 'stt_remove', 'stt_update', 'readiness_inspect']) {
      const conversation = readBuiltInSettingsOperationPolicyV1('voiceSettingsOperation', [operation, 'conversation']);
      const dictation = readBuiltInSettingsOperationPolicyV1('voiceSettingsOperation', [operation, 'dictation']);
      expect(dictation).toEqual(expect.objectContaining({
        kind: 'invoke', owner: 'voiceSettingsOperation', options: [operation, 'dictation'],
        requiresApproval: operation !== 'readiness_inspect',
        requiresHumanInteraction: operation !== 'readiness_inspect',
      }));
      expect(conversation).toEqual(expect.objectContaining({ kind: 'invoke', options: [operation, 'conversation'] }));
    }
    expect(readBuiltInSettingsOperationPolicyV1('voiceSettingsOperation', ['tts_prepare', 'dictation'])).toBeNull();
  });
  it('requires an observed UI platform for the composer Enter preference', () => {
    const declaration = readBuiltInSettingDeclarationV1('session.composer.enterToSend')!;
    expect(readPortablePlatformAccountSettingBindingV1(declaration, null)).toBeNull();
    const web = readPortablePlatformAccountSettingBindingV1(declaration, 'web')!;
    const native = readPortablePlatformAccountSettingBindingV1(declaration, 'native')!;
    expect(web?.key).toBe('agentInputEnterToSend');
    expect(native?.key).toBe('agentInputEnterToSendNative');
    const settings = accountSettingsParse({});
    expect(readBuiltInAccountSettingValueV1({ ...declaration, storage: web }, settings)).toBe(true);
    expect(readBuiltInAccountSettingValueV1({ ...declaration, storage: native }, settings)).toBe(false);
    expect(buildBuiltInAccountSettingMutationV1({ ...declaration, storage: web }, settings, false)).toEqual({ agentInputEnterToSend: false });
    expect(buildBuiltInAccountSettingMutationV1({ ...declaration, storage: native }, settings, 'yes')).toBeNull();
  });
  it('admits only the exact Instructions Agent-edits mode and preserves all neighboring policy', () => {
    const declaration = readBuiltInSettingDeclarationV1('actions.promptDocAgentEdits');
    expect(declaration ? parseBuiltInAccountSettingValueV1(declaration, 'allowed') : { success: false })
      .toEqual({ success: true, value: 'allowed' });
    if (!declaration) throw new Error('policy mode unavailable');
    const baseline = accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {
      'prompt_doc.update': { enabled: false, disabledSurfaces: ['agent', 'cli'], approvalRequiredSurfaces: ['mcp'],
        toolExposureModes: { agent: 'discoverable_only' } },
      'prompt_doc.create': { disabledSurfaces: ['mcp'] },
    }, approvalWaivedSurfaces: { 'prompt_doc.create': ['cli'] } } });
    const apply = (value: string) => {
      const mutation = buildBuiltInAccountSettingMutationV1(declaration, baseline, value);
      expect(Object.keys(mutation ?? {})).toEqual(['actionsSettingsV1']);
      return accountSettingsParse({ ...baseline, ...mutation });
    };
    const allowed = apply('allowed');
    expect(allowed.actionsSettingsV1.actions['prompt_doc.update'].disabledSurfaces).toEqual(['cli']);
    expect(allowed.actionsSettingsV1.actions['prompt_doc.update'].approvalRequiredSurfaces).toEqual(['mcp']);
    expect(allowed.actionsSettingsV1.actions['prompt_doc.update'].enabled).toBe(false);
    expect(allowed.actionsSettingsV1.actions['prompt_doc.update'].toolExposureModes).toEqual({ agent: 'discoverable_only' });
    expect(allowed.actionsSettingsV1.approvalWaivedSurfaces).toEqual({ 'prompt_doc.create': ['cli'], 'prompt_doc.update': ['agent'] });
    expect(allowed.actionsSettingsV1.actions['prompt_doc.create']).toEqual(baseline.actionsSettingsV1.actions['prompt_doc.create']);
    expect(readBuiltInAccountSettingValueV1(declaration, allowed)).toBe('allowed');
    expect(readBuiltInAccountSettingValueV1(declaration, apply('off'))).toBe('off');
    expect(readBuiltInAccountSettingValueV1(declaration, apply('default'))).toBe('default');
    expect(readBuiltInAccountSettingValueV1(declaration, apply('ask_first'))).toBe('ask_first');
    expect(parseBuiltInAccountSettingValueV1(declaration, { v: 1, actions: {} })).toEqual({ success: false });
    expect(buildBuiltInAccountSettingMutationV1(declaration, baseline, 'on')).toBeNull();
    const input = { anchor: declaration.anchor, value: 'allowed' };
    const waived = accountSettingsParse({ actionsSettingsV1: { v: 1, actions: {},
      approvalWaivedSurfaces: { 'settings.set': ['agent', 'mcp'] },
    } }).actionsSettingsV1;
    for (const surface of ['agent', 'mcp'] as const) {
      expect(isApprovalRequiredByActionsSettings('settings.set', accountSettingsParse({}).actionsSettingsV1,
        { surface }, undefined, undefined, input)).toBe(true);
      expect(isApprovalRequiredByActionsSettings('settings.set', waived, { surface }, undefined, undefined, input)).toBe(false);
    }
    expect(requiresPresentUserExecutionAuthorityForActionInputV1(getActionSpec('settings.set'), input)).toBe(false);
  });
  it('discovers Account, device, Home and Team Settings without a UI process', () => {
    const registry = BUILT_IN_SETTINGS_DECLARATIONS_V1;
    expect(new Set(registry.map(row => row.anchor)).size).toBe(registry.length);
    expect(registry).toEqual(expect.arrayContaining([
      expect.objectContaining({ anchor: 'appearance.avatarStyle', storage: expect.objectContaining({ scope: 'account', key: 'avatarStyle' }) }),
      expect.objectContaining({ anchor: 'appearance.themeMode', storage: expect.objectContaining({ scope: 'local' }) }),
      expect.objectContaining({ anchor: 'coordination.autoFollowAssigned', targetKinds: ['home'] }),
      expect.objectContaining({ pageId: 'teams', targetKinds: ['team'] }),
    ]));
  });
  it('admits values at the Account schema and preserves nested siblings in a sparse intent', () => {
    const declaration = readBuiltInSettingDeclarationV1('actions.createSession.allowCrossMachine')!;
    const baseline = accountSettingsParse({});
    const settings = accountSettingsParse({ sessionAgentSpawnPolicyV1: {
      ...baseline.sessionAgentSpawnPolicyV1, allowCustomDirectory: false,
    } });
    expect(parseBuiltInAccountSettingValueV1(declaration, 'yes')).toEqual({ success: false });
    expect(parseBuiltInAccountSettingValueV1(declaration, false)).toEqual({ success: true, value: false });
    const mutation = buildBuiltInAccountSettingMutationV1(declaration, settings, false);
    expect(Object.keys(mutation!)).toEqual(['sessionAgentSpawnPolicyV1']);
    const updated = accountSettingsParse({ ...settings, ...mutation });
    expect(updated.sessionAgentSpawnPolicyV1.allowCustomDirectory).toBe(false);
    expect(readBuiltInAccountSettingValueV1(declaration, updated)).toBe(false);
    expect(buildBuiltInAccountSettingMutationV1(declaration, settings, 'yes')).toBeNull();
  });
  it('rejects malformed allow-list writes while retaining fail-closed stored recovery', () => {
    const declaration = readBuiltInSettingDeclarationV1('actions.createSession.allowedRoleIds')!;
    const baseline = accountSettingsParse({ sessionAgentStartAllowListsV1: {
      allowedRoleIds: [''], allowedAgentTargetKeys: ['agent:happier.agent.codex/codex'],
    } });
    expect(baseline.sessionAgentStartAllowListsV1.allowedRoleIds).toEqual([]);
    for (const value of ['builder', [''], [false]]) {
      expect(parseBuiltInAccountSettingValueV1(declaration, value)).toEqual({ success: false });
      expect(buildBuiltInAccountSettingMutationV1(declaration, baseline, value)).toBeNull();
    }
    expect(parseBuiltInAccountSettingValueV1(declaration, null)).toEqual({ success: true, value: null });
    expect(buildBuiltInAccountSettingMutationV1(declaration, baseline, ['builder']))
      .toEqual({ sessionAgentStartAllowListsV1: { v: 1, allowedRoleIds: ['builder'],
        allowedAgentTargetKeys: ['agent:happier.agent.codex/codex'] } });
  });
  it('keeps opt-out storage semantics and present-user consent at the shared declaration', () => {
    const declaration = readBuiltInSettingDeclarationV1('account.analytics')!;
    const settings = accountSettingsParse({ analyticsOptOut: true });
    expect(readBuiltInAccountSettingValueV1(declaration, settings)).toBe(false);
    expect(buildBuiltInAccountSettingMutationV1(declaration, settings, true)).toEqual({ analyticsOptOut: false });
    expect(readBuiltInSettingDeclarationV1('voicePrivacy.diagnosticsEnabled')?.storage?.access).toBe('read_only');
    expect(readBuiltInSettingDeclarationV1('voicePrivacy.forgetVoiceAgentMemory')?.operation).toEqual(expect.objectContaining({
      kind: 'invoke', requiresHumanInteraction: true, requiresApproval: true,
    }));
    expect(readBuiltInSettingDeclarationV1('voicePrivacy.diagnosticsCleanup')?.operation).toEqual(expect.objectContaining({
      kind: 'invoke', requiresHumanInteraction: false, requiresApproval: false,
    }));
  });
});
