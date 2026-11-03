import { describe, expect, it } from 'vitest';
import { SETTINGS_DECLARATION_ACTION_IDS_V1, SettingsDeclarationActionInputSchemasV1 } from './settingsDeclarationActionFamily.js';
import { getActionSpec } from './actionSpecs.js';
import { normalizeSessionListFilterV1 } from '../sessions/listFilter/sessionListFilterV1.js';

describe('collection space intent admission', () => {
  it('accepts entity-bound intents while rejecting authority, foreign filters and unknown mutation fields', () => {
    const schema = SettingsDeclarationActionInputSchemasV1['settings.invoke'];
    const input = { kind: 'collection_space', entityKind: 'sessionWork', mutation: {
      op: 'create', space: { entityKind: 'sessionWork', id: 'work', name: ' Work ', icon: { kind: 'icon', name: 'list' },
        filter: normalizeSessionListFilterV1(), includeNeedsYouEverywhere: false },
    } };
    expect(schema.safeParse({ anchor: 'session.list.spaces', input }).success).toBe(true);
    for (const changed of [
      { ...input, accountId: 'other' },
      { ...input, entityKind: 'workflow' },
      { ...input, mutation: { ...input.mutation, beforeSpaceId: 'unexpected' } },
      { ...input, mutation: { op: 'edit', spaceId: 'work', changes: { filter: { view: 'all' } } } },
      { ...input, mutation: { op: 'delete', spaceId: 'my-work' } },
    ]) expect(schema.safeParse({ anchor: 'session.list.spaces', input: changed }).success).toBe(false);
  });
});

describe('Voice credential source operation admission', () => {
  it('admits reference-only Voice binding, removal and recipient review, rejecting material and authority', () => {
    const schema = SettingsDeclarationActionInputSchemasV1['settings.invoke'];
    const base = { kind: 'voice_saved_secret', credentialSlotId: 'api_key', expectedSettingsVersion: 3,
      machineId: 'machine-a', expectedSecretId: null, expectedSecretUpdatedAt: null };
    for (const operation of [
      { ...base, operation: 'bind', secretId: 'happier:shared-secret:v1:existing' },
      { ...base, operation: 'remove', expectedSecretId: 'existing', expectedSecretUpdatedAt: 2 },
      { ...base, operation: 'review', expectedSecretId: 'existing', expectedSecretUpdatedAt: 2 },
      { ...base, operation: 'inspect' },
    ]) {
      expect(schema.safeParse({ anchor: 'voiceConversations.provider.acme.voice/realtime.credential', input: operation }).success).toBe(true);
      for (const extra of [{ value: 'private' }, { approvedRecipientContractDigest: 'caller-approval' }, { confirmed: true }, { accountId: 'other' }]) {
        expect(schema.safeParse({ anchor: 'voiceConversations.provider.acme.voice/realtime.credential', input: { ...operation, ...extra } }).success).toBe(false);
      }
    }
    for (const value of [null, { v: 1, bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'connected', profileId: 'work' } } },
      { v: 1, bindingsByServiceId: { 'happier.agent.codex/openai-codex': { source: 'connected', selection: 'group', groupId: 'pool' } } }]) {
      expect(schema.safeParse({ anchor: 'voiceConversations.provider.acme.voice/realtime.globalConnectedServices',
        input: { kind: 'voice_connected_services', expectedSettingsVersion: 3, value } }).success).toBe(true);
    }
  });
  it('admits exact source choices without accepting secret values or caller authority', () => {
    const schema = SettingsDeclarationActionInputSchemasV1['settings.invoke'];
    const input = { kind: 'voice_credential_source', credentialSlotId: 'api_key', expectedSettingsVersion: 3,
      selection: { kind: 'connectedAccount', target: { kind: 'account', account: {
        service: { pluginId: 'acme.voice', localId: 'account' }, accountId: 'work',
      } } } };
    expect(schema.safeParse({ anchor: 'voiceConversations.provider.acme.voice/realtime.credentialSource', input }).success).toBe(true);
    for (const patch of [{ selection: { kind: 'savedSecret', value: 'secret' } }, { secret: 'secret' },
      { confirmed: true }, { accountId: 'other' }, { expectedSettingsVersion: -1 }]) {
      expect(schema.safeParse({ anchor: 'voiceConversations.provider.acme.voice/realtime.credentialSource', input: { ...input, ...patch } }).success).toBe(false);
    }
  });
});

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
      { kind: 'project', serverId: 'home-1', projectKey: 'project-1' },
      { kind: 'public_profile_draft', serverId: 'home-1' },
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

describe('atmosphere picture operation input admission', () => {
  it('accepts URL or exact Machine file acquisition and rejects authority, local-path and removal-input additions', () => {
    const schema = SettingsDeclarationActionInputSchemasV1['settings.invoke'];
    for (const source of [{ kind: 'url', url: 'https://example.test/image.webp' },
      { kind: 'picked' },
      { kind: 'machine_file', machineId: 'machine-1', path: 'C:\\Pictures\\image.png' }]) {
      expect(schema.safeParse({ anchor: 'appearance.atmospherePictureAdd', input: { kind: 'atmosphere_picture_add', source } }).success).toBe(true);
      expect(schema.safeParse({ anchor: 'appearance.atmospherePictureAdd', input: { kind: 'atmosphere_picture_add', source: { ...source, accountId: 'other' } } }).success).toBe(false);
    }
    for (const source of [{ kind: 'url', url: 'file:///private/image.png' }, { kind: 'url', url: 'data:image/png;base64,aQ==' },
      { kind: 'picked', uri: 'file:///private/image.png' }, { kind: 'picked', data: 'data:image/png;base64,aQ==' },
      { kind: 'machine_file', path: '/image.png' }, { kind: 'file', path: '/image.png' }]) {
      expect(schema.safeParse({ anchor: 'appearance.atmospherePictureAdd', input: { kind: 'atmosphere_picture_add', source } }).success).toBe(false);
    }
    expect(schema.safeParse({ anchor: 'appearance.atmospherePictureRemove', input: { kind: 'atmosphere_picture_remove', localId: 'user-1', confirmed: true } }).success).toBe(false);
    expect(schema.safeParse({ anchor: 'appearance.atmospherePictureAdd', target: { kind: 'public_profile_draft', serverId: 'home-1' },
      input: { kind: 'atmosphere_picture_add', source: { kind: 'picked' } } }).success).toBe(true);
  });
});

describe('Settings declaration surface parity', () => {
  it('admits exact object and multi-key receipts as bound-setting restore inputs', () => {
    const basis = { kind: 'restore', scope: { serverId: 'home', accountId: 'account' }, beforeVersion: 1, appliedVersion: 2 };
    expect(SettingsDeclarationActionInputSchemasV1['settings.set'].safeParse({
      anchor: 'sourceControl.backendDefaultDiff', value: { backendId: 'external.scm/backend', mode: 'pending' },
      reversal: { ...basis, before: { unset: true }, applied: { value: { 'external.scm/backend': 'pending' } } },
    }).success).toBe(true);
    expect(SettingsDeclarationActionInputSchemasV1['settings.set'].safeParse({
      anchor: 'sourceControl.gitRouting', value: 'external.scm/backend',
      reversal: { ...basis, changes: [
        { key: 'scmBackendRouting', before: { unset: true }, applied: { value: 'plugin' } },
        { key: 'scmGitRepoBackend', before: { unset: true }, applied: { value: 'external.scm/backend' } },
      ] },
    }).success).toBe(true);
  });
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
