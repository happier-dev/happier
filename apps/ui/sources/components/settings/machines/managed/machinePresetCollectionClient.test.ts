import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Boundary mocks must be registered first; cold module transformation is not this contract.
const { useMachinePresets, useMachinePresetDetail } = await import('./useMachinePresets');
const { createMachinePresetCollectionClient } = await import('./machinePresetCollectionClient');
beforeEach(async () => {
    await harness.reset();
    (await import('@/sync/ops/actions/scopedHomeActionExecutor')).resetScopedHomeActionExecutorsForTests();
});
afterEach(() => standardCleanup());

const preset = { id: 'preset', homeId: 'srv_history', revision: 3, name: 'Current recipe', archivedAt: 0,
    owner: { kind: 'account', accountId: 'owner' },
    recipe: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Future name', choices: {} },
    controller: { machineId: 'controller', installationId: 'installation' } } as const;
const resource = { id: 'resource', homeId: 'srv_history', custodianAccountId: 'owner', preset: { id: 'preset', revision: 1 },
    launch: { ...preset.recipe, name: 'Original guest' }, controller: preset.controller,
    allocation: 'confirmed-absent', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, archivedAt: 0 } as const;

describe('preset collection and history through Actions', () => {
    it('settles a signed-out preset collection as unavailable rather than loading forever', async () => {
        const serverId = await harness.addHome({ name: 'History', serverUrl: 'https://history.example', serverIdentityId: 'srv_history', accountId: null });
        const rendered = await renderHook(() => useMachinePresets([serverId]));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().statesByServerId[serverId])
            .toMatchObject({ value: null, loading: false, error: 'signed_out' }));
        expect(harness.requests.some(request => request.path.includes('/machines/'))).toBe(false);
        await rendered.unmount();
    });
    it('settles a signed-out detail without issuing reads or keeping creation progress active', async () => {
        const serverId = await harness.addHome({ name: 'History', serverUrl: 'https://history.example', serverIdentityId: 'srv_history', accountId: null });
        const rendered = await renderHook(() => useMachinePresetDetail(serverId, 'preset'));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().state).toMatchObject({ value: null, loading: false, error: 'signed_out' }));
        expect(harness.requests.some(request => request.path.includes('/machines/'))).toBe(false);
        await rendered.unmount();
    });
    it('withdraws protected collection rows when the captured credential is replaced', async () => {
        const serverId = await harness.addHome({ name: 'History', serverUrl: 'https://history.example', serverIdentityId: 'srv_history', accountId: 'owner' });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [preset] } });
        const rendered = await renderHook(() => useMachinePresets([serverId]));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().presetsByServerId[serverId]).toEqual([preset]));
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
        const serverId = await harness.addHome({ name: 'History', serverUrl: 'https://history.example', serverIdentityId: 'srv_history', accountId: 'owner' });
        await harness.addHome({ name: 'Other', serverUrl: 'https://other.example', serverIdentityId: 'srv_other', accountId: 'other' });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset } });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [preset] } });
        harness.answer(serverId, '/v1/machines/managed/actions/list', { select: input => ({ body: {
            machines: input && typeof input === 'object' && 'archived' in input && input.archived
                ? [resource] : [{ ...resource, archivedAt: undefined }],
        } }) });
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_history');
        expect(await client.list()).toEqual({ kind: 'succeeded', value: [preset] });
        const detail = await client.detail('preset');
        expect(detail).toMatchObject({ kind: 'succeeded', value: { preset, machines: [resource] } });
        expect(harness.requestsFor('/v1/machines/managed/actions/list').map(request => request.input)).toEqual([
            { homeId: 'srv_history' }, { homeId: 'srv_history', archived: true },
        ]);
        const restored = { ...preset, revision: 4, archivedAt: undefined };
        harness.answer(serverId, '/v1/machines/presets/restore', { body: { kind: 'saved', preset: restored } });
        expect(await client.execute('machines.presets.restore', { homeId: 'srv_history', id: 'preset', expectedRevision: 3 }))
            .toMatchObject({ kind: 'succeeded', value: { kind: 'saved', preset: { revision: 4 } } });
        const archivedAgain = { ...restored, revision: 5, archivedAt: 24 };
        harness.answer(serverId, '/v1/machines/presets/archive', { body: { kind: 'saved', preset: archivedAgain } });
        expect(await client.execute('machines.presets.archive', { homeId: 'srv_history', id: 'preset', expectedRevision: 4 }))
            .toMatchObject({ kind: 'succeeded', value: { kind: 'saved', preset: archivedAgain } });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: archivedAgain } });
        expect(await client.detail('preset')).toMatchObject({ kind: 'succeeded', value: { preset: archivedAgain, machines: [resource] } });
        expect(harness.requestsFor('/v1/machines/presets/restore')[0]?.input)
            .toEqual({ homeId: 'srv_history', id: 'preset', expectedRevision: 3 });
        expect(harness.requestsFor('/v1/machines/presets/archive')[0]?.input)
            .toEqual({ homeId: 'srv_history', id: 'preset', expectedRevision: 4 });
        expect(harness.requests.filter(request => request.path.includes('/machines/')).every(request => request.serverId === serverId)).toBe(true);
        expect(harness.requests.filter(request => request.path.includes('/managed/')).every(request => request.path.endsWith('/list'))).toBe(true);
        expect(harness.requests.some(request => request.path.includes('/acquire'))).toBe(false);
    });

    it('keeps archive/restore at the approval owner and never mutates the preset or resources while approval is pending', async () => {
        const serverId = await harness.addHome({ name: 'History', serverUrl: 'https://history.example', serverIdentityId: 'srv_history', accountId: 'owner' });
        await harness.requireUiApproval(serverId, 'machines.presets.archive');
        const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_history');
        const result = await client.execute('machines.presets.archive', { homeId: 'srv_history', id: 'preset', expectedRevision: 3 });
        expect(result).toMatchObject({ kind: 'approval_pending', approval: { artifactId: expect.any(String) } });
        expect(harness.requestsFor('/v1/machines/presets/archive')).toEqual([]);
        expect(harness.requests.some(request => request.path.includes('/managed/'))).toBe(false);
    });

    it('settles a rejected archive approval visibly while retaining the acknowledged preset and its history', async () => {
        const serverId = await harness.addHome({ name: 'History', serverUrl: 'https://history.example', serverIdentityId: 'srv_history', accountId: 'owner' });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: { ...preset, archivedAt: undefined } } });
        harness.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [resource] } });
        await harness.requireUiApproval(serverId, 'machines.presets.archive');
        const approvals: ActionApprovalRegistration[] = [];
        const rendered = await renderHook(() => useMachinePresetDetail(serverId, 'preset', registration => approvals.push(registration)));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().state.value?.machines).toHaveLength(1));
        await act(async () => { expect(await rendered.getCurrent().archiveOrRestore()).toMatchObject({ kind: 'approval_pending' }); });
        const registration = approvals[0];
        if (!registration || typeof registration === 'string') throw new Error('Expected the real typed Action approval continuation');
        // Drive the published terminal callback; the approval Artifact reader owns when it is delivered.
        await act(async () => registration.onTerminal?.('rejected'));
        expect(rendered.getCurrent().state.error).toBe('approval_rejected');
        expect(rendered.getCurrent().state.value?.preset.archivedAt).toBeUndefined();
        expect(rendered.getCurrent().history[0]?.managedId).toBe('resource');
        expect(harness.requestsFor('/v1/machines/presets/archive')).toEqual([]);
        await rendered.unmount();
    });
});
