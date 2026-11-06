import { act } from 'react-test-renderer';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineAgentInventoryItem } from '@happier-dev/protocol';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import type { Machine } from '@/sync/domains/state/storageTypes';

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { machineAgentInventoryStore } = await import('@/agents/machineAgents/machineAgentInventoryStore');
const { writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { readNewSessionDraftProjectionFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
const { clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
const { HOME_COMPOSER_DRAFT_ID, useFirstAgentSetupItem } = await import('./useFirstAgentSetupItem');
const before = storage.getState();
const uninstalled: MachineAgentInventoryItem = {
    agentId: 'review', title: 'Review', installed: false, version: null, latestVersion: null,
    update: { supported: false, command: null }, signIn: { status: 'unknown', loginSupport: 'unsupported' },
    platform: { supported: true }, install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [],
};

afterEach(() => {
    standardCleanup();
    storage.setState(before, true);
    clearMachineRequestReachabilityForTest();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    network.resetRequests();
});
afterAll(() => network.dispose());

async function setup(machines: Machine[], draftMachineId?: string, onRender?: () => void) {
    const home = await network.addHome(`https://first-agent-${machines[0]!.id}.test`, 'account-setup');
    setActiveServerId(home.id);
    const scope = { serverId: home.id, accountId: 'account-setup' };
    storage.setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])), machineListByServerId: { [home.id]: machines } });
    if (draftMachineId) {
        writeNewSessionDraft({ scope, draftId: HOME_COMPOSER_DRAFT_ID,
            patch: { text: 'Review this change', authoring: { executionTarget: { kind: 'machine', target: { serverId: home.id, machineId: draftMachineId } } } }, materializationIntent: 'userEdit' });
        expect(readNewSessionDraftProjectionFromRepository({ scope, draftId: HOME_COMPOSER_DRAFT_ID })?.draft.selectedMachineId).toBe(draftMachineId);
    }
    const hook = await renderHook(() => {
        onRender?.();
        return { binding: useServerCredentialAccountScopeBinding(home.id).binding, item: useFirstAgentSetupItem({ phone: false }) };
    });
    await vi.waitFor(() => expect(hook.getCurrent().binding).toBeTruthy());
    const publishInventory = async () => {
        // Real retained inventory publication, as hydration and daemon observation use it.
        await act(async () => {
            for (const machine of machines) machineAgentInventoryStore.publish(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id),
                { status: 'offline', items: [uninstalled], lastCheckedAt: 12 });
        });
    };
    await publishInventory();
    return { home, hook, publishInventory };
}

describe('Home first-agent setup target', () => {
    it('renders only for the selected name or eligibility, not another Machine fact', async () => {
        let renders = 0;
        const rows = Array.from({ length: 196 }, (_, index) => createMachineFixture({ id: `setup-local-${index}`, activeAt: Date.now() }));
        const { home, hook } = await setup(rows, rows[0]!.id, () => { renders++; });
        const options = { sourceServerId: home.id };
        renders = 0;
        await act(async () => storage.getState().applyMachines([{ ...rows[195]!, metadataVersion: 2,
            metadata: { ...rows[195]!.metadata!, displayName: 'Other machine' } }], false, options));
        expect(renders).toBe(0);
        await act(async () => storage.getState().applyMachines([{ ...rows[0]!, metadataVersion: 2,
            metadata: { ...rows[0]!.metadata!, displayName: 'Chosen machine' } }], false, options));
        expect(hook.getCurrent().item?.renderTile({ open: () => {} })).toMatchObject({ props: { machineName: 'Chosen machine' } });
        expect(renders).toBeGreaterThan(0);
        await act(async () => storage.getState().applyMachines([{ ...storage.getState().machines[rows[0]!.id]!,
            availability: { kind: 'locked', reason: 'decryption_failed' } }], false, options));
        expect(hook.getCurrent().item).toBeNull();
        expect(network.requests).toEqual([]);
        await hook.unmount();
    });

    it('offers setup on the selectable fallback rather than retained locked or replaced machines', async () => {
        const now = Date.now();
        const { hook } = await setup([
            createMachineFixture({ id: 'locked', activeAt: now, metadata: { ...createMachineFixture().metadata!, displayName: 'Locked' }, availability: { kind: 'locked', reason: 'decryption_failed' } }),
            createMachineFixture({ id: 'replaced', activeAt: now, metadata: { ...createMachineFixture().metadata!, displayName: 'Replaced' }, replacedByMachineId: 'current' }),
            createMachineFixture({ id: 'current', activeAt: now, metadata: { ...createMachineFixture().metadata!, displayName: 'Current' } }),
        ]);
        expect(hook.getCurrent().item?.renderTile({ open: () => {} })).toMatchObject({ props: { machineName: 'Current' } });
        expect(network.requests).toEqual([]);
        await hook.unmount();
    });

    it.each(['locked', 'replaced'] as const)('does not offer setup on an explicitly selected %s machine', async kind => {
        const { hook } = await setup([
            createMachineFixture({ id: `selected-${kind}`, activeAt: Date.now(),
                ...(kind === 'locked' ? { availability: { kind: 'locked', reason: 'decryption_failed' } as const } : { replacedByMachineId: 'current' }) }),
            createMachineFixture({ id: 'current', activeAt: Date.now() }),
        ], `selected-${kind}`);
        expect(hook.getCurrent().item).toBeNull();
        await hook.unmount();
    });

    it('preserves an explicit offline draft rather than offering setup on another machine', async () => {
        const chosen = createMachineFixture({ id: 'chosen', active: false, activeAt: 1, metadata: { ...createMachineFixture().metadata!, displayName: 'Chosen' } });
        const { hook } = await setup([chosen,
            createMachineFixture({ id: 'alternative', activeAt: Date.now(), metadata: { ...createMachineFixture().metadata!, displayName: 'Alternative' } })], chosen.id);
        expect(hook.getCurrent().item).toBeNull();
        expect(network.requests).toEqual([]);
        await hook.unmount();
    });
});
