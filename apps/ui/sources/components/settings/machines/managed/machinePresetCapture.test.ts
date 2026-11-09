import { afterEach, beforeEach, expect, it } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { MachinePresetActionInputSchemasV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import type { ManagedMachinePresetV1, PresetMutationResultV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { MachineSetupSourceV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { createMachinePresetCollectionClient } = await import('./machinePresetCollectionClient');
beforeEach(async () => {
    await harness.reset();
    (await import('@/sync/ops/actions/scopedHomeActionExecutor')).resetScopedHomeActionExecutorsForTests();
});
afterEach(() => standardCleanup());

it('captures two admitted Preset copies through the existing create Action and collection reader without losing ordered script bytes', async ({ onTestFailed }) => {
    let phase = 'capture-home';
    let failureCode: string | undefined;
    onTestFailed(() => console.error('capture_roundtrip_phase', phase,
        { requests: harness.requests.length,
            creates: harness.requestsFor('/v1/machines/presets/create').length,
            lists: harness.requestsFor('/v1/machines/presets/list').length, failureCode }));
    const serverId = await harness.addHome({ name: 'Capture', serverUrl: 'https://capture.example',
        serverIdentityId: 'srv_capture_home', accountId: 'owner', currentAccount: true });
    phase = 'other-home';
    await harness.addHome({ name: 'Other', serverUrl: 'https://other.example',
        serverIdentityId: 'srv_other_home', accountId: 'other', currentAccount: true });
    const first = { body: '\r\necho first\r\n', affects: 'none' as const };
    const second = { body: ' \r\n', affects: { services: ['editor'] },
        check: { executable: 'test', args: ['-f', '/ready'], unsatisfiedExitCodes: [1] } };
    const sources: MachineSetupSourceV1 = [
        { kind: 'accountPreset', presetId: 'first', presetRevision: 2, setup: { scripts: [first] } },
        { kind: 'accountPreset', presetId: 'second', presetRevision: 7, setup: { scripts: [second] } },
        { kind: 'direct', setup: {} },
    ];
    let saved: ManagedMachinePresetV1 | undefined;
    // The HTTP boundary stores exactly the request admitted by the real Action
    // path; the capture merger, executor, approval and collection parser stay real.
    harness.answer(serverId, '/v1/machines/presets/create', { select: input => {
        const parsed = MachinePresetActionInputSchemasV1['machines.presets.create'].parse(input);
        saved = { ...parsed, revision: 1 };
        return { body: { kind: 'saved', preset: saved } };
    } });
    harness.answer(serverId, '/v1/machines/presets/list', { select: () => ({ body: { kind: 'listed', presets: saved ? [saved] : [] } }) });
    const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_capture_home');
    expect(client).toHaveProperty('capture', expect.any(Function));
    let approved: PresetMutationResultV1 | undefined;
    phase = 'capture';
    const result = await client.capture({ homeId: 'srv_capture_home', id: 'captured', name: 'Captured setup',
        owner: { kind: 'account', accountId: 'owner' },
        launch: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1,
            name: 'Future guest', choices: {} },
        controller: { machineId: 'controller', installationId: 'installation' } }, sources,
    { onApprovalSucceeded: (value: PresetMutationResultV1) => { approved = value; } });
    if (result.kind === 'failed') failureCode = result.code;
    if (result.kind === 'approval_pending') {
        expect(harness.requestsFor('/v1/machines/presets/create')).toEqual([]);
        phase = 'approval-decision';
        await expect(decideApprovalAsInbox(serverId, result.approval.artifactId, 'approve')).resolves.toMatchObject({ ok: true });
        phase = 'approval-delivery';
        await waitForHomeGovernance(() => expect(approved?.kind).toBe('saved'));
    } else expect(result).toMatchObject({ kind: 'succeeded', value: { kind: 'saved' } });
    expect(saved?.setup).toEqual({ scripts: [first, second] });
    phase = 'collection-list';
    expect(await client.list()).toMatchObject({ kind: 'succeeded', value: [{ id: 'captured', setup: { scripts: [first, second] } }] });
    phase = 'complete';
    expect(harness.requests.filter(request => request.path.includes('/machines/')).map(request => request.path))
        .toEqual(['/v1/machines/presets/create', '/v1/machines/presets/list']);
});

it('refuses conflicting retained setup before creating any Preset', async () => {
    const serverId = await harness.addHome({ name: 'Capture', serverUrl: 'https://capture.example',
        serverIdentityId: 'srv_capture_home', accountId: 'owner', currentAccount: true });
    const client = createMachinePresetCollectionClient({ serverId, accountId: 'owner' }, 'srv_capture_home');
    const sources: MachineSetupSourceV1 = [
        { kind: 'accountPreset', presetId: 'first', presetRevision: 1,
            setup: { toolchain: { adapterId: 'mise', config: 'first' }, scripts: [{ body: 'echo first' }] } },
        { kind: 'direct', setup: { toolchain: { adapterId: 'mise', config: 'other' }, scripts: [{ body: 'echo second' }] } },
    ];
    expect(await client.capture({ homeId: 'srv_capture_home', id: 'captured', name: 'Captured setup',
        owner: { kind: 'account', accountId: 'owner' },
        launch: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Guest', choices: {} },
        controller: { machineId: 'controller', installationId: 'installation' } }, sources))
        .toEqual({ kind: 'failed', code: 'machine_setup_conflict' });
    expect(harness.requests).toEqual([]);
});
