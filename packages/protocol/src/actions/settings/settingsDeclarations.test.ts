import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '../../account/settings/accountSettings.js';
import { isAccountSettingActionSurfaceAllowedV1, isPresentUserSettingWriteV1 } from '../accountSettingDeclarations.js';
import { isApprovalRequiredByActionsSettings } from '../actionApprovalPolicy.js';
import { BUILT_IN_SETTINGS_DECLARATIONS_V1, readBuiltInSettingDeclarationV1,
  parseBuiltInAccountSettingValueV1, readBuiltInAccountSettingValueV1,
  buildBuiltInAccountSettingMutationV1, readPortablePlatformAccountSettingBindingV1,
  readBuiltInSettingsOperationPolicyV1 } from './settingsDeclarations.js';

describe('portable built-in Settings declarations', () => {
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
    expect(isPresentUserSettingWriteV1('settings.set', input)).toBe(true);
    for (const surface of ['agent', 'mcp'] as const) {
      expect(isAccountSettingActionSurfaceAllowedV1('settings.set', input, surface)).toBe(true);
      expect(isApprovalRequiredByActionsSettings('settings.set', waived, { surface }, undefined, undefined, input)).toBe(true);
    }
  });
  it('discovers Account, device, Home and Team Settings without a UI process', () => {
    const registry = BUILT_IN_SETTINGS_DECLARATIONS_V1;
    expect(new Set(registry.map(row => row.anchor)).size).toBe(registry.length);
    expect(registry).toEqual(expect.arrayContaining([
      expect.objectContaining({ anchor: 'appearance.avatarStyle', storage: expect.objectContaining({ scope: 'account', key: 'avatarStyle' }) }),
      expect.objectContaining({ anchor: 'appearance.themeMode', storage: expect.objectContaining({ scope: 'local' }) }),
      expect.objectContaining({ anchor: 'notifications.autoFollowAssigned', targetKinds: ['home'] }),
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
  it('keeps opt-out storage semantics and present-user consent at the shared declaration', () => {
    const declaration = readBuiltInSettingDeclarationV1('account.analytics')!;
    const settings = accountSettingsParse({ analyticsOptOut: true });
    expect(readBuiltInAccountSettingValueV1(declaration, settings)).toBe(false);
    expect(buildBuiltInAccountSettingMutationV1(declaration, settings, true)).toEqual({ analyticsOptOut: false });
    expect(readBuiltInSettingDeclarationV1('delegation.approvalReviewerEnabled')?.presentUserOnly).toBe(true);
    expect(readBuiltInSettingDeclarationV1('transcript.showToolCalls')?.surfaces).toEqual({ agent: false, mcp: false });
    expect(readBuiltInSettingDeclarationV1('voicePrivacy.diagnosticsEnabled')?.storage?.access).toBe('read_only');
    expect(readBuiltInSettingDeclarationV1('voicePrivacy.forgetVoiceAgentMemory')?.operation).toEqual(expect.objectContaining({
      kind: 'invoke', requiresHumanInteraction: true, requiresApproval: true,
    }));
    expect(readBuiltInSettingDeclarationV1('voicePrivacy.diagnosticsCleanup')?.operation).toEqual(expect.objectContaining({
      kind: 'invoke', requiresHumanInteraction: false, requiresApproval: false,
    }));
  });
});
