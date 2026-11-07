import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { selectActiveTestHomeForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { removeServerProfile, setActiveServerId, setServerProfileIdentityForUrl, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { useMachineField, useMachineListForServerSelection } from './hooks';

describe('useMachineField exact demand', () => {
    let previousState: ReturnType<typeof storage.getState>;
    beforeEach(async () => { await selectActiveTestHomeForTests(); previousState = storage.getState(); });
    afterEach(() => { standardCleanup(); vi.restoreAllMocks(); storage.setState(previousState, true); });

    it('does no Software fleet traversal for resource arrivals while setup, availability and membership remain current', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        const rows = Array.from({ length: 120 }, (_, index) => createMachineFixture({ id: `software-${index}` }));
        storage.getState().applyMachines(rows, true, { sourceServerId: serverId });
        storage.getState().markMachineListSettled(serverId);
        let visits = 0;
        const select = (machines: readonly typeof rows[number][]) => machines.map(machine => {
            visits += 1;
            return { id: machine.id, desired: machine.metadata?.setup?.revision,
                observed: machine.daemonState?.setup?.desiredRevision, available: machine.availability?.kind,
                access: machine.access?.accessState };
        });
        const hook = await renderHook((machineIds: readonly string[]) => {
            const demand = React.useMemo(() => ({ machineIds,
                fields: [{ section: 'metadata', field: 'setup' }, { section: 'daemonState', field: 'setup' }] as const,
            }), [machineIds]);
            return useMachineListForServerSelection(serverId, select, demand);
        }, { initialProps: rows.map(row => row.id) });
        expect(hook.getCurrent()).toHaveLength(120);
        visits = 0;
        for (const row of rows) {
            await act(async () => storage.getState().applyMachines([{ ...row, daemonStateVersion: 2,
                daemonState: { ...row.daemonState, resources: { v: 1, attention: { level: 'calm', reasons: [] },
                    vitals: { state: 'unavailable', since: 1, reason: 'reader_failed' } } },
            }], false, { sourceServerId: serverId }));
        }
        expect(visits).toBe(0);
        await hook.rerender();
        expect(visits).toBe(0);
        const current = storage.getState().machines[rows[0]!.id]!;
        await act(async () => storage.getState().applyMachines([{ ...current, metadataVersion: 2,
            metadata: { ...current.metadata!, setup: { version: 1, revision: 2, exclusions: [], sources: [] } },
        }], false, { sourceServerId: serverId }));
        expect(hook.getCurrent()[0]?.desired).toBe(2);
        expect(visits).toBe(120);
        visits = 0;
        const desired = storage.getState().machines[current.id]!;
        await act(async () => storage.getState().applyMachines([{ ...desired, daemonStateVersion: 3,
            daemonState: { ...desired.daemonState, setup: { version: 1, desiredRevision: 2, status: 'satisfied', recipes: [] } },
        }], false, { sourceServerId: serverId }));
        expect(hook.getCurrent()[0]?.observed).toBe(2);
        expect(visits).toBe(120);
        await act(async () => storage.getState().applyMachines([{ ...storage.getState().machines[current.id]!,
            availability: { kind: 'locked', reason: 'content_unreadable' },
        }], false, { sourceServerId: serverId }));
        expect(hook.getCurrent()[0]?.available).toBe('locked');
        await act(async () => storage.getState().applyMachines([{ ...storage.getState().machines[current.id]!,
            availability: { kind: 'available' }, access: { custodian: { accountId: 'alice', displayName: 'Alice' },
                role: 'manage', resourceMode: 'plain', accessState: 'refused', reason: 'access_denied' },
        }], false, { sourceServerId: serverId }));
        expect(hook.getCurrent()[0]?.access).toBe('refused');
        await act(async () => storage.getState().applyMachines([], true, { sourceServerId: serverId }));
        await hook.rerender([]);
        expect(hook.getCurrent()).toEqual([]);
    });

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
