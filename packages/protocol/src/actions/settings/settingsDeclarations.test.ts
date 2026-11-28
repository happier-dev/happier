import { describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, ACCOUNT_SETTING_ARTIFACTS, isAccountSettingsReadOnlySourceKeyV1 } from '../../account/settings/accountSettings.js';
import { isApprovalRequiredByActionsSettings } from '../actionApprovalPolicy.js';
import { getActionSpec } from '../actionSpecs.js';
import { requiresPresentUserExecutionAuthorityForActionInputV1 } from '../decisionAuthority.js';
import { listUiFeatureToggleDefinitions } from './featurePreferenceMutations.js';
import { BUILT_IN_SETTINGS_DECLARATIONS_V1, readBuiltInSettingDeclarationV1,
  parseBuiltInAccountSettingValueV1, readBuiltInAccountSettingValueV1,
  buildBuiltInAccountSettingMutationV1, readPortablePlatformAccountSettingBindingV1,
  readBuiltInSettingsOperationPolicyV1, resolveBuiltInAccountSettingResetValueV1, readBuiltInSettingsWriteSafetyV1 } from './settingsDeclarations.js';

it('keeps anchor-level access and Agent safety for fields in the same Account setting', () => {
  const source = { anchor: 'appearance.atmosphereSource' };
  const picture = { anchor: 'appearance.atmospherePictureRef' };
  expect(readBuiltInSettingDeclarationV1(source.anchor)).toMatchObject({
    storage: { scope: 'account', key: 'homeAtmosphere', path: ['source'], access: 'read_write' },
  });
  expect(readBuiltInSettingDeclarationV1(picture.anchor)).toMatchObject({
    storage: { scope: 'account', key: 'homeAtmosphere', path: ['picture', 'ref'], access: 'read_write' },
  });
  expect(readBuiltInSettingsWriteSafetyV1(source)).toBe('safe');
  expect(readBuiltInSettingsWriteSafetyV1(picture)).toBe('danger');
});

it('declares catalog-derived keyboard shortcuts through the existing command preference owner', () => {
  for (const commandId of ['action:review.start', 'session.action:ui.session.rename', 'action:acme.tools/actions/run']) {
    const declaration = readBuiltInSettingDeclarationV1(`keyboard.${commandId}`);
    expect(declaration).toMatchObject({ storage: { owner: 'commandStorage', options: [commandId] } });
    if (!declaration) throw new Error('Derived shortcut is not declared');
    expect(buildBuiltInAccountSettingMutationV1(declaration, accountSettingsParse({}), { enabled: true, binding: 'Mod+Shift+9' }))
      .toMatchObject({ keyboardShortcutOverridesV1: { [commandId]: [{ binding: 'Mod+Shift+9' }] } });
  }
});

it('lets Settings Actions configure the existing Connected Account quota summaries', () => {
  const declaration = readBuiltInSettingDeclarationV1('connectedServices.quotaSummaryStrategy');
  expect(declaration).toBeTruthy();
  if (!declaration) throw new Error('Quota summary preference is not declared');
  const value = { 'anthropic/work': 'min_remaining' };
  expect(buildBuiltInAccountSettingMutationV1(declaration, accountSettingsParse({}), value))
    .toEqual({ connectedServicesQuotaSummaryStrategyByKey: value });
  expect(parseBuiltInAccountSettingValueV1(declaration, { 'anthropic/work': 'unknown' })).toEqual({ success: false });
});

it('exposes deletion reminder lead time to the existing Settings Actions with one shared default', () => {
  const declaration = readBuiltInSettingDeclarationV1('machines.defaults.deletionReminderLeadTime');
  expect(declaration).toMatchObject({ storage: {
    scope: 'account', key: 'managedMachineDeletionReminderLeadTimeMs', access: 'read_write',
  } });
  if (!declaration) throw new Error('Deletion reminder preference is not declared');
  const settings = accountSettingsParse({});
  expect(readBuiltInAccountSettingValueV1(declaration, settings)).toBe(172_800_000);
  expect(buildBuiltInAccountSettingMutationV1(declaration, settings, 604_800_000))
    .toEqual({ managedMachineDeletionReminderLeadTimeMs: 604_800_000 });
  expect(resolveBuiltInAccountSettingResetValueV1(declaration)).toEqual({ success: true, value: 172_800_000 });
});

