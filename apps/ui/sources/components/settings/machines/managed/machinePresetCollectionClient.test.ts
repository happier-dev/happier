import { applyManagedMachinePresetUpdateFixture, createPlainManagedMachinePresetFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1, ManagedMachinePresetCreateInputV1Schema, ManagedMachinePresetUpdateInputV1Schema, ManagedMachinePresetRecipientCensusInputV1Schema, type PresetMutationResultV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { publishHomeAccountChange, publishHomeAccountChangeWake } from '@/sync/runtime/orchestration/homeAccountChange';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import type { MachinePresetEditDraft } from './machinePresetEditDraft';
import { ManagedMachinePublicFullV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { createDeferred, renderScreen } from '@/dev/testkit';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

async function addPresetHome(input: Parameters<typeof harness.addHome>[0]) {
    const serverId = await harness.addHome(input);
    if (input.accountEncryptionMode !== 'e2ee') harness.answer(serverId, '/v1/machines/presets/recipient-census', {
        body: { kind: 'ready', contentEncryptionMode: 'plain', recipients: [] },
    });
    return serverId;
}

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    renderCustomModals: true,
    settleTransientConfirmations: false,
}).module);
// Boundary mocks must be registered first; cold module transformation is not this contract.
const { useMachinePresets, useMachinePresetDetail } = await import('./useMachinePresets');
const { createMachinePresetCollectionClient } = await import('./machinePresetCollectionClient');
const { ModalProvider } = await import('@/modal');
beforeEach(async () => {
    await harness.reset();
    (await import('@/sync/ops/actions/scopedHomeActionExecutor')).resetScopedHomeActionExecutorsForTests();
});
afterEach(async () => {
    standardCleanup();
    // Withdraw fixture credentials through their owner before device isolation clears its listeners.
    await harness.reset();
});

const preset = { id: 'preset', homeId: 'srv_history', revision: 3, name: 'Current launch', archivedAt: 0,
    owner: { kind: 'account', accountId: 'owner' },
    launch: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Future name', choices: {} },
    controller: { machineId: 'controller', installationId: 'installation' } } as const;
const resource = ManagedMachinePublicFullV1Schema.parse({ id: 'resource', homeId: 'srv_history', custodianAccountId: 'owner', preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' },
    launch: { ...preset.launch, name: 'Original guest' }, controller: preset.controller,
    allocation: 'confirmed-absent', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, archivedAt: 0 });

