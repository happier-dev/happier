import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { useExternalSessionsAutoLinkSources } = await import('./useExternalSessionsAutoLinkSources');
afterEach(standardCleanup);

const agent = { pluginId: 'happier.agent.codex', localId: 'codex' };
const policy = { machineId: 'machine-one', qualifiedIdentity: { v: 1 as const, agent,
    source: { kind: 'codexHome', contractVersion: 1 } }, sourcePolicyId: `es-source-policy:v1:${'d'.repeat(64)}`, enabledAtMs: 100 };
const knownAgents = [{ agent, agentTitle: 'Codex' }];
const externalSettings = { v: 1, keepPassivelyFollowingAfterRestart: false, autoLinkSourcePolicies: [policy] };

describe('useExternalSessionsAutoLinkSources', () => {
    it('admits source removal through Settings Actions and captures the revision when the operation starts', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ externalSessionsSettingsV1: externalSettings,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } }) });
        try {
            let renders = 0;
            const hook = await renderHook(() => {
                renders += 1;
                return useExternalSessionsAutoLinkSources({ rawSettings: externalSettings, knownAgents });
            });
            await expect(hook.getCurrent()[0]!.setEnabled(false)).rejects.toMatchObject({ code: 'action_disabled' });
            expect(account.settingsWrites).toHaveLength(0);
            await act(async () => account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1 } })));
            const descriptors = hook.getCurrent();
            const beforeUnrelatedRevision = renders;
            // An unrelated revision must preserve the projection and the next operation's fresh CAS.
            await act(async () => account.replaceSettings(settingsParse({ ...account.persistedSettings,
                showFlavorIcons: !account.persistedSettings.showFlavorIcons }), { version: 2 }));
            expect(renders).toBe(beforeUnrelatedRevision);
            expect(hook.getCurrent()).toBe(descriptors);
            await act(async () => { await descriptors[0]!.setEnabled(false); });
            expect(account.settingsWrites).toHaveLength(1);
            expect(account.persistedSettings.externalSessionsSettingsV1).toMatchObject({ autoLinkSourcePolicies: [] });
        } finally { standardCleanup(); await account.dispose(); }
    });

    it('keeps foreign-server policy controls inert and rejects a retired Account scope', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ externalSessionsSettingsV1: externalSettings }) });
        try {
            const hook = await renderHook(() => useExternalSessionsAutoLinkSources({ rawSettings: externalSettings, knownAgents,
                accountOperationsAvailable: false }));
            expect(hook.getCurrent()[0]?.canChange).toBe(false);
            await hook.getCurrent()[0]!.setEnabled(false);
            expect(account.settingsWrites).toHaveLength(0);
            const own = await renderHook(() => useExternalSessionsAutoLinkSources({ rawSettings: externalSettings, knownAgents }));
            const remove = own.getCurrent()[0]!.setEnabled;
            await act(async () => storage.setState({ settingsScope: { ...account.scope, accountId: 'another-account' } }));
            await expect(remove(false)).rejects.toMatchObject({ code: 'action_account_scope_changed' });
            expect(account.settingsWrites).toHaveLength(0);
        } finally { standardCleanup(); await account.dispose(); }
    });
});