it('declares every Account feature control before Settings projects its page', () => {
  for (const { featureId, isExperimental } of listUiFeatureToggleDefinitions()) {
    expect(readBuiltInSettingDeclarationV1(`features.${featureId}`), featureId).toMatchObject({
      sectionId: isExperimental ? 'features.experiments' : 'features.optionalFeatures',
      sectionTitleKey: isExperimental ? 'settingsFeatures.experiments' : 'settingsFeatures.localTogglesTitle',
      storage: { scope: 'account', owner: 'featureToggle', options: [featureId], access: 'read_write' },
    });
  }
});

it('discovers MCP server loading under the Code Mode gate and its existing Action owner', () => {
  expect(readBuiltInSettingDeclarationV1('mcp.detail.loading')).toMatchObject({
    pageId: 'mcp',
    sectionId: 'mcp.detail.tools',
    titleKey: 'capabilities.mcp.tools.loading.rowTitle',
    featureId: 'sessions.codeMode',
    storage: { scope: 'account', kind: 'owner', owner: 'mcp.servers.tools.set', access: 'read_write',
      field: 'loading', allowedValues: ['every_turn', 'on_demand'] },
  });
});

it('offers only the canonical Dictation recognition language to Settings Actions', () => {
  expect(readBuiltInSettingDeclarationV1('voiceDictation.language')?.storage?.options).toEqual(['dictation.language']);
  expect(readBuiltInSettingDeclarationV1('voiceDictation.sttLanguage')).toBeNull();
  expect(readBuiltInSettingDeclarationV1('voiceConversations.sttLanguage')).not.toBeNull();
});

it('declares capture preferences at their native or local device owner', () => {
  for (const [anchor, owner] of [
    ['desktop.captureShortcut', 'captureShortcut'], ['desktop.instantWindowShortcut', 'instantWindowShortcut'],
    ['desktop.recordingShortcut', 'recordingShortcut'], ['desktop.captureFolder', 'libraryFolder'],
  ]) expect(readBuiltInSettingDeclarationV1(anchor)).toMatchObject({ pageId: 'desktop', storage: {
    scope: 'local', kind: 'localOwner', owner: 'desktopCapturePreferenceBinding', options: [owner], access: 'read_write',
  } });
  expect(readBuiltInSettingDeclarationV1('desktop.captureSound')).toMatchObject({ storage: { scope: 'local', key: 'screenCaptureSound' } });
  expect(readBuiltInSettingDeclarationV1('desktop.captureIncludeWindowText')).toMatchObject({ storage: { scope: 'local', key: 'screenCaptureIncludeWindowText' } });
});

describe('Workflows setting alias', () => {
  it('resolves the released Automations setting to the same declaration and preference writer', () => {
    const workflow = readBuiltInSettingDeclarationV1('features.workflows');
    const alias = readBuiltInSettingDeclarationV1('features.automations');
    expect(workflow).not.toBeNull();
    expect(alias).toBe(workflow);
    expect(buildBuiltInAccountSettingMutationV1(alias!, { featureToggles: { automations: false } }, true))
      .toEqual({ featureToggles: { automations: true } });
  });
});

describe('producer-owned Home process facts', () => {
  it('omits internal registry facts from portable discovery while retaining real Home settings', () => {
    const offeredKeys = BUILT_IN_SETTINGS_DECLARATIONS_V1
      .filter(declaration => declaration.storage?.scope === 'home' && declaration.storage.kind === 'homeSettings')
      .map(declaration => declaration.storage?.key);
    for (const key of [
      'HAPPIER_PERSONAL_HOME_RELOCATION_OPERATION_ID', 'HAPPIER_SERVER_STARTUP_RECEIPT_PATH',
      'HAPPIER_SERVER_STARTUP_RECEIPT_NONCE', 'HAPPIER_UPDATER_FORWARD_RECOVERY_CAPABILITY',
      'HAPPIER_RELEASE_SOURCE_SHA', 'HAPPIER_SERVER_FLAVOR',
    ]) expect(offeredKeys).not.toContain(key);
    expect(offeredKeys).toContain('PORT');
    expect(offeredKeys).toContain('SERVER_ROLE');
  });
});