describe('preset collection and history through Actions', () => {
    it('shares one preset list across concurrent and repeated Store, Software and Add-to-preset visits', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset)] } });
        const first = await renderHook(() => useMachinePresets([serverId]));
        const second = await renderHook(() => useMachinePresets(['srv_history']));
        await waitForHomeGovernance(() => expect(first.getCurrent().presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(preset).opened]));
        await waitForHomeGovernance(() => expect(second.getCurrent().presetsByServerId.srv_history).toEqual([createPlainManagedMachinePresetFixture(preset).opened]));
        const rows = first.getCurrent().presetsByServerId[serverId];
        const visitedRows: Array<readonly import('./machinePresetCollectionClient').ManagedMachinePresetListEntryV1[] | undefined> = [];
        const warmLoading: boolean[] = [];
        await first.unmount();
        await second.unmount();
        for (let visit = 0; visit < 3; visit += 1) {
            const hook = await renderHook(() => {
                const collection = useMachinePresets([serverId]);
                warmLoading.push(collection.statesByServerId[serverId]?.loading ?? true);
                return collection;
            });
            await waitForHomeGovernance(() => expect(hook.getCurrent().statesByServerId[serverId]?.loading).toBe(false));
            visitedRows.push(hook.getCurrent().presetsByServerId[serverId]);
            await hook.unmount();
        }
        expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(1);
        expect(warmLoading.every(loading => !loading)).toBe(true);
        for (const visited of visitedRows) expect(visited).toBe(rows);
    });

    it('invalidates the shared preset list only for real preset content changes, including remote creates while closed', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset)] } });
        const first = await renderHook(() => useMachinePresets([serverId]));
        const second = await renderHook(() => useMachinePresets([serverId]));
        await waitForHomeGovernance(() => expect(second.getCurrent().presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(preset).opened]));
        const before = harness.requestsFor('/v1/machines/presets/list').length;
        for (let index = 0; index < 5; index += 1) {
            await act(async () => {
                publishHomeAccountChange(serverId, [preset.controller.machineId], { changeKinds: ['machine'] });
                publishHomeAccountChange(serverId, [`unrelated-account-${index}`], { changeKinds: ['account'] });
            });
            await flushHookEffects({ cycles: 10 });
        }
        expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before);
        await first.unmount();
        await second.unmount();
        const created = { ...preset, id: 'remote-created', revision: 1 } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset), createPlainManagedMachinePresetFixture(created)] } });
        // A disconnected Home has delivered nothing yet. Reopening retains its last answer.
        const reopened = await renderHook(() => useMachinePresets([serverId]));
        expect(reopened.getCurrent().presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(preset).opened]);
        await act(async () => {
            publishHomeAccountChange(serverId, undefined, { source: 'connected', changesCatchUp: true });
            publishHomeAccountChangeWake(serverId, { t: 'account-change',
                entityIds: [MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1], changeKinds: ['account'] }, 'catch-up-pending');
        });
        await flushHookEffects();
        expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before);
        // The incumbent catch-up owner publishes the consumed feed page, including unseen row ids.
        await act(async () => publishHomeAccountChange(serverId, [MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1],
            { feedPageConsumed: true, changeKinds: ['account'] }));
        await waitForHomeGovernance(() => expect(reopened.getCurrent().presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(preset).opened, createPlainManagedMachinePresetFixture(created).opened]));
        expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before + 1);
        const archived = { ...created, revision: 2, archivedAt: 42 } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset), createPlainManagedMachinePresetFixture(archived)] } });
        // Secondary Homes publish their existing socket receipt directly.
        await act(async () => { publishHomeAccountChangeWake(serverId, { t: 'account-change',
            entityIds: [MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1], changeKinds: ['account'] }, 'socket'); });
        await waitForHomeGovernance(() => expect(reopened.getCurrent().presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(preset).opened, createPlainManagedMachinePresetFixture(archived).opened]));
        expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before + 2);
        await reopened.unmount();
        const restored = { ...created, revision: 3 } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset), createPlainManagedMachinePresetFixture(restored)] } });
        await act(async () => publishHomeAccountChange(serverId, [MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }));
        await flushHookEffects();
        expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before + 2);
        const restoredVisit = await renderHook(() => useMachinePresets([serverId]));
        await waitForHomeGovernance(() => expect(restoredVisit.getCurrent().presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(preset).opened, createPlainManagedMachinePresetFixture(restored).opened]));
        expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before + 3);
        await restoredVisit.unmount();
    });

    it('refreshes retained Team preset visibility after removal, addition and archive while ignoring connection wakes', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        const shared = { ...preset, id: 'team-preset', owner: { kind: 'team' as const, teamId: 'team' } } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset), createPlainManagedMachinePresetFixture(shared)] } });
        const initial = await renderHook(() => useMachinePresets([serverId]));
        await waitForHomeGovernance(() => expect(initial.getCurrent().presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(preset).opened, createPlainManagedMachinePresetFixture(shared).opened]));
        await initial.unmount();
        const before = harness.requestsFor('/v1/machines/presets/list').length;
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset)] } });
        await act(async () => publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }));
        await flushHookEffects();
        expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before);
        const reopened = await renderHook(() => useMachinePresets([serverId]));
        try {
            await waitForHomeGovernance(() => expect(reopened.getCurrent().presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(preset).opened]));
            expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before + 1);
            harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset), createPlainManagedMachinePresetFixture(shared)] } });
            await act(async () => publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }));
            await waitForHomeGovernance(() => expect(reopened.getCurrent().presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(preset).opened, createPlainManagedMachinePresetFixture(shared).opened]));
            // Archiving the Team removes its presets from the visible collection.
            harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset)] } });
            await act(async () => publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }));
            await waitForHomeGovernance(() => expect(reopened.getCurrent().presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(preset).opened]));
            expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before + 3);
            await act(async () => publishHomeAccountChange(serverId, undefined, { source: 'connected', changesCatchUp: true }));
            await flushHookEffects();
            expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before + 3);
        } finally { await reopened.unmount(); }
    });

    it('retries an unavailable shared preset read on reconnect while ready rows stay quiet', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        const unavailable = createDeferred<void>();
        harness.answer(serverId, '/v1/machines/presets/list', { status: 503, body: { error: 'unavailable' }, respondAfter: unavailable.promise });
        const hook = await renderHook(() => useMachinePresets([serverId]));
        try {
            await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(1));
            await act(async () => {
                publishHomeAccountChange(serverId, undefined, { source: 'connected', changesCatchUp: true });
                publishHomeAccountChange(serverId, undefined, { source: 'connected' });
            });
            await flushHookEffects();
            expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(1);
            unavailable.resolve();
            await waitForHomeGovernance(() => expect(hook.getCurrent().statesByServerId[serverId]).toMatchObject({ loading: false, error: expect.any(String) }));
            const before = harness.requestsFor('/v1/machines/presets/list').length;
            harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset)] } });
            await act(async () => publishHomeAccountChange(serverId, undefined, { source: 'connected', changesCatchUp: true }));
            await waitForHomeGovernance(() => expect(hook.getCurrent().presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(preset).opened]));
            expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before + 1);
            await act(async () => publishHomeAccountChange(serverId, undefined, { source: 'connected', changesCatchUp: true }));
            await flushHookEffects();
            expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before + 1);
        } finally { unavailable.resolve(); await hook.unmount(); }
    });

    it('recovers retained presets from the canonical snapshot boundary while ordinary reconnects stay quiet', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset)] } });
        const initial = await renderHook(() => useMachinePresets([serverId]));
        await waitForHomeGovernance(() => expect(initial.getCurrent().presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(preset).opened]));
        await initial.unmount();
        const before = harness.requestsFor('/v1/machines/presets/list').length;
        const created = { ...preset, id: 'created-before-snapshot-base' } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset), createPlainManagedMachinePresetFixture(created)] } });
        await act(async () => publishHomeAccountChange(serverId, undefined, { source: 'snapshot' }));
        expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before);
        const reopened = await renderHook(() => useMachinePresets([serverId]));
        try {
            await waitForHomeGovernance(() => expect(reopened.getCurrent().presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(preset).opened, createPlainManagedMachinePresetFixture(created).opened]));
            expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before + 1);
            await act(async () => {
                publishHomeAccountChange(serverId, undefined, { source: 'connected', changesCatchUp: true });
                publishHomeAccountChange(serverId, [preset.controller.machineId], { changeKinds: ['machine'] });
                publishHomeAccountChangeWake(serverId, { t: 'account-change', entityIds: undefined,
                    changeKinds: ['account'] }, 'catch-up-pending');
            });
            await flushHookEffects();
            expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before + 1);
        } finally { await reopened.unmount(); }
    });

    it('refreshes shared content from the authoritative push after local writes, without rereading its own writes', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset)] } });
        const hook = await renderHook(() => useMachinePresets([serverId]));
        await waitForHomeGovernance(() => expect(hook.getCurrent().presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(preset).opened]));
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, preset.homeId);
        const before = harness.requestsFor('/v1/machines/presets/list').length;
        const updated = { ...preset, name: 'Saved edit', revision: 4 } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(updated)] } });
        harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'saved', preset: createPlainManagedMachinePresetFixture(updated) } });
        await act(async () => { await client.execute('machines.presets.update', {
            homeId: preset.homeId, id: preset.id, expectedRevision: 3, patch: { privateContent: { v: 1, name: updated.name, launch: preset.launch } },
        }, { preset }); });
        expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before);
        // The HTTP fixture emits the same committed Account change as the real writer.
        await act(async () => publishHomeAccountChange(serverId, [MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(updated).opened]));
        expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before + 1);
        const rows = hook.getCurrent().presetsByServerId[serverId];
        await act(async () => { await client.execute('machines.presets.update', {
            homeId: preset.homeId, id: preset.id, expectedRevision: 4, patch: { privateContent: { v: 1, name: updated.name, launch: preset.launch } },
        }, { preset }); });
        harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'refused', code: 'permission_denied' } });
        await act(async () => { await client.execute('machines.presets.update', {
            homeId: preset.homeId, id: preset.id, expectedRevision: 4, patch: { privateContent: { v: 1, name: 'Refused edit', launch: preset.launch } },
        }, { preset }); });
        await flushHookEffects();
        expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before + 1);
        expect(hook.getCurrent().presetsByServerId[serverId]).toBe(rows);
        await hook.unmount();
    });

    it('parks retained Machine settings facts and catches up without retaining withdrawn Account data', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [] } });
        const { storage } = await import('@/sync/domains/state/storage');
        const { useMachinesSettingsViewModel } = await import('../machinesSettingsViewModel');
        const { recordMachineRequestSucceeded, recordMachineRequestFailed, readMachineRequestReachabilityRevision } =
            await import('@/sync/domains/machines/reachability/machineReachability');
        let machine = createMachineFixture({ id: 'controller', activeAt: Date.now() });
        storage.setState({ profileScope: { serverId: 'srv_history', accountId: 'owner' }, machines: { [machine.id]: machine },
            machineListByServerId: { srv_history: [machine] }, machineListStatusByServerId: { srv_history: 'idle' } });
        let presented = true;
        let renders = 0;
        const wrapper = ({ children }: React.PropsWithChildren) => React.createElement(
            PluginSurfaceFocusEligibilityProvider, { active: presented, children });
        const hook = await renderHook(() => { renders += 1; return useMachinesSettingsViewModel(); }, { wrapper });
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().managedInventory.loading).toBe(false));
            expect(hook.getCurrent().machineRows).toHaveLength(1);
            presented = false;
            await hook.rerender();
            const hidden = hook.getCurrent();
            const before = renders;
            const beforeReachability = readMachineRequestReachabilityRevision();
            const observedAtMs = Date.now();
            for (let index = 1; index <= 5; index += 1) {
                machine = { ...machine, metadataVersion: machine.metadataVersion + 1,
                    metadata: { ...machine.metadata!, displayName: `Current machine ${index}` } };
                await act(async () => {
                    storage.getState().applyMachines([machine], false, { sourceServerId: 'srv_history' });
                    storage.setState({ machineListStatusByServerId: { srv_history: index % 2 ? 'error' : 'idle' } });
                    const input = { serverId: 'srv_history', accountId: 'owner', machineId: machine.id, observedAtMs: observedAtMs + index };
                    if (index % 2) recordMachineRequestFailed(input); else recordMachineRequestSucceeded(input);
                });
            }
            expect(renders - before).toBe(0);
            expect(hook.getCurrent()).toBe(hidden);
            expect(storage.getState().machines[machine.id]?.metadata?.displayName).toBe('Current machine 5');
            expect(readMachineRequestReachabilityRevision()).toBeGreaterThan(beforeReachability);
            presented = true;
            await hook.rerender();
            expect(hook.getCurrent().machineRows[0]?.title).toBe('Current machine 5');
            expect(hook.getCurrent().reachabilityRevision).toBe(readMachineRequestReachabilityRevision());
            presented = false;
            await hook.rerender();
            await act(async () => storage.setState({ profileScope: null, machines: {}, machineListByServerId: {} }));
            expect(hook.getCurrent().allMachines).toEqual([]);
            expect(hook.getCurrent().machineRows).toEqual([]);
        } finally { await hook.unmount(); }
    });

    it('parks retained Machine settings inventory reads and refreshes current resources on presentation', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [] } });
        harness.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [resource] } });
        const { useMachinesSettingsViewModel } = await import('../machinesSettingsViewModel');
        let presented = true;
        let renders = 0;
        const wrapper = ({ children }: React.PropsWithChildren) => React.createElement(
            PluginSurfaceFocusEligibilityProvider, { active: presented, children });
        const hook = await renderHook(() => { renders += 1; return useMachinesSettingsViewModel(); }, { wrapper });
        try {
            await waitForHomeGovernance(() => expect(Object.values(hook.getCurrent().managedByServerId).flat()).toHaveLength(1));
            await waitForHomeGovernance(() => expect(hook.getCurrent().managedInventory.loading).toBe(false));
            presented = false;
            await hook.rerender();
            const hidden = hook.getCurrent();
            const before = renders;
            const requests = harness.requestsFor('/v1/machines/managed/actions/list').length;
            const changed = { ...resource, intentRevision: 2, desired: 'stop' };
            harness.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [changed] } });
            for (let index = 0; index < 5; index += 1) {
                await act(async () => publishHomeAccountChange(serverId));
                await flushHookEffects({ cycles: 10 });
            }
            expect(harness.requestsFor('/v1/machines/managed/actions/list')).toHaveLength(requests);
            expect(renders - before).toBe(0);
            expect(hook.getCurrent()).toBe(hidden);
            presented = true;
            await hook.rerender();
            await waitForHomeGovernance(() => expect(Object.values(hook.getCurrent().managedByServerId).flat())
                .toEqual([expect.objectContaining({ intentRevision: 2, desired: 'stop' })]));
        } finally { await hook.unmount(); }
    });

    it.each(['collection', 'detail'] as const)('suspends retained %s reads while hidden and resumes with current data', async kind => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset)] } });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(preset) } });
        harness.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [resource] } });
        let presented = false;
        const wrapper = ({ children }: React.PropsWithChildren) => React.createElement(
            PluginSurfaceFocusEligibilityProvider, { active: presented, children });
        const hook = await renderHook(() => {
            const collection = useMachinePresets(kind === 'collection' ? [serverId] : []);
            const detail = useMachinePresetDetail(serverId, kind === 'detail' ? preset.id : '');
            return kind === 'collection' ? collection.statesByServerId[serverId] : detail.state;
        }, { wrapper });
        const path = kind === 'collection' ? '/v1/machines/presets/list' : '/v1/machines/presets/get';
        try {
            expect(harness.requestsFor(path)).toHaveLength(0);
            presented = true;
            await hook.rerender();
            await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({ value: expect.anything() }));
            const ready = hook.getCurrent();
            const before = harness.requestsFor(path).length;
            presented = false;
            await hook.rerender();
            const updated = { ...preset, revision: preset.revision + 1, name: 'Updated while hidden' } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
            harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(updated)] } });
            harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(updated) } });
            for (let index = 0; index < 20; index += 1) {
                await act(async () => publishHomeAccountChange(serverId, kind === 'collection' ? [MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1] : undefined));
            }
            await flushHookEffects({ cycles: 30 });
            expect(harness.requestsFor(path)).toHaveLength(before);
            expect(hook.getCurrent()?.value).toBe(ready?.value);
            presented = true;
            await hook.rerender();
            await waitForHomeGovernance(() => expect(harness.requestsFor(path)).toHaveLength(before + 1));
            await waitForHomeGovernance(() => expect(hook.getCurrent()).toMatchObject({
                loading: false, error: null,
                value: kind === 'collection' ? [createPlainManagedMachinePresetFixture(updated).opened] : { preset: createPlainManagedMachinePresetFixture(updated).opened, machines: [resource] },
            }));
        } finally { await hook.unmount(); }
    });

    it('keeps preset collection reads independent of Account settings version pushes', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset)] } });
        const hook = await renderHook(() => useMachinePresets([serverId]));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(preset).opened]));
            const before = harness.requestsFor('/v1/machines/presets/list').length;
            for (let version = 1; version <= 3; version++) {
                await act(async () => { publishHomeAccountChangeWake(serverId,
                    { t: 'account-settings-changed', settingsVersion: version }, 'socket'); });
                await flushHookEffects({ cycles: 30 });
            }
            expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before);
            const updated = { ...preset, revision: preset.revision + 1 } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
            harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(updated)] } });
            await act(async () => publishHomeAccountChange(serverId, [MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1], { source: 'socket', changeKinds: ['account'] }));
            await waitForHomeGovernance(() => expect(hook.getCurrent().presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(updated).opened]));
            expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before + 1);
        } finally { await hook.unmount(); }
    });

    it('keeps preset content independent of controller presence and reloads only a saved preset change', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset)] } });
        const hook = await renderHook(() => useMachinePresets([serverId]));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().presetsByServerId[serverId]).toHaveLength(1));
            const before = harness.requestsFor('/v1/machines/presets/list').length;
            for (let index = 0; index < 20; index += 1) {
                await act(async () => publishHomeAccountChange(serverId, [`other-machine-${index}`],
                    { source: 'socket', changeKinds: ['machine'] }));
                await flushHookEffects({ cycles: 10 });
            }
            expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before);
            await act(async () => publishHomeAccountChange(serverId, [preset.controller.machineId],
                { source: 'socket', changeKinds: ['machine'] }));
            await flushHookEffects({ cycles: 10 });
            expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before);
            await act(async () => publishHomeAccountChange(serverId, [MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1],
                { source: 'socket', changeKinds: ['account'] }));
            await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before + 1));
        } finally { await hook.unmount(); }
    });

    it('refreshes the saved controller label on a title-only content edit while keeping toggles independent', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ profileScope: { serverId, accountId: 'owner' } });
        const machine = createMachineFixture({ id: preset.controller.machineId, installationId: preset.controller.installationId,
            kind: 'persistent', metadata: { ...createMachineFixture().metadata!, displayName: 'Renamed builder' } });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId, sourceAccountId: 'owner' });
        const { archivedAt: _archivedAt, ...activePreset } = preset;
        const original = { ...activePreset, owner: { kind: 'team' as const, teamId: 'team' }, teamAcquireDelegated: true, controllerDisplayName: 'Former builder' } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(original) } });
        harness.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [] } });
        const edited = { ...original, revision: 4, name: 'Edited guest', controllerDisplayName: 'Renamed builder' } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
        harness.answer(serverId, '/v1/machines/presets/update', { body: { kind: 'saved', preset: createPlainManagedMachinePresetFixture(edited) } });
        const hook = await renderHook(() => useMachinePresetDetail(serverId, preset.id));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().state.value?.preset.id).toBe(preset.id));
            await act(async () => { await hook.getCurrent().update({ privateContent: { v: 1, name: edited.name, launch: original.launch } }); });
            expect(harness.requestsFor('/v1/machines/presets/update')[0]!.input).toEqual({
                homeId: preset.homeId, id: preset.id, expectedRevision: preset.revision,
                patch: { contentEncryptionMode: 'plain', recipients: [], content: { t: 'plain', v: { v: 1, name: edited.name, launch: original.launch, controllerDisplayName: 'Renamed builder' } } },
            });
            await act(async () => { await hook.getCurrent().update({ teamAcquireDelegated: false }); });
            expect(harness.requestsFor('/v1/machines/presets/update')[1]!.input).toMatchObject({ patch: { teamAcquireDelegated: false } });
            expect(harness.requestsFor('/v1/machines/presets/update')[1]!.input).not.toHaveProperty('patch.content.v.controllerDisplayName');
            storage.getState().applyMachines([{ ...machine, metadata: null, metadataVersion: 2,
                availability: { kind: 'locked', reason: 'decryption_failed' } }], false,
            { sourceServerId: serverId, sourceAccountId: 'owner' });
            await act(async () => { await hook.getCurrent().update({ privateContent: { v: 1, name: 'Unavailable builder edit', launch: original.launch } }); });
            expect(harness.requestsFor('/v1/machines/presets/update')[2]!.input).not.toHaveProperty('patch.content.v.controllerDisplayName');
        } finally { await hook.unmount(); }
    });

    it.each(['create', 'update', 'capture'] as const)('snapshots the local controller display label only on an explicit %s save', async mode => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ profileScope: { serverId, accountId: 'owner' } });
        const machine = createMachineFixture({ id: preset.controller.machineId, installationId: preset.controller.installationId,
            metadata: { ...createMachineFixture().metadata!, host: 'private-host', displayName: 'Company builder' } });
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId, sourceAccountId: 'owner' });
        const saved = { ...preset, owner: { kind: 'team' as const, teamId: 'team' }, teamAcquireDelegated: true } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
        const operation = mode === 'update' ? 'update' : 'create';
        harness.answer(serverId, `/v1/machines/presets/${operation}`, { body: { kind: 'saved', preset: createPlainManagedMachinePresetFixture(saved) } });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_history');
        const draft = { name: preset.name, creation: { launch: preset.launch, controller: preset.controller } };
        const save = () => mode === 'capture' ? client.capture({ homeId: 'srv_history', id: preset.id, name: preset.name,
            owner: saved.owner, teamAcquireDelegated: true, launch: preset.launch, controller: preset.controller }, [{ kind: 'direct', setup: {} }])
            : mode === 'update' ? client.saveDraft({ draft, preset: saved })
                : client.execute('machines.presets.create', { homeId: preset.homeId, id: preset.id,
                    owner: saved.owner, teamAcquireDelegated: true, privateContent: { v: 1, name: preset.name, launch: preset.launch }, controller: preset.controller });
        expect(await save()).toMatchObject({ kind: 'succeeded' });
        const input = harness.requestsFor(`/v1/machines/presets/${operation}`)[0]!.input;
        expect(input).toMatchObject(mode === 'update'
            ? { patch: { content: { t: 'plain', v: { controllerDisplayName: 'Company builder' } } } } : { content: { t: 'plain', v: { controllerDisplayName: 'Company builder' } } });
        storage.getState().applyMachines([{ ...machine, metadataVersion: 2,
            metadata: { ...machine.metadata!, displayName: 'Renamed builder' } }], false,
        { sourceServerId: serverId, sourceAccountId: 'owner' });
        expect(harness.requestsFor(`/v1/machines/presets/${operation}`)).toHaveLength(1);
        expect(await save()).toMatchObject({ kind: 'succeeded' });
        const renamed = harness.requestsFor(`/v1/machines/presets/${operation}`)[1]!.input;
        expect(renamed).toMatchObject(mode === 'update'
            ? { patch: { content: { t: 'plain', v: { controllerDisplayName: 'Renamed builder' } } } } : { content: { t: 'plain', v: { controllerDisplayName: 'Renamed builder' } } });
        storage.getState().applyMachines([{ ...machine, installationId: 'replacement-installation', metadataVersion: 3 }], false,
            { sourceServerId: serverId, sourceAccountId: 'owner' });
        expect(await save()).toMatchObject({ kind: 'succeeded' });
        const replaced = harness.requestsFor(`/v1/machines/presets/${operation}`)[2]!.input;
        if (mode === 'update') expect(replaced).not.toHaveProperty('patch.content.v.controllerDisplayName');
        else expect(replaced).not.toHaveProperty('content.v.controllerDisplayName');
        expect(harness.requests.filter(request => request.path.includes('/machines/')
            && !request.path.includes('/presets/'))).toEqual([]);
    });

    it.each([
        { accountEncryptionMode: 'e2ee', team: true, delegated: true },
        { accountEncryptionMode: 'plain', team: true, delegated: true },
        { accountEncryptionMode: 'plain', team: false, delegated: false },
        { accountEncryptionMode: 'plain', team: true, delegated: false },
    ] as const)('keeps supplied labels private and snapshots current labels only for Plain delegated Team saves: $accountEncryptionMode team=$team delegated=$delegated', async scenario => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true,
            accountEncryptionMode: scenario.accountEncryptionMode,
            ...(scenario.accountEncryptionMode === 'e2ee' ? { credentials: {
                token: createAccountTokenForTests('owner', { currentAccount: true }),
                secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url'),
            } } : {}) });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ profileScope: { serverId, accountId: 'owner' } });
        storage.getState().applyMachines([createMachineFixture({ id: preset.controller.machineId,
            installationId: preset.controller.installationId,
            metadata: { ...createMachineFixture().metadata!, displayName: 'Private decrypted builder' } })], true,
        { sourceServerId: serverId, sourceAccountId: 'owner' });
        const owner = scenario.team ? { kind: 'team' as const, teamId: 'team' } : preset.owner;
        const definition = { homeId: preset.homeId, id: preset.id, name: preset.name, owner,
            launch: preset.launch, controller: preset.controller,
            ...(scenario.delegated ? { teamAcquireDelegated: true } : {}) };
        const saved = { ...definition, revision: preset.revision } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
        if (scenario.accountEncryptionMode === 'e2ee') {
            const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
            const { computeContentPublicKeyFingerprint } = await import('@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint');
            const encryption = await createEncryptionFromAuthCredentials({ token: createAccountTokenForTests('owner', { currentAccount: true }),
                secret: encodeBase64(new Uint8Array(32).fill(24), 'base64url') });
            harness.answer(serverId, '/v1/machines/presets/recipient-census', { select: value => ({ body: { kind: 'ready', contentEncryptionMode: 'e2ee', recipients: [{
                account: { kind: 'account', accountId: 'owner', name: null, firstName: null, lastName: null, username: null, avatarUrl: null },
                readiness: { status: 'available', contentPublicKey: encodeBase64(encryption.contentDataKey, 'base64'),
                    contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(encryption.contentDataKey) },
                envelopeStatus: ManagedMachinePresetRecipientCensusInputV1Schema.parse(value).presetId ? 'prepared' : 'missing',
            }] } }) });
        }
        harness.answer(serverId, '/v1/machines/presets/create', { select: value => ({ body: { kind: 'saved',
            preset: { ...ManagedMachinePresetCreateInputV1Schema.parse(value), revision: saved.revision } } }) });
        harness.answer(serverId, '/v1/machines/presets/update', { select: value => ({ body: { kind: 'saved',
            preset: applyManagedMachinePresetUpdateFixture(createPlainManagedMachinePresetFixture(saved), ManagedMachinePresetUpdateInputV1Schema.parse(value)) } }) });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, preset.homeId);
        const captures = [
            await client.capture({ ...definition, controllerDisplayName: 'Retained supplied label' }, [{ kind: 'direct', setup: {} }]),
            await client.execute('machines.presets.update', { homeId: preset.homeId, id: preset.id,
                expectedRevision: preset.revision, patch: { privateContent: { v: 1, name: 'Edited', launch: preset.launch, controllerDisplayName: 'Retained supplied label' } } },
            { preset: saved }),
            await client.saveDraft({ preset: saved, draft: { name: 'Draft save', creation: { launch: preset.launch, controller: preset.controller } } }),
        ];
        const publishes = scenario.accountEncryptionMode === 'plain' && scenario.team && scenario.delegated;
        for (const [index, captured] of captures.entries()) {
            expect(captured.kind === 'succeeded' ? 'succeeded' : captured).toBe('succeeded');
            if (captured.kind !== 'succeeded' || captured.value.kind !== 'saved') throw new Error('Expected opened saved preset');
            expect(captured.value.preset.controllerDisplayName).toBe(publishes
                ? 'Private decrypted builder' : index < 2 ? 'Retained supplied label' : undefined);
        }
        for (const request of harness.requestsFor('/v1/machines/presets/create')) {
            expect(request.input).not.toHaveProperty('controllerDisplayName');
            if (scenario.accountEncryptionMode === 'plain') expect(request.input).toHaveProperty('content.v.controllerDisplayName', publishes ? 'Private decrypted builder' : 'Retained supplied label');
            else expect(request.input).not.toHaveProperty('content.v');
        }
        for (const [index, request] of harness.requestsFor('/v1/machines/presets/update').entries()) {
            expect(request.input).not.toHaveProperty('patch.controllerDisplayName');
            if (scenario.accountEncryptionMode === 'e2ee') expect(request.input).not.toHaveProperty('patch.content.v');
            else if (index === 0) expect(request.input).toHaveProperty('patch.content.v.controllerDisplayName', publishes ? 'Private decrypted builder' : 'Retained supplied label');
            else if (publishes) expect(request.input).toHaveProperty('patch.content.v.controllerDisplayName', 'Private decrypted builder');
            else expect(request.input).not.toHaveProperty('patch.content.v.controllerDisplayName');
        }
        expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(1);
        expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(2);
    });

    it.each(['absent', 'different-installation'] as const)('preserves a supplied private controller label when its local snapshot is %s', async snapshot => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ profileScope: { serverId, accountId: 'owner' } });
        storage.getState().applyMachines(snapshot === 'absent' ? [] : [createMachineFixture({
            id: preset.controller.machineId, installationId: 'replacement-installation',
            metadata: { ...createMachineFixture().metadata!, displayName: 'Different builder' },
        })], true, { sourceServerId: serverId, sourceAccountId: 'owner' });
        harness.answer(serverId, '/v1/machines/presets/create', { select: input => ({ body: {
            kind: 'saved', preset: { ...ManagedMachinePresetCreateInputV1Schema.parse(input), revision: 1 },
        } }) });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, preset.homeId);
        const result = await client.capture({ homeId: preset.homeId, id: preset.id, name: preset.name,
            owner: { kind: 'team', teamId: 'team' }, teamAcquireDelegated: true,
            controller: preset.controller, launch: preset.launch, controllerDisplayName: 'Retained private builder',
        }, [{ kind: 'direct', setup: {} }]);
        expect(result).toMatchObject({ kind: 'succeeded', value: { kind: 'saved',
            preset: { controllerDisplayName: 'Retained private builder' } } });
        const request = harness.requestsFor('/v1/machines/presets/create')[0]?.input;
        expect(request).toHaveProperty('content.v.controllerDisplayName', 'Retained private builder');
        expect(request).not.toHaveProperty('controllerDisplayName');
    });

    it.each(['create', 'update'] as const)('saves a setup-only editor draft through the existing %s Action without creation facts', async mode => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        const setup = { scripts: [{ body: '\r\necho exact saved bytes\r\n', affects: 'none' as const }],
            items: [{ kind: 'softwareRecipe' as const, selection: {
                ref: { pluginId: 'tools.example', recipeId: 'editor', revision: 'pinned-revision' }, inputs: { name: 'editor' },
            } }] };
        const draft: MachinePresetEditDraft = { name: 'Build tools', setup };
        const saved = { id: 'setup-only', homeId: 'srv_history', revision: mode === 'update' ? 9 : 1, name: draft.name, setup,
            owner: { kind: 'account' as const, accountId: 'owner' } } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
        harness.answer(serverId, `/v1/machines/presets/${mode}`, { body: { kind: 'saved', preset: createPlainManagedMachinePresetFixture(saved) } });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_history');
        const result = await client.saveDraft({ draft, ...(mode === 'update'
            ? { preset: { id: saved.id, revision: 8, owner: saved.owner } } : { id: saved.id, owner: saved.owner }) });
        expect(result).toEqual({ kind: 'succeeded', value: { kind: 'saved', preset: createPlainManagedMachinePresetFixture(saved).opened } });
        expect(harness.requestsFor(`/v1/machines/presets/${mode}`).map(request => request.input)).toEqual([mode === 'update' ? {
            homeId: 'srv_history', id: saved.id, expectedRevision: 8,
            patch: { contentEncryptionMode: 'plain', content: { t: 'plain', v: { v: 1, name: draft.name, setup } }, recipients: [], controller: null, controllerPoolId: null, teamAcquireDelegated: false,
                retention: null, wakeOnAcceptedMessage: null, simultaneousLimit: null },
        } : { homeId: 'srv_history', id: saved.id, owner: saved.owner, contentEncryptionMode: 'plain', content: { t: 'plain', v: { v: 1, name: draft.name, setup } }, recipients: [] }]);
        expect(harness.requests.filter(request => request.path.includes('/actions/machines.provisioners.')
            || request.path.includes('/actions/machines.managed.acquire') || request.path.includes('/actions/machines.setup.'))).toEqual([]);
    });

    it('ignores unrelated Workflow Run wakes while refreshing preset, history, access and unknown Home changes', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset)] } });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(preset) } });
        harness.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [resource] } });
        const homes = [serverId];
        const hook = await renderHook(() => ({ collection: useMachinePresets(homes), detail: useMachinePresetDetail(serverId, preset.id) }));
        const counts = () => ({ list: harness.requestsFor('/v1/machines/presets/list').length,
            preset: harness.requestsFor('/v1/machines/presets/get').length,
            history: harness.requestsFor('/v1/machines/managed/actions/list').length });
        try {
            await waitForHomeGovernance(() => {
                expect(hook.getCurrent().collection.presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(preset).opened]);
                expect(hook.getCurrent().detail.state.value).toEqual({ preset: createPlainManagedMachinePresetFixture(preset).opened, machines: [resource] });
            });
            const initial = counts();
            for (let index = 0; index < 4; index += 1) {
                await act(async () => publishHomeAccountChange(serverId, [`workflow-run:run-${index}`],
                    { source: 'socket', changeKinds: ['account'] }));
                await flushHookEffects({ cycles: 30 });
            }
            for (const kind of ['artifact', 'automation', 'discussion', 'feed', 'friends', 'friend_request', 'friend_accepted', 'kv', 'pet', 'session'] as const) {
                await act(async () => publishHomeAccountChange(serverId, ['unrelated'], { changeKinds: [kind] }));
                await flushHookEffects({ cycles: 30 });
            }
            expect(counts()).toEqual(initial);

            const updated = { ...preset, revision: preset.revision + 1 } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
            harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(updated)] } });
            harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(updated) } });
            await act(async () => { publishHomeAccountChangeWake(serverId, { t: 'account-change',
                entityIds: [MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1], changeKinds: ['account'] }, 'socket'); });
            await waitForHomeGovernance(() => {
                expect(hook.getCurrent().collection.presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(updated).opened]);
                expect(hook.getCurrent().detail.state.value?.preset.revision).toBe(updated.revision);
            });
            expect(counts()).toEqual({ list: initial.list + 1, preset: initial.preset + 1, history: initial.history + 2 });

            const changedResource = { ...resource, intentRevision: resource.intentRevision + 1 };
            harness.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [changedResource] } });
            await act(async () => publishHomeAccountChange(serverId, [resource.id], { changeKinds: ['machine'] }));
            await waitForHomeGovernance(() => expect(hook.getCurrent().detail.state.value?.machines).toEqual([changedResource]));
            expect(counts()).toEqual({ list: initial.list + 1, preset: initial.preset + 2, history: initial.history + 4 });

            await act(async () => publishHomeAccountChange(serverId));
            await waitForHomeGovernance(() => expect(counts()).toEqual(
                { list: initial.list + 1, preset: initial.preset + 3, history: initial.history + 6 }));

            harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'refused', code: 'permission_denied' } });
            harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'refused', code: 'permission_denied' } });
            await act(async () => publishHomeAccountChange(serverId, ['workflow-run:run', TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }));
            await waitForHomeGovernance(() => {
                expect(hook.getCurrent().collection.statesByServerId[serverId]).toMatchObject({ value: null, error: 'permission_denied' });
                expect(hook.getCurrent().detail.state).toMatchObject({ value: null, error: 'permission_denied' });
            });
            expect(counts()).toEqual({ list: initial.list + 2, preset: initial.preset + 4, history: initial.history + 6 });
        } finally { await hook.unmount(); }
    });
    it('retains a failed preset configuration during Retry and publishes only its changed answer', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history-retry.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { useMachinePresetConfiguration } = await import('./useMachinePresets');
        const { createManagedProvisionerClient } = await import('./managedProvisionerClient');
        const { MachineProvisionerContributionV1Schema } = await import('@happier-dev/protocol/plugins/contributions/machineProvisioners');
        const provisioner = { contribution: preset.launch.provider, occurrenceId: 'retry-occurrence', acquireExecutionTarget: 'daemon' as const,
            descriptor: MachineProvisionerContributionV1Schema.parse({ id: 'native', title: 'Native', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
                launchSchema: { type: 'object', properties: {}, additionalProperties: false },
                resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
                billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
                actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } }) };
        const optionsInput = { kind: 'ready', schema: { type: 'object', properties: {}, additionalProperties: false },
            action: { pluginId: provisioner.contribution.pluginId, id: 'options', occurrenceId: provisioner.occurrenceId } } as const;
        let reply = createDeferred<void>();
        let available = false;
        for (const actionId of ['machines.provisioners.check', 'machines.provisioners.options'] as const) {
            await answerExternalActionAccountForHome(harness, serverId, {
                ...preset.controller, tokenEpoch: 0, actionId,
                execute: async () => {
                    await reply.promise;
                    return available ? actionId === 'machines.provisioners.check' ? { available: true }
                        : { base: { launch: {} }, dimensions: { size: [], image: [], location: [], network: [], duration: [] } }
                        : { ok: false, errorCode: 'action_failed', error: 'action_failed' };
                },
                failure: value => {
                    const failure = ActionExecuteFailureSchema.safeParse(value);
                    return failure.success ? failure.data : null;
                },
            });
        }
        let commits = 0;
        const wrapper = ({ children }: React.PropsWithChildren) => React.createElement(React.Profiler,
            { id: 'preset-retry', onRender: () => { commits++; } }, children);
        const onApprovalPending = () => {};
        const openedPreset = createPlainManagedMachinePresetFixture(preset).opened;
        const rendered = await renderHook(() => {
            const { binding, resolution } = useServerCredentialAccountScopeBinding(serverId);
            const client = React.useMemo(() => binding ? createManagedProvisionerClient(binding.scope, 'srv_history') : null, [binding]);
            return useMachinePresetConfiguration({ binding, resolution, client, homeId: 'srv_history',
                preset: openedPreset, provisioner, optionsInput, onApprovalPending });
        }, { wrapper });
        try {
            await act(async () => reply.resolve());
            await waitForHomeGovernance(() => expect(rendered.getCurrent().error).toBe('action_failed'));
            await flushHookEffects();
            reply = createDeferred<void>();
            commits = 0;
            await act(async () => rendered.getCurrent().refresh());
            expect.soft(rendered.getCurrent()).toMatchObject({ error: 'action_failed', loading: false });
            expect.soft(commits).toBe(1);
            commits = 0;
            await act(async () => reply.resolve());
            await flushHookEffects();
            expect.soft(commits).toBe(0);
            available = true;
            reply = createDeferred<void>();
            await act(async () => rendered.getCurrent().refresh());
            await act(async () => reply.resolve());
            await waitForHomeGovernance(() => expect(rendered.getCurrent().error).toBeNull());
        } finally { await rendered.unmount(); }
    });
    it('keeps setup-only configuration independent of a retained creation provisioner', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { useMachinePresetConfiguration } = await import('./useMachinePresets');
        const { createManagedProvisionerClient } = await import('./managedProvisionerClient');
        const { MachineProvisionerContributionV1Schema } = await import('@happier-dev/protocol/plugins/contributions/machineProvisioners');
        const provisioner = { contribution: preset.launch.provider, occurrenceId: 'retained-occurrence', acquireExecutionTarget: 'daemon' as const,
            descriptor: MachineProvisionerContributionV1Schema.parse({ id: 'native', title: 'Native', icon: 'server', resourceKind: 'VM', schemaVersion: 1,
                launchSchema: { type: 'object', properties: {}, additionalProperties: false },
                resourceSchema: { type: 'object', properties: {}, additionalProperties: false }, platforms: ['linux'], prerequisites: [],
                billing: { location: 'local', stoppedBilling: 'not-billed' }, retention: { supportedIntents: ['start', 'stop', 'delete'] },
                actions: { check: 'check', options: 'options', acquire: 'acquire', bootstrap: 'bootstrap', inspect: 'inspect', power: 'power', destroy: 'destroy' } }) };
        const setupOnly = { id: 'setup-only', homeId: 'srv_history', revision: 1, name: 'Build tools',
            owner: preset.owner, setup: { scripts: [{ body: '\r\necho retained\r\n', affects: 'none' as const }] } } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
        const rendered = await renderHook(() => {
            const { binding, resolution } = useServerCredentialAccountScopeBinding(serverId);
            const client = React.useMemo(() => binding ? createManagedProvisionerClient(binding.scope, 'srv_history') : null, [binding]);
            return { resolution, configuration: useMachinePresetConfiguration({ binding, resolution, client, homeId: 'srv_history',
                preset: createPlainManagedMachinePresetFixture(setupOnly).opened, provisioner, optionsInput: { kind: 'loading' }, onApprovalPending() {} }) };
        });
        try {
            await waitForHomeGovernance(() => expect(rendered.getCurrent().resolution.kind).toBe('bound'));
            await flushHookEffects({ cycles: 30 });
            expect(rendered.getCurrent().configuration).toMatchObject({ facts: null, loading: false, error: null });
            expect(harness.requests.filter(request => request.path.includes('/actions/machines.provisioners.'))).toEqual([]);
        } finally { await rendered.unmount(); }
    });
    it.each(['collection', 'detail'] as const)('retains the ready %s receipt during equal revalidation and publishes real changes', async kind => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        let currentPreset = createPlainManagedMachinePresetFixture(preset);
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [currentPreset] } });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: currentPreset } });
        harness.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [resource] } });
        const publications: unknown[] = [];
        const hook = await renderHook(() => {
            const collection = useMachinePresets(kind === 'collection' ? [serverId] : []);
            const detail = useMachinePresetDetail(serverId, kind === 'detail' ? preset.id : '');
            const state = kind === 'collection' ? collection.statesByServerId[serverId] : detail.state;
            React.useEffect(() => { publications.push(state); }, [state]);
            return { state, refresh: kind === 'collection' ? collection.refresh : detail.refresh };
        });
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().state).toMatchObject({ loading: false, error: null }));
            // Start the refresh budget after the initial ready receipt reached its actual consumer effect.
            await waitForHomeGovernance(() => expect(publications.at(-1)).toBe(hook.getCurrent().state));
            const retained = hook.getCurrent().state;
            publications.length = 0;
            for (let index = 0; index < 4; index += 1) {
                await act(async () => hook.getCurrent().refresh());
                await flushHookEffects({ cycles: 30 });
            }
            expect(publications).toHaveLength(0);
            expect(hook.getCurrent().state).toBe(retained);
            currentPreset = createPlainManagedMachinePresetFixture({ ...preset, revision: 4 });
            harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [currentPreset] } });
            harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: currentPreset } });
            await act(async () => hook.getCurrent().refresh());
            await waitForHomeGovernance(() => expect(hook.getCurrent().state?.value).toEqual(kind === 'collection'
                ? [currentPreset.opened] : { preset: currentPreset.opened, machines: [resource] }));
            expect(publications.length).toBeGreaterThan(0);
            const path = kind === 'collection' ? '/v1/machines/presets/list' : '/v1/machines/presets/get';
            harness.answer(serverId, path, { status: 503, body: { kind: 'refused', code: 'unavailable' } });
            await act(async () => hook.getCurrent().refresh());
            await waitForHomeGovernance(() => expect(hook.getCurrent().state).toMatchObject({ loading: false, error: expect.any(String) }));
            await waitForHomeGovernance(() => expect(publications.at(-1)).toBe(hook.getCurrent().state));
            const failure = hook.getCurrent().state;
            publications.length = 0;
            await act(async () => hook.getCurrent().refresh());
            await flushHookEffects({ cycles: 30 });
            expect(publications).toHaveLength(0);
            expect(hook.getCurrent().state).toBe(failure);
            harness.answer(serverId, path, { status: 403, body: { kind: 'refused', code: 'permission_denied' } });
            await act(async () => hook.getCurrent().refresh());
            await waitForHomeGovernance(() => expect(hook.getCurrent().state?.value).toBeNull());
        } finally { await hook.unmount(); }
    });
    it('starts ordinary history reads only after their inline review is confirmed', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        let releaseHistory!: () => void;
        const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(preset) } });
        harness.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [resource] }, respondAfter: historyGate });
        await harness.requireUiApproval(serverId, 'machines.presets.get');
        const modalHost = await renderScreen(React.createElement(ModalProvider));
        const rendered = await renderHook(() => useMachinePresetDetail(serverId, 'preset'));
        try {
            await waitForHomeGovernance(() => expect(modalHost.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
            expect(harness.artifacts(serverId).list()).toEqual([]);
            expect(harness.requestsFor('/v1/machines/presets/get')).toEqual([]);
            await modalHost.pressByTestIdAsync('actions.confirmation-review.decision-approve');
            await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/get')).toHaveLength(1));
            await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/managed/actions/list')).toHaveLength(2));
            expect(harness.artifacts(serverId).list()).toEqual([]);
            releaseHistory();
            await waitForHomeGovernance(() => expect(rendered.getCurrent().state).toMatchObject({ loading: false, error: null }));
        } finally {
            releaseHistory();
            await rendered.unmount();
            await modalHost.unmount();
        }
    });
    it.each(['collection', 'detail'] as const)('keeps the %s result while a later inline review is canceled', async kind => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        const otherId = await addPresetHome({ name: 'Other', serverUrl: 'https://other-history.example',
            serverIdentityId: 'srv_other_history', accountId: 'owner', currentAccount: true, active: false });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset)] } });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(preset) } });
        harness.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [resource] } });
        const otherPreset = { ...preset, id: 'other', homeId: 'srv_other_history' } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
        harness.answer(otherId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(otherPreset)] } });
        await harness.requireUiApproval(serverId, kind === 'collection' ? 'machines.presets.list' : 'machines.presets.get');
        const modalHost = await renderScreen(React.createElement(ModalProvider));
        const rendered = await renderHook(() => {
            const collection = useMachinePresets(kind === 'collection' ? [serverId, otherId] : [otherId]);
            const detail = useMachinePresetDetail(serverId, kind === 'detail' ? 'preset' : '');
            return { collection, detail };
        });
        const state = () => kind === 'collection' ? rendered.getCurrent().collection.statesByServerId[serverId] : rendered.getCurrent().detail.state;
        try {
            await waitForHomeGovernance(() => expect(modalHost.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
            expect(harness.artifacts(serverId).list()).toEqual([]);
            await modalHost.pressByTestIdAsync('actions.confirmation-review.decision-approve');
            await waitForHomeGovernance(() => expect(state()).toMatchObject({ loading: false, error: null }));
            const retained = state()?.value;
            expect(retained).toEqual(kind === 'collection' ? [createPlainManagedMachinePresetFixture(preset).opened] : { preset: createPlainManagedMachinePresetFixture(preset).opened, machines: [resource] });
            const otherReads = () => harness.requestsFor('/v1/machines/presets/list').filter(request => request.serverId === otherId);
            const readsBefore = otherReads().length;
            await act(async () => publishHomeAccountChange(otherId, [MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }));
            await waitForHomeGovernance(() => expect(otherReads()).toHaveLength(readsBefore + 1));
            await act(async () => publishHomeAccountChange(serverId, [MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1], { changeKinds: ['account'] }));
            await waitForHomeGovernance(() => expect(modalHost.findByTestId('actions.confirmation-review.decision-reject')).not.toBeNull());
            expect(harness.artifacts(serverId).list()).toEqual([]);
            await modalHost.pressByTestIdAsync('actions.confirmation-review.decision-reject');
            await waitForHomeGovernance(() => expect(state()).toMatchObject({ loading: false, error: 'approval_canceled' }));
            expect(state()?.value).toBe(retained);
        } finally {
            await rendered.unmount();
            await modalHost.unmount();
        }
    });
    it.each([
        { kind: 'conflict', currentRevision: 5 },
        { kind: 'refused', code: 'permission_denied' },
    ] satisfies PresetMutationResultV1[])('retains the typed $kind result after a preset mutation inline review', async result => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(preset) } });
        harness.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [resource] } });
        harness.answer(serverId, '/v1/machines/presets/update', { body: result });
        const direct = await createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_history')
            .execute('machines.presets.update', { homeId: 'srv_history', id: 'preset', expectedRevision: 3,
                patch: { privateContent: { v: 1, name: 'Updated', launch: preset.launch } } }, { preset });
        expect(direct).toEqual({ kind: 'succeeded', value: result });
        await harness.requireUiApproval(serverId, 'machines.presets.update');
        const modalHost = await renderScreen(React.createElement(ModalProvider));
        const rendered = await renderHook(() => ({ detail: useMachinePresetDetail(serverId, 'preset') }));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().detail.state.value?.preset.id).toBe('preset'));
        let mutation: Promise<unknown> | null = null;
        await act(async () => { mutation = rendered.getCurrent().detail.update({ privateContent: { v: 1, name: 'Updated', launch: preset.launch } }); });
        await waitForHomeGovernance(() => expect(modalHost.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
        expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(1);
        expect(harness.artifacts(serverId).list()).toEqual([]);
        if (result.kind === 'refused') harness.answer(serverId, '/v1/machines/presets/get', { status: 403, body: result });
        await modalHost.pressByTestIdAsync('actions.confirmation-review.decision-approve');
        if (!mutation) throw new Error('Expected preset mutation');
        await expect(mutation).resolves.toEqual({ kind: 'succeeded', value: result });
        await waitForHomeGovernance(() => expect(rendered.getCurrent().detail.mutationResult).toEqual(result));
        expect(rendered.getCurrent().detail.mutationResult).toEqual(result);
        if (result.kind === 'refused') expect(rendered.getCurrent().detail.state.value).toBeNull();
        else expect(rendered.getCurrent().detail.state.value?.preset.revision).toBe(3);
        await rendered.unmount();
        await modalHost.unmount();
    });

    it('retains setup-only Presets in the Machines inventory without a controller catalog or managed-resource answer', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example', serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        const setupOnly = { id: 'setup-only', homeId: 'srv_history', revision: 1, name: 'Build tools',
            owner: { kind: 'account', accountId: 'owner' }, setup: { scripts: [{ body: 'prepare-tools' }] } } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { srv_history: [] }, machineListStatusByServerId: { srv_history: 'idle' } });
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { respondAfter: new Promise<void>(() => {}) });
        harness.answer(serverId, '/v1/machines/managed/actions/list', { respondAfter: new Promise<void>(() => {}) });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(setupOnly)] } });
        const { useMachinesSettingsViewModel } = await import('../machinesSettingsViewModel');
        const rendered = await renderHook(() => useMachinesSettingsViewModel());
        await waitForHomeGovernance(() => expect(Object.values(rendered.getCurrent().presetInventory.statesByServerId))
            .toEqual([expect.objectContaining({ loading: false })]));
        expect(Object.values(rendered.getCurrent().presetInventory.statesByServerId)).toEqual([
            expect.objectContaining({ loading: false, error: null, value: [createPlainManagedMachinePresetFixture(setupOnly).opened] }),
        ]);
        expect(Object.values(rendered.getCurrent().presetsByServerId).flat()).toEqual([createPlainManagedMachinePresetFixture(setupOnly).opened]);
        expect(harness.requests.some(request => request.path.includes('/actions/machines.provisioners.'))).toBe(false);
        await rendered.unmount();
    });
    it('settles a failed server preset read without waiting for a controller', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example', serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v1/machines/presets/list', { status: 503, body: { kind: 'refused', code: 'unavailable' } });
        const rendered = await renderHook(() => useMachinePresets([serverId]));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().statesByServerId[serverId]).toMatchObject({ loading: false, value: null }));
        expect(rendered.getCurrent().statesByServerId[serverId]?.error).toBeTruthy();
        expect(harness.requests.some(request => request.path.includes('/actions/machines.provisioners.'))).toBe(false);
        await rendered.unmount();
    });
    it.each(['profile', 'portable'] as const)('loads server presets with silent controllers through a %s Home identifier', async identifier => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example', serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { srv_history: [createMachineFixture({ id: 'controller', installationId: 'installation', activeAt: Date.now() })] },
            machineListStatusByServerId: { srv_history: 'idle' } });
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { respondAfter: new Promise<void>(() => {}) });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset)] } });
        const scopeId = identifier === 'profile' ? serverId : 'srv_history';
        const rendered = await renderHook(() => useMachinePresets([scopeId]));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().statesByServerId[scopeId]).toMatchObject({ loading: false, error: null, value: [preset] }));
        expect(harness.requests.some(request => request.path.includes('/actions/machines.provisioners.'))).toBe(false);
        await rendered.unmount();
    });
    it('settles a signed-out preset collection as unavailable rather than loading forever', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example', serverIdentityId: 'srv_history', accountId: null });
        const rendered = await renderHook(() => useMachinePresets([serverId]));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().statesByServerId[serverId])
            .toMatchObject({ value: null, loading: false, error: 'signed_out' }));
        expect(harness.requests.some(request => request.path.includes('/machines/'))).toBe(false);
        await rendered.unmount();
    });
    it('settles a signed-out detail without issuing reads or keeping creation progress active', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example', serverIdentityId: 'srv_history', accountId: null });
        const rendered = await renderHook(() => useMachinePresetDetail(serverId, 'preset'));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().state).toMatchObject({ value: null, loading: false, error: 'signed_out' }));
        expect(harness.requests.some(request => request.path.includes('/machines/'))).toBe(false);
        await rendered.unmount();
    });
    it('isolates shared preset rows by Home and retires only the replaced Account', async () => {
        const firstId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        const secondId = await addPresetHome({ name: 'Other', serverUrl: 'https://other.example',
            serverIdentityId: 'srv_other', accountId: 'other-owner', currentAccount: true });
        const other = { ...preset, id: 'other-preset', homeId: 'srv_other', owner: { kind: 'account' as const, accountId: 'other-owner' } } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
        harness.answer(firstId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset)] } });
        harness.answer(secondId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(other)] } });
        const hook = await renderHook(() => useMachinePresets([firstId, secondId]));
        try {
            await waitForHomeGovernance(() => expect(hook.getCurrent().presetsByServerId).toEqual({
                [firstId]: [createPlainManagedMachinePresetFixture(preset).opened],
                [secondId]: [createPlainManagedMachinePresetFixture(other).opened],
            }));
            const retainedOther = hook.getCurrent().presetsByServerId[secondId];
            harness.answer(firstId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [] } });
            await act(async () => { await harness.switchAccount(firstId, 'replacement'); });
            await waitForHomeGovernance(() => expect(hook.getCurrent().presetsByServerId[firstId]).toEqual([]));
            expect(hook.getCurrent().presetsByServerId[secondId]).toBe(retainedOther);
            expect(harness.requestsFor('/v1/machines/presets/list').filter(request => request.serverId === secondId)).toHaveLength(1);
        } finally { await hook.unmount(); }
    });

    it('withdraws protected collection rows when the captured credential is replaced', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example', serverIdentityId: 'srv_history', accountId: 'owner' });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset)] } });
        const rendered = await renderHook(() => useMachinePresets([serverId]));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().presetsByServerId[serverId]).toEqual([createPlainManagedMachinePresetFixture(preset).opened]));
        const unchanged = rendered.getCurrent().presetsByServerId;
        await act(async () => rendered.getCurrent().refresh());
        await waitForHomeGovernance(() => expect(rendered.getCurrent().statesByServerId[serverId]?.loading).toBe(false));
        expect(rendered.getCurrent().presetsByServerId).toBe(unchanged);
        harness.answer(serverId, '/v1/machines/presets/list', { status: 403, body: { kind: 'refused', code: 'permission_denied' } });
        await act(async () => { await harness.switchAccount(serverId, 'other-owner'); });
        await waitForHomeGovernance(() => expect(Object.values(rendered.getCurrent().presetsByServerId).flat()).toEqual([]));
        await rendered.unmount();
    });
    it('reads an archived preset and its real resource history on its captured Home while another Home is focused', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example', serverIdentityId: 'srv_history', accountId: 'owner' });
        await addPresetHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(preset) } });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset)] } });
        let unrelatedRowsTransferred = 0;
        harness.answer(serverId, '/v1/machines/managed/actions/list', { select: input => {
            const archived = input && typeof input === 'object' && 'archived' in input && input.archived;
            const selected = input && typeof input === 'object' && 'presetId' in input && input.presetId === preset.id;
            const unrelated = selected ? [] : Array.from({ length: 128 }, (_, index) => ({ ...resource,
                id: `unrelated-${index}`, preset: { id: `other-${index}`, revision: 1 } }));
            unrelatedRowsTransferred += unrelated.length;
            return { body: { machines: [archived ? resource : { ...resource, archivedAt: undefined }, ...unrelated] } };
        } });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_history');
        expect(await client.list()).toEqual({ kind: 'succeeded', value: [createPlainManagedMachinePresetFixture(preset).opened] });
        const detail = await client.detail('preset');
        expect(detail).toMatchObject({ kind: 'succeeded', value: { preset, machines: [resource] } });
        expect(unrelatedRowsTransferred).toBe(0);
        // PERF-L12-I-BRIEF.md P-05 requires selection at the canonical query owner for both history directions.
        expect(harness.requestsFor('/v1/machines/managed/actions/list').map(request => request.input)).toEqual([
            { homeId: 'srv_history', presetId: 'preset' }, { homeId: 'srv_history', presetId: 'preset', archived: true },
        ]);
        const restored = { ...preset, revision: 4, archivedAt: undefined } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
        harness.answer(serverId, '/v1/machines/presets/restore', { body: { kind: 'saved', preset: createPlainManagedMachinePresetFixture(restored) } });
        expect(await client.execute('machines.presets.restore', { homeId: 'srv_history', id: 'preset', expectedRevision: 3 }))
            .toMatchObject({ kind: 'succeeded', value: { kind: 'saved', preset: { revision: 4 } } });
        const archivedAgain = { ...restored, revision: 5, archivedAt: 24 } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
        harness.answer(serverId, '/v1/machines/presets/archive', { body: { kind: 'saved', preset: createPlainManagedMachinePresetFixture(archivedAgain) } });
        expect(await client.execute('machines.presets.archive', { homeId: 'srv_history', id: 'preset', expectedRevision: 4 }))
            .toMatchObject({ kind: 'succeeded', value: { kind: 'saved', preset: createPlainManagedMachinePresetFixture(archivedAgain).opened } });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(archivedAgain) } });
        expect(await client.detail('preset')).toMatchObject({ kind: 'succeeded', value: { preset: createPlainManagedMachinePresetFixture(archivedAgain).opened, machines: [resource] } });
        expect(harness.requestsFor('/v1/machines/presets/restore')[0]?.input)
            .toEqual({ homeId: 'srv_history', id: 'preset', expectedRevision: 3 });
        expect(harness.requestsFor('/v1/machines/presets/archive')[0]?.input)
            .toEqual({ homeId: 'srv_history', id: 'preset', expectedRevision: 4 });
        expect(harness.requests.filter(request => request.path.includes('/machines/')).every(request => request.serverId === serverId)).toBe(true);
        expect(harness.requests.filter(request => request.path.includes('/managed/')).every(request => request.path.endsWith('/list'))).toBe(true);
        expect(harness.requests.some(request => request.path.includes('/acquire'))).toBe(false);
    });

    it('keeps archive at the action owner until its inline review is approved', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example', serverIdentityId: 'srv_history', accountId: 'owner' });
        const archived = { ...preset, archivedAt: 42 } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
        harness.answer(serverId, '/v1/machines/presets/archive', { body: { kind: 'saved', preset: createPlainManagedMachinePresetFixture(archived) } });
        await harness.requireUiApproval(serverId, 'machines.presets.archive');
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_history');
        const modalHost = await renderScreen(React.createElement(ModalProvider));
        const result = client.execute('machines.presets.archive', { homeId: 'srv_history', id: 'preset', expectedRevision: 3 });
        await waitForHomeGovernance(() => expect(modalHost.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
        expect(harness.requestsFor('/v1/machines/presets/archive')).toEqual([]);
        expect(harness.artifacts(serverId).list()).toEqual([]);
        expect(harness.requests.some(request => request.path.includes('/managed/'))).toBe(false);
        await modalHost.pressByTestIdAsync('actions.confirmation-review.decision-approve');
        await expect(result).resolves.toEqual({ kind: 'succeeded', value: { kind: 'saved', preset: createPlainManagedMachinePresetFixture(archived).opened } });
        expect(harness.requestsFor('/v1/machines/presets/archive')).toHaveLength(1);
        await modalHost.unmount();
    });

    it('leaves the acknowledged preset and history intact when its archive review is canceled', async () => {
        const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example', serverIdentityId: 'srv_history', accountId: 'owner' });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture({ ...preset, archivedAt: undefined }) } });
        harness.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [resource] } });
        await harness.requireUiApproval(serverId, 'machines.presets.archive');
        const modalHost = await renderScreen(React.createElement(ModalProvider));
        const rendered = await renderHook(() => useMachinePresetDetail(serverId, 'preset'));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().state.value?.machines).toHaveLength(1));
        let archive: Promise<unknown> | null = null;
        await act(async () => { archive = rendered.getCurrent().archiveOrRestore(); });
        await waitForHomeGovernance(() => expect(modalHost.findByTestId('actions.confirmation-review.decision-reject')).not.toBeNull());
        expect(harness.artifacts(serverId).list()).toEqual([]);
        await modalHost.pressByTestIdAsync('actions.confirmation-review.decision-reject');
        if (!archive) throw new Error('Expected archive mutation');
        await expect(archive).resolves.toEqual({ kind: 'failed', code: 'approval_canceled' });
        expect(rendered.getCurrent().state.error).toBeNull();
        expect(rendered.getCurrent().state.value?.preset.archivedAt).toBeUndefined();
        expect(rendered.getCurrent().history[0]?.managedId).toBe('resource');
        expect(harness.requestsFor('/v1/machines/presets/archive')).toEqual([]);
        await rendered.unmount();
        await modalHost.unmount();
    });
});


