import { describe, expect, it } from 'vitest';

import { createLiveStorageStoreMock, createStorageModuleMock, createStorageModuleStub, createUseSettingMock } from './storage';
import { createSessionFixture } from '../fixtures/sessionFixtures';
import { createToolCallMessageFixture } from '../fixtures/transcriptFixtures';
import { clearSessionMessageDerivedCachesForServerScopeReset, readSessionMessagesSnapshot } from '@/sync/store/hooks';
import { clearSessionTranscriptDerivedCachesForSession } from '@/sync/runtime/sessionTranscriptDerivedCaches';

describe('storage fixture setting readers', () => {
    it('reads the injected Session owner and keeps the canonical ordered transcript snapshot', () => {
        const session = createSessionFixture();
        let sessions = { [session.id]: session };
        const store = createLiveStorageStoreMock(() => ({ sessions }));
        const module = createStorageModuleStub({ storage: store });
        expect(store((state) => [state.profile.connectedServicesV2, state.profile.connectedAccountsV4])).toEqual([[], []]);
        expect(store((state) => state.profile)).toBe(module.useProfile());
        const explicitProfile = { ...store.getState().profile, id: 'account-2' };
        const overriddenStore = createLiveStorageStoreMock(() => ({ profile: explicitProfile }));
        expect(overriddenStore((state) => state.profile)).toBe(explicitProfile);
        expect(module.useSessionMachineId(session.id)).toBe('machine-1');
        expect(module.useSessionMachineId('absent')).toBeNull();
        sessions = { [session.id]: { ...session, metadata: { ...session.metadata!, machineId: 'machine-2' } } };
        expect(module.useSessionMachineId(session.id)).toBe('machine-2');

        const first = createToolCallMessageFixture({ id: 'first', createdAt: 1 });
        const second = createToolCallMessageFixture({ id: 'second', createdAt: 2 });
        const snapshot = module.readSessionMessagesSnapshot(session.id, ['second', 'first'], { first, second }, 1, true);
        expect(snapshot).toEqual([second, first]);
        expect(module.readSessionMessagesSnapshot(session.id, [], {}, 2, false)).toBe(snapshot);
        expect(readSessionMessagesSnapshot(session.id, [], {}, 2, false)).toBe(snapshot);
        clearSessionTranscriptDerivedCachesForSession(session.id);
        expect(module.readSessionMessagesSnapshot(session.id, [], {}, 2, false)).toEqual([]);
        module.readSessionMessagesSnapshot(session.id, ['first'], { first }, 3, true);
        clearSessionMessageDerivedCachesForServerScopeReset();
        expect(module.readSessionMessagesSnapshot(session.id, [], {}, 4, false)).toEqual([]);
    });

    it('reads the injected setting through both read-only and mutable hooks as the fixture changes', () => {
        const values: { scmGitPaneLayout: 'tabs' | 'unified' } = { scmGitPaneLayout: 'tabs' };
        const module = createStorageModuleStub({ useSetting: createUseSettingMock({ values }) });

        expect(module.useSetting('scmGitPaneLayout')).toBe('tabs');
        expect(module.useSettingMutable('scmGitPaneLayout')[0]).toBe('tabs');
        values.scmGitPaneLayout = 'unified';
        expect(module.useSettingMutable('scmGitPaneLayout')[0]).toBe('unified');
    });

    it('uses the injected reader for a partial module without replacing an explicit mutable fixture', async () => {
        const original = createStorageModuleStub({});
        // Module-loader boundary: return a deterministic original namespace, not an app singleton.
        const importOriginal = async <T,>() => original as T;
        const reader = createUseSettingMock({ values: { scmGitPaneLayout: 'tabs' } });
        const partial = await createStorageModuleMock({ importOriginal, overrides: { useSetting: reader } });
        expect(partial.useSettingMutable('scmGitPaneLayout')[0]).toBe('tabs');

        const explicit = createStorageModuleStub({ useSettingMutable: partial.useSettingMutable });
        const preserved = await createStorageModuleMock({ importOriginal, overrides: {
            useSetting: createUseSettingMock({ values: { scmGitPaneLayout: 'unified' } }),
            useSettingMutable: explicit.useSettingMutable,
        } });
        expect(preserved.useSettingMutable('scmGitPaneLayout')[0]).toBe('tabs');
    });
});