describe('deliberate atmosphere picture selection', () => {
  it('retains stored siblings that the owning mutation schema already accepts', () => {
    const declaration = readBuiltInSettingDeclarationV1('externalSessions.keepFollowingAfterRestart')!;
    const current = { v: 1, keepPassivelyFollowingAfterRestart: false, autoLinkSourcePolicies: [], futureNested: { revision: 2 } };
    expect(buildBuiltInAccountSettingMutationV1(declaration, { externalSessionsSettingsV1: current }, true))
      .toEqual({ externalSessionsSettingsV1: { ...current, keepPassivelyFollowingAfterRestart: true } });
  });

  it('applies a field intent to an absent stored owner through its canonical defaults', () => {
    const declaration = readBuiltInSettingDeclarationV1('appearance.atmosphereShowOn')!;
    expect(buildBuiltInAccountSettingMutationV1(declaration, {}, ['home']))
      .toEqual({ homeAtmosphere: { ...accountSettingsParse({}).homeAtmosphere, showOn: ['home'] } });
  });

  it('opens retained compound fields before strictly admitting the new field intent', () => {
    const declaration = readBuiltInSettingDeclarationV1('appearance.atmosphereShowOn')!;
    const current = accountSettingsParse({}).homeAtmosphere;
    const stored = { homeAtmosphere: { ...current, planet: { ...current.planet, digits: false, nextRelease: true }, nextRelease: true } };
    expect(buildBuiltInAccountSettingMutationV1(declaration, stored, ['home']))
      .toEqual({ homeAtmosphere: { ...current, planet: { ...current.planet, digits: false }, showOn: ['home'] } });
    expect(buildBuiltInAccountSettingMutationV1(declaration, stored, ['home', 'unsupported-place'])).toBeNull();
  });

  it('writes only the authored picture preference', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    try {
      const declaration = readBuiltInSettingDeclarationV1('appearance.atmospherePictureRef')!;
      const baseline = accountSettingsParse({});
      const mutation = buildBuiltInAccountSettingMutationV1(declaration, baseline, { kind: 'builtin', id: 'calm-sea' });
      expect(mutation?.homeAtmosphere).toEqual({ ...baseline.homeAtmosphere, picture: { ...baseline.homeAtmosphere.picture, ref: { kind: 'builtin', id: 'calm-sea' } } });
      const changed = accountSettingsParse({ ...baseline, ...mutation });
      const layout = readBuiltInSettingDeclarationV1('appearance.atmospherePictureLayout')!;
      expect(buildBuiltInAccountSettingMutationV1(layout, changed, 'wallpaper')?.homeAtmosphere)
        .toMatchObject({ picture: { ...changed.homeAtmosphere.picture, layout: 'wallpaper' } });
    } finally { vi.useRealTimers(); }
  });
});

describe('Collection deletion approval presentation', () => {
  it.each(['sessionWork', 'workflow', 'discussion'] as const)('reviews the %s saved-space consequence through settings.invoke', entityKind => {
    const anchor = `${entityKind === 'sessionWork' ? 'session' : entityKind}.list.spaces`;
    const spec = getActionSpec('settings.invoke');
    const input = { anchor, input: { kind: 'collection_space', entityKind, mutation: { op: 'delete', spaceId: 'saved' } } };
    expect(spec.safetyForInput?.(input)).toBe('danger');
    expect(isApprovalRequiredByActionsSettings('settings.invoke', accountSettingsParse({}).actionsSettingsV1,
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }, undefined, undefined, input)).toBe(true);
    const reset = { anchor, input: { kind: 'collection_space', entityKind, mutation: { op: 'resetDefault' } } };
    expect(spec.safetyForInput?.(reset)).toBe('safe');
    expect(isApprovalRequiredByActionsSettings('settings.invoke', accountSettingsParse({}).actionsSettingsV1,
      { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }, undefined, undefined, reset)).toBe(false);
  });
});

