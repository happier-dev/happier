import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { selectActiveTestHomeForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { removeServerProfile, setActiveServerId, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { useMachineField } from './hooks';

describe('useMachineField exact demand', () => {
    let previousState: ReturnType<typeof storage.getState>;
    beforeEach(async () => { await selectActiveTestHomeForTests(); previousState = storage.getState(); });
    afterEach(() => { standardCleanup(); vi.restoreAllMocks(); storage.setState(previousState, true); });

    it('does zero snapshot work for unrelated Machine arrivals and reads the selected field when it changes', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        const rows = Array.from({ length: 120 }, (_, index) => createMachineFixture({ id: `field-${index}`,
            metadata: { ...createMachineFixture().metadata!, agentInventory: { checkedAt: 1, installedAgentIds: ['codex'] } },
        }));
        storage.getState().applyMachines(rows, true, { sourceServerId: serverId });
        storage.getState().markMachineListSettled(serverId);
        let snapshots = 0;
        let renders = 0;
        // Observe React's actual snapshot boundary while preserving its real subscription logic.
        const useSyncExternalStore = React.useSyncExternalStore;
        vi.spyOn(React, 'useSyncExternalStore').mockImplementation((subscribe, getSnapshot, getServerSnapshot) =>
            useSyncExternalStore(subscribe, () => { snapshots += 1; return getSnapshot(); }, getServerSnapshot));
        const hook = await renderHook(() => {
            renders += 1;
            return useMachineField(` ${rows[0]!.id} `, 'metadata', 'agentInventory', { serverId });
        });
        expect(hook.getCurrent()?.installedAgentIds).toEqual(['codex']);
        const initial = hook.getCurrent();
        snapshots = 0;
        renders = 0;
        for (const row of rows.slice(1)) {
            await act(async () => storage.getState().applyMachines([{ ...row, metadataVersion: 2,
                metadata: { ...row.metadata!, host: 'changed-other-machine' },
            }], false, { sourceServerId: serverId }));
        }
        // Same-Machine unrelated content also retains the admitted field identity.
        await act(async () => storage.getState().applyMachines([{ ...rows[0]!, metadataVersion: 2,
            metadata: { ...rows[0]!.metadata!, host: 'changed-other-field' },
        }], false, { sourceServerId: serverId }));
        expect(snapshots).toBe(0);
        expect(renders).toBe(0);
        expect(hook.getCurrent()).toBe(initial);
        const selected = storage.getState().machines[rows[0]!.id]!;
        await act(async () => storage.getState().applyMachines([{ ...selected, metadataVersion: 3,
            metadata: { ...selected.metadata!, agentInventory: { checkedAt: 2, installedAgentIds: ['codex', 'claude'] } },
        }], false, { sourceServerId: serverId }));
        expect(hook.getCurrent()?.installedAgentIds).toEqual(['codex', 'claude']);
        expect(renders).toBe(1);
        expect(snapshots).toBeGreaterThan(0);
        await act(async () => storage.getState().applyMachines([{ ...storage.getState().machines[selected.id]!, revokedAt: 1 }], false, { sourceServerId: serverId }));
        expect(hook.getCurrent()).toBeNull();
    });

    it('rebinds a demanded Home identity and switches the exact Machine without a Machine publication', async () => {
        const previousHome = getActiveServerSnapshot().serverId;
        const first = await upsertServerProfile({ serverUrl: 'https://machine-field-first.example.test' });
        const second = await upsertServerProfile({ serverUrl: 'https://machine-field-second.example.test' });
        const row = createMachineFixture({ id: 'same-field-machine', metadata: { ...createMachineFixture().metadata!,
            agentInventory: { checkedAt: 1, installedAgentIds: ['codex'] },
        } });
        const other = { ...row, metadata: { ...row.metadata!, agentInventory: { checkedAt: 2, installedAgentIds: ['claude'] } } };
        try {
            await setActiveServerId(first.id);
            storage.getState().applyMachines([row], true, { sourceServerId: first.id });
            storage.getState().markMachineListSettled(first.id);
            storage.getState().applyMachines([other], true, { sourceServerId: second.id });
            storage.getState().markMachineListSettled(second.id);
            const hook = await renderHook((serverId: string) => useMachineField(row.id, 'metadata', 'agentInventory', { serverId }),
                { initialProps: 'srv_machine_field_second' });
            expect(hook.getCurrent()).toBeNull();
            const inventory = storage.getState().machineRecordsByServerId;
            await act(async () => { await setServerProfileIdentityForUrl(second.serverUrl, 'srv_machine_field_second'); });
            expect(storage.getState().machineRecordsByServerId).toBe(inventory);
            expect(hook.getCurrent()?.installedAgentIds).toEqual(['claude']);
            await hook.rerender(first.id);
            expect(hook.getCurrent()?.installedAgentIds).toEqual(['codex']);
            await hook.rerender(second.id);
            expect(hook.getCurrent()?.installedAgentIds).toEqual(['claude']);
            await act(async () => { await setActiveServerId(second.id); });
            expect(hook.getCurrent()?.installedAgentIds).toEqual(['claude']);
            await act(async () => storage.getState().applyMachines([], true, { sourceServerId: second.id }));
            expect(hook.getCurrent()).toBeNull();
            await act(async () => storage.getState().applyMachines([{ ...other, metadataVersion: 3 }], false, { sourceServerId: second.id }));
            expect(hook.getCurrent()?.installedAgentIds).toEqual(['claude']);
            await hook.unmount();
        } finally {
            await setActiveServerId(previousHome);
            await removeServerProfile(first.id);
            await removeServerProfile(second.id);
        }
    });
});
