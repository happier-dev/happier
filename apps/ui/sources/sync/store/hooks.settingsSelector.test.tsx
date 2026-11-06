import { act } from 'react-test-renderer';
import * as React from 'react';
import { beforeEach, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults, settingsParse, type Settings } from '@/sync/domains/settings/settings';
import { useSettingsSelector } from './hooks';
import { useSetting } from './settingsReadHooks';
import { holdSettingWrite, useSettingsPreviewStore } from './settingsPreview';
import { useSessionListQuerySourceState } from '@/sync/domains/session/listing/useSessionListQuerySourceState';

import { useAgentUiSettings, getAgentUiSettingsKeys } from '@/agents/catalog/useAgentUiSettings';
import { publishProjectedAgentUiBehaviorDescriptors, clearProjectedAgentUiBehaviorDescriptors } from '@/agents/registry/agentUiBehaviorProjection';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { useFeatureLocalPolicySettings } from '@/hooks/server/useFeatureLocalPolicySettings';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';

const collectionScope = { serverId: 'selector-home', accountId: 'selector-account' };

beforeEach(async () => {
    getPersistenceStorage().clearAll();
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
