import { act } from 'react-test-renderer';
import * as React from 'react';
import { beforeEach, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { useSettingsSelector } from './hooks';
import { useSetting } from './settingsReadHooks';
import { useSessionListQuerySourceState } from '@/sync/domains/session/listing/useSessionListQuerySourceState';

beforeEach(async () => {
    getPersistenceStorage().clearAll();
    await storage.getState().activateSettingsScope({ serverId: 'selector-home', accountId: 'selector-account' });
    storage.getState().applySettings(settingsDefaults, 1);
});

it('does not recompute settings projections for other store domains', async () => {
    let computations = 0;
    const selectDensity = (settings: Settings) => {
        computations++;
        return { density: settings.sessionListDensity };
    };
    const hook = await renderHook(() => useSettingsSelector(selectDensity));
    const baseline = computations;
    await act(async () => {
        storage.setState({ machines: { ...storage.getState().machines } });
    });
    expect(computations).toBe(baseline);
    const nextDensity = hook.getCurrent().density === 'narrow' ? 'cozy' : 'narrow';
    await act(async () => {
        storage.getState().applySettingsLocal({ sessionListDensity: nextDensity });
    });
    expect(hook.getCurrent().density).toBe(nextDensity);
    expect(computations).toBe(baseline + 1);
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