describe('restored session-list indicator preferences (owner amendment 2026-11-01)', () => {
  it('keeps the 0.2 Account choices effective and settable from Appearance → Sessions', () => {
    const defaults = accountSettingsParse({});
    expect(defaults.sessionListNarrowWorkingIndicatorStyle).toBe('spinner');
    expect(defaults.sessionListWorkingStatusAnimatedTextEnabled).toBe(true);
    const stored = accountSettingsParse({ sessionListWorkingStatusAnimatedTextEnabled: false,
      sessionListNarrowWorkingIndicatorStyle: 'pulse', sessionListStatusWords: true });
    expect(stored.sessionListNarrowWorkingIndicatorStyle).toBe('pulse');
    expect(stored.sessionListWorkingStatusAnimatedTextEnabled).toBe(false);
    for (const [anchor, key, value] of [
      ['appearance.sessionListWorkingIndicator', 'sessionListNarrowWorkingIndicatorStyle', 'pulse'],
      ['appearance.sessionListWorkingStatusAnimatedText', 'sessionListWorkingStatusAnimatedTextEnabled', false],
    ] as const) {
      expect(isAccountSettingsReadOnlySourceKeyV1(key)).toBe(false);
      const declaration = readBuiltInSettingDeclarationV1(anchor);
      expect(declaration).toMatchObject({ pageId: 'appearance', sectionId: 'appearance.sessions', agentSafety: 'safe',
        storage: { scope: 'account', key, access: 'read_write' } });
      expect(buildBuiltInAccountSettingMutationV1(declaration!, stored, value)).not.toBeNull();
    }
  });
});

describe('status words Settings declaration', () => {
  it('owns one opt-in Account boolean for every host work column', () => {
    const anchor = 'session.list.statusWords';
    expect(BUILT_IN_SETTINGS_DECLARATIONS_V1.filter(value => value.anchor === anchor)).toHaveLength(1);
    const declaration = readBuiltInSettingDeclarationV1(anchor);
    expect(declaration).toMatchObject({ pageId: 'session', sectionId: 'session.rowDetails',
      sectionTitleKey: 'settingsSession.rootGroups.rowDetails.title', agentSafety: 'safe',
      sensitive: false,
      storage: { scope: 'account', key: 'sessionListStatusWords', access: 'read_write' } });
    if (!declaration) throw new Error('Status words setting unavailable');
    const baseline = accountSettingsParse({});
    expect(readBuiltInAccountSettingValueV1(declaration, baseline)).toBe(false);
    expect(buildBuiltInAccountSettingMutationV1(declaration, baseline, true)).toEqual({ sessionListStatusWords: true });
    expect(readBuiltInAccountSettingValueV1(declaration, accountSettingsParse({ sessionListStatusWords: true }))).toBe(true);
    expect(readBuiltInAccountSettingValueV1(declaration, accountSettingsParse({ sessionListStatusWords: 'true' }))).toBe(false);
    expect(buildBuiltInAccountSettingMutationV1(declaration, baseline, 'true')).toBeNull();
    expect(resolveBuiltInAccountSettingResetValueV1(declaration)).toEqual({ success: true, value: false });
  });
});

describe('attention placement Settings declaration', () => {
  it('belongs to Session list without changing its anchor or Account value contract', () => {
    const anchor = 'session.list.attentionPlacement';
    expect(BUILT_IN_SETTINGS_DECLARATIONS_V1.filter(value => value.anchor === anchor)).toHaveLength(1);
    const declaration = readBuiltInSettingDeclarationV1(anchor);
    expect(declaration).toMatchObject({ pageId: 'session', sectionId: 'session.listOrganization',
      sectionTitleKey: 'settingsSession.rootGroups.listOrganization.title', agentSafety: 'safe',
      sensitive: false,
      storage: { scope: 'account', key: 'sessionListAttentionPlacementV1', access: 'read_write',
        allowedValues: ['both', 'top', 'inPlace'] } });
    if (!declaration) throw new Error('Attention placement setting unavailable');
    const baseline = accountSettingsParse({});
    expect(readBuiltInAccountSettingValueV1(declaration, baseline)).toBe('both');
    for (const value of ['both', 'top', 'inPlace']) {
      const mutation = buildBuiltInAccountSettingMutationV1(declaration, baseline, value);
      expect(mutation).toEqual({ sessionListAttentionPlacementV1: value });
      expect(readBuiltInAccountSettingValueV1(declaration, accountSettingsParse({ ...baseline, ...mutation }))).toBe(value);
    }
    expect(buildBuiltInAccountSettingMutationV1(declaration, baseline, 'working')).toBeNull();
    expect(resolveBuiltInAccountSettingResetValueV1(declaration)).toEqual({ success: true, value: 'both' });
  });
});

