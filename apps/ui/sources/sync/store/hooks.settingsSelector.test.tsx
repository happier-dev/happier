import { act } from 'react-test-renderer';
import * as React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { clearPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults, settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { useSettingsSelector } from './hooks';
import { useLocalSetting, useSetting } from './settingsReadHooks';
import { holdSettingWrite, useSettingsPreviewStore } from './settingsPreview';
import { useAgentUiSettings, getAgentUiSettingsKeys } from '@/agents/catalog/useAgentUiSettings';
import { publishProjectedAgentUiBehaviorDescriptors, clearProjectedAgentUiBehaviorDescriptors } from '@/agents/registry/agentUiBehaviorProjection';
import { useSessionAuthoringEnginePicker } from '@/components/sessions/authoring/controls/useSessionAuthoringEnginePicker';
import { useSessionListQuerySourceState } from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import { useCollectionSpaceBinding } from '@/components/ui/lists/collection/useCollectionSpaceBinding';
import { useCollectionSpaceFilter } from '@/components/ui/lists/collection/useCollectionSpaceFilter';
import { useNewSessionOrganizationPlacement } from '@/components/sessions/new/organization/useNewSessionOrganizationPlacement';
import { createDefaultCollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import { selectCollectionSpace } from '@/sync/domains/session/listing/sessionListSpaces';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { useFeatureLocalPolicySettings } from '@/hooks/server/useFeatureLocalPolicySettings';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { observeStorageSubscriptionDeliveries } from '@/dev/testkit/performance/storageSubscriptionCensus';

const collectionScope = { serverId: 'selector-home', accountId: 'selector-account' };
const defaultSpace = createDefaultCollectionSpaceV1('sessionWork');
const collectionInput = { defaultName: defaultSpace.name, defaultFilter: defaultSpace.filter };

it('captures the active Space at deliberate New entry and leaves disabled entries without automatic organization context', async () => {
    storage.setState({ profileScope: collectionScope });
    const spaces = ['space-a', 'space-b'].map(id => ({ ...defaultSpace, id, name: id }));
    storage.getState().applySettings(settingsParse({ ...storage.getState().settings,
        collectionSpacesV1: { v: 1, spaces } }), 2);
    await selectCollectionSpace(collectionScope, 'sessionWork', 'space-a');
    // A New Session surface opened from the ordinary entry starts in the active Space (entry context, not a stored draft).
    const enterNew = (input: Readonly<{ startInActiveSpace: boolean; initialSpaceMembership?: null }> = { startInActiveSpace: true }) =>
        renderHook(() => useNewSessionOrganizationPlacement({
            serverId: collectionScope.serverId, executionTarget: null, directory: '', ...input,
        }));
    const captured = await enterNew();
    expect(captured.getCurrent().spaceMembership).toEqual({ spaceId: 'space-a', spaceSettingsTarget: collectionScope });
    await act(async () => {
        await selectCollectionSpace(collectionScope, 'sessionWork', 'space-b');
    });
    // Captured at entry: a later sidebar switch does not move the open draft.
    expect(captured.getCurrent().spaceMembership).toMatchObject({ spaceId: 'space-a' });
    await captured.unmount();
    for (const input of [{ startInActiveSpace: false }, { startInActiveSpace: true, initialSpaceMembership: null }] as const) {
        // Contextual entries and a draft whose Space was cleared start in no Space.
        const other = await enterNew(input);
        expect(other.getCurrent().spaceMembership).toBeNull();
        await other.unmount();
    }
    // Opened before the Account's settings are readable: the entry takes its Space once they are, then keeps it.
    const settingsBefore = storage.getState().settings;
    storage.setState({ settingsVersion: null });
    const cold = await enterNew();
    expect(cold.getCurrent().spaceMembership).toBeNull();
    await act(async () => { storage.getState().applySettings(settingsBefore, 3); });
    expect(cold.getCurrent().spaceMembership).toMatchObject({ spaceId: 'space-b' });
    await act(async () => {
        await selectCollectionSpace(collectionScope, 'sessionWork', 'space-a');
    });
    expect(cold.getCurrent().spaceMembership).toMatchObject({ spaceId: 'space-b' });
    await cold.unmount();
    for (const key of ['collectionSpacesEnabled', 'sessionSpacesEnabled'] as const) {
        await act(async () => { storage.getState().applySettingsLocal({ [key]: false }); });
        const disabled = await enterNew();
        expect(disabled.getCurrent().spaceMembership).toBeNull();
        await disabled.unmount();
        await act(async () => { storage.getState().applySettingsLocal({ [key]: true }); });
    }
});

it.each(['workflow', 'discussion'] as const)('restores ordinary %s filters while disabled and retains the Account-local selection', async entityKind => {
    storage.setState({ profileScope: collectionScope });
    const baseline = createDefaultCollectionSpaceV1(entityKind);
    const space = entityKind === 'workflow'
        ? { ...createDefaultCollectionSpaceV1('workflow'), id: 'saved', filter: { view: 'running' as const } }
        : { ...createDefaultCollectionSpaceV1('discussion'), id: 'saved', filter: { state: 'active' as const, attention: 'needs_you' as const, unreadOnly: true } };
    storage.getState().applySettings(settingsParse({ ...storage.getState().settings,
        collectionSpacesV1: { v: 1, spaces: [space] } }), 2);
    await selectCollectionSpace(collectionScope, entityKind, space.id);
    const lifetime = { scope: collectionScope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
    const counter = createRenderCommitCounter();
    const hook = await renderHook(() => {
        useRenderCommitCounter(counter);
        return useCollectionSpaceFilter(entityKind, { lifetime, defaultName: baseline.name, defaultFilter: baseline.filter });
    });
    expect(hook.getCurrent().filters).toEqual(space.filter);
    counter.reset();
    await act(async () => { storage.getState().applySettings(settingsParse({ ...storage.getState().settings }), 3); });
    expect(counter.read()).toEqual({ renders: 0, commits: 0 });
    await act(async () => { storage.getState().applySettingsLocal({ collectionSpacesEnabled: false }); });
    expect(hook.getCurrent().spacesEnabled).toBe(false);
    expect(hook.getCurrent().filters).toEqual(baseline.filter);
    expect(hook.getCurrent().bound).toBe(true);
    expect(hook.getCurrent().selectedSpaceId).toBe('saved');
    expect(hook.getCurrent().activeSpace).toBeNull();
    await act(async () => { storage.getState().applySettingsLocal({ collectionSpacesEnabled: true }); });
    expect(hook.getCurrent().filters).toEqual(space.filter);
    await hook.unmount();
    await act(async () => {
        storage.getState().applySettingsLocal({ collectionSpacesEnabled: false });
        storage.setState({ settingsVersion: null });
    });
    const cold = await renderHook(() => useCollectionSpaceFilter(entityKind, {
        lifetime, defaultName: baseline.name, defaultFilter: baseline.filter,
    }));
    expect(cold.getCurrent().bound).toBe(false);
    await act(async () => { storage.setState({ settingsVersion: 4 }); });
    expect(cold.getCurrent().bound).toBe(true);
    expect(cold.getCurrent().filters).toEqual(baseline.filter);
    await cold.unmount();
});

beforeEach(async () => {
    clearPersistenceStorage();
    useSettingsPreviewStore.setState({ scope: null, account: {}, local: {}, projects: {}, profiles: {} });
    await storage.getState().activateSettingsScope({ serverId: 'selector-home', accountId: 'selector-account' });
    storage.getState().applySettings(settingsDefaults, 1);
});

it.each([
    { key: 'hideInactiveSessions', anchor: 'session.list.hideInactive' },
    { key: 'useEnhancedSessionWizard', anchor: 'session.startWith' },
] as const)('projects the held $key preference before commit without waking on unrelated keys', async ({ key, anchor }) => {
    let computations = 0;
    const stored = storage.getState().settings[key];
    const select = (settings: Settings) => { computations++; return settings[key]; };
    const counter = createRenderCommitCounter();
    const hook = await renderHook(() => {
        useRenderCommitCounter(counter);
        return useSettingsSelector(select, [key]);
    });
    const gatedCounter = createRenderCommitCounter();
    const gated = await renderHook(() => {
        useRenderCommitCounter(gatedCounter);
        return useSettingsSelector(() => false, [key]);
    });
    gatedCounter.reset();
    const baseline = computations;
    counter.reset();
    let releaseUnrelated!: () => void;
    await act(async () => { releaseUnrelated = holdSettingWrite({ anchor: 'session.list.density' }, 'cozy'); });
    expect(computations).toBe(baseline);
    expect(counter.read()).toEqual({ renders: 0, commits: 0 });
    let release!: () => void;
    await act(async () => { release = holdSettingWrite({ anchor }, !stored, () => ({ [key]: !stored })); });
    expect(storage.getState().settings[key]).toBe(stored);
    expect(hook.getCurrent()).toBe(!stored);
    expect(gatedCounter.read()).toEqual({ renders: 0, commits: 0 });
    await act(async () => { release(); releaseUnrelated(); });
    expect(hook.getCurrent()).toBe(stored);
    await act(async () => { release = holdSettingWrite({ anchor }, !stored, () => ({ [key]: !stored })); });
    await act(async () => { await storage.getState().activateSettingsScope({ serverId: 'other-home', accountId: 'other-account' }); });
    expect(hook.getCurrent()).toBe(storage.getState().settings[key]);
    await act(async () => { release(); });
    await hook.unmount();
    await gated.unmount();
});

it('shares status words with work columns without rerendering them for unrelated publications', async () => {
    let commits = 0;
    const hook = await renderHook(() => {
        React.useLayoutEffect(() => { commits++; });
        return useSetting('sessionListStatusWords');
    });
    expect(hook.getCurrent()).toBe(false);
    const before = commits;
    await act(async () => {
        storage.setState({ machines: { ...storage.getState().machines } });
        storage.getState().applySettingsLocal({ showLineNumbers: !storage.getState().settings.showLineNumbers });
    });
    expect(commits - before).toBe(0);
    await act(async () => {
        storage.getState().applySettingsLocal({ sessionListStatusWords: true });
    });
    expect(hook.getCurrent()).toBe(true);
    expect(commits - before).toBe(1);
    await act(async () => {
        storage.getState().applySettingsLocal({ sessionListStatusWords: false });
    });
    expect(hook.getCurrent()).toBe(false);
    expect(commits - before).toBe(2);
    await hook.unmount();
});

it('reads no stored Settings value when a useSetting consumer rerenders over an unchanged store', async () => {
    let reads = 0;
    const settings = storage.getState().settings;
    const stored = settings.sessionListStatusWords;
    // Count reads of the setting itself on the store's data, not inside the hook.
    storage.setState({ settings: Object.defineProperty({ ...settings }, 'sessionListStatusWords', {
        enumerable: true,
        get: () => { reads++; return stored; },
    }) });
    const hook = await renderHook((tick: number) => {
        void tick;
        return useSetting('sessionListStatusWords');
    }, { initialProps: 0 });
    expect(hook.getCurrent()).toBe(stored);
    const afterMount = reads;
    for (let tick = 1; tick <= 5; tick++) await hook.rerender(tick);
    expect(hook.getCurrent()).toBe(stored);
    expect(reads - afterMount).toBe(0);
    await act(async () => { storage.getState().applySettingsLocal({ sessionListStatusWords: !stored }); });
    expect(hook.getCurrent()).toBe(!stored);
    await hook.unmount();
});

it('reads no stored device-local value when a useLocalSetting consumer rerenders over an unchanged store', async () => {
    let reads = 0;
    const localSettings = storage.getState().localSettings;
    const stored = localSettings.desktopOverlayEnabled;
    storage.setState({ localSettings: Object.defineProperty({ ...localSettings }, 'desktopOverlayEnabled', {
        enumerable: true,
        get: () => { reads++; return stored; },
    }) });
    const hook = await renderHook((tick: number) => {
        void tick;
        return useLocalSetting('desktopOverlayEnabled');
    }, { initialProps: 0 });
    expect(hook.getCurrent()).toBe(stored);
    const afterMount = reads;
    for (let tick = 1; tick <= 5; tick++) await hook.rerender(tick);
    expect(hook.getCurrent()).toBe(stored);
    expect(reads - afterMount).toBe(0);
    await act(async () => { storage.getState().applyLocalSettings({ desktopOverlayEnabled: !stored }); });
    expect(hook.getCurrent()).toBe(!stored);
    await hook.unmount();
});

it('withdraws inactive local-setting and preview demand and resumes the current key-scoped value', async () => {
    storage.getState().applyLocalSettings({ themePreference: 'light' });
    const counter = createRenderCommitCounter();
    let computations = 0;
    const select = (value: 'light' | 'dark' | 'adaptive') => { computations++; return value; };
    const deliveries = observeStorageSubscriptionDeliveries(paths => paths.some(path =>
        path[0] === 'state' && path[1] === 'localSettings' && path[2] === 'themePreference'));
    const previewSubscribe = vi.spyOn(useSettingsPreviewStore, 'subscribe');
    const hook = await renderHook((enabled: boolean) => {
        useRenderCommitCounter(counter);
        return useLocalSetting('themePreference', select, enabled);
    }, { initialProps: false });
    try {
        expect(previewSubscribe).not.toHaveBeenCalled();
        computations = 0;
        counter.reset();
        for (let index = 0; index < 10; index++) await act(async () => {
            storage.getState().applyLocalSettings({ themePreference: index % 2 ? 'light' : 'dark' });
            useSettingsPreviewStore.setState({ local: { themePreference: { owner: Symbol('preview'), value: index % 2 ? 'dark' : 'light' } } });
        });
        expect(deliveries.count).toBe(0);
        expect(computations).toBe(0);
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        await hook.rerender(true);
        expect(previewSubscribe).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent()).toBe('dark');
        await act(async () => { useSettingsPreviewStore.setState({ local: {} }); });
        expect(hook.getCurrent()).toBe('light');
        deliveries.reset(); counter.reset(); computations = 0;
        await act(async () => {
            storage.getState().applyLocalSettings({ uiFontScale: 1.15 });
            useSettingsPreviewStore.setState({ local: { uiFontScale: { owner: Symbol('other'), value: 1.2 } } });
        });
        expect(deliveries.count).toBe(0);
        expect(computations).toBe(0);
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        await act(async () => { storage.getState().applyLocalSettings({ themePreference: 'dark' }); });
        expect(deliveries.count).toBe(1);
        expect(hook.getCurrent()).toBe('dark');
        expect(counter.read()).toEqual({ renders: 1, commits: 1 });
        await act(async () => { useSettingsPreviewStore.setState({ local: { themePreference: { owner: Symbol('preview'), value: 'adaptive' } } }); });
        expect(hook.getCurrent()).toBe('adaptive');
        expect(storage.getState().localSettings.themePreference).toBe('dark');
        await hook.rerender(false);
        deliveries.reset(); counter.reset(); computations = 0;
        await act(async () => {
            storage.getState().applyLocalSettings({ themePreference: 'light' });
            useSettingsPreviewStore.setState({ local: {} });
        });
        expect(deliveries.count).toBe(0);
        expect(computations).toBe(0);
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
    } finally { await hook.unmount(); previewSubscribe.mockRestore(); deliveries.restore(); }
});

it('does not recompute settings projections for other store domains', async () => {
    let computations = 0;
    const selectDensity = (settings: Settings) => {
        computations++;
        return { density: settings.sessionListDensity };
    };
    const hook = await renderHook(() => useSettingsSelector(selectDensity, ['sessionListDensity']));
    const baseline = computations;
    await act(async () => {
        storage.setState({ machines: { ...storage.getState().machines } });
    });
    expect(computations).toBe(baseline);
    await act(async () => { storage.getState().applySettingsLocal({ showLineNumbers: !storage.getState().settings.showLineNumbers }); });
    expect(computations).toBe(baseline);
    const nextDensity = hook.getCurrent().density === 'narrow' ? 'cozy' : 'narrow';
    await act(async () => {
        storage.getState().applySettingsLocal({ sessionListDensity: nextDensity });
    });
    expect(hook.getCurrent().density).toBe(nextDensity);
    expect(computations).toBe(baseline + 1);
    await hook.unmount();
});

it('does no consumer projection or render work for unrelated accepted Settings keys', async () => {
    let computations = 0;
    const counter = createRenderCommitCounter();
    const selectDensity = (settings: Settings) => {
        computations++;
        return { density: settings.sessionListDensity };
    };
    const hook = await renderHook(() => {
        useRenderCommitCounter(counter);
        return useSettingsSelector(selectDensity, ['sessionListDensity']);
    });
    const baseline = computations;
    counter.reset();
    for (let revision = 2; revision <= 4; revision++) {
        await act(async () => {
            const current = storage.getState();
            current.applySettings({ ...current.settings, showLineNumbers: !current.settings.showLineNumbers }, revision);
        });
    }
    expect(computations - baseline).toBe(0);
    expect(counter.read()).toEqual({ renders: 0, commits: 0 });
    const nextDensity = hook.getCurrent().density === 'narrow' ? 'cozy' : 'narrow';
    await act(async () => { storage.getState().applySettingsLocal({ sessionListDensity: nextDensity }); });
    expect(hook.getCurrent().density).toBe(nextDensity);
    expect(computations - baseline).toBe(1);
    expect(counter.read()).toEqual({ renders: 1, commits: 1 });
    await hook.unmount();
});

it('routes feature-policy settings demand by key before evaluating the consumer', async () => {
    const telemetryEnabled = syncPerformanceTelemetry.isEnabled();
    syncPerformanceTelemetry.configure({ enabled: true });
    const counter = createRenderCommitCounter();
    const hook = await renderHook(() => {
        useRenderCommitCounter(counter);
        return useFeatureLocalPolicySettings();
    });
    try {
        const selected = hook.getCurrent();
        counter.reset();
        syncPerformanceTelemetry.reset();
        for (let revision = 2; revision <= 4; revision++) {
            await act(async () => {
                const current = storage.getState();
                current.applySettings({ ...current.settings, showLineNumbers: !current.settings.showLineNumbers }, revision);
            });
        }
        const evaluations = syncPerformanceTelemetry.snapshot().events
            .filter(event => event.name.startsWith('sync.store.storage.selector.'))
            .reduce((count, event) => count + event.count, 0);
        expect(evaluations).toBe(0);
        expect(counter.read()).toEqual({ renders: 0, commits: 0 });
        expect(hook.getCurrent()).toBe(selected);
        await act(async () => {
            storage.getState().applySettingsLocal({ experiments: !selected.experiments });
        });
        expect(hook.getCurrent().experiments).toBe(!selected.experiments);
        expect(counter.read()).toEqual({ renders: 1, commits: 1 });
        counter.reset();
        await act(async () => {
            storage.getState().applySettingsLocal({ featureToggles: { ...selected.featureToggles, 'execution.runs': true } });
        });
        expect(hook.getCurrent().featureToggles['execution.runs']).toBe(true);
        expect(counter.read()).toEqual({ renders: 1, commits: 1 });
    } finally {
        await hook.unmount();
        syncPerformanceTelemetry.configure({ enabled: telemetryEnabled });
        syncPerformanceTelemetry.reset();
    }
});

it('keeps catalog-declared Agent Account settings live without unrelated work', async () => {
    const counter = createRenderCommitCounter();
    const input = { agentIds: ['codex'], domain: 'runtime' } as const;
    const hook = await renderHook(() => {
        useRenderCommitCounter(counter);
        return useAgentUiSettings(input);
    });
    const selected = hook.getCurrent();
    expect(getAgentUiSettingsKeys(input)).toEqual(['codexBackendMode']);
    counter.reset();
    await act(async () => {
        const current = storage.getState();
        current.applySettings({ ...current.settings, showLineNumbers: !current.settings.showLineNumbers }, 2);
    });
    expect(counter.read()).toEqual({ renders: 0, commits: 0 });
    expect(hook.getCurrent()).toBe(selected);
    await act(async () => {
        storage.getState().applySettings(settingsParse({ ...storage.getState().settings, codexBackendMode: 'acp' }), 3);
    });
    expect(hook.getCurrent()).toEqual({ codexBackendMode: 'acp' });
    expect(counter.read()).toEqual({ renders: 1, commits: 1 });
    await hook.unmount();
});

it('takes dependency keys from the effective Machine behavior and honors setting scopes', () => {
    const descriptor = (scope: 'host' | 'account' | 'daemon') => ({
        kind: 'plugin.ui.v1', version: 1, pluginId: 'fixture.agent', agentId: 'codex',
        behavior: { payload: { sessionExtras: {
            providerId: 'codex', outputKey: 'mode', values: ['narrow', 'cozy'],
            settingKey: { scope, localId: 'sessionListDensity' },
        } } },
    });
    try {
        for (const scope of ['host', 'account', 'daemon'] as const) {
            publishProjectedAgentUiBehaviorDescriptors({
                machineId: 'settings-machine', accountScope: collectionScope,
                accountLifetime: { isCurrent: () => true },
                descriptorsByAgentId: { codex: descriptor(scope) },
            });
            expect(getAgentUiSettingsKeys({ agentIds: ['codex'], machineId: 'settings-machine',
                accountScope: collectionScope, domain: 'runtime' })).toEqual(scope === 'host' ? ['sessionListDensity'] : []);
        }
    } finally {
        clearProjectedAgentUiBehaviorDescriptors();
    }
});

it('keeps the authoring engine picker quiet for unrelated Account settings', async () => {
    const counter = createRenderCommitCounter();
    const input = { values: {} };
    const hook = await renderHook(() => {
        useRenderCommitCounter(counter);
        return useSessionAuthoringEnginePicker(input);
    });
    const result = hook.getCurrent();
    counter.reset();
    await act(async () => {
        const current = storage.getState();
        current.applySettings({ ...current.settings, showLineNumbers: !current.settings.showLineNumbers }, 2);
    });
    expect(counter.read()).toEqual({ renders: 0, commits: 0 });
    expect(hook.getCurrent().options).toBe(result.options);
    await hook.unmount();
});

it('keeps the mounted Session list source stable for unrelated Account settings', async () => {
    let commits = 0;
    const input = { enabled: false, homes: [] } as const;
    const hook = await renderHook(() => {
        React.useLayoutEffect(() => { commits++; });
        return useSessionListQuerySourceState(input);
    });
    const before = commits;
    const source = hook.getCurrent();
    await act(async () => {
        storage.getState().applySettingsLocal({ showLineNumbers: !storage.getState().settings.showLineNumbers });
    });
    expect(commits - before).toBe(0);
    expect(hook.getCurrent()).toBe(source);
    await act(async () => {
        storage.getState().applySettingsLocal({ sessionListLayoutV1: 'recent_activity' });
    });
    expect(commits - before).toBe(1);
    await hook.unmount();
});

it('does not render a bound Collection for unrelated accepted settings revisions', async () => {
    storage.setState({ profileScope: collectionScope });
    const counter = createRenderCommitCounter();
    const hook = await renderHook(() => {
        useRenderCommitCounter(counter);
        return useCollectionSpaceBinding('sessionWork', collectionInput);
    });
    expect(hook.getCurrent().spacesReady).toBe(true);
    const binding = hook.getCurrent();
    counter.reset();
    for (let revision = 2; revision <= 4; revision++) {
        await act(async () => {
            const current = storage.getState();
            current.applySettings({ ...current.settings, showLineNumbers: !current.settings.showLineNumbers }, revision);
        });
    }
    expect(storage.getState().settingsVersion).toBe(4);
    expect(counter.read()).toEqual({ renders: 0, commits: 0 });
    expect(hook.getCurrent()).toBe(binding);
    await hook.unmount();
});

it('keeps bound Collection readiness, catalog, selection and Account changes live', async () => {
    storage.setState({ profileScope: collectionScope, settingsVersion: null });
    const hook = await renderHook(() => useCollectionSpaceBinding('sessionWork', collectionInput));
    expect(hook.getCurrent().spacesReady).toBe(false);
    await act(async () => { storage.getState().applySettings(settingsDefaults, 2); });
    expect(hook.getCurrent().spacesReady).toBe(true);

    const customSpace = { ...defaultSpace, id: 'review', name: 'Review' } as Omit<typeof defaultSpace, 'membership'>; // The default factory omits membership; no readonly tags enter this fixture.
    await act(async () => {
        const current = storage.getState();
        current.applySettings({ ...current.settings, collectionSpacesV1: { v: 1, spaces: [customSpace] } }, 3);
    });
    expect(hook.getCurrent().spaces.map(space => space.id)).toEqual(['my-work', 'review']);
    await act(async () => {
        expect(await selectCollectionSpace(collectionScope, 'sessionWork', customSpace.id)).toBeUndefined();
    });
    expect(hook.getCurrent().selectedSpace).toEqual(customSpace);

    const nextScope = { ...collectionScope, accountId: 'next-account' };
    await act(async () => { await storage.getState().activateSettingsScope(nextScope); });
    expect(hook.getCurrent().spacesReady).toBe(false);
    expect(hook.getCurrent().admittedSpaces.spaces).toEqual([]);
    await act(async () => {
        storage.setState({ profileScope: nextScope });
        storage.getState().applySettings(settingsDefaults, 1);
    });
    expect(hook.getCurrent().spacesReady).toBe(true);
    expect(hook.getCurrent().spaceSettingsScope).toEqual(nextScope);
    expect(hook.getCurrent().selectedSpaceId).toBe('my-work');
    await act(async () => { storage.getState().clearSettingsScope(); });
    expect(hook.getCurrent().spacesReady).toBe(false);
    await hook.unmount();
});
