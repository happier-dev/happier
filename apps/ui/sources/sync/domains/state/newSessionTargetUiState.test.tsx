import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { writePersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { accountSettingsScopeKeySuffix } from '@/sync/domains/settings/scope/accountSettingsScope';
import { clearPersistenceStorage, getPersistenceStorage } from './persistenceStorage';
import { loadAccountSettings, prepareAccountSettingsScopeForActivation, saveAccountSettings } from './accountSettingsPersistence';
import { clearOrdinaryNewSessionDraftIdExact, migrateNewSessionUiState, migrateNewSessionUiStateScope, readLastNewSessionAgentPickerView, readLastUsedBackendSelection, readOrdinaryNewSessionDraftId, rememberLastNewSessionAgentPickerView, rememberLastUsedBackendSelection, rememberOrdinaryNewSessionDraftId, useLastUsedBackendSelectionForScope, useOrdinaryNewSessionDraftId } from './newSessionTargetUiState';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { loadSettings, saveSettings } from './settingsPersistence';

afterEach(() => { standardCleanup(); vi.restoreAllMocks(); clearPersistenceStorage(); });

const scope = { serverId: 'srv_lastused', accountId: 'alice' };
const otherScope = { ...scope, accountId: 'bob' };
const cacheKey = `account-settings:v2:${accountSettingsScopeKeySuffix(scope)}`;
const target = writePersistedBackendTargetRefV2({ kind: 'backend', backendId: 'codex' });

describe('device-local New Session target memory', () => {
    it('keeps a valid legacy target when its warmed destination only projected an invalid target to empty memory', () => {
        const device = getPersistenceStorage();
        const destination = `ui-state:new-session-target-v1:${serverAccountScopeKeySuffix(scope)}`;
        const invalid = JSON.stringify({ lastUsedBackendTarget: { kind: 'unknown' }, lastUsedAgent: null });
        device.set(destination, invalid);
        const source = JSON.stringify({ version: 3, settings: { lastUsedBackendTarget: target } });
        device.set(cacheKey, source);
        expect(readLastUsedBackendSelection(scope)).toEqual({ lastUsedBackendTarget: null, lastUsedAgent: null });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        loadAccountSettings(scope);
        expect(device.getString(cacheKey)).toBe(source);
        expect(() => saveAccountSettings(scope, settingsDefaults, 3)).toThrow();
        expect(device.getString(destination)).toBe(invalid);
    });
    it.each([
        { kind: 'draft', raw: '{invalid' }, { kind: 'draft', raw: '"not-a-draft-id"' },
        { kind: 'picker', raw: '{invalid' }, { kind: 'picker', raw: '{"kind":"unknown"}' },
    ] as const)('keeps valid legacy memory when a warmed $kind destination cannot be admitted: $raw', ({ kind, raw }) => {
        const device = getPersistenceStorage();
        const namespace = kind === 'draft' ? 'new-session-ordinary-draft-v1' : 'new-session-picker-view-v1';
        const destination = `ui-state:${namespace}:${serverAccountScopeKeySuffix(scope)}`;
        device.set(destination, raw);
        const seed = kind === 'draft' ? { newSessionOrdinaryEntryDraftId: '4a506d8a-85bd-4c42-a662-6f502f3acc45' }
            : { lastNewSessionAgentPickerViewV1: { kind: 'favoriteModels' } };
        const source = JSON.stringify({ version: 3, settings: seed });
        device.set(cacheKey, source);
        expect(kind === 'draft' ? readOrdinaryNewSessionDraftId(scope) : readLastNewSessionAgentPickerView(scope)).toBeNull();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        loadAccountSettings(scope);
        expect(device.getString(cacheKey)).toBe(source);
        expect(() => saveAccountSettings(scope, settingsDefaults, 3)).toThrow();
        expect(device.getString(cacheKey)).toBe(source);
        expect(device.getString(destination)).toBe(raw);
    });

    it('refuses scope adoption into a warmed unreadable destination and keeps the source memory', () => {
        const adoptedScope = { ...scope, serverId: 'unreadable-adopted-home' };
        const draftId = '4a506d8a-85bd-4c42-a662-6f502f3acc45';
        rememberOrdinaryNewSessionDraftId(scope, draftId);
        const destination = `ui-state:new-session-ordinary-draft-v1:${serverAccountScopeKeySuffix(adoptedScope)}`;
        getPersistenceStorage().set(destination, '{invalid');
        expect(readOrdinaryNewSessionDraftId(adoptedScope)).toBeNull();
        expect(() => migrateNewSessionUiStateScope(scope, adoptedScope)).toThrow();
        expect(readOrdinaryNewSessionDraftId(scope)).toBe(draftId);
        expect(getPersistenceStorage().getString(destination)).toBe('{invalid');
    });
    it('retains a refused unscoped legacy import through an unrelated preference save, then retries', () => {
        const device = getPersistenceStorage();
        const draftId = '4a506d8a-85bd-4c42-a662-6f502f3acc45';
        const raw = JSON.stringify({ version: 2, settings: {
            lastNewSessionAgentPickerViewV1: { kind: 'favoriteModels' }, newSessionOrdinaryEntryDraftId: draftId,
        } });
        device.set('settings', raw);
        const set = device.set.bind(device);
        const refusal = vi.spyOn(device, 'set').mockImplementation((key, value) => {
            if (key.startsWith('ui-state:new-session-ordinary-draft-v1:')) throw new Error('device full');
            set(key, value);
        });
        expect(() => saveSettings({ ...settingsDefaults, analyticsOptOut: true }, 2)).toThrow();
        expect(device.getString('settings')).toBe(raw);
        refusal.mockRestore();
        saveSettings({ ...settingsDefaults, analyticsOptOut: true }, 2);
        expect(readOrdinaryNewSessionDraftId(null)).toBe(draftId);
        expect(readLastNewSessionAgentPickerView(null)).toEqual({ kind: 'favoriteModels' });
        expect(loadSettings().settings).not.toHaveProperty('newSessionOrdinaryEntryDraftId');
    });
    it.each([
        { lastNewSessionAgentPickerViewV1: { kind: 'unknown' } },
        { newSessionOrdinaryEntryDraftId: 'not-a-draft-id' },
        { lastUsedBackendTarget: { kind: 'unknown' } },
        { lastUsedAgent: 42 },
    ])('preserves refused Account-cache admission through an unrelated preference save: %j', seed => {
        const device = getPersistenceStorage();
        const raw = JSON.stringify({ version: 3, settings: seed });
        device.set(cacheKey, raw);
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        loadAccountSettings(scope);
        expect(device.getString(cacheKey)).toBe(raw);
        expect(() => saveAccountSettings(scope, { ...settingsDefaults, analyticsOptOut: true }, 3)).toThrow();
        expect(device.getString(cacheKey)).toBe(raw);
    });
    it('imports the moving 0.2 picker target spelling through canonical target normalization', () => {
        // 0.2 c1e74e521fa2e725702ae21b472afe46a9d2d6c6:
        // backendTargets/backendTargetRef.ts writes this bundled-Agent key.
        getPersistenceStorage().set(cacheKey, JSON.stringify({ version: 3, settings: {
            lastNewSessionAgentPickerViewV1: { kind: 'backend', backendTargetKey: 'agent:codex' },
        } }));
        loadAccountSettings(scope);
        expect(readLastNewSessionAgentPickerView(scope)).toEqual({ kind: 'backend',
            backendTargetKey: 'agent:happier.agent.codex/codex' });
    });

    it('imports picker focus and ordinary-entry custody once without retaining interaction keys in Settings', () => {
        const device = getPersistenceStorage();
        const draftId = '4a506d8a-85bd-4c42-a662-6f502f3acc45';
        device.set(cacheKey, JSON.stringify({ version: 3, settings: {
            analyticsOptOut: true,
            lastNewSessionAgentPickerViewV1: { kind: 'favoriteModels' },
            newSessionOrdinaryEntryDraftId: draftId,
        } }));
        const write = vi.spyOn(device, 'set');
        const imported = loadAccountSettings(scope);
        expect(imported.settings).not.toHaveProperty('lastNewSessionAgentPickerViewV1');
        expect(imported.settings).not.toHaveProperty('newSessionOrdinaryEntryDraftId');
        expect(imported.settings).toMatchObject({ analyticsOptOut: true });
        expect(readLastNewSessionAgentPickerView(scope)).toEqual({ kind: 'favoriteModels' });
        expect(readOrdinaryNewSessionDraftId(scope)).toBe(draftId);
        expect(write.mock.calls.filter(([key]) => key.startsWith('ui-state:new-session-'))).toHaveLength(2);
        write.mockClear();
        loadAccountSettings(scope);
        expect(write).not.toHaveBeenCalled();
    });

    it('keeps focus and draft writes off Settings and notifies only the exact draft scope', async () => {
        const draftId = '4a506d8a-85bd-4c42-a662-6f502f3acc45';
        const newerDraftId = 'fa142bd3-1ec5-487b-a38c-16e7d4f0ab1d';
        let renders = 0;
        const hook = await renderHook(() => { renders++; return useOrdinaryNewSessionDraftId(scope); });
        const write = vi.spyOn(getPersistenceStorage(), 'set');
        const before = renders;
        await act(async () => {
            rememberOrdinaryNewSessionDraftId(otherScope, draftId);
            for (const view of [null, { kind: 'favoriteModels' as const }, null, { kind: 'favoriteModels' as const }]) {
                rememberLastNewSessionAgentPickerView(scope, view);
            }
        });
        expect(renders).toBe(before);
        await act(async () => rememberOrdinaryNewSessionDraftId(scope, draftId));
        expect(hook.getCurrent()).toBe(draftId);
        const afterDraft = renders;
        await act(async () => rememberOrdinaryNewSessionDraftId(scope, draftId));
        expect(renders).toBe(afterDraft);
        await act(async () => {
            rememberOrdinaryNewSessionDraftId(scope, newerDraftId);
            clearOrdinaryNewSessionDraftIdExact(scope, draftId);
        });
        expect(hook.getCurrent()).toBe(newerDraftId);
        await act(async () => clearOrdinaryNewSessionDraftIdExact(scope, newerDraftId));
        expect(hook.getCurrent()).toBeNull();
        expect(readOrdinaryNewSessionDraftId(otherScope)).toBe(draftId);
        expect(write.mock.calls.filter(([key]) => key === 'settings' || key.startsWith('account-settings:'))).toHaveLength(0);
        // A retained pre-migration cache must never overwrite current intent or explicit clearing.
        migrateNewSessionUiState(scope, { newSessionOrdinaryEntryDraftId: draftId,
            lastNewSessionAgentPickerViewV1: { kind: 'backend', backendTargetKey: 'agent:happier.agent.codex/codex' } });
        expect(readOrdinaryNewSessionDraftId(scope)).toBeNull();
        expect(readLastNewSessionAgentPickerView(scope)).toEqual({ kind: 'favoriteModels' });
    });

    it('retains both interaction seeds on storage refusal and retries without overwriting a completed import', () => {
        const device = getPersistenceStorage();
        const draftId = '4a506d8a-85bd-4c42-a662-6f502f3acc45';
        const raw = JSON.stringify({ version: 3, settings: {
            lastNewSessionAgentPickerViewV1: { kind: 'favoriteModels' }, newSessionOrdinaryEntryDraftId: draftId,
        } });
        device.set(cacheKey, raw);
        const set = device.set.bind(device);
        const refusal = vi.spyOn(device, 'set').mockImplementation((key, value) => {
            if (key.startsWith('ui-state:new-session-ordinary-draft-v1:')) throw new Error('device full');
            set(key, value);
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        loadAccountSettings(scope);
        expect(device.getString(cacheKey)).toBe(raw);
        rememberLastNewSessionAgentPickerView(scope, null);
        expect(() => saveAccountSettings(scope, settingsDefaults, 3)).toThrow();
        expect(device.getString(cacheKey)).toBe(raw);
        refusal.mockRestore();
        expect(loadAccountSettings(scope).settings).not.toHaveProperty('newSessionOrdinaryEntryDraftId');
        expect(readOrdinaryNewSessionDraftId(scope)).toBe(draftId);
        expect(readLastNewSessionAgentPickerView(scope)).toBeNull();
    });

    it('notifies only the changed Account/Home and ignores equal writes', async () => {
        let renders = 0;
        const subject = await renderHook(() => {
            renders++;
            return useLastUsedBackendSelectionForScope(scope);
        });
        const initialRenders = renders;
        await act(async () => rememberLastUsedBackendSelection(otherScope, { lastUsedBackendTarget: target }));
        expect(renders).toBe(initialRenders);
        await act(async () => rememberLastUsedBackendSelection(scope, { lastUsedBackendTarget: target, lastUsedAgent: 'codex' }));
        expect(subject.getCurrent().lastUsedBackendTarget).toEqual(target);
        const changedRenders = renders;
        await act(async () => rememberLastUsedBackendSelection(scope, { lastUsedBackendTarget: { ...target } }));
        expect(renders).toBe(changedRenders);
    });

    it('keeps the predecessor source on a refused import, including an unrelated preference save, then retries', () => {
        const device = getPersistenceStorage();
        const raw = JSON.stringify({ version: 3, settings: { lastUsedBackendTarget: target } });
        device.set(cacheKey, raw);
        const write = device.set.bind(device);
        const refusal = vi.spyOn(device, 'set').mockImplementation((key, value) => {
            if (key.startsWith('ui-state:new-session-target-v1:')) throw new Error('device full');
            write(key, value);
        });
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        loadAccountSettings(scope);
        expect(device.getString(cacheKey)).toBe(raw);
        expect(() => saveAccountSettings(scope, { ...settingsDefaults, analyticsOptOut: true }, 3)).toThrow();
        expect(device.getString(cacheKey)).toBe(raw);
        refusal.mockRestore();
        expect(loadAccountSettings(scope).settings).not.toHaveProperty('lastUsedBackendTarget');
        expect(readLastUsedBackendSelection(scope).lastUsedBackendTarget).toEqual(target);
    });

    it('adopts unscoped 0.2 memory into the first Account and preserves it through Home identity migration', async () => {
        const device = getPersistenceStorage();
        const draftId = '4a506d8a-85bd-4c42-a662-6f502f3acc45';
        device.set('settings', JSON.stringify({ version: 2, settings: { lastUsedBackendTarget: target, lastUsedAgent: 'codex',
            lastNewSessionAgentPickerViewV1: { kind: 'favoriteModels' }, newSessionOrdinaryEntryDraftId: draftId } }));
        // Startup may import before authentication; an intervening preference save
        // must not strand that observation under the retired unscoped key.
        migrateNewSessionUiState(null, loadSettings().settings);
        saveSettings(settingsDefaults, 2);
        await prepareAccountSettingsScopeForActivation(scope);
        expect(readLastUsedBackendSelection(scope).lastUsedBackendTarget).toEqual(target);
        expect(readLastNewSessionAgentPickerView(scope)).toEqual({ kind: 'favoriteModels' });
        expect(readOrdinaryNewSessionDraftId(scope)).toBe(draftId);
        expect(JSON.parse(device.getString(cacheKey)!).settings).not.toHaveProperty('lastUsedBackendTarget');
        const adoptedScope = { ...scope, serverId: 'srv_lastused_adopted' };
        await prepareAccountSettingsScopeForActivation(adoptedScope, [scope]);
        expect(readLastUsedBackendSelection(adoptedScope).lastUsedBackendTarget).toEqual(target);
        expect(readLastNewSessionAgentPickerView(adoptedScope)).toEqual({ kind: 'favoriteModels' });
        expect(readOrdinaryNewSessionDraftId(adoptedScope)).toBe(draftId);
        expect(readLastUsedBackendSelection(otherScope).lastUsedBackendTarget).toBeNull();
        expect(readOrdinaryNewSessionDraftId(otherScope)).toBeNull();
    });
});