describe('background-work attention Settings declaration', () => {
  it('reads, writes and resets the preference through its portable account owner', () => {
    const declaration = readBuiltInSettingDeclarationV1('session.list.backgroundWorkAttention');
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
  it('addresses collapsed groups through the device disclosure owner rather than a Settings key', () => {
    const declaration = readBuiltInSettingDeclarationV1('session.list.collapsedGroups');
    expect(declaration?.storage).toEqual({ scope: 'local', kind: 'localOwner',
      owner: 'sessionListDisclosureBinding', access: 'read_write' });
  });

  it('edits suggestion fields through the Account policy while preserving privacy and source choices', () => {
    const declaration = readBuiltInSettingDeclarationV1('sourceControl.aiSuggestionsEnabled');
    expect(declaration).not.toBeNull();
    if (!declaration) return;
    const settings = accountSettingsParse({ filesEditorAiSuggestionsV1: {
      connectionId: 'pc_local', modelId: 'base', excludedGlobs: ['private/**'], disabledLanguageIds: ['markdown'],
    } });
    const mutation = buildBuiltInAccountSettingMutationV1(declaration, settings, true);
    expect(accountSettingsParse({ ...settings, ...mutation }).filesEditorAiSuggestionsV1)
      .toEqual({ ...settings.filesEditorAiSuggestionsV1, enabled: true });
    expect(buildBuiltInAccountSettingMutationV1(declaration, settings, 'true')).toBeNull();
    const model = readBuiltInSettingDeclarationV1('sourceControl.aiSuggestionsModel');
    expect(model).not.toBeNull();
    if (model) expect(buildBuiltInAccountSettingMutationV1(model, settings, 'another'))
      .toEqual({ filesEditorAiSuggestionsV1: { ...settings.filesEditorAiSuggestionsV1, modelId: 'another' } });
  });
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
    for (const value of ['suggest', 'list_pin', 'none']) {
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


it('exposes the Session window Bot rail as one device-local switch', () => {
    expect(readBuiltInSettingDeclarationV1('desktop.windowBotRail')).toMatchObject({ pageId: 'desktop', sectionId: 'desktop.windows',
        storage: { scope: 'local', key: 'desktopWindowBotRailEnabled', access: 'read_write' } });
});

it('offers the contracted Notch controls and retires competing preference Actions', () => {
    const controls = BUILT_IN_SETTINGS_DECLARATIONS_V1.filter(value => value.sectionId === 'desktop.overlay');
    expect(controls.map(value => value.anchor)).toEqual(['desktop.enabled', 'desktop.dock', 'desktop.display', 'desktop.idle',
        'desktop.visibilityMode', 'desktop.notchConversationPresentation', 'desktop.alwaysOnTop']);
    expect(readBuiltInSettingDeclarationV1('desktop.notchConversationPresentation')).toMatchObject({ storage: {
        scope: 'local', key: 'desktopNotchConversationPresentation', allowedValues: ['overlay', 'window'],
    } });
    for (const anchor of ['desktop.showWhenRunning', 'desktop.showWhenAttentionRequired', 'desktop.showWhenReady',
        'desktop.autoHideEnabled', 'desktop.autoHideDelay', 'desktop.showPreviewText', 'pets.desktopOverlayVisibilityMode']) {
        expect(readBuiltInSettingDeclarationV1(anchor)).toBeNull();
    }
});

it('lets an agent change the four Home look choices without a prompt, in the words the sheet shows', () => {
    const rows = [
        ['appearance.atmosphereSource', undefined],
        ['appearance.atmospherePlanetIntensity', ['quiet', 'calm', 'full']],
        ['appearance.homeBackgroundField', ['animated', 'still', 'off']],
        ['appearance.atmospherePlanetDigits', undefined],
    ] as const;
    for (const [anchor, allowedValues] of rows) {
        const declaration = readBuiltInSettingDeclarationV1(anchor);
        expect(declaration, anchor).toMatchObject({ pageId: 'appearance', agentSafety: 'safe', sensitive: false });
        if (allowedValues) expect(declaration?.storage?.allowedValues, anchor).toEqual(allowedValues);
    }
    expect(readBuiltInSettingDeclarationV1('appearance.atmospherePlanetPlacement')).toBeNull();
    expect(readBuiltInSettingDeclarationV1('appearance.atmospherePlanetStyle')).toBeNull();
});
