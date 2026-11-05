import * as React from 'react';
import { PluginSurfaceFocusEligibilityProvider } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import type { PresetMutationResultV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// Boundary mocks must be registered first; cold module transformation is not this contract.
const { useMachinePresets, useMachinePresetDetail } = await import('./useMachinePresets');
const { createMachinePresetCollectionClient } = await import('./machinePresetCollectionClient');
const { useActionApprovalContinuation } = await import('@/components/approvals/useActionApprovalContinuation');
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
    it.each(['collection', 'detail'] as const)('suspends retained %s reads while hidden and resumes with current data', async kind => {
        const serverId = await harness.addHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [preset] } });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset } });
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
            for (let index = 0; index < 20; index += 1) {
                await act(async () => publishHomeAccountChange(serverId));
            }
            await flushHookEffects({ cycles: 30 });
            expect(harness.requestsFor(path)).toHaveLength(before);
            expect(hook.getCurrent()?.value).toBe(ready?.value);
            presented = true;
            await hook.rerender();
            await waitForHomeGovernance(() => expect(harness.requestsFor(path)).toHaveLength(before + 1));
        } finally { await hook.unmount(); }
    });

    it('refreshes a preset collection for its controller changes without reading for other Machines', async () => {
        const serverId = await harness.addHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [preset] } });
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
            await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before + 1));
            await act(async () => publishHomeAccountChange(serverId, ['new-preset'],
                { source: 'socket', changeKinds: ['account'] }));
            await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/list')).toHaveLength(before + 2));
        } finally { await hook.unmount(); }
    });

    it('refreshes ordinary history reads invalidated after an approved preset read settles', async () => {
        const serverId = await harness.addHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        let releaseHistory!: () => void;
        const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset } });
        harness.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [resource] }, respondAfter: historyGate });
        await harness.requireUiApproval(serverId, 'machines.presets.get');
        const rendered = await renderHook(() => {
            const registration = React.useRef<(approval: ActionApprovalRegistration) => void>(() => {});
            const onApprovalPending = React.useCallback((approval: ActionApprovalRegistration) => registration.current(approval), []);
            const detail = useMachinePresetDetail(serverId, 'preset', onApprovalPending);
            const approval = useActionApprovalContinuation({ serverId, scopeKey: `${serverId}:owner:history`, onExecuted: () => {} });
            registration.current = approval.requestApproval;
            return { detail, approval };
        });
        try {
            await waitForHomeGovernance(() => expect(rendered.getCurrent().approval.approvalStatus).toBe('open'));
            const approvalId = rendered.getCurrent().approval.approvalId;
            if (!approvalId) throw new Error('Expected the preset read approval');
            await expect(decideApprovalAsInbox(serverId, approvalId, 'approve')).resolves.toMatchObject({ ok: true });
            await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/managed/actions/list')).toHaveLength(2));
            await act(async () => publishHomeAccountChange(serverId));
            await flushHookEffects();
            expect(harness.artifacts(serverId).list()).toHaveLength(2);
            expect(rendered.getCurrent().approval.approvalId).not.toBe(approvalId);
        } finally {
            releaseHistory();
            await rendered.unmount();
        }
    });
    it.each(['collection', 'detail'] as const)('keeps the %s read approval through Home wakes while another Home refreshes, then settles mixed-change rejection', async kind => {
        const serverId = await harness.addHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        const otherId = await harness.addHome({ name: 'Other', serverUrl: 'https://other-history.example',
            serverIdentityId: 'srv_other_history', accountId: 'owner', currentAccount: true, active: false });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [preset] } });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset } });
        harness.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [resource] } });
        const otherPreset = { ...preset, id: 'other', homeId: 'srv_other_history' };
        harness.answer(otherId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [otherPreset] } });
        await harness.requireUiApproval(serverId, kind === 'collection' ? 'machines.presets.list' : 'machines.presets.get');
        const rendered = await renderHook(() => {
            const registration = React.useRef<(approval: ActionApprovalRegistration) => void>(() => {});
            const onApprovalPending = React.useCallback((approval: ActionApprovalRegistration) => registration.current(approval), []);
            const collection = useMachinePresets(kind === 'collection' ? [serverId, otherId] : [otherId], onApprovalPending);
            const detail = useMachinePresetDetail(serverId, kind === 'detail' ? 'preset' : '', onApprovalPending);
            const approval = useActionApprovalContinuation({ serverId, scopeKey: `${serverId}:owner:${kind}`, onExecuted: () => {} });
            registration.current = approval.requestApproval;
            return { collection, detail, approval };
        });
        const state = () => kind === 'collection' ? rendered.getCurrent().collection.statesByServerId[serverId] : rendered.getCurrent().detail.state;
        await waitForHomeGovernance(() => expect(rendered.getCurrent().approval.approvalStatus).toBe('open'));
        const approvalId = rendered.getCurrent().approval.approvalId;
        if (!approvalId) throw new Error('Expected the read approval');
        await act(async () => publishHomeAccountChange(serverId));
        await flushHookEffects();
        expect(rendered.getCurrent().approval.approvalId).toBe(approvalId);
        expect(harness.artifacts(serverId).list()).toHaveLength(1);
        const otherReads = () => harness.requestsFor('/v1/machines/presets/list').filter(request => request.serverId === otherId);
        const readsBefore = otherReads().length;
        await act(async () => publishHomeAccountChange(otherId));
        await waitForHomeGovernance(() => expect(otherReads()).toHaveLength(readsBefore + 1));
        expect(rendered.getCurrent().approval.approvalId).toBe(approvalId);
        expect(harness.artifacts(serverId).list()).toHaveLength(1);
        await expect(decideApprovalAsInbox(serverId, approvalId, 'approve')).resolves.toMatchObject({ ok: true });
        await waitForHomeGovernance(() => expect(state()).toMatchObject({ loading: false, error: null }));
        const retained = state()?.value;
        expect(retained).toEqual(kind === 'collection' ? [preset] : { preset, machines: [resource] });
        await act(async () => publishHomeAccountChange(serverId, [preset.id], { changeKinds: ['artifact', 'account'] }));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().approval.approvalStatus).toBe('open'));
        const rejectedId = rendered.getCurrent().approval.approvalId;
        if (!rejectedId || rejectedId === approvalId) throw new Error('Expected the fresh read approval');
        await expect(decideApprovalAsInbox(serverId, rejectedId, 'reject')).resolves.toMatchObject({ ok: true });
        await waitForHomeGovernance(() => expect(state()).toMatchObject({ loading: false, error: 'approval_rejected' }));
        expect(state()?.value).toBe(retained);
        await rendered.unmount();
    });
    it.each([
        { kind: 'conflict', currentRevision: 5 },
        { kind: 'refused', code: 'permission_denied' },
    ] satisfies PresetMutationResultV1[])('retains the typed $kind result of an approved preset mutation', async result => {
        const serverId = await harness.addHome({ name: 'History', serverUrl: 'https://history.example',
            serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset } });
        harness.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [resource] } });
        harness.answer(serverId, '/v1/machines/presets/update', { body: result });
        await harness.requireUiApproval(serverId, 'machines.presets.update');
        const rendered = await renderHook(() => {
            const registration = React.useRef<(approval: ActionApprovalRegistration) => void>(() => {});
            const onApprovalPending = React.useCallback((approval: ActionApprovalRegistration) => registration.current(approval), []);
            const detail = useMachinePresetDetail(serverId, 'preset', onApprovalPending);
            const approval = useActionApprovalContinuation({ serverId, scopeKey: `${serverId}:owner:preset`, onExecuted: detail.refresh });
            registration.current = approval.requestApproval;
            return { detail, approval };
        });
        await waitForHomeGovernance(() => expect(rendered.getCurrent().detail.state.value?.preset.id).toBe('preset'));
        await act(async () => { expect(await rendered.getCurrent().detail.update({ name: 'Updated' })).toMatchObject({ kind: 'approval_pending' }); });
        await waitForHomeGovernance(() => expect(rendered.getCurrent().approval.approvalStatus).toBe('open'));
        expect(harness.requestsFor('/v1/machines/presets/update')).toEqual([]);
        if (result.kind === 'refused') harness.answer(serverId, '/v1/machines/presets/get', { status: 403, body: result });
        await expect(decideApprovalAsInbox(serverId, harness.artifacts(serverId).list()[0]!.id, 'approve'))
            .resolves.toMatchObject({ ok: true });
        expect(rendered.getCurrent().detail.mutationResult).toEqual(result);
        if (result.kind === 'refused') expect(rendered.getCurrent().detail.state.value).toBeNull();
        else expect(rendered.getCurrent().detail.state.value?.preset.revision).toBe(3);
        await rendered.unmount();
    });

    it('settles the Machines page preset inventory without a controller catalog or managed-resource answer', async () => {
        const serverId = await harness.addHome({ name: 'History', serverUrl: 'https://history.example', serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { srv_history: [] }, machineListStatusByServerId: { srv_history: 'idle' } });
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { respondAfter: new Promise<void>(() => {}) });
        harness.answer(serverId, '/v1/machines/managed/actions/list', { respondAfter: new Promise<void>(() => {}) });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [preset] } });
        const { useMachinesSettingsViewModel } = await import('../machinesSettingsViewModel');
        const rendered = await renderHook(() => useMachinesSettingsViewModel());
        await waitForHomeGovernance(() => expect(Object.values(rendered.getCurrent().presetsByServerId).flat()).toEqual([preset]));
        expect(Object.values(rendered.getCurrent().presetInventory.statesByServerId)).toEqual([
            expect.objectContaining({ loading: false, error: null, value: [preset] }),
        ]);
        expect(harness.requests.some(request => request.path.includes('/actions/machines.provisioners.'))).toBe(false);
        await rendered.unmount();
    });
    it('settles a failed server preset read without waiting for a controller', async () => {
        const serverId = await harness.addHome({ name: 'History', serverUrl: 'https://history.example', serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        harness.answer(serverId, '/v1/machines/presets/list', { status: 503, body: { kind: 'refused', code: 'unavailable' } });
        const rendered = await renderHook(() => useMachinePresets([serverId]));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().statesByServerId[serverId]).toMatchObject({ loading: false, value: null }));
        expect(rendered.getCurrent().statesByServerId[serverId]?.error).toBeTruthy();
        expect(harness.requests.some(request => request.path.includes('/actions/machines.provisioners.'))).toBe(false);
        await rendered.unmount();
    });
    it.each(['profile', 'portable'] as const)('loads server presets with silent controllers through a %s Home identifier', async identifier => {
        const serverId = await harness.addHome({ name: 'History', serverUrl: 'https://history.example', serverIdentityId: 'srv_history', accountId: 'owner', currentAccount: true });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ machineListByServerId: { srv_history: [createMachineFixture({ id: 'controller', installationId: 'installation', activeAt: Date.now() })] },
            machineListStatusByServerId: { srv_history: 'idle' } });
        harness.answer(serverId, '/v1/actions/machines.provisioners.list', { respondAfter: new Promise<void>(() => {}) });
        harness.answer(serverId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [preset] } });
        const scopeId = identifier === 'profile' ? serverId : 'srv_history';
        const rendered = await renderHook(() => useMachinePresets([scopeId]));
        await waitForHomeGovernance(() => expect(rendered.getCurrent().statesByServerId[scopeId]).toMatchObject({ loading: false, error: null, value: [preset] }));
        expect(harness.requests.some(request => request.path.includes('/actions/machines.provisioners.'))).toBe(false);
        await rendered.unmount();
    });
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
