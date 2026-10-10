import { describe, expect, it } from 'vitest';
import { SETTINGS_DECLARATION_ACTION_IDS_V1, SettingsDeclarationActionInputSchemasV1 } from './settingsDeclarationActionFamily.js';
import { getActionSpec } from './actionSpecs.js';

describe('Settings history purge operation admission', () => {
  it('admits only an explicit nonempty exact-version target without credential or confirmation fields', () => {
    const schema = SettingsDeclarationActionInputSchemasV1['settings.invoke'];
    const operation = { anchor: 'account.settingsHistory', input: { kind: 'account_settings_history_purge', versions: [1, 4] } };
    expect(schema.safeParse(operation).success).toBe(true);
    for (const input of [
      { ...operation.input, versions: [] },
      { ...operation.input, versions: [-1] },
      { ...operation.input, confirmed: true },
      { ...operation.input, content: { t: 'encrypted', c: 'private' } },
    ]) expect(schema.safeParse({ ...operation, input }).success).toBe(false);
  });
});

describe('explicit Settings resource target admission', () => {
  it('admits exact Home, Team and connection addresses and rejects caller authority fields', () => {
    for (const target of [
      { kind: 'home', serverId: 'home-1' },
      { kind: 'team', serverId: 'home-1', teamId: 'team-1' },
      { kind: 'team_identity_connection', serverId: 'home-1', teamId: 'team-1', connectionId: 'connection-1' },
    ]) {
      for (const actionId of ['settings.get', 'settings.set'] as const) {
        const input = { anchor: 'teams.authentication.admissionJit', ...(actionId === 'settings.set' ? { value: true } : {}), target };
        expect(SettingsDeclarationActionInputSchemasV1[actionId].safeParse(input).success).toBe(true);
        expect(SettingsDeclarationActionInputSchemasV1[actionId].safeParse({ ...input, target: { ...target, accountId: 'other-account' } }).success).toBe(false);
      }
    }
    expect(SettingsDeclarationActionInputSchemasV1['settings.set'].safeParse({ anchor: 'appearance.themeMode', value: 'dark',
      target: { kind: 'team', serverId: 'home-1' } }).success).toBe(false);
  });
});

describe('Settings declaration surface parity', () => {
  it('publishes reset with a strict target and eligible Voice discovery', () => {
    expect(SETTINGS_DECLARATION_ACTION_IDS_V1).toEqual([
      'settings.list', 'settings.get', 'settings.set', 'settings.reset', 'settings.invoke',
    ]);
    expect(SettingsDeclarationActionInputSchemasV1['settings.reset'].safeParse({
      anchor: 'appearance.themeMode',
    }).success).toBe(true);
    expect(SettingsDeclarationActionInputSchemasV1['settings.reset'].safeParse({
      anchor: 'appearance.themeMode', value: 'dark',
    }).success).toBe(false);
    for (const actionId of SETTINGS_DECLARATION_ACTION_IDS_V1) {
      const spec = getActionSpec(actionId);
      expect(spec.surfaces.voice, actionId).toBe(true);
      expect(spec.bindings.voiceClientToolName, actionId).toBe(actionId.replaceAll('.', '_'));
    }
  });
});
