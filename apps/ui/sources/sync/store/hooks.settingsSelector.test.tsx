import { act } from 'react-test-renderer';
import { beforeEach, expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { useSettingsSelector } from './hooks';
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
    let renders = 0;
    const input = { enabled: false, homes: [] } as const;
    const hook = await renderHook(() => {
        renders++;
        return useSessionListQuerySourceState(input);
    });
    const before = renders;
    const source = hook.getCurrent();
    await act(async () => {
        storage.getState().applySettingsLocal({ showLineNumbers: !storage.getState().settings.showLineNumbers });
    });
    console.info(`Session list unrelated-setting render delta: ${renders - before}`);
    expect(renders - before).toBe(0);
    expect(hook.getCurrent()).toBe(source);
    await act(async () => {
        storage.getState().applySettingsLocal({ sessionListActiveGroupingV1: 'date' });
    });
    expect(renders - before).toBe(1);
    await hook.unmount();
});