it.each(['create', 'update'] as const)('saves three Store catalog apps through the real %s Action schema', async mode => {
    const { storeAppPresetItem } = await import('@/components/store/presets/storePresetDoor');
    const { MachinePresetActionInputSchemasV1 } = await import('@happier-dev/protocol/machines/managed/machinePresetActionsV1');
    const { machinePresetEditContinuationDraft } = await import('./machinePresetEditDraft');
    const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
        serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
    const scripts = [{ body: 'echo setup', affects: 'none' as const }, { body: 'echo software', affects: 'none' as const }];
    const recipes = [
        { kind: 'setupRecipe' as const, selection: { ref: { pluginId: 'tools.example', recipeId: 'automatic-security-updates', revision: '1' }, inputs: {} } },
        { kind: 'softwareRecipe' as const, selection: { ref: { pluginId: 'tools.example', recipeId: 'docker-engine', revision: '1' }, inputs: {} } },
    ];
    let draft: import('./machinePresetEditDraft').MachinePresetEditDraft = { name: 'Saved apps', setup: { items: recipes, scripts } };
    const apps = ['Redis', 'Dokploy two', 'Dokploy three'].map((name, index) =>
        storeAppPresetItem(name, { sourceId: 'catalog', itemId: String(index), version: '1', ref: { kind: 'version', version: '1' } }));
    for (const item of apps) {
        const continuation = machinePresetEditContinuationDraft({ draft, item, onReturn: () => undefined });
        if (!continuation.ok) throw new Error('Store App must join the retained draft');
        draft = continuation.draft;
    }
    const setup = { items: [...recipes, ...apps], scripts };
    const saved = { homeId: 'srv_history', id: 'apps', revision: 1, name: draft.name,
        owner: { kind: 'account' as const, accountId: 'owner' }, setup } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
    harness.answer(serverId, '/v1/machines/presets/' + mode, { body: { kind: 'saved', preset: createPlainManagedMachinePresetFixture(saved) } });
    const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_history');
    const result = await client.saveDraft({ draft, ...(mode === 'update' ? { preset: { ...saved, revision: 0 } }
        : { id: saved.id, owner: saved.owner }) });
    expect(result).toEqual({ kind: 'succeeded', value: { kind: 'saved', preset: createPlainManagedMachinePresetFixture(saved).opened } });
    const request = harness.requestsFor('/v1/machines/presets/' + mode)[0];
    expect(MachinePresetActionInputSchemasV1[mode === 'update' ? 'machines.presets.update' : 'machines.presets.create'].safeParse(request?.input).success).toBe(true);
    expect(request?.input).toMatchObject(mode === 'update' ? { expectedRevision: 0, patch: { content: { t: 'plain', v: { setup } } } } : { content: { t: 'plain', v: { setup } } });
});

it('retains the canonical schema issue path when a preset save is refused before transport', async () => {
    const { storeAppPresetItem } = await import('@/components/store/presets/storePresetDoor');
    const serverId = await addPresetHome({ name: 'History', serverUrl: 'https://history.example',
        serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
    const item = storeAppPresetItem('Dokploy', { sourceId: 'dokploy', itemId: 'app', version: '1', ref: { kind: 'version', version: '1' } });
    Reflect.deleteProperty(item.definition, 'bindings');
    const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_history');
    const result = await client.saveDraft({ preset: { id: 'apps', revision: 0, owner: { kind: 'account', accountId: 'owner' } }, draft: { name: 'Apps', setup: { items: [item] } } });
    expect(result).toMatchObject({ kind: 'failed', code: 'invalid_parameters', diagnosticDetail: expect.any(String) });
    if (result.kind !== 'failed' || !result.diagnosticDetail) throw new Error('Missing validation diagnostic');
    expect(JSON.parse(result.diagnosticDetail)).toMatchObject({ details: { issues: expect.arrayContaining([{
        code: 'invalid_type', path: ['setup', 'items', 0, 'definition', 'bindings'], message: 'Expected array', expected: 'array',
    }]) } });
    expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(0);
});
